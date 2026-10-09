"""Bounded, checkout-independent N -> N+1 Farol app replacement.

Input is one JSON object on fd 3. Exit status is classified; stdout is one
JSON phase record. No caller-supplied filesystem path is used for mutation.
"""
import ctypes
import errno
import fcntl
import datetime
import hashlib
import json
import os
import plistlib
import posixpath
import select
import stat
import struct
import subprocess
import sys
import time

APP = "Farol.app"
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


def inode_matches(st, expected):
    return str(st.st_dev) == expected["device"] and str(st.st_ino) == expected["inode"]


def valid_inode(value):
    return isinstance(value, dict) and set(value) == {"device", "inode"} and all(
        isinstance(part, str) and 1 <= len(part) <= 30 and part.isascii() and part.isdigit()
        and (part == "0" or not part.startswith("0")) for part in value.values())


def verify_inherited_lease(home, state, request, lease):
    # Reopen the canonical state route, not just a possibly detached directory.
    current_home = open_home(request["home"])
    current_state = None
    try:
        if identity(os.fstat(home)) != identity(os.fstat(current_home)):
            fail("closed_state_changed")
        current_state = open_owner_state(current_home)
        named = os.fstat(current_state)
        held = os.fstat(state)
        if identity(named) != identity(held) or named.st_nlink != held.st_nlink or stat.S_IMODE(named.st_mode) != 0o700 or not inode_matches(held, request["predecessor"]["stateIdentity"]):
            fail("closed_state_changed")
        before = entry(state, "promotion.lease")
        inherited = os.fstat(lease)
        if before is None or not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 or stat.S_IMODE(before.st_mode) != 0o600 or inherited.st_nlink != 1 or identity(before) != identity(inherited) or not inode_matches(inherited, request["leaseIdentity"]):
            fail("inherited_lease_identity")
        if fcntl.fcntl(lease, fcntl.F_GETFL) & os.O_ACCMODE != os.O_RDWR:
            fail("inherited_lease_access")
        # The trusted producer keeps its exact descriptor locked until the ACK.
        # First refuse an unlocked/shared lock using an independent description;
        # then the idempotent exclusive check rejects a crossed description.
        # Never unlock: parent and child share this same flock after inheritance.
        probe = os.open("promotion.lease", FILE_FLAGS, dir_fd=state)
        try:
            if identity(os.fstat(probe)) != identity(inherited):
                fail("inherited_lease_identity")
            try:
                fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fail("inherited_lease_unheld")
        finally:
            os.close(probe)
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("inherited_lease_crossed")
        current = entry(state, "promotion.lease")
        if current is None or current.st_nlink != 1 or identity(current) != identity(inherited):
            fail("inherited_lease_identity")
    finally:
        if current_state is not None:
            os.close(current_state)
        os.close(current_home)


def confirmed_closed(state, request):
    if process_start(request["pid"]) is not None:
        fail("closed_process_running")
    if entry(state, "running.json") is not None:
        fail("run_marker_present")
    before = entry(state, "last-quit.json")
    data = read_file(state, "last-quit.json", 8192)
    after = entry(state, "last-quit.json")
    if before is None or after is None or before.st_mode & 0o077 or after.st_nlink != 1 or identity(before) != identity(after) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        fail("closed_quit_changed")
    if hashlib.sha256(data).hexdigest() != request["predecessor"]["lastQuitSha256"]:
        fail("closed_quit_digest")
    try:
        receipt = json.loads(data)
        if not isinstance(receipt, dict) or set(receipt) != {"schema", "at", "drained", "unconfirmed"} or type(receipt["schema"]) is not int or receipt["schema"] != 1 or receipt["drained"] is not True or receipt["unconfirmed"] != [] or not isinstance(receipt["at"], str):
            fail("quit_not_confirmed")
        at = datetime.datetime.fromisoformat(receipt["at"].replace("Z", "+00:00"))
        started = datetime.datetime.fromisoformat(request["predecessor"]["startedAt"].replace("Z", "+00:00"))
        if at.tzinfo is None or started.tzinfo is None or at <= started or at > datetime.datetime.now(datetime.timezone.utc):
            fail("quit_stale")
    except (ValueError, TypeError):
        fail("quit_invalid")


