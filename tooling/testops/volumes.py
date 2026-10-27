"""Owned TestOps Docker volume lifecycle: prepare, release, prune and status.

Only volumes labelled ``farol.testops.task`` are ever considered; unlabelled
volumes are never inspected for removal or removed. A short exclusive flock on the
permanent ``_output/testops/volumes.lock`` serialises lease registration with
volume creation, release, and prune's check-and-remove. It is never held while
tests run.

A lease ``_output/testops/scopes/<scope>.json`` is written before any volume is
created, so a partial prepare stays accounted. Its owner is the long-lived runner
for the scope, identified by pid plus process start time. ``--owner-pid``
defaults to the parent of the ``testops.py`` process, i.e. the runner shell or
script that calls prepare, runs the gate and later calls release. A lease whose
owner is gone no longer protects its volumes from prune.

Removal is by exact name and is verified with ``docker volume inspect``. Any rm
error, remaining volume or unreadable state reports INCOMPLETE, never PASS.
"""
from __future__ import annotations

import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import time
import uuid
from pathlib import Path

LABEL = "farol.testops.task"
CREATED = "farol.testops.created"
RETAIN = "farol.testops.retain"
CACHE_KEY = "farol.testops.cache-key"
CHECKOUT = "farol.testops.checkout"
RESERVED = {LABEL, CREATED, RETAIN, CACHE_KEY, CHECKOUT}
PREFIX = "farol-testops-"
SCOPE = re.compile(r"farol-testops-[a-f0-9]{8}")
CACHE_KEEP = 2
PS = "/bin/ps"
DOCKER_SECONDS = 120


class Refused(Exception):
    """Refusal before any effect; nothing was created or removed."""


