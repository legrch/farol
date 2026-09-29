"""Bounded, checkout-independent N -> N+1 Farol app replacement.

Input is one JSON object on fd 3. Exit status is classified; stdout is one
JSON phase record. No caller-supplied filesystem path is used for mutation.
"""
import fcntl
import datetime
import hashlib
import json
import os
import plistlib
import posixpath
import stat
import struct
import subprocess
import sys
import time

APP = "Farol Next Preview.app"
BUNDLE = "local.farol.next.preview"
ROOT_PARTS = ("Library", "Application Support", "Farol Next Preview", "installed-updates")
DIGEST_VERSION = "farol.next.tree-digest/v2"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | getattr(os, "O_NONBLOCK", 0)
MAX_ENTRIES = 100000
MAX_BYTES = 1024 * 1024 * 1024
MAX_DEPTH = 128
MAX_RECORD = 8192


class Refusal(Exception):
    def __init__(self, code, phase="refused"):
        self.code = code
        self.phase = phase


def fail(code, phase="refused"):
    raise Refusal(code, phase)


def identity(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid)


def open_dir(parent, name):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.geteuid() or before.st_mode & 0o022:
        fail("path_type")
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    if identity(os.fstat(fd)) != identity(before):
        os.close(fd)
        fail("path_replaced")
    return fd


def components(value):
    if not isinstance(value, str) or not value.startswith("/") or value == "/" or os.path.normpath(value) != value or "\x00" in value:
        fail("input")
    parts = value.split("/")[1:]
    if any(not p or p in (".", "..") or len(os.fsencode(p)) > 255 for p in parts):
        fail("input")
    return parts