def correlation(request):
    value = {key: request[key] for key in ("operationId", "action", "source", "target", "pid", "processStart")}
    if "predecessor" in request:
        value.update(predecessor=request["predecessor"], leaseIdentity=request["leaseIdentity"])
    return value


def continue_channel():
    channel = os.fstat(6)
    if not (stat.S_ISFIFO(channel.st_mode) or stat.S_ISSOCK(channel.st_mode)):
        fail("continue_channel")


def await_continue(request):
    continue_channel()
    os.set_blocking(6, False)
    deadline = time.monotonic() + request["waitSeconds"]
    data = bytearray()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([6], [], [], remaining)[0]:
                fail("continue_timeout")
            chunk = os.read(6, min(4096, 4097 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 4096:
                fail("continue_size")
        try:
            frame = json.loads(data)
        except (ValueError, UnicodeError):
            fail("continue_invalid")
        if frame != {"schema": "farol.installed-update-continue/1", **correlation(request)}:
            fail("continue_identity")
    finally:
        os.close(6)



_handoff_sent = False


def emit_handoff(request, phase, error=None):
    """One bounded event on the launcher-owned private fd; EOF seals the frame."""
    global _handoff_sent
    if _handoff_sent:
        fail("handoff_duplicate")
    channel = os.fstat(4)
    if not (stat.S_ISFIFO(channel.st_mode) or stat.S_ISSOCK(channel.st_mode)):
        fail("handoff_channel")
    event = {
        "schema": "farol.installed-update-handoff/1",
        "phase": phase,
        **correlation(request),
    }
    if error is not None:
        event["error"] = error
    data = (json.dumps(event, separators=(",", ":")) + "\n").encode()
    if len(data) > 4096:
        fail("handoff_size")
    os.set_blocking(4, False)
    offset = 0
    while offset < len(data):
        written = os.write(4, data[offset:])
        if written <= 0:
            fail("handoff_write")
        offset += written
    _handoff_sent = True
    os.close(4)

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
    if isinstance(request, dict) and "predecessor" in request:
        required.update(("predecessor", "leaseIdentity"))
        proof = request["predecessor"]
        if request.get("action") not in ("apply", "rollback") or (request.get("action") == "rollback" and request.get("relaunch") is not False) or not isinstance(proof, dict) or set(proof) != {"kind", "startedAt", "lastQuitSha256", "stateIdentity"} or proof["kind"] != "confirmed_closed" or not isinstance(proof["startedAt"], str) or not 1 <= len(proof["startedAt"]) <= 64 or not isinstance(proof["lastQuitSha256"], str) or len(proof["lastQuitSha256"]) != 64 or any(c not in "0123456789abcdef" for c in proof["lastQuitSha256"]) or not valid_inode(proof["stateIdentity"]) or not valid_inode(request.get("leaseIdentity")):
            fail("input")
    if not isinstance(request, dict) or set(request) != required or request["schema"] != "farol.installed-update/1" or request["action"] not in ("apply", "recover", "rollback"):
        fail("input")
    if not isinstance(request["operationId"], str) or len(request["operationId"]) != 32 or any(c not in "0123456789abcdef" for c in request["operationId"]):
        fail("input")
    for key in ("source", "target"):
        value = request[key]
        if not isinstance(value, dict) or set(value) != {"digest", "version", "buildId"} or not isinstance(value["version"], str) or not 1 <= len(value["version"]) <= 128 or not isinstance(value["buildId"], str) or not isinstance(value["digest"], str) or any(len(value[k]) != 64 or any(c not in "0123456789abcdef" for c in value[k]) for k in ("digest", "buildId")):
            fail("input")
    if request["source"] == request["target"] or request["drain"] != {"status": "reconciled", "acceptedSource": request["source"]["buildId"], "acceptedTarget": request["target"]["buildId"]}:
        fail("acceptance")
    if type(request["pid"]) is not int or request["pid"] <= 1 or not isinstance(request["processStart"], str) or not 1 <= len(request["processStart"]) <= 128 or type(request["waitSeconds"]) is not int or not 1 <= request["waitSeconds"] <= 120 or type(request["relaunch"]) is not bool:
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
    phases = ("prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "cancelled", "launch_requested", "completed", "cancel_launch_requested", "cancel_completed", "rollback_launch_requested", "rollback_completed")
    if not isinstance(record, dict) or set(record) != set(record_for(request, "prepared")) or any(record.get(k) != record_for(request, "prepared")[k] for k in ("schema", "operationId", "source", "target")) or record.get("phase") not in phases:
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


def exchange_checked(left_fd, left_name, right_fd, right_name, left_expected, right_expected):
    """Swap two pinned directories in one Darwin namespace operation."""
    left = entry(left_fd, left_name)
    right = entry(right_fd, right_name)
    if (left is None or right is None or not stat.S_ISDIR(left.st_mode)
            or not stat.S_ISDIR(right.st_mode) or left.st_uid != os.geteuid()
            or right.st_uid != os.geteuid() or identity(left) != left_expected
            or identity(right) != right_expected):
        fail("exchange_precondition")
    if sys.platform != "darwin":
        fail("exchange_unsupported")
    renameatx = ctypes.CDLL(None, use_errno=True).renameatx_np
    renameatx.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    renameatx.restype = ctypes.c_int
    # RENAME_SWAP from Darwin sys/stdio.h. Both entries must exist; no fixed-slot gap.
    if renameatx(left_fd, os.fsencode(left_name), right_fd, os.fsencode(right_name), 0x00000002) != 0:
        error = ctypes.get_errno()
        if error in (errno.ENOSYS, errno.ENOTSUP, errno.EXDEV, errno.EINVAL):
            fail("exchange_unsupported")
        fail("exchange_uncertain")
    moved_left = entry(left_fd, left_name)
    moved_right = entry(right_fd, right_name)
    if (moved_left is None or moved_right is None
            or identity(moved_left) != right_expected
            or identity(moved_right) != left_expected):
        fail("exchange_uncertain")
    os.fsync(left_fd)
    os.fsync(right_fd)


def matches_tree(parent, name, build):
    try:
        checked_tree(parent, name, build["digest"], build["version"], build["buildId"])
        return True
    except Refusal:
        return False


def require_predecessor_state(request):
    # Strict 0.1 and beta3 readers reject current settings/retained records.
    # No app+state downgrade is qualified for either predecessor.
    # Refuse before restoring its app; never launch it against newer settings.
    # This is not a compatibility claim for other release transitions.
    source = request["source"]["version"]
    target = request["target"]["version"]
    if ((source.startswith("0.1.") and not target.startswith("0.1."))
            or source == "0.2.0-owner.beta.3"):
        fail("predecessor_state_unqualified")


def inspect_recovery(apps, op, request):
    """Read-only proof of an exact pair before a live-app Quit handoff."""
    phase = read_phase(op, request)
    app = entry(apps, APP)
    staged = entry(op, "staged.app")
    previous = entry(op, "previous.app")
    failed = entry(op, "failed.app")
    source = request["source"]
    target = request["target"]
    if app is None:
        fail("recovery_pair", phase)
    if phase in ("prepared", "cancelled", "cancel_launch_requested", "cancel_completed") and previous is None and failed is None and staged is not None:
        if ((matches_tree(apps, APP, source) and matches_tree(op, "staged.app", target))
                or (phase == "prepared" and matches_tree(apps, APP, target) and matches_tree(op, "staged.app", source))):
            return
    if phase in ("prepared", "predecessor_saved", "new_installed", "verified", "launch_requested", "completed", "rollback_started") and previous is not None and staged is None and failed is None:
        if matches_tree(apps, APP, target) and matches_tree(op, "previous.app", source):
            return
        if phase == "rollback_started" and matches_tree(apps, APP, source) and matches_tree(op, "previous.app", target):
            return
    if phase in ("rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed") and previous is None and staged is None and failed is not None:
        if matches_tree(apps, APP, source) and stat.S_ISDIR(failed.st_mode) and failed.st_uid == os.geteuid():
            return
    fail("recovery_pair", phase)


def reconcile(apps, op, request, fence):
    source = request["source"]
    target = request["target"]
    phase = read_phase(op, request)
    app = entry(apps, APP)
    previous = entry(op, "previous.app")
    failed = entry(op, "failed.app")
    staged = entry(op, "staged.app")
    if phase in ("rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed"):
        if staged is not None:
            fail("rollback_uncertain", phase)
        if phase == "rollback_started" and app is not None and previous is not None and failed is None:
            if matches_tree(apps, APP, target) and matches_tree(op, "previous.app", source):
                # Exact pre-exchange pair: finish the journaled rollback once.
                require_predecessor_state(request)
                fence()
                exchange_checked(apps, APP, op, "previous.app", identity(app), identity(previous))
            # Post-exchange pair must also match both accepted digests. A crash
            # with rejected target bytes has no durable inode binding to move.
            checked_tree(apps, APP, source["digest"], source["version"], source["buildId"])
            checked_tree(op, "previous.app", target["digest"], target["version"], target["buildId"])
            fence()
            rename_checked(op, "previous.app", op, "failed.app", identity(entry(op, "previous.app")))
            write_record(op, "journal.json", record_for(request, "rolled_back"))
            return "rolled_back"
        if previous is not None and app is None and failed is not None and phase == "rollback_started":
            # An older journal may have crashed in the former two-rename gap.
            checked_tree(op, "previous.app", source["digest"], source["version"], source["buildId"])
            require_predecessor_state(request)
            fence()
            rename_checked(op, "previous.app", apps, APP, identity(previous))
            write_record(op, "journal.json", record_for(request, "rolled_back"))
            return "rolled_back"
        if app is not None and previous is None and failed is not None:
            checked_tree(apps, APP, source["digest"], source["version"], source["buildId"])
            # Failed bytes may be the target rejected by post-swap verification.
            if not stat.S_ISDIR(failed.st_mode) or failed.st_uid != os.geteuid():
                fail("failed_type", phase)
            if phase == "rollback_started":
                fence()
                write_record(op, "journal.json", record_for(request, "rolled_back"))
                return "rolled_back"
            return phase
        fail("rollback_uncertain", phase)
    if failed is not None:
        fail("failed_unexpected", phase)
    if phase in ("prepared", "cancelled", "cancel_launch_requested", "cancel_completed") and previous is None:
        if app is not None and staged is not None:
            if matches_tree(apps, APP, source) and matches_tree(op, "staged.app", target):
                # The exchange has not happened; do not start it in recovery.
                if phase == "prepared":
                    fence()
                    write_record(op, "journal.json", record_for(request, "cancelled"))
                    return "cancelled"
                return phase
            if phase == "prepared":
                # The atomic exchange happened, but predecessor was not named yet.
                checked_tree(apps, APP, target["digest"], target["version"], target["buildId"])
                checked_tree(op, "staged.app", source["digest"], source["version"], source["buildId"])
                fence()
                rename_checked(op, "staged.app", op, "previous.app", identity(staged))
                write_record(op, "journal.json", record_for(request, "verified"))
                return "verified"
        fail("predecessor_missing", phase)
    if previous is None:
        fail("predecessor_missing", phase)
    checked_tree(op, "previous.app", source["digest"], source["version"], source["buildId"])
    if app is None:
        if phase in ("prepared", "predecessor_saved") and staged is not None:
            # Repair only a pre-existing journal from the former two-rename protocol.
            checked_tree(op, "staged.app", target["digest"], target["version"], target["buildId"])
            require_predecessor_state(request)
            fence()
            rename_checked(op, "previous.app", apps, APP, identity(previous))
            write_record(op, "journal.json", record_for(request, "rolled_back"))
            return "rolled_back"
        fail("app_missing", phase)
    if staged is not None:
        fail("staged_unexpected", phase)
    checked_tree(apps, APP, target["digest"], target["version"], target["buildId"])
    if phase in ("prepared", "predecessor_saved", "new_installed"):
        fence()
        write_record(op, "journal.json", record_for(request, "verified"))
        return "verified"
    return phase


def update_lock(update):
    before = entry(update, "lock")
    if before is None:
        fd = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=update)
        os.fsync(update)
    else:
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1:
            fail("lock_type")
        fd = os.open("lock", os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=update)
        if identity(os.fstat(fd)) != identity(before):
            os.close(fd)
            fail("lock_replaced")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        fail("update_busy")
    return fd


def verify_staging_route(home, update, op, request):
    current = home
    opened = []
    try:
        for part in ROOT_PARTS:
            current = open_dir(current, part)
            opened.append(current)
        if identity(os.fstat(current)) != identity(os.fstat(update)):
            fail("closed_staging_changed")
        current = open_dir(current, request["operationId"])
        opened.append(current)
        if identity(os.fstat(current)) != identity(os.fstat(op)):
            fail("closed_staging_changed")
    finally:
        for fd in opened:
            os.close(fd)


def closed_rollback_pair(apps, op, request):
    """Pin a settled journal and exact target/previous pair; never reconcile here."""
    before = entry(op, "journal.json")
    phase = read_phase(op, request)
    if phase not in ("verified", "completed"):
        fail("rollback_phase", phase)
    data = read_file(op, "journal.json")
    after = entry(op, "journal.json")
    if before is None or after is None or identity(before) != identity(after) or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        fail("closed_rollback_journal_changed")
    try:
        if json.loads(data) != record_for(request, phase):
            fail("journal_mismatch")
    except (ValueError, UnicodeError):
        fail("journal_invalid")
    if any(entry(op, name) is not None for name in ("staged.app", "failed.app", "rejected-target.json")):
        fail("closed_rollback_pair")
    pair = []
    for parent, name, build in ((apps, APP, request["target"]), (op, "previous.app", request["source"])):
        named = entry(parent, name)
        checked_tree(parent, name, build["digest"], build["version"], build["buildId"])
        current = entry(parent, name)
        if named is None or current is None or identity(named) != identity(current):
            fail("closed_rollback_pair_changed")
        pair.append(identity(current))
    current_journal = entry(op, "journal.json")
    if current_journal is None or identity(current_journal) != identity(after) or (current_journal.st_size, current_journal.st_mtime_ns, current_journal.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        fail("closed_rollback_journal_changed")
    if any(entry(op, name) is not None for name in ("staged.app", "failed.app", "rejected-target.json")):
        fail("closed_rollback_pair")
    for (parent, name), expected in zip(((apps, APP), (op, "previous.app")), pair):
        current = entry(parent, name)
        if current is None or identity(current) != expected:
            fail("closed_rollback_pair_changed")
    journal = (identity(after), after.st_size, after.st_mtime_ns, after.st_ctime_ns, hashlib.sha256(data).hexdigest())
    return (phase, journal, *pair)


def relaunch_arguments(request, completion):
    """Correlate this single launch while the existing owner lease remains held.

    The target observes this exact helper's completion before its first startup
    acquisition. Ordinary uncorrelated launches still refuse a busy promotion.
    No path or authority is supplied by the startup hint.
    """
    # A restored source may predate the startup lease/correlation protocol.
    # Never launch it from a helper that still owns the promotion lease.
    if completion != "completed":
        fail("launch_phase")
    helper_pid = os.getpid()
    helper_start = process_start(helper_pid)
    if helper_start is None:
        fail("launch_helper_identity")
    build = request["target"]
    hint = json.dumps({
        "operationId": request["operationId"],
        "action": request["action"],
        "phase": completion,
        "helper": {"pid": helper_pid, "processStart": helper_start},
        "buildId": build["buildId"],
    }, separators=(",", ":"))
    if len(hint.encode("utf-8")) > 2048:
        fail("launch_hint_bound")
    return ("/usr/bin/open", "-a", request["home"] + "/Applications/" + APP,
            "--args", "--farol-installed-update-relaunch=" + hint)


def run(request):
    if "predecessor" in request and (request["action"] not in ("apply", "rollback") or (request["action"] == "rollback" and request["relaunch"] is not False)):
        fail("input")
    if request["action"] == "rollback":
        require_predecessor_state(request)
    home = open_home(request["home"])
    apps = None
    update = None
    op = None
    lock_fd = None
    state = None
    lease_fd = None
    closed = "predecessor" in request
    def fence():
        if lease_fd is None:
            fail("owner_lease_lost")
        if closed:
            verify_inherited_lease(home, state, request, lease_fd)
            verify_staging_route(home, update, op, request)
        else:
            verify_owner_lease(state, lease_fd)
        assert_parent_path(request["home"], home, apps)
    try:
        apps = open_dir(home, "Applications")
        state = open_owner_state(home)
        if closed:
            lease_fd = 5
            os.set_inheritable(lease_fd, False)
            verify_inherited_lease(home, state, request, lease_fd)
            confirmed_closed(state, request)
        current = home
        for part in ROOT_PARTS:
            child = ensure_dir(current, part) if request["action"] == "apply" and not closed else open_dir(current, part)
            if current != home:
                os.close(current)
            current = child
        update = current
        if not closed:
            lock_fd = update_lock(update)
        op = ensure_dir(update, request["operationId"]) if request["action"] == "apply" and not closed else open_dir(update, request["operationId"])
        if request["action"] == "apply":
            started_at = None if closed else initial_marker(state, request)
            if entry(op, "journal.json") is not None or entry(op, "previous.app") is not None or entry(op, "failed.app") is not None:
                fail("operation_exists")
            if entry(apps, APP) is None:
                fail("app_missing")
            checked_tree(apps, APP, request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            checked_tree(op, "staged.app", request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            if closed:
                fence()
                confirmed_closed(state, request)
                continue_channel()
                emit_handoff(request, "closed_predecessor_ready")
                await_continue(request)
                fence()
                confirmed_closed(state, request)
                # No journal, app mutation or relaunch is possible before the
                # parent closes its reference and sends this exact continuation.
                lock_fd = update_lock(update)
            else:
                # Establish process identity before it may exit; never infer it from an absent PID.
                if process_start(request["pid"]) != request["processStart"]:
                    fail("process_identity")
                emit_handoff(request, "waiting_for_exit")
                wait_exit(request["pid"], request["processStart"], request["waitSeconds"], observed=True)
                lease_fd = owner_lease(state)
                confirmed_quit(state, started_at)
            checked_tree(apps, APP, request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            checked_tree(op, "staged.app", request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
            predecessor_inode = identity(entry(apps, APP))
            staged_inode = identity(entry(op, "staged.app"))
            if closed:
                fence()
                confirmed_closed(state, request)
                if any(entry(op, name) is not None for name in ("journal.json", "previous.app", "failed.app")):
                    fail("operation_exists")
            assert_parent_path(request["home"], home, apps)
            write_record(op, "journal.json", record_for(request, "prepared"))
            verify_owner_lease(state, lease_fd)
            assert_parent_path(request["home"], home, apps)
            exchange_checked(apps, APP, op, "staged.app", predecessor_inode, staged_inode)
            checked_tree(op, "staged.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
            fence()
            rename_checked(op, "staged.app", op, "previous.app", predecessor_inode)
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
                fence()
                exchange_checked(apps, APP, op, "previous.app", staged_inode, predecessor_inode)
                fence()
                rename_checked(op, "previous.app", op, "failed.app", staged_inode)
                rejected = entry(op, "failed.app")
                if rejected is None or identity(rejected) != staged_inode:
                    fail("target_uncertain", "rollback_started")
                # Rejected bytes cannot attest as the accepted target. Bind the
                # quarantined directory before declaring this rollback terminal.
                write_record(op, "rejected-target.json", {
                    "schema": "farol.rejected-update-target/1",
                    "operationId": request["operationId"],
                    "source": request["source"], "target": request["target"],
                    "directoryIdentity": {"device": str(rejected.st_dev), "inode": str(rejected.st_ino)},
                })
                write_record(op, "journal.json", record_for(request, "rolled_back"))
                fail("target_verification", "rolled_back")
        elif request["action"] == "rollback":
            if closed:
                # The proof belongs to the current target process, never the old
                # source. Admission cannot settle an uncertain launch or journal.
                fence()
                confirmed_closed(state, request)
                pair = closed_rollback_pair(apps, op, request)
                continue_channel()
                emit_handoff(request, "closed_predecessor_ready")
                await_continue(request)
                fence()
                confirmed_closed(state, request)
                lock_fd = update_lock(update)
                if closed_rollback_pair(apps, op, request) != pair:
                    fail("closed_rollback_pair_changed")
                fence()
                confirmed_closed(state, request)
                target_inode, predecessor_inode = pair[2:]
            else:
                started_at = initial_marker(state, request)
                if read_phase(op, request) not in ("verified", "completed", "launch_requested"):
                    fail("rollback_phase")
                checked_tree(apps, APP, request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
                checked_tree(op, "previous.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
                if entry(op, "failed.app") is not None:
                    fail("failed_exists")
                if process_start(request["pid"]) != request["processStart"]:
                    fail("process_identity")
                emit_handoff(request, "waiting_for_exit")
                wait_exit(request["pid"], request["processStart"], request["waitSeconds"], observed=True)
                lease_fd = owner_lease(state)
                confirmed_quit(state, started_at)
                assert_parent_path(request["home"], home, apps)
                phase = reconcile(apps, op, request, fence)
                if phase not in ("verified", "completed", "launch_requested"):
                    fail("rollback_phase", phase)
                checked_tree(apps, APP, request["target"]["digest"], request["target"]["version"], request["target"]["buildId"])
                checked_tree(op, "previous.app", request["source"]["digest"], request["source"]["version"], request["source"]["buildId"])
                if entry(op, "failed.app") is not None:
                    fail("failed_exists")
            write_record(op, "journal.json", record_for(request, "rollback_started"))
            if closed:
                fence()
                confirmed_closed(state, request)
                exchange_checked(apps, APP, op, "previous.app", target_inode, predecessor_inode)
                fence()
                confirmed_closed(state, request)
                rename_checked(op, "previous.app", op, "failed.app", target_inode)
            else:
                verify_owner_lease(state, lease_fd)
                assert_parent_path(request["home"], home, apps)
                exchange_checked(apps, APP, op, "previous.app", identity(entry(apps, APP)), identity(entry(op, "previous.app")))
                fence()
                rename_checked(op, "previous.app", op, "failed.app", identity(entry(op, "previous.app")))
        elif request["action"] == "recover" and request["relaunch"]:
            started_at = initial_marker(state, request)
            assert_parent_path(request["home"], home, apps)
            inspect_recovery(apps, op, request)
            if process_start(request["pid"]) != request["processStart"]:
                fail("process_identity")
            emit_handoff(request, "waiting_for_exit")
            wait_exit(request["pid"], request["processStart"], request["waitSeconds"], observed=True)
            lease_fd = owner_lease(state)
            confirmed_quit(state, started_at)
        if lease_fd is None:
            lease_fd = owner_lease(state)
            confirmed_quit(state)
        verify_owner_lease(state, lease_fd)
        assert_parent_path(request["home"], home, apps)
        phase = reconcile(apps, op, request, fence)
        # Only the verified new target participates in correlated startup.
        # Cancellation/rollback keeps the predecessor closed, including older
        # binaries that would ignore our startup hint and promotion lease.
        # Their durable terminal remains cancelled/rolled_back; historical
        # launch-requested records are still observational and never retried.
        if request["relaunch"] and phase == "verified":
            launch_requested, completed = "launch_requested", "completed"
            fence()
            write_record(op, "journal.json", record_for(request, launch_requested))
            # One request only. A failed/unknown launch remains explicit for caller reconciliation.
            assert_parent_path(request["home"], home, apps)
            result = subprocess.run(relaunch_arguments(request, completed), timeout=10, check=False)
            if result.returncode != 0:
                fail("launch_failed", launch_requested)
            write_record(op, "journal.json", record_for(request, completed))
            phase = completed
        return phase
    finally:
        for fd in (op, lock_fd, lease_fd, state, update, apps, home):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def emit_terminal(result):
    # The app may already have exited and closed its observation pipe. That is
    # expected after readiness; losing the observer must not undo a journaled result.
    data = (json.dumps(result) + "\n").encode()
    try:
        os.set_blocking(1, False)
        offset = 0
        while offset < len(data):
            written = os.write(1, data[offset:])
            if written <= 0:
                return
            offset += written
    except OSError:
        pass


def main():
    request = None
    try:
        request = parse_request()
        phase = run(request)
        emit_terminal({"phase": phase, "operationId": request["operationId"]})
    except Refusal as exc:
        if request is not None and not _handoff_sent:
            try:
                emit_handoff(request, "refused", exc.code)
            except (OSError, Refusal):
                pass
        result = {"phase": exc.phase, "error": exc.code}
        if request is not None:
            result["operationId"] = request["operationId"]
        emit_terminal(result)
        raise SystemExit(70)
    except BaseException:
        result = {"phase": "unknown", "error": "internal"}
        if request is not None:
            result["operationId"] = request["operationId"]
        emit_terminal(result)
        raise SystemExit(79)


if __name__ == "__main__":
    main()