class Engine:
    def __init__(self, binary, socket=None):
        if not binary.is_absolute() or not binary.is_file() or not os.access(binary, os.X_OK):
            raise Refused("EXPLICIT_DOCKER_EXECUTABLE_REQUIRED")
        self.prefix = [str(binary)]
        if socket is not None:
            socket = socket.resolve(strict=True)
            if not stat.S_ISSOCK(socket.stat().st_mode):
                raise Refused("EXPLICIT_LOCAL_UNIX_DOCKER_SOCKET_REQUIRED")
            self.prefix += ["--host", "unix://" + str(socket)]
            self.endpoint = "unix://" + str(socket)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/var/empty"),
                    "LANG": "C", "LC_ALL": "C"}
        if socket is None:
            # Pin the current context's endpoint once: ownership verified on one
            # engine must never authorize a removal on another after a switch.
            result = self.call("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
            host = result.stdout.strip()
            if result.returncode != 0 or not re.fullmatch(r"(unix|tcp|ssh|npipe)://\S+", host):
                raise Refused("DOCKER_ENDPOINT_UNRESOLVED")
            self.prefix += ["--host", host]
            self.endpoint = host

    def call(self, *args):
        return subprocess.run(self.prefix + list(args), env=self.env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True, timeout=DOCKER_SECONDS)


def checkout_id(root):
    """Leases live in one checkout while Docker may be shared: label the owner.

    A path alone is not unique (another client or container can use the same
    path against the same daemon), so a random identity is minted once per
    checkout. Losing it makes earlier volumes "unknown", which keeps them.
    """
    base, _ = output_dirs(root)
    path = base / "checkout.id"
    if not path.exists():
        # Publish a complete file atomically: link(2) fails if another client
        # won the race, and nobody can read a half-written identity.
        temporary = base / (".checkout.id." + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(uuid.uuid4().hex + "\n")
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
        finally:
            os.unlink(temporary)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as handle:
        token = handle.read().strip()
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise Refused("CHECKOUT_IDENTITY_INVALID")
    material = token + "\0" + str(Path(root).resolve())
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def scope_id(scope):
    return scope[len(PREFIX):]


def owned_name(scope, name):
    return bool(re.fullmatch(re.escape(scope) + r"-[a-z0-9-]{1,64}", name))


def process_start(pid):
    """Owner start time; '' when no such process, None when unknown."""
    try:
        result = subprocess.run([PS, "-o", "lstart=", "-p", str(pid)], stdin=subprocess.DEVNULL,
                                env={"PATH": "/usr/bin:/bin", "TZ": "UTC", "LANG": "C", "LC_ALL": "C"},
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    text = " ".join(result.stdout.split())
    if result.returncode == 0 and text:
        return text
    if result.returncode == 1 and not text:
        return ""
    return None


def inspect(engine, name):
    """(True, record) present; (False, None) verified absent; (None, reason) unknown."""
    result = engine.call("volume", "inspect", name)
    if result.returncode == 0:
        try:
            values = json.loads(result.stdout)
        except ValueError:
            return None, "VOLUME_INSPECT_UNREADABLE"
        if isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict) \
                and values[0].get("Name") == name:
            return True, values[0]
        return None, "VOLUME_INSPECT_UNREADABLE"
    error = result.stderr.lower()
    if (result.returncode == 1 and "no such volume" in error and name.lower() in error
            and result.stdout.strip() in {"", "[]"}):
        return False, None
    return None, "VOLUME_INSPECT_FAILED:" + result.stderr.strip()[:200]


def remove_volume(engine, name):
    """Remove one volume by exact name; None only after verified absence."""
    result = engine.call("volume", "rm", name)
    present, _ = inspect(engine, name)
    if present is False:
        return None
    if result.returncode != 0:
        return "VOLUME_RM_FAILED:" + result.stderr.strip()[:200]
    return "VOLUME_STILL_PRESENT_AFTER_RM"


def references(engine, name):
    """Container IDs (running or stopped) mounting the volume; None when unknown."""
    result = engine.call("ps", "-a", "--no-trunc", "--filter", "volume=" + name, "--format", "{{.ID}}")
    return result.stdout.split() if result.returncode == 0 else None


def labelled(engine, value=None):
    """Exact-name inventory of task-labelled volumes; unreadable rows are retained as unknown."""
    selector = LABEL if value is None else LABEL + "=" + value
    result = engine.call("volume", "ls", "--quiet", "--filter", "label=" + selector)
    if result.returncode != 0:
        raise OSError("VOLUME_LIST_FAILED:" + result.stderr.strip()[:200])
    rows = {}
    for name in sorted(set(result.stdout.split())):
        present, record = inspect(engine, name)
        if present is False:
            continue
        labels = record.get("Labels") if present else None
        if present and isinstance(labels, dict) and isinstance(labels.get(LABEL), str):
            if value is None or labels[LABEL] == value:
                rows[name] = {"labels": labels, "createdAt": record.get("CreatedAt")}
        else:
            rows[name] = {"labels": None, "reason": record if present is None else "LABELS_UNREADABLE"}
    return rows


def output_dirs(root):
    base = root / "_output" / "testops"
    current = root
    for part in ("_output", "testops", "scopes"):
        current = current / part
        if current.is_symlink():
            raise Refused("OWNED_OUTPUT_DIRECTORY_REQUIRED:" + str(current))
        current.mkdir(mode=0o700, exist_ok=True)
    return base, base / "scopes"


@contextlib.contextmanager
def locked(root, timeout):
    """Short exclusive lock on the permanent volumes.lock; never deleted."""
    base, _ = output_dirs(root)
    descriptor = os.open(base / "volumes.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refused("VOLUMES_LOCK_TIMEOUT")
                time.sleep(0.05)
        yield
    finally:
        os.close(descriptor)


def valid_lease(value, scope):
    owner = value.get("owner") if isinstance(value, dict) else None
    rows = value.get("volumes") if isinstance(value, dict) else None
    return (isinstance(owner, dict) and value.get("schema") == 1 and value.get("scope") == scope
            and type(owner.get("pid")) is int and owner["pid"] > 0
            and isinstance(owner.get("start"), str) and owner["start"]
            and isinstance(rows, list) and rows
            and all(isinstance(row, dict) and isinstance(row.get("name"), str)
                    and owned_name(scope, row["name"]) and row.get("retain") in {"run", "cache"}
                    for row in rows))


def read_lease(path, scope):
    """The lease, or None when present but unreadable; raises FileNotFoundError when absent."""
    if path.is_symlink():
        return None
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        raise
    except (OSError, ValueError):
        return None
    return value if valid_lease(value, scope) else None


def leases(scopes):
    found = {}
    for path in sorted(scopes.iterdir()):
        if path.suffix == ".json" and SCOPE.fullmatch(path.stem):
            try:
                found[path.stem] = read_lease(path, path.stem)
            except FileNotFoundError:
                continue
    return found


def lease_state(lease):
    start = process_start(lease["owner"]["pid"])
    if start is None:
        return "unknown"
    return "live" if start == lease["owner"]["start"] else "dead"


def write_lease(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(json.dumps(value, indent=2) + "\n")
        output.flush()
        os.fsync(output.fileno())


def prepare(root, engine, scope, names, retain, cache_key, extra, owner_pid, timeout):
    if not SCOPE.fullmatch(scope):
        raise Refused("OWNED_SCOPE_REQUIRED")
    if not names or len(set(names)) != len(names) or not all(owned_name(scope, n) for n in names):
        raise Refused("VOLUME_OUTSIDE_OWNED_SCOPE")
    if retain == "cache" and not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", cache_key or ""):
        raise Refused("CACHE_KEY_REQUIRED")
    if retain != "cache" and cache_key is not None:
        raise Refused("CACHE_KEY_ONLY_FOR_CACHE")
    labels = {}
    for item in extra:
        key, sep, value = item.partition("=")
        if not sep or not re.fullmatch(r"farol\.testops\.[a-z0-9.-]{1,64}", key) or key in RESERVED \
                or not re.fullmatch(r"[A-Za-z0-9._:/-]{1,128}", value):
            raise Refused("LABEL_REJECTED:" + item)
        labels[key] = value
    start = process_start(owner_pid)
    if not start:
        raise Refused("LIVE_LEASE_OWNER_REQUIRED")
    created = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    labels.update({LABEL: scope_id(scope), CREATED: created, RETAIN: retain,
                   CHECKOUT: checkout_id(root)})
    if cache_key is not None:
        labels[CACHE_KEY] = cache_key
    with locked(root, timeout):
        _, scopes = output_dirs(root)
        path = scopes / (scope + ".json")
        if path.exists() or path.is_symlink():
            raise Refused("SCOPE_LEASE_EXISTS")
        for name in names:
            present, _ = inspect(engine, name)
            if present is not False:
                raise Refused("VOLUME_NAME_NOT_FREE:" + name)
        # Registered before any create, so a partial prepare is still accounted.
        write_lease(path, {"schema": 1, "scope": scope, "created": created,
                           "endpoint": engine.endpoint,
                           "owner": {"pid": owner_pid, "start": start},
                           "volumes": [{"name": n, "retain": retain} for n in names]})
        made = []
        arguments = []
        for key in sorted(labels):
            arguments += ["--label", key + "=" + labels[key]]
        for name in names:
            result = engine.call("volume", "create", "--driver", "local", *arguments, name)
            present, record = inspect(engine, name)
            observed = (record.get("Labels") or {}) if present is True else {}
            if result.returncode != 0 or present is not True or any(observed.get(k) != v for k, v in labels.items()):
                return {"status": "INCOMPLETE", "reason": "VOLUME_CREATE_FAILED", "volume": name,
                        "error": result.stderr.strip()[:200], "created": made, "lease": str(path),
                        "next": "release the scope; the lease accounts for every requested name"}, 1
            made.append(name)
    return {"status": "PASS", "scope": scope, "volumes": made, "retain": retain,
            "lease": str(path), "owner": {"pid": owner_pid, "start": start}}, 0


def release(root, engine, scope, timeout):
    if not SCOPE.fullmatch(scope):
        raise Refused("OWNED_SCOPE_REQUIRED")
    with locked(root, timeout):
        _, scopes = output_dirs(root)
        path = scopes / (scope + ".json")
        try:
            lease = read_lease(path, scope)
        except FileNotFoundError:
            lease = False
        if lease is None:
            return {"status": "INCOMPLETE", "reason": "LEASE_UNREADABLE", "lease": str(path)}, 1
        if lease is False:
            # Ownership is this checkout's lease; a scope label alone is not.
            raise Refused("LOCAL_LEASE_REQUIRED")
        if lease.get("endpoint") != engine.endpoint:
            # Absence on another daemon proves nothing about the original one.
            raise Refused("LEASE_ENGINE_MISMATCH")
        errors, removed, absent, retained, containers = [], [], [], [], []
        here = checkout_id(root)
        targets = {}
        for row in lease["volumes"]:
            targets[row["name"]] = row["retain"]
        try:
            for name, row in labelled(engine, scope_id(scope)).items():
                if name not in targets and row["labels"] is not None \
                        and row["labels"].get(CHECKOUT) == here and owned_name(scope, name):
                    targets[name] = "cache" if row["labels"].get(RETAIN) == "cache" else "run"
        except OSError as error:
            errors.append(str(error))
        # Every effect below needs the volume to be verifiably this checkout's now:
        # a stale or lost-race lease name never authorizes deleting someone else's.
        verified = {}
        for name in sorted(targets):
            present, record = inspect(engine, name)
            if present is False:
                absent.append(name)  # E.g. a lease name whose create never happened.
                continue
            labels = (record or {}).get("Labels") if present else None
            if present is None or not isinstance(labels, dict):
                errors.append(name + ":" + (record if isinstance(record, str) else "LABELS_UNREADABLE"))
                continue
            if labels.get(CHECKOUT) != here or labels.get(LABEL) != scope_id(scope):
                errors.append("NOT_THIS_CHECKOUT:" + name)
                continue
            verified[name] = "cache" if labels.get(RETAIN) == "cache" else targets[name]
        runs = sorted(name for name, kind in verified.items() if kind == "run")
        retained.extend(sorted(name for name, kind in verified.items() if kind == "cache"))
        # Only containers that mount this checkout's verified run volumes are removed.
        users = set()
        for name in runs:
            found = references(engine, name)
            if found is None:
                errors.append("CONTAINER_REFERENCES_UNKNOWN:" + name)
            else:
                users.update(found)
        listing = engine.call("ps", "-a", "--no-trunc", "--filter", "label=" + LABEL + "=" + scope_id(scope),
                              "--format", "{{.ID}} {{.Names}}")
        labelled_containers = {}
        if listing.returncode != 0:
            errors.append("CONTAINER_LIST_FAILED:" + listing.stderr.strip()[:200])
        for line in listing.stdout.splitlines() if listing.returncode == 0 else []:
            cid, _, names = line.strip().partition(" ")
            if cid:
                labelled_containers[cid] = names
        for cid in sorted(users):
            names = next((n for full, n in labelled_containers.items() if full.startswith(cid) or cid.startswith(full)), None)
            if names is None or not all(owned_name(scope, n) for n in names.split(",")):
                errors.append("FOREIGN_CONTAINER_USES_VOLUME:" + cid)
                continue
            result = engine.call("rm", "--force", cid)
            if result.returncode != 0:
                errors.append("CONTAINER_RM_FAILED:" + cid + ":" + result.stderr.strip()[:200])
            else:
                containers.append(cid)
        for name in runs:
            error = remove_volume(engine, name)
            if error:
                errors.append(name + ":" + error)
            else:
                removed.append(name)
        report = {"scope": scope, "removedContainers": containers, "removed": removed,
                  "alreadyAbsent": absent, "retainedCache": retained, "lease": str(path)}
        if errors:
            return {"status": "INCOMPLETE", "errors": errors, **report}, 1
        if lease:
            path.unlink()
        return {"status": "PASS", "leaseRemoved": bool(lease), **report}, 0


def process_commands():
    """Command lines of live processes; None when unreadable (keep everything)."""
    try:
        result = subprocess.run([PS, "-axww", "-o", "command="], stdin=subprocess.DEVNULL,
                                env={"PATH": "/usr/bin:/bin", "TZ": "UTC", "LANG": "C", "LC_ALL": "C"},
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.splitlines() if result.returncode == 0 and result.stdout else None


def classify(root, engine, sizes=None):
    _, scopes = output_dirs(root)
    # A gate can outlive the runner that owns its lease and run between
    # containers; it names its scope and volumes on its own command line.
    commands = process_commands()
    found = leases(scopes)
    live, unknown_names, unknown_scopes, lease_rows = set(), set(), set(), []
    for scope, lease in found.items():
        if lease is None:
            unknown_scopes.add(scope_id(scope))
            lease_rows.append({"scope": scope, "state": "unknown", "reason": "LEASE_UNREADABLE"})
            continue
        state = lease_state(lease)
        names = {row["name"] for row in lease["volumes"]}
        if state == "live":
            live |= names
        elif state == "unknown":
            unknown_names |= names
        lease_rows.append({"scope": scope, "state": state, "owner": lease["owner"], "volumes": sorted(names)})
    rows, cache = [], {}
    here = checkout_id(root)
    for name, item in labelled(engine).items():
        labels = item["labels"]
        row = {"name": name, "size": (sizes or {}).get(name)}
        rows.append(row)
        if labels is None:
            row.update(state="unknown", reason=item.get("reason", "LABELS_UNREADABLE"))
            continue
        row.update(scope=PREFIX + labels[LABEL], retain=labels.get(RETAIN, "run"),
                   created=labels.get(CREATED) or item.get("createdAt"))
        if not SCOPE.fullmatch(row["scope"]) or not owned_name(row["scope"], name):
            row.update(state="unknown", reason="LABEL_NAME_MISMATCH")
        elif labels.get(CHECKOUT) != here:
            # Another checkout's lease is invisible here; never judge its volume.
            row.update(state="unknown", reason="NOT_THIS_CHECKOUT")
        elif name in live:
            row.update(state="active", reason="LIVE_LEASE")
        elif commands is None:
            row.update(state="unknown", reason="PROCESSES_UNREADABLE")
        elif any(name in command or row["scope"] in command for command in commands):
            row.update(state="active", reason="PROCESS_REFERENCE")
        elif name in unknown_names or labels[LABEL] in unknown_scopes:
            row.update(state="unknown", reason="LEASE_STATE_UNKNOWN")
        else:
            users = references(engine, name)
            if users is None:
                row.update(state="unknown", reason="CONTAINER_REFERENCES_UNKNOWN")
            elif users:
                row.update(state="active", reason="CONTAINER_REFERENCE", containers=users)
            elif row["retain"] == "run":
                row.update(state="removable", reason="UNREFERENCED_RUN_VOLUME")
            elif row["retain"] == "cache" and labels.get(CACHE_KEY):
                cache.setdefault(labels[CACHE_KEY], []).append(row)
            else:
                row.update(state="unknown", reason="RETAIN_OR_CACHE_KEY_LABEL_INVALID")
    for key, members in cache.items():
        members.sort(key=lambda r: (str(r["created"] or ""), r["name"]), reverse=True)
        for index, row in enumerate(members):
            row["cacheKey"] = key
            if index < CACHE_KEEP:
                row.update(state="protected", reason="NEWEST_UNREFERENCED_CACHE")
            else:
                row.update(state="removable", reason="SUPERSEDED_CACHE")
    return rows, lease_rows, found


def prune(root, engine, timeout):
    with locked(root, timeout):
        rows, lease_rows, found = classify(root, engine)
        removed, errors = [], []
        for row in rows:
            if row["state"] != "removable":
                continue
            error = remove_volume(engine, row["name"])
            if error:
                errors.append(row["name"] + ":" + error)
            else:
                removed.append(row["name"])
        dropped = []
        _, scopes = output_dirs(root)
        for item in lease_rows:
            if item["state"] != "dead":
                continue
            lease = found[item["scope"]]
            runs = [r["name"] for r in lease["volumes"] if r["retain"] == "run"]
            if lease.get("endpoint") == engine.endpoint and \
                    all(inspect(engine, name)[0] is False for name in runs):
                (scopes / (item["scope"] + ".json")).unlink()
                dropped.append(item["scope"])
        kept = [{k: row[k] for k in ("name", "state", "reason")} for row in rows if row["state"] != "removable"]
        status = "INCOMPLETE" if errors else "PASS"
        return {"status": status, "removed": removed, "errors": errors, "kept": kept,
                "droppedLeases": dropped}, 1 if errors else 0


def volume_sizes(engine):
    result = engine.call("system", "df", "--verbose", "--format", "{{json .Volumes}}")
    try:
        values = json.loads(result.stdout) if result.returncode == 0 else []
        return {v["Name"]: v.get("Size") for v in values if isinstance(v, dict) and "Name" in v}
    except (ValueError, TypeError):
        return {}


def status(root, engine, timeout):
    with locked(root, timeout):
        rows, lease_rows, _ = classify(root, engine, volume_sizes(engine))
    totals = {}
    for row in rows:
        totals[row["state"]] = totals.get(row["state"], 0) + 1
    return {"schema": 1, "kind": "testops-volumes-status", "status": "OBSERVED",
            "totals": totals, "volumes": rows, "leases": lease_rows}, 0


def add_parser(sub):
    parser = sub.add_parser("volumes", help="Owned TestOps Docker volume lifecycle")
    actions = parser.add_subparsers(dest="volumes_command", required=True)
    for name in ("prepare", "release", "prune", "status"):
        action = actions.add_parser(name)
        action.add_argument("--docker", type=Path, required=True, help="Absolute Docker CLI executable")
        action.add_argument("--socket", type=Path, help="Optional local Docker unix socket")
        action.add_argument("--lock-timeout", type=float, default=120.0)
        if name in {"prepare", "release"}:
            action.add_argument("--scope", required=True)
        if name == "prepare":
            action.add_argument("--volume", action="append", required=True, help="Exact owned volume name")
            action.add_argument("--retain", choices=("run", "cache"), default="run")
            action.add_argument("--cache-key", help="Toolchain/lock key; required for --retain cache")
            action.add_argument("--label", action="append", default=[], help="Extra farol.testops.* label")
            action.add_argument("--owner-pid", type=int, default=os.getppid(),
                                help="Long-lived runner owning the lease (default: parent process)")


def command(args, root):
    try:
        engine = Engine(args.docker, args.socket)
        if args.volumes_command == "prepare":
            result, code = prepare(root, engine, args.scope, args.volume, args.retain, args.cache_key,
                                   args.label, args.owner_pid, args.lock_timeout)
        elif args.volumes_command == "release":
            result, code = release(root, engine, args.scope, args.lock_timeout)
        elif args.volumes_command == "prune":
            result, code = prune(root, engine, args.lock_timeout)
        else:
            result, code = status(root, engine, args.lock_timeout)
    except Refused as error:
        result, code = {"status": "BLOCKED", "reason": str(error)}, 2
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # An interrupted effect has an unknown outcome: never report cleanup as done.
        result, code = {"status": "INCOMPLETE", "reason": type(error).__name__ + ":" + str(error)[:200]}, 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return code