def open_home(value):
    fd = os.open("/", DIR_FLAGS)
    try:
        for p in components(value):
            before = os.stat(p, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or before.st_uid not in (0, os.geteuid()) or before.st_mode & 0o022:
                fail("home_type")
            child = os.open(p, DIR_FLAGS, dir_fd=fd)
            if identity(os.fstat(child)) != identity(before):
                os.close(child)
                fail("home_replaced")
            os.close(fd)
            fd = child
        if os.fstat(fd).st_uid != os.geteuid():
            fail("home_owner")
        return fd
    except BaseException:
        os.close(fd)
        raise


def ensure_dir(parent, name):
    try:
        os.mkdir(name, 0o700, dir_fd=parent)
        os.fsync(parent)
    except FileExistsError:
        pass
    return open_dir(parent, name)


def entry(parent, name):
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None


def read_file(parent, name, limit=MAX_RECORD):
    before = entry(parent, name)
    if before is None or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid():
        fail("file_type")
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        if identity(os.fstat(fd)) != identity(before) or before.st_size > limit:
            fail("file_replaced")
        chunks = []
        size = 0
        while size <= limit:
            chunk = os.read(fd, min(4096, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        data = b"".join(chunks)
        if len(data) > limit or len(data) != before.st_size or identity(os.fstat(fd)) != identity(before):
            fail("file_changed")
        return data
    finally:
        os.close(fd)


def write_record(parent, name, record):
    data = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(data) > MAX_RECORD:
        fail("record_size")
    current = entry(parent, name)
    if current is not None and (not stat.S_ISREG(current.st_mode) or current.st_uid != os.geteuid() or current.st_nlink != 1):
        fail("journal_type")
    temp = ".journal-" + os.urandom(12).hex()
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(temp, name, src_dir_fd=parent, dst_dir_fd=parent)
    os.fsync(parent)


def checked_tree(parent, name, expected, version, build_id):
    before = entry(parent, name)
    if before is None or not stat.S_ISDIR(before.st_mode) or before.st_uid != os.geteuid():
        fail("app_type")
    root = open_dir(parent, name)
    try:
        if identity(os.fstat(root)) != identity(before):
            fail("app_replaced")
        digest = hashlib.sha256()
        digest.update((DIGEST_VERSION + "\0").encode())
        count = 0
        total = 0
        links = {}
        kinds = {}
        def walk(fd, prefix, depth):
            nonlocal count, total
            if depth > MAX_DEPTH:
                fail("tree_limit")
            for child_name in sorted(os.listdir(fd), key=lambda s: s.encode("utf-16-be", "surrogatepass")):
                if child_name in ("", ".", "..") or "/" in child_name:
                    fail("tree_name")
                count += 1
                if count > MAX_ENTRIES:
                    fail("tree_limit")
                relative = child_name if not prefix else prefix + "/" + child_name
                st = os.stat(child_name, dir_fd=fd, follow_symlinks=False)
                mode = stat.S_IMODE(st.st_mode)
                kind = b"d" if stat.S_ISDIR(st.st_mode) else b"f" if stat.S_ISREG(st.st_mode) else b"l" if stat.S_ISLNK(st.st_mode) else None
                if kind is None:
                    fail("tree_type")
                kinds[relative] = kind
                raw = relative.encode("utf-8")
                digest.update(struct.pack(">I", len(raw)) + raw + kind + struct.pack(">I", mode))
                if kind == b"d":
                    child = open_dir(fd, child_name)
                    try:
                        walk(child, relative, depth + 1)
                    finally:
                        os.close(child)
                elif kind == b"l":
                    link = os.readlink(child_name, dir_fd=fd)
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), link))
                    if not link or posixpath.isabs(link) or resolved == ".." or resolved.startswith("../"):
                        fail("link_escape")
                    links[relative] = link
                    raw_link = link.encode("utf-8")
                    digest.update(struct.pack(">I", len(raw_link)) + raw_link)
                else:
                    if st.st_nlink != 1:
                        fail("hardlink")
                    file_fd = os.open(child_name, FILE_FLAGS, dir_fd=fd)
                    try:
                        if identity(os.fstat(file_fd)) != identity(st):
                            fail("file_replaced")
                        content = hashlib.sha256()
                        size = 0
                        while True:
                            chunk = os.read(file_fd, 1024 * 1024)
                            if not chunk:
                                break
                            size += len(chunk)
                            total += len(chunk)
                            if total > MAX_BYTES:
                                fail("tree_limit")
                            content.update(chunk)
                        if identity(os.fstat(file_fd)) != identity(st) or size != st.st_size:
                            fail("file_changed")
                        digest.update(content.digest())
                    finally:
                        os.close(file_fd)
        walk(root, "", 0)
        # Resolve symlink chains using only the inventoried tree, never by
        # following a link into the host filesystem.
        def resolve_path(candidate, hops=0):
            if hops > 40 or candidate == ".." or candidate.startswith("../"):
                fail("link_cycle_or_escape")
            pieces = candidate.split("/")
            for index in range(1, len(pieces) + 1):
                prefix = "/".join(pieces[:index])
                if prefix in links:
                    replacement = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), links[prefix]))
                    remainder = "/".join(pieces[index:])
                    return resolve_path(posixpath.normpath(posixpath.join(replacement, remainder)), hops + 1)
            if candidate not in kinds:
                fail("link_target")
            return candidate
        for name, link in links.items():
            resolve_path(posixpath.normpath(posixpath.join(posixpath.dirname(name), link)))
        if digest.hexdigest() != expected:
            fail("digest")
        contents = open_dir(root, "Contents")
        try:
            plist = plistlib.loads(read_file(contents, "Info.plist", 65536))
            if plist.get("CFBundleIdentifier") != BUNDLE or plist.get("CFBundleShortVersionString") != version.split("-", 1)[0]:
                fail("bundle_identity")
            resources = open_dir(contents, "Resources")
            try:
                app_resources = open_dir(resources, "app")
                try:
                    build = json.loads(read_file(app_resources, "build-identity.json", 65536))
                finally:
                    os.close(app_resources)
                if build.get("bundleId") != BUNDLE or build.get("version") != version or build.get("buildId") != build_id:
                    fail("build_identity")
            finally:
                os.close(resources)
        finally:
            os.close(contents)
        if identity(os.fstat(root)) != identity(before):
            fail("app_replaced")
    finally:
        os.close(root)



def open_owner_state(home):
    current = home
    opened = []
    try:
        for part in ("Library", "Application Support", "Farol Next Preview", "farol-next-state"):
            child = open_dir(current, part)
            opened.append(child)
            current = child
        if os.fstat(current).st_mode & 0o077:
            fail("state_private")
        return opened.pop()
    finally:
        for fd in opened:
            os.close(fd)


def owner_lease(state):
    before = entry(state, "promotion.lease")
    if before is None or not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 or before.st_mode & 0o077:
        fail("owner_lease_type")
    fd = os.open("promotion.lease", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=state)
    if identity(os.fstat(fd)) != identity(before):
        os.close(fd)
        fail("owner_lease_replaced")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        fail("owner_lease_held")
    return fd


def verify_owner_lease(state, lease):
    current = entry(state, "promotion.lease")
    if current is None or identity(current) != identity(os.fstat(lease)):
        fail("owner_lease_lost")


def owner_record(state, name, limit):
    data = read_file(state, name, limit)
    if entry(state, name).st_mode & 0o077:
        fail("owner_record_private")
    try:
        return json.loads(data)
    except (ValueError, UnicodeError):
        fail("owner_record_invalid")


def initial_marker(state, request):
    marker = owner_record(state, "running.json", 4096)
    if not isinstance(marker, dict) or set(marker) != {"schema", "pid", "startedAt", "bootTime", "processStart"} or marker["schema"] != 1 or marker["pid"] != request["pid"] or marker["processStart"] != request["processStart"] or not isinstance(marker["startedAt"], str):
        fail("run_marker_mismatch")
    return marker["startedAt"]


def confirmed_quit(state, started_at=None):
    if entry(state, "running.json") is not None:
        fail("run_marker_present")
    receipt = owner_record(state, "last-quit.json", 8192)
    if not isinstance(receipt, dict) or set(receipt) != {"schema", "at", "drained", "unconfirmed"} or receipt["schema"] != 1 or receipt["drained"] is not True or receipt["unconfirmed"] != [] or not isinstance(receipt["at"], str):
        fail("quit_not_confirmed")
    try:
        at = datetime.datetime.fromisoformat(receipt["at"].replace("Z", "+00:00"))
        if at.tzinfo is None or (started_at is not None and at <= datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00"))):
            fail("quit_stale")
    except (ValueError, TypeError):
        fail("quit_invalid")


def process_start(pid):
    result = subprocess.run(("/bin/ps", "-p", str(pid), "-o", "lstart="), capture_output=True, text=True, timeout=3, check=False)
    if result.returncode not in (0, 1) or result.stderr:
        fail("process_unknown")
    value = result.stdout.strip()
    if value:
        return value
    try:
        os.kill(pid, 0)  # Existence probe only; never sends a signal.
    except ProcessLookupError:
        return None
    except OSError:
        fail("process_unknown")
    fail("process_unknown")


def wait_exit(pid, expected, deadline, observed=False):
    if not observed and process_start(pid) != expected:
        fail("process_identity")
    end = time.monotonic() + deadline
    while True:
        current = process_start(pid)
        if current is None:
            return
        if current != expected:
            fail("process_reused")
        if time.monotonic() >= end:
            fail("process_running")
        time.sleep(0.1)


def parse_request():
    chunks = []
    size = 0
    while size <= MAX_RECORD:
        chunk = os.read(3, min(4096, MAX_RECORD + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    raw = b"".join(chunks)
    if not raw or len(raw) > MAX_RECORD:
        fail("input")
    try:
        request = json.loads(raw)
    except (ValueError, UnicodeError):
        fail("input")
    required = {"schema", "action", "home", "operationId", "source", "target", "drain", "pid", "processStart", "waitSeconds", "relaunch"}
    if not isinstance(request, dict) or set(request) != required or request["schema"] != "farol.installed-update/1" or request["action"] not in ("apply", "recover", "rollback"):
        fail("input")
    if not isinstance(request["operationId"], str) or len(request["operationId"]) != 32 or any(c not in "0123456789abcdef" for c in request["operationId"]):
        fail("input")
    for key in ("source", "target"):
        value = request[key]
        if not isinstance(value, dict) or set(value) != {"digest", "version", "buildId"} or not isinstance(value["version"], str) or not value["version"] or not isinstance(value["buildId"], str) or not isinstance(value["digest"], str) or any(len(value[k]) != 64 or any(c not in "0123456789abcdef" for c in value[k]) for k in ("digest", "buildId")):
            fail("input")
    if request["source"] == request["target"] or request["drain"] != {"status": "reconciled", "acceptedSource": request["source"]["buildId"], "acceptedTarget": request["target"]["buildId"]}:
        fail("acceptance")
    if type(request["pid"]) is not int or request["pid"] <= 1 or not isinstance(request["processStart"], str) or not request["processStart"] or type(request["waitSeconds"]) is not int or not 1 <= request["waitSeconds"] <= 120 or type(request["relaunch"]) is not bool:
        fail("input")
    components(request["home"])
    return request


def record_for(request, phase):
    return {"schema": "farol.installed-update-journal/1", "operationId": request["operationId"], "source": request["source"], "target": request["target"], "phase": phase}


def read_phase(op, request):
    try:
        record = json.loads(read_file(op, "journal.json"))
    except (ValueError, UnicodeError):
        fail("journal_invalid")
    if not isinstance(record, dict) or set(record) != set(record_for(request, "prepared")) or any(record.get(k) != record_for(request, "prepared")[k] for k in ("schema", "operationId", "source", "target")) or record.get("phase") not in ("prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "launch_requested", "completed"):
        fail("journal_mismatch")
    return record["phase"]


def assert_parent_path(home_value, home, apps):
    live_home = open_home(home_value)
    try:
        if identity(os.fstat(live_home)) != identity(os.fstat(home)):
            fail("home_replaced")
    finally:
        os.close(live_home)
    current = open_dir(home, "Applications")
    try:
        if identity(os.fstat(current)) != identity(os.fstat(apps)):
            fail("parent_replaced")
    finally:
        os.close(current)


def rename_checked(source_fd, source_name, target_fd, target_name, expected=None):
    source = entry(source_fd, source_name)
    if source is None or not stat.S_ISDIR(source.st_mode) or (expected is not None and identity(source) != expected):
        fail("source_replaced")
    if entry(target_fd, target_name) is not None:
        fail("destination_exists")
    os.rename(source_name, target_name, src_dir_fd=source_fd, dst_dir_fd=target_fd)
    moved = entry(target_fd, target_name)
    if moved is None or identity(moved) != identity(source):
        fail("move_uncertain")
    os.fsync(source_fd)
    os.fsync(target_fd)


def reconcile(apps, op, request):
    source = request["source"]
    target = request["target"]
    phase = read_phase(op, request)
    app = entry(apps, APP)
    previous = entry(op, "previous.app")
    failed = entry(op, "failed.app")
    if phase in ("rollback_started", "rolled_back"):
        if previous is not None and app is not None and failed is None and phase == "rollback_started":
            checked_tree(op, "previous.app", source["digest"], source["version"], source["buildId"])
            checked_tree(apps, APP, target["digest"], target["version"], target["buildId"])
            return "rollback_started"
        if previous is not None and app is None and failed is not None:
            checked_tree(op, "previous.app", **{"expected": source["digest"], "version": source["version"], "build_id": source["buildId"]})
            rename_checked(op, "previous.app", apps, APP)
            write_record(op, "journal.json", record_for(request, "rolled_back"))
            return "rolled_back"
        if app is not None and previous is None and failed is not None:
            checked_tree(apps, APP, source["digest"], source["version"], source["buildId"])
            return "rolled_back"
        fail("rollback_uncertain", phase)
    if failed is not None:
        fail("failed_unexpected", phase)
    if previous is None:
        if phase == "prepared" and app is not None:
            checked_tree(apps, APP, source["digest"], source["version"], source["buildId"])
            return "prepared"
        fail("predecessor_missing", phase)
    checked_tree(op, "previous.app", source["digest"], source["version"], source["buildId"])
    if app is None:
        # The predecessor has been moved; restore it. Never guess whether the new app may launch.
        rename_checked(op, "previous.app", apps, APP)
        write_record(op, "journal.json", record_for(request, "rolled_back"))
        return "rolled_back"
    checked_tree(apps, APP, target["digest"], target["version"], target["buildId"])
    if phase in ("prepared", "predecessor_saved", "new_installed"):
        write_record(op, "journal.json", record_for(request, "verified"))
        return "verified"
    return phase


def run(request):
    home = open_home(request["home"])
    apps = None
    update = None
    op = None
    lock_fd = None
    state = None
    lease_fd = None
    try:
        apps = open_dir(home, "Applications")
        state = open_owner_state(home)
        current = home
        for part in ROOT_PARTS:
            child = ensure_dir(current, part) if request["action"] == "apply" else open_dir(current, part)
            if current != home:
                os.close(current)
            current = child
        update = current
        lock_before = entry(update, "lock")
        if lock_before is None:
            lock_fd = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=update)
            os.fsync(update)
        else:
            if not stat.S_ISREG(lock_before.st_mode) or lock_before.st_uid != os.geteuid() or lock_before.st_nlink != 1:
                fail("lock_type")
            lock_fd = os.open("lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=update)
            if identity(os.fstat(lock_fd)) != identity(lock_before):
                fail("lock_replaced")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("update_busy")
        op = ensure_dir(update, request["operationId"]) if request["action"] == "apply" else open_dir(update, request["operationId"])
        if request["action"] == "apply":
            started_at = initial_marker(state, request)
            if entry(op, "journal.json") is not None or entry(op, "previous.app") is not None or entry(op, "failed.app") is not None:
                fail("operation_exists")
            if entry(apps, APP) is None:
                fail("app_missing")
            checked_tree(apps, APP, request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            checked_tree(op, "staged.app", request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            # Establish process identity before it may exit; never infer it from an absent PID.
            if process_start(request["pid"]) != request["processStart"]:
                fail("process_identity")
            wait_exit(request["pid"], request["processStart"], request["waitSeconds"], observed=True)
            lease_fd = owner_lease(state)
            confirmed_quit(state, started_at)
            checked_tree(apps, APP, request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            checked_tree(op, "staged.app", request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            predecessor_inode = identity(entry(apps, APP))
            staged_inode = identity(entry(op, "staged.app"))
            assert_parent_path(request["home"], home, apps)
            write_record(op, "journal.json", record_for(request, "prepared"))
            verify_owner_lease(state, lease_fd)
            assert_parent_path(request["home"], home, apps)
            rename_checked(apps, APP, op, "previous.app", predecessor_inode)
            checked_tree(op, "previous.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            write_record(op, "journal.json", record_for(request, "predecessor_saved"))
            verify_owner_lease(state, lease_fd)
            assert_parent_path(request["home"], home, apps)
            rename_checked(op, "staged.app", apps, APP, staged_inode)
            write_record(op, "journal.json", record_for(request, "new_installed"))
            try:
                checked_tree(apps, APP, request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            except Refusal:
                # Only the inode just moved from our staged slot may be displaced.
                if entry(apps, APP) is None or identity(entry(apps, APP)) != staged_inode:
                    fail("target_uncertain", "new_installed")
                checked_tree(op, "previous.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
                verify_owner_lease(state, lease_fd)
                assert_parent_path(request["home"], home, apps)
                write_record(op, "journal.json", record_for(request, "rollback_started"))
                rename_checked(apps, APP, op, "failed.app", staged_inode)
                rename_checked(op, "previous.app", apps, APP, predecessor_inode)
                write_record(op, "journal.json", record_for(request, "rolled_back"))
                fail("target_verification", "rolled_back")
        elif request["action"] == "rollback":
            started_at = initial_marker(state, request)
            wait_exit(request["pid"], request["processStart"], request["waitSeconds"])
            lease_fd = owner_lease(state)
            confirmed_quit(state, started_at)
            assert_parent_path(request["home"], home, apps)
            phase = reconcile(apps, op, request)
            if phase not in ("verified", "completed", "launch_requested", "rollback_started"):
                fail("rollback_phase", phase)
            checked_tree(apps, APP, request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            checked_tree(op, "previous.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            if entry(op, "failed.app") is not None:
                fail("failed_exists")
            if phase != "rollback_started":
                write_record(op, "journal.json", record_for(request, "rollback_started"))
            verify_owner_lease(state, lease_fd)
            assert_parent_path(request["home"], home, apps)
            rename_checked(apps, APP, op, "failed.app")
        if lease_fd is None:
            lease_fd = owner_lease(state)
            confirmed_quit(state)
        verify_owner_lease(state, lease_fd)
        assert_parent_path(request["home"], home, apps)
        phase = reconcile(apps, op, request)
        if request["action"] == "apply" and phase == "verified" and request["relaunch"]:
            write_record(op, "journal.json", record_for(request, "launch_requested"))
            # One request only. A failed/unknown launch remains explicit for caller reconciliation.
            assert_parent_path(request["home"], home, apps)
            path = request["home"] + "/Applications/" + APP
            result = subprocess.run(("/usr/bin/open", "-a", path), timeout=10, check=False)
            if result.returncode != 0:
                fail("launch_failed", "launch_requested")
            write_record(op, "journal.json", record_for(request, "completed"))
            phase = "completed"
        return phase
    finally:
        for fd in (op, lock_fd, lease_fd, state, update, apps, home):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def main():
    try:
        request = parse_request()
        phase = run(request)
        print(json.dumps({"phase": phase, "operationId": request["operationId"]}))
    except Refusal as exc:
        print(json.dumps({"phase": exc.phase, "error": exc.code}))
        raise SystemExit(70)
    except BaseException:
        print(json.dumps({"phase": "unknown", "error": "internal"}))
        raise SystemExit(79)


if __name__ == "__main__":
    main()
