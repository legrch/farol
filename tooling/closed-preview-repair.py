"""Cold repair only. Executed as hash-pinned stdin bytes, never a file import.

Descriptor copy/digest encoding is shared by design with promotion-apply.py.
All mutations are relative to checked directory descriptors. No deletion,
profile copy, fence removal, helper replay, relaunch or network operation.
"""
import ctypes
import datetime
import errno
import fcntl
import hashlib
import json
import os
import plistlib
import posixpath
import re
import stat
import struct
import sys

APP_NAME = "Farol Next Preview.app"
NORMAL_RECEIPT = APP_NAME + ".receipt.json"
REPAIR_RECEIPT = APP_NAME + ".repair.json"
JOURNAL = ".farol-closed-repair.json"
SCHEMA = "farol.next.closed-repair/1"
MAX_ENTRIES = 100_000
MAX_BYTES = 1024 * 1024 * 1024
MAX_DEPTH = 128
TREE_DIGEST_VERSION = "farol.next.tree-digest/v2"
KIND_CODES = {"file": b"f", "directory": b"d", "symlink": b"l"}
EXIT_INVALID = "INPUT_INVALID"
EXIT_PATH = "PATH_UNSAFE"
EXIT_COPY = "COPY_UNCONFIRMED"
EXIT_DIGEST = "DIGEST_INVALID"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

class Refusal(Exception):
    pass

def refuse(code):
    raise Refusal(code)

def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                refuse(EXIT_INVALID)
            result[key] = value
        return result
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        refuse(EXIT_INVALID)

def shape(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys.split()):
        refuse(EXIT_INVALID)

def hex_value(value, length):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{%s}" % length, value):
        refuse(EXIT_INVALID)

def canonical_at(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value):
        refuse(EXIT_INVALID)
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        refuse(EXIT_INVALID)

def read_request():
    raw = bytearray()
    while len(raw) <= 65536:
        chunk = os.read(3, min(8192, 65537 - len(raw)))
        if not chunk:
            break
        raw.extend(chunk)
    if not raw or len(raw) > 65536:
        refuse(EXIT_INVALID)
    request = strict_json(raw)
    shape(request, "schema home candidate action expectedPredecessor operationId target sourceCommit sourceTreeDigest quitDigest hook")
    if request["schema"] != SCHEMA or request["action"] not in ("apply", "rollback"):
        refuse(EXIT_INVALID)
    if request["hook"] not in (None, "parent_opened", "copy_intent", "staged", "swap_intent", "swapped", "save_intent", "saved", "quarantine_intent", "quarantined", "receipt_intent", "receipt_published", "rollback_intent", "rollback_swapped", "rollback_receipt_published"):
        refuse(EXIT_INVALID)
    hex_value(request["quitDigest"], 64)
    if request["action"] == "apply":
        hex_value(request["expectedPredecessor"], 64)
        validate_build(request["target"])
        hex_value(request["sourceCommit"], 40)
        hex_value(request["sourceTreeDigest"], 64)
        if request["operationId"] is not None:
            hex_value(request["operationId"], 32)
        components(request["candidate"])
    else:
        hex_value(request["operationId"], 32)
        if any(request[key] is not None for key in ("candidate", "expectedPredecessor", "target", "sourceCommit", "sourceTreeDigest")):
            refuse(EXIT_INVALID)
    components(request["home"])
    return request

def components(value):
    if (
        not isinstance(value, str)
        or not value.startswith("/")
        or value == "/"
        or "\x00" in value
        or "\\" in value
        or os.path.normpath(value) != value
    ):
        refuse(EXIT_INVALID)
    parts = value.split("/")[1:]
    if not parts or len(parts) > 256:
        refuse(EXIT_INVALID)
    for part in parts:
        if part in ("", ".", "..") or len(os.fsencode(part)) > 255:
            refuse(EXIT_INVALID)
    return parts


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


def open_directory(parent_fd, name):
    try:
        listed = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        refuse(EXIT_PATH)
    if not stat.S_ISDIR(listed.st_mode) or stat.S_ISLNK(listed.st_mode):
        refuse(EXIT_PATH)
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_fd)
    except OSError:
        refuse(EXIT_PATH)
    try:
        opened = os.fstat(descriptor)
        if identity(opened) != identity(listed) or not stat.S_ISDIR(opened.st_mode):
            refuse(EXIT_PATH)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def require_safe_directory(info, *, final):
    effective_user = os.geteuid()
    allowed_owners = (effective_user,) if final else (0, effective_user)
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid not in allowed_owners
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        refuse(EXIT_PATH)


def open_absolute_directory(value, *, final_owner=True):
    parts = components(value)
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        require_safe_directory(os.fstat(descriptor), final=False)
        for index, part in enumerate(parts):
            child = open_directory(descriptor, part)
            os.close(descriptor)
            descriptor = child
            require_safe_directory(
                os.fstat(descriptor),
                final=final_owner and index == len(parts) - 1,
            )
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def checked_name(name):
    if (
        not isinstance(name, str)
        or name in ("", ".", "..")
        or "/" in name
        or "\x00" in name
        or len(os.fsencode(name)) > 255
    ):
        refuse(EXIT_COPY)
    return name


def sorted_names(descriptor, state=None):
    budget = state if state is not None else {"entries": 0}
    names = []
    try:
        with os.scandir(descriptor) as entries:
            for entry in entries:
                bump_entry(budget)
                names.append(checked_name(entry.name))
    except OSError:
        refuse(EXIT_COPY)
    return sorted(names, key=lambda item: item.encode("utf-16-be", "surrogatepass"))


def bump_entry(state):
    state["entries"] += 1
    if state["entries"] > MAX_ENTRIES:
        refuse(EXIT_COPY)


def copy_file(source_fd, destination_fd, name, listed, state):
    if listed.st_nlink != 1:
        refuse(EXIT_COPY)
    try:
        reader = os.open(name, FILE_FLAGS, dir_fd=source_fd)
    except OSError:
        refuse(EXIT_COPY)
    writer = None
    try:
        opened = os.fstat(reader)
        if identity(opened) != identity(listed) or opened.st_nlink != 1:
            refuse(EXIT_COPY)
        writer = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=destination_fd,
        )
        while True:
            chunk = os.read(reader, 1024 * 1024)
            if not chunk:
                break
            state["bytes"] += len(chunk)
            if state["bytes"] > MAX_BYTES:
                refuse(EXIT_COPY)
            offset = 0
            while offset < len(chunk):
                written = os.write(writer, chunk[offset:])
                if written <= 0:
                    refuse(EXIT_COPY)
                offset += written
        after = os.fstat(reader)
        if identity(after) != identity(opened) or after.st_size != opened.st_size:
            refuse(EXIT_COPY)
        os.fchmod(writer, stat.S_IMODE(listed.st_mode))
        os.fsync(writer)
    except OSError:
        refuse(EXIT_COPY)
    finally:
        if writer is not None:
            os.close(writer)
        os.close(reader)


def copy_tree(source_fd, destination_fd, state, depth=0):
    if depth > MAX_DEPTH:
        refuse(EXIT_COPY)
    for name in sorted_names(source_fd, state):
        try:
            listed = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        except OSError:
            refuse(EXIT_COPY)
        mode = stat.S_IMODE(listed.st_mode)
        if stat.S_ISDIR(listed.st_mode):
            try:
                os.mkdir(name, 0o700, dir_fd=destination_fd)
            except OSError:
                refuse(EXIT_COPY)
            source_child = open_directory(source_fd, name)
            destination_child = open_directory(destination_fd, name)
            try:
                copy_tree(source_child, destination_child, state, depth + 1)
                os.fchmod(destination_child, mode)
                os.fsync(destination_child)
            finally:
                os.close(destination_child)
                os.close(source_child)
        elif stat.S_ISREG(listed.st_mode):
            copy_file(source_fd, destination_fd, name, listed, state)
        elif stat.S_ISLNK(listed.st_mode):
            try:
                target = os.readlink(name, dir_fd=source_fd)
            except OSError:
                refuse(EXIT_COPY)
            if (
                not target
                or os.path.isabs(target)
                or "\x00" in target
                or len(os.fsencode(target)) > 4096
            ):
                refuse(EXIT_COPY)
            try:
                os.symlink(target, name, dir_fd=destination_fd)
            except OSError:
                refuse(EXIT_COPY)
        else:
            refuse(EXIT_COPY)


def length_prefixed(value):
    encoded = value.encode("utf-8")
    return struct.pack(">I", len(encoded)) + encoded


def assert_contained_link(relative, target):
    if not target or posixpath.isabs(target) or "\x00" in target:
        refuse(EXIT_DIGEST)
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
    if resolved == ".." or resolved.startswith("../"):
        refuse(EXIT_DIGEST)


def digest_file(descriptor, listed, state):
    if listed.st_nlink != 1:
        refuse(EXIT_DIGEST)
    before = os.fstat(descriptor)
    if identity(before) != identity(listed) or before.st_nlink != 1:
        refuse(EXIT_DIGEST)
    content = hashlib.sha256()
    read_bytes = 0
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        read_bytes += len(chunk)
        state["bytes"] += len(chunk)
        if state["bytes"] > MAX_BYTES:
            refuse(EXIT_DIGEST)
        content.update(chunk)
    after = os.fstat(descriptor)
    if identity(after) != identity(before) or after.st_size != read_bytes:
        refuse(EXIT_DIGEST)
    return content.digest()


def digest_tree(directory_fd):
    digest = hashlib.sha256()
    digest.update((TREE_DIGEST_VERSION + "\0").encode("utf-8"))
    state = {"entries": 0, "bytes": 0}

    def walk(current_fd, prefix, depth):
        if depth > MAX_DEPTH:
            refuse(EXIT_DIGEST)
        for name in sorted_names(current_fd, state):
            relative = name if not prefix else f"{prefix}/{name}"
            try:
                listed = os.stat(name, dir_fd=current_fd, follow_symlinks=False)
            except OSError:
                refuse(EXIT_DIGEST)
            if listed.st_uid != os.geteuid() or (not stat.S_ISLNK(listed.st_mode) and stat.S_IMODE(listed.st_mode) & 0o022):
                refuse(EXIT_DIGEST)
            if stat.S_ISLNK(listed.st_mode):
                kind = "symlink"
            elif stat.S_ISDIR(listed.st_mode):
                kind = "directory"
            elif stat.S_ISREG(listed.st_mode):
                kind = "file"
            else:
                refuse(EXIT_DIGEST)
            digest.update(length_prefixed(relative))
            digest.update(KIND_CODES[kind])
            digest.update(struct.pack(">I", stat.S_IMODE(listed.st_mode)))
            if kind == "symlink":
                try:
                    target = os.readlink(name, dir_fd=current_fd)
                except OSError:
                    refuse(EXIT_DIGEST)
                assert_contained_link(relative, target)
                digest.update(length_prefixed(target))
            elif kind == "directory":
                child = open_directory(current_fd, name)
                try:
                    walk(child, relative, depth + 1)
                finally:
                    os.close(child)
            else:
                try:
                    descriptor = os.open(name, FILE_FLAGS, dir_fd=current_fd)
                except OSError:
                    refuse(EXIT_DIGEST)
                try:
                    digest.update(digest_file(descriptor, listed, state))
                finally:
                    os.close(descriptor)

    walk(directory_fd, "", 0)
    return digest.hexdigest()



def present(fd, name):
    try:
        return os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def read_private(fd, name, maximum=65536, optional=False):
    listed = present(fd, name)
    if listed is None and optional:
        return None
    if listed is None or not stat.S_ISREG(listed.st_mode) or listed.st_nlink != 1 or listed.st_uid != os.geteuid() or stat.S_IMODE(listed.st_mode) & 0o077 or listed.st_size > maximum:
        refuse("RECORD_UNSAFE")
    reader = os.open(name, FILE_FLAGS, dir_fd=fd)
    try:
        before = os.fstat(reader)
        if identity(before) != identity(listed):
            refuse("RECORD_CHANGED")
        raw = os.read(reader, maximum + 1)
        after = os.fstat(reader)
        if len(raw) != before.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns:
            refuse("RECORD_CHANGED")
        return raw
    finally:
        os.close(reader)


def read_json(fd, name, optional=False):
    raw = read_private(fd, name, optional=optional)
    return None if raw is None else strict_json(raw)


def publish(fd, name, value):
    # The old journal/receipt is retained until atomic publication. A failed
    # write keeps its temporary bytes; no cleanup guesses ownership or outcome.
    temporary = "." + name + "." + os.urandom(16).hex() + ".tmp"
    raw = (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    if len(raw) > 65536:
        refuse(EXIT_INVALID)
    writer = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=fd)
    try:
        offset = 0
        while offset < len(raw):
            offset += os.write(writer, raw[offset:])
        os.fsync(writer)
    finally:
        os.close(writer)
    # Never overwrite a symlink/non-private record even though rename would
    # replace the link itself rather than following it.
    read_private(fd, name, optional=True)
    os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
    os.fsync(fd)


def validate_build(value):
    shape(value, "digest version buildId")
    hex_value(value["digest"], 64)
    hex_value(value["buildId"], 64)
    if not isinstance(value["version"], str) or len(value["version"]) > 128 or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", value["version"]):
        refuse(EXIT_INVALID)


def bundle(fd):
    require_safe_directory(os.fstat(fd), final=True)
    if stat.S_IMODE(os.fstat(fd).st_mode) != 0o755:
        refuse("BUNDLE_ROOT_UNCONFIRMED")
    digest = digest_tree(fd)
    opened = []
    try:
        parent = fd
        for component in ("Contents", "Resources", "app"):
            parent = open_directory(parent, component)
            opened.append(parent)
        # Identity is public package metadata but must still be regular,
        # singly linked, owner-owned, non-writable by other users and bounded.
        listed = present(parent, "build-identity.json")
        if listed is None or not stat.S_ISREG(listed.st_mode) or listed.st_nlink != 1 or listed.st_uid != os.geteuid() or stat.S_IMODE(listed.st_mode) & 0o022 or listed.st_size > 8192:
            refuse("BUILD_IDENTITY_INVALID")
        reader = os.open("build-identity.json", FILE_FLAGS, dir_fd=parent)
        try:
            if identity(os.fstat(reader)) != identity(listed):
                refuse("BUILD_IDENTITY_CHANGED")
            raw = os.read(reader, 8193)
        finally:
            os.close(reader)
        value = strict_json(raw)
        keys = "schema product version bundleId updateChannel builtAt sourceCommit sourceTreeDigest sourceDirty buildId"
        shape(value, keys + (" buildVersion" if "buildVersion" in value else ""))
        if (type(value["schema"]) is not int or value["schema"] != 1) or value["product"] != "Farol Next Preview" or value["bundleId"] != "local.farol.next.preview" or value["sourceDirty"] is not False or value["updateChannel"] not in ("local-preview-only", "github-owner-beta", "github-stable"):
            refuse("BUILD_IDENTITY_INVALID")
        canonical_at(value["builtAt"])
        hex_value(value["sourceCommit"], 40)
        hex_value(value["sourceTreeDigest"], 64)
        validate_build({"digest": digest, "version": value["version"], "buildId": value["buildId"]})
        if "buildVersion" in value and (not isinstance(value["buildVersion"], str) or not re.fullmatch(r"[1-9][0-9]{0,8}", value["buildVersion"])):
            refuse("BUILD_IDENTITY_INVALID")
        if value["updateChannel"] == "github-owner-beta" and ("buildVersion" not in value or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+-owner\.beta\.(0|[1-9][0-9]*)", value["version"])):
            refuse("BUILD_IDENTITY_INVALID")
        if value["updateChannel"] == "github-stable" and ("buildVersion" not in value or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value["version"])):
            refuse("BUILD_IDENTITY_INVALID")
        body = {key: value[key] for key in ("schema", "product", "version", "bundleId", "updateChannel")}
        if "buildVersion" in value:
            body["buildVersion"] = value["buildVersion"]
        body.update({key: value[key] for key in ("builtAt", "sourceCommit", "sourceTreeDigest", "sourceDirty")})
        calculated = hashlib.sha256(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        if value["buildId"] != calculated:
            refuse("BUILD_IDENTITY_INVALID")
        contents = opened[0]
        plist_stat = present(contents, "Info.plist")
        if plist_stat is None or not stat.S_ISREG(plist_stat.st_mode) or plist_stat.st_nlink != 1 or plist_stat.st_size > 65536:
            refuse("PLIST_INVALID")
        reader = os.open("Info.plist", FILE_FLAGS, dir_fd=contents)
        try:
            plist = plistlib.loads(os.read(reader, 65537))
        finally:
            os.close(reader)
        if plist.get("CFBundleIdentifier") != value["bundleId"] or plist.get("CFBundleShortVersionString") != value["version"].split("-", 1)[0] or plist.get("CFBundleVersion") != value.get("buildVersion", "1"):
            refuse("PLIST_INVALID")
        if digest_tree(fd) != digest:
            refuse("BUNDLE_CHANGED")
        return {"digest": digest, "version": value["version"], "buildId": value["buildId"]}, value
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def measured(parent, name):
    child = open_directory(parent, name)
    try:
        accepted, metadata = bundle(child)
        info = os.fstat(child)
        return accepted, metadata, [info.st_dev, info.st_ino]
    finally:
        os.close(child)


def repair_receipt(value, home, user_data):
    shape(value, "schema operationId phase destination userData source target sourceCommit sourceTreeDigest sourceDirty previous quarantine quarantined quitDigest")
    hex_value(value["operationId"], 32)
    for build in (value["source"], value["target"]):
        validate_build(build)
    for key, length in (("sourceCommit", 40), ("sourceTreeDigest", 64), ("quitDigest", 64)):
        hex_value(value[key], length)
    if value["schema"] != SCHEMA or value["phase"] not in ("installed", "rolled_back") or value["sourceDirty"] is not False or type(value["quarantined"]) is not bool or value["source"]["digest"] == value["target"]["digest"] or value["destination"] != home + "/Applications/" + APP_NAME or value["userData"] != user_data or value["previous"] != home + "/Applications/.farol-repair-" + value["operationId"] + "/previous.app" or value["quarantine"] != user_data + "/installed-updates-quarantine-" + value["operationId"]:
        refuse("REPAIR_RECEIPT_INVALID")
    return value


def normal_anchor(applications, home, user_data, actual, metadata):
    value = read_json(applications, NORMAL_RECEIPT)
    shape(value, "schema operation product version sourceCommit sourceTreeDigest sourceDirty artifactSha256 source destination receipt overwrite legacyMutation activation verifiedDestinationSha256")
    shape(value["activation"], "userData drained obligations")
    slot = home + "/Applications/" + APP_NAME
    if value["schema"] != "farol.next.promotion-plan/1" or value["operation"] != "applied" or value["product"] != "Farol Next Preview" or value["destination"] != slot or value["receipt"] != slot + ".receipt.json" or value["overwrite"] is not False or value["legacyMutation"] is not False or value["activation"] != {"userData": user_data, "drained": True, "obligations": []} or value["activation"]["drained"] is not True or value["sourceDirty"] is not False or value["version"] != actual["version"] or value["verifiedDestinationSha256"] != actual["digest"] or value["artifactSha256"] != actual["digest"] or value["sourceCommit"] != metadata["sourceCommit"] or value["sourceTreeDigest"] != metadata["sourceTreeDigest"]:
        refuse("PREDECESSOR_UNACCEPTED")
    components(value["source"])


def accepted_anchor(applications, home, user_data, actual, metadata):
    prior = read_json(applications, REPAIR_RECEIPT, optional=True)
    if prior is None:
        normal_anchor(applications, home, user_data, actual, metadata)
        return
    prior = repair_receipt(prior, home, user_data)
    # This anchor is reached only by a fresh apply, never same-operation recovery.
    # Runtime rollback requires the genuine original normal install anchor.
    if prior["phase"] == "installed":
        refuse("CLOSED_REPAIR_CHAIN_UNSUPPORTED")
    container = open_directory(applications, ".farol-repair-" + prior["operationId"])
    try:
        if stat.S_IMODE(os.fstat(container).st_mode) & 0o077:
            refuse(EXIT_PATH)
        companion, companion_metadata, _ = measured(container, "previous.app")
    finally:
        os.close(container)
    if prior["phase"] == "installed":
        if actual != prior["target"] or companion != prior["source"] or metadata["sourceCommit"] != prior["sourceCommit"] or metadata["sourceTreeDigest"] != prior["sourceTreeDigest"]:
            refuse("PREDECESSOR_UNACCEPTED")
    else:
        if actual != prior["source"] or companion != prior["target"] or companion_metadata["sourceCommit"] != prior["sourceCommit"] or companion_metadata["sourceTreeDigest"] != prior["sourceTreeDigest"]:
            refuse("PREDECESSOR_UNACCEPTED")
        normal_anchor(applications, home, user_data, actual, metadata)


def hook(request, phase):
    if request["hook"] == phase:
        os.write(4, b"R")
        if os.read(5, 1) != b"C":
            refuse("TEST_INTERRUPTION")


def quit_check(state, expected):
    if present(state, "running.json") is not None:
        refuse("RUNNING_OR_UNCONFIRMED")
    raw = read_private(state, "last-quit.json", 8192)
    value = strict_json(raw)
    shape(value, "schema at drained unconfirmed")
    canonical_at(value["at"])
    if (type(value["schema"]) is not int or value["schema"] != 1) or value["drained"] is not True or value["unconfirmed"] != [] or hashlib.sha256(raw).hexdigest() != expected:
        refuse("QUIT_UNCONFIRMED_OR_CHANGED")


def lease_check(state):
    held = os.fstat(6)
    listed = present(state, "promotion.lease")
    if listed is None or not stat.S_ISREG(held.st_mode) or held.st_nlink != 1 or held.st_uid != os.geteuid() or stat.S_IMODE(held.st_mode) & 0o077 or identity(held) != identity(listed):
        refuse("LEASE_INVALID")
    probe = os.open("promotion.lease", FILE_FLAGS, dir_fd=state)
    try:
        try:
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            refuse("LEASE_NOT_HELD")
    finally:
        os.close(probe)
    # An independent descriptor that happens to name the inode cannot pass.
    try:
        fcntl.flock(6, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        refuse("LEASE_DESCRIPTOR_NOT_HOLDER")


def producers_ended(value):
    shape(value, "pid processStart")
    if type(value["pid"]) is not int or value["pid"] < 2 or not isinstance(value["processStart"], str) or not value["processStart"] or len(value["processStart"]) > 128:
        refuse("PRODUCER_UNCONFIRMED")
    try:
        os.kill(value["pid"], 0)
    except ProcessLookupError:
        return
    except OSError:
        refuse("PRODUCER_UNCONFIRMED")
    refuse("PRODUCER_LIVE_OR_REUSED")


def birthtime_ns(descriptor):
    # Python's st_birthtime is a float and cannot bind Node's nanosecond witness.
    # Darwin fgetattrlist returns packed creation timespec from this exact fd.
    attributes = ctypes.create_string_buffer(struct.pack("=HHIIIII", 5, 0, 0x200, 0, 0, 0, 0))
    output = ctypes.create_string_buffer(32)
    function = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).fgetattrlist
    function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_ulong]
    function.restype = ctypes.c_int
    if function(descriptor, attributes, output, len(output), 1) != 0 or struct.unpack_from("=I", output.raw)[0] != 20:
        refuse("DOWNLOAD_IDENTITY_UNCONFIRMED")
    seconds, nanos = struct.unpack_from("=qq", output.raw, 4)
    if seconds < 0 or not 0 <= nanos < 1_000_000_000:
        refuse("DOWNLOAD_IDENTITY_UNCONFIRMED")
    return str(seconds * 1_000_000_000 + nanos)


def retained_download_only(updates, user_data, ready, pending, cleanup):
    required = {"schema", "handle", "manifest", "operation", "downloadId"}
    optional = {"preparation", "helper", "archiveReleased"}
    if not isinstance(ready, dict) or not required <= set(ready) or not set(ready) <= required | optional or ready["schema"] != "farol.ready-update/1":
        refuse("DOWNLOAD_READY_INVALID")
    if ready["operation"] is not None or ready.get("preparation") is not None or ready.get("helper") is not None or ready.get("archiveReleased", False) is not False:
        refuse("UPDATE_APPLY_OR_RESTORE_PENDING")
    if pending is None or cleanup is None:
        refuse("DOWNLOAD_LINKAGE_UNCONFIRMED")
    hex_value(ready["downloadId"], 32)
    download = pending["download"]
    if ready["downloadId"] != download["id"] or "identity" not in download or ready["handle"] != cleanup["handle"]:
        refuse("DOWNLOAD_LINKAGE_UNCONFIRMED")
    components(ready["handle"])
    expected_parent = user_data + "/installed-updates/download-" + download["id"] + "/github-updates"
    archive_name = posixpath.basename(ready["handle"])
    if len(ready["handle"]) > 4096 or posixpath.dirname(ready["handle"]) != expected_parent or not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip", archive_name):
        refuse("DOWNLOAD_LINKAGE_UNCONFIRMED")
    # Validate metadata shape and linkage, not the archive or package outcome.
    # No extractor/verifier is launched and unknown contents are never replayed.
    manifest = ready["manifest"]
    shape(manifest, "schema repository channel product bundleId version buildVersion sourceCommit sourceTreeDigest buildId artifactSha256 archiveSha256 archiveName archiveSize platform arch signing notarized sourceDirty")
    if manifest["schema"] != "farol.github-release/1" or manifest["repository"] != "legrch/farol-releases" or manifest["product"] != "Farol Next Preview" or manifest["bundleId"] != "local.farol.next.preview" or manifest["channel"] not in ("stable", "owner-beta") or manifest["platform"] != "darwin" or manifest["arch"] != "arm64" or manifest["signing"] != "unsigned" or manifest["notarized"] is not False or manifest["sourceDirty"] is not False:
        refuse("DOWNLOAD_READY_INVALID")
    version = manifest["version"]
    pattern = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" + (r"-owner\.beta\.(0|[1-9][0-9]*)" if manifest["channel"] == "owner-beta" else "")
    if not isinstance(version, str) or len(version) > 128 or not re.fullmatch(pattern, version) or not isinstance(manifest["buildVersion"], str) or not re.fullmatch(r"[1-9][0-9]{0,8}", manifest["buildVersion"]):
        refuse("DOWNLOAD_READY_INVALID")
    for key, length in (("sourceCommit", 40), ("sourceTreeDigest", 64), ("buildId", 64), ("artifactSha256", 64), ("archiveSha256", 64)):
        hex_value(manifest[key], length)
    if manifest["buildId"] != pending["buildId"] or manifest["archiveSha256"] != pending["archiveSha256"] or manifest["archiveName"] != "Farol-" + version + "-darwin-arm64.zip" or type(manifest["archiveSize"]) is not int or not 1 <= manifest["archiveSize"] <= 2_147_483_648:
        refuse("DOWNLOAD_LINKAGE_UNCONFIRMED")
    directory = open_directory(updates, "download-" + download["id"])
    staging = None
    try:
        info = os.fstat(directory)
        require_safe_directory(info, final=True)
        witness = download["identity"]
        if stat.S_IMODE(info.st_mode) & 0o077 or witness != {"dev": str(info.st_dev), "ino": str(info.st_ino), "birthtimeNs": birthtime_ns(directory)}:
            refuse("DOWNLOAD_IDENTITY_UNCONFIRMED")
        staging = open_directory(directory, "github-updates")
        require_safe_directory(os.fstat(staging), final=True)
        if stat.S_IMODE(os.fstat(staging).st_mode) & 0o077:
            refuse(EXIT_PATH)
        archive = present(staging, archive_name)
        if archive is None or not stat.S_ISREG(archive.st_mode) or archive.st_nlink != 1 or archive.st_uid != os.geteuid() or stat.S_IMODE(archive.st_mode) & 0o077:
            refuse("DOWNLOAD_ARCHIVE_UNCONFIRMED")
        producers_ended(download["producer"])
    finally:
        if staging is not None:
            os.close(staging)
        os.close(directory)


def updates_check(user_data_fd, user_data):
    if present(user_data_fd, "installed-updates") is None:
        return None
    updates = open_directory(user_data_fd, "installed-updates")
    try:
        require_safe_directory(os.fstat(updates), final=True)
        if stat.S_IMODE(os.fstat(updates).st_mode) & 0o077:
            refuse(EXIT_PATH)
        names = sorted_names(updates)
        pending = None
        cleanup = None
        ready = None
        for name in names:
            if name in ("restore-pending.json", "last-update.json", "journal.json") or re.fullmatch("[0-9a-f]{32}", name):
                refuse("UPDATE_APPLY_OR_RESTORE_PENDING")
            listed = present(updates, name)
            if name == "download-pending.json":
                value = read_json(updates, name)
                shape(value, "schema buildId archiveSha256 download")
                if value["schema"] != "farol.update-download-intent/1":
                    refuse(EXIT_INVALID)
                hex_value(value["buildId"], 64)
                hex_value(value["archiveSha256"], 64)
                download = value["download"]
                if not isinstance(download, dict) or set(download) not in ({"phase", "id", "producer"}, {"phase", "id", "producer", "identity"}) or download["phase"] not in ("downloading", "verifying"):
                    refuse("PRODUCER_UNCONFIRMED")
                hex_value(download["id"], 32)
                if "identity" in download:
                    shape(download["identity"], "dev ino birthtimeNs")
                    if any(not isinstance(item, str) or not re.fullmatch("[0-9]{1,30}", item) for item in download["identity"].values()):
                        refuse(EXIT_INVALID)
                producers_ended(download["producer"])
                pending = value
            elif name == "ready.json":
                ready = read_json(updates, name)
            elif name == "package-cleanup-pending.json":
                value = read_json(updates, name)
                shape(value, "schema handle")
                if value["schema"] != "farol.update-package-cleanup/1" or not isinstance(value["handle"], str) or not value["handle"].startswith(user_data + "/installed-updates/"):
                    refuse(EXIT_INVALID)
                components(value["handle"])
                cleanup = value
            elif not stat.S_ISDIR(listed.st_mode) or stat.S_ISLNK(listed.st_mode):
                refuse("UPDATE_STATE_UNSUPPORTED")
        if "ready.json" in names:
            retained_download_only(updates, user_data, ready, pending, cleanup)
        # Only inspect names/metadata in unknown extraction trees. Never open,
        # execute, remove, or replay their contents, including linked nodes.
        state = {"entries": 0}
        def walk(fd, depth):
            if depth > MAX_DEPTH:
                refuse(EXIT_PATH)
            for name in sorted_names(fd, state):
                if name in ("journal.json", "restore-pending.json") or (name == "ready.json" and depth != 0):
                    refuse("UPDATE_APPLY_OR_RESTORE_PENDING")
                info = present(fd, name)
                if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
                    child = open_directory(fd, name)
                    try:
                        walk(child, depth + 1)
                    finally:
                        os.close(child)
        walk(updates, 0)
        return [os.fstat(updates).st_dev, os.fstat(updates).st_ino]
    finally:
        os.close(updates)


def native_check(state, retained_locks):
    # Exact roots owned by PrivateMcpLifecycle and PrivateExecutionFence.
    # Retain their existing kernel locks, never create or unlink a fence.
    def retain(parent, name):
        listed = present(parent, name)
        if listed is None:
            return
        if not stat.S_ISREG(listed.st_mode) or listed.st_uid != os.geteuid() or listed.st_nlink != 1 or stat.S_IMODE(listed.st_mode) & 0o077:
            refuse("NATIVE_LOCK_UNSAFE")
        if any(identity(os.fstat(fd)) == identity(listed) for fd in retained_locks):
            return
        lock = os.open(name, FILE_FLAGS, dir_fd=parent)
        try:
            if identity(os.fstat(lock)) != identity(listed):
                refuse("NATIVE_LOCK_CHANGED")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(lock)
            refuse("NATIVE_WORK_LIVE_OR_UNCONFIRMED")
        retained_locks.append(lock)
    parent = state
    opened = []
    try:
        for name in ("secure-mcp-connector", "computer-authority"):
            if present(parent, name) is None:
                return
            parent = open_directory(parent, name)
            opened.append(parent)
            require_safe_directory(os.fstat(parent), final=True)
            if stat.S_IMODE(os.fstat(parent).st_mode) & 0o077:
                refuse(EXIT_PATH)
        if present(parent, "mcp-lifecycle") is not None:
            lifecycle = open_directory(parent, "mcp-lifecycle")
            opened.append(lifecycle)
            require_safe_directory(os.fstat(lifecycle), final=True)
            if stat.S_IMODE(os.fstat(lifecycle).st_mode) & 0o077:
                refuse(EXIT_PATH)
            retain(lifecycle, "lifetime.lock")
        if present(parent, "execution-fence-mutation.lock") is not None:
            refuse("NATIVE_WORK_UNCONFIRMED")
        if present(parent, "execution-fence") is None:
            return
        fence = open_directory(parent, "execution-fence")
        opened.append(fence)
        require_safe_directory(os.fstat(fence), final=True)
        if stat.S_IMODE(os.fstat(fence).st_mode) & 0o077:
            refuse(EXIT_PATH)
        for name in sorted_names(fence):
            if name != "admission.lock":
                refuse("NATIVE_WORK_UNCONFIRMED")
        retain(fence, "admission.lock")
    finally:
        for fd in reversed(opened):
            os.close(fd)


def swap(parent_a, name_a, parent_b, name_b):
    if sys.platform != "darwin":
        refuse("PLATFORM_UNSUPPORTED")
    libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    rename = libc.renameatx_np
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(parent_a, os.fsencode(name_a), parent_b, os.fsencode(name_b), 2) != 0:
        refuse("SWAP_UNCONFIRMED")
    os.fsync(parent_a)
    os.fsync(parent_b)


def run(request):
    if sys.platform != "darwin":
        refuse("PLATFORM_UNSUPPORTED")
    home = request["home"]
    user_data = home + "/Library/Application Support/Farol Next Preview"
    home_fd = open_absolute_directory(home)
    os.close(home_fd)
    for location in (home + "/Library", home + "/Library/Application Support"):
        checked = open_absolute_directory(location)
        os.close(checked)
    applications = open_absolute_directory(home + "/Applications")
    profile = open_absolute_directory(user_data)
    state = open_directory(profile, "farol-next-state")
    descriptors = [applications, profile, state]
    locks = []
    container = None
    try:
        for fd in (profile, state):
            require_safe_directory(os.fstat(fd), final=True)
            if stat.S_IMODE(os.fstat(fd).st_mode) & 0o077:
                refuse(EXIT_PATH)
        anchors = [(home + "/Applications", applications), (user_data, profile), (user_data + "/farol-next-state", state)]
        def guard():
            for location, pinned in anchors:
                reopened = open_absolute_directory(location)
                try:
                    if identity(os.fstat(reopened)) != identity(os.fstat(pinned)):
                        refuse("PARENT_CHANGED")
                finally:
                    os.close(reopened)
            lease_check(state)
            quit_check(state, request["quitDigest"])
            native_check(state, locks)
            updates_check(profile, user_data)
        guard()
        hook(request, "parent_opened")
        guard()
        prior = read_json(applications, JOURNAL, optional=True)
        action = request["action"]
        if prior is not None:
            shape(prior, "schema phase receipt sourceInode targetInode updatesInode")
            if prior["schema"] != "farol.next.closed-repair-journal/1":
                refuse("JOURNAL_INVALID")
            receipt = repair_receipt(prior["receipt"], home, user_data)
            for pair in (prior["sourceInode"], prior["targetInode"], prior["updatesInode"]):
                if pair is not None and (not isinstance(pair, list) or len(pair) != 2 or any(type(item) is not int or item < 0 for item in pair)):
                    refuse("JOURNAL_INVALID")
            if prior["sourceInode"] is None or prior["phase"] not in ("allocate_intent", "copy_intent", "staged", "swap_intent", "save_intent", "quarantine_intent", "receipt_intent", "installed", "rollback_intent", "rollback_receipt_intent", "rolled_back"):
                refuse("JOURNAL_INVALID")
        # A matching published terminal receipt is a measured metadata-only
        # recovery point. A later genuine normal Quit may change its digest;
        # the exact slot/predecessor pair and quarantine are still rechecked
        # before the journal is completed, without another swap or copy.
        published_terminal = prior is not None and prior["phase"] in ("receipt_intent", "rollback_receipt_intent") and read_json(applications, REPAIR_RECEIPT, optional=True) == prior["receipt"]
        resuming = prior is not None and prior["phase"] not in ("installed", "rolled_back")
        if action == "rollback":
            if prior is None or prior["receipt"]["operationId"] != request["operationId"] or prior["phase"] not in ("installed", "rollback_intent", "rollback_receipt_intent", "rolled_back"):
                refuse("ROLLBACK_PAIR_UNCONFIRMED")
            if prior["phase"] in ("rollback_intent", "rollback_receipt_intent") and prior["receipt"]["quitDigest"] != request["quitDigest"] and not published_terminal:
                refuse("ROLLBACK_QUIT_CHANGED")
            journal = prior
        elif resuming:
            if request["operationId"] != prior["receipt"]["operationId"]:
                refuse("RECOVERY_REQUIRED:" + prior["receipt"]["operationId"])
            if prior["phase"].startswith("rollback") or request["target"] != prior["receipt"]["target"] or request["expectedPredecessor"] != prior["receipt"]["source"]["digest"] or request["sourceCommit"] != prior["receipt"]["sourceCommit"] or request["sourceTreeDigest"] != prior["receipt"]["sourceTreeDigest"] or (request["quitDigest"] != prior["receipt"]["quitDigest"] and not published_terminal):
                refuse("RECOVERY_PAIR_CHANGED")
            journal = prior
        else:
            if request["operationId"] is not None:
                if prior is not None and request["operationId"] == prior["receipt"]["operationId"] and prior["phase"] == "installed" and request["target"] == prior["receipt"]["target"] and request["expectedPredecessor"] == prior["receipt"]["source"]["digest"] and request["sourceCommit"] == prior["receipt"]["sourceCommit"] and request["sourceTreeDigest"] == prior["receipt"]["sourceTreeDigest"]:
                    journal = prior
                else:
                    refuse("RECOVERY_PAIR_UNCONFIRMED")
            else:
                actual, metadata, source_inode = measured(applications, APP_NAME)
                if actual["digest"] != request["expectedPredecessor"] or actual == request["target"]:
                    refuse("PREDECESSOR_MISMATCH")
                accepted_anchor(applications, home, user_data, actual, metadata)
                updates_inode = updates_check(profile, user_data)
                op = os.urandom(16).hex()
                receipt = {"schema": SCHEMA, "operationId": op, "phase": "installed", "destination": home + "/Applications/" + APP_NAME, "userData": user_data, "source": actual, "target": request["target"], "sourceCommit": request["sourceCommit"], "sourceTreeDigest": request["sourceTreeDigest"], "sourceDirty": False, "previous": home + "/Applications/.farol-repair-" + op + "/previous.app", "quarantine": user_data + "/installed-updates-quarantine-" + op, "quarantined": updates_inode is not None, "quitDigest": request["quitDigest"]}
                journal = {"schema": "farol.next.closed-repair-journal/1", "phase": "allocate_intent", "receipt": receipt, "sourceInode": source_inode, "targetInode": None, "updatesInode": updates_inode}
                guard()
                publish(applications, JOURNAL, journal)
        receipt = journal["receipt"]
        op = receipt["operationId"]
        name = ".farol-repair-" + op
        def intent(phase):
            guard()
            journal["phase"] = phase
            publish(applications, JOURNAL, journal)
            hook(request, phase)
            guard()
        if journal["phase"] == "allocate_intent":
            guard()
            if present(applications, name) is None:
                os.mkdir(name, 0o700, dir_fd=applications)
                os.fsync(applications)
        container = open_directory(applications, name)
        descriptors.append(container)
        require_safe_directory(os.fstat(container), final=True)
        if stat.S_IMODE(os.fstat(container).st_mode) & 0o077:
            refuse(EXIT_PATH)
        anchors.append((home + "/Applications/" + name, container))
        if journal["phase"] == "allocate_intent":
            if sorted_names(container):
                refuse("ALLOCATION_UNCONFIRMED")
            intent("copy_intent")
        if journal["phase"] == "copy_intent" and present(container, "staged.app") is None:
            # No stage exists in the exact empty operation container and the
            # original installed inode/build is unchanged. Only this measured
            # no-stage condition permits preparation; partial copies stay fenced.
            if sorted_names(container):
                refuse("COPY_CONTAINER_UNCONFIRMED")
            original, _, original_inode = measured(applications, APP_NAME)
            if original != receipt["source"] or original_inode != journal["sourceInode"]:
                refuse("COPY_SOURCE_CHANGED")
            source = open_absolute_directory(request["candidate"])
            descriptors.append(source)
            actual, metadata = bundle(source)
            if actual != receipt["target"] or metadata["sourceCommit"] != receipt["sourceCommit"] or metadata["sourceTreeDigest"] != receipt["sourceTreeDigest"]:
                refuse("TARGET_IDENTITY_CHANGED")
            guard()
            os.mkdir("staged.app", 0o700, dir_fd=container)
            staged = open_directory(container, "staged.app")
            descriptors.append(staged)
            copy_tree(source, staged, {"entries": 0, "bytes": 0})
            os.fchmod(staged, 0o755)
            os.fsync(staged)
            os.fsync(container)
        if journal["phase"] == "copy_intent":
            # A complete stage can be identified after interruption. A present
            # partial copy remains a qualification gap; never overwrite or recopy it.
            actual, metadata, inode = measured(container, "staged.app")
            if actual != receipt["target"] or metadata["sourceCommit"] != receipt["sourceCommit"] or metadata["sourceTreeDigest"] != receipt["sourceTreeDigest"]:
                refuse("COPY_INTERRUPTED_UNCONFIRMED")
            journal["targetInode"] = inode
            intent("staged")
        def pair(first_parent, first_name, first_build, first_inode, second_name, second_build, second_inode):
            first, _, inode_a = measured(first_parent, first_name)
            second, _, inode_b = measured(container, second_name)
            return first == first_build and inode_a == first_inode and second == second_build and inode_b == second_inode
        def quarantine_terminal():
            quarantined = present(profile, "installed-updates-quarantine-" + op)
            expected = journal["updatesInode"]
            if (expected is None and quarantined is not None) or (expected is not None and (quarantined is None or not stat.S_ISDIR(quarantined.st_mode) or quarantined.st_uid != os.geteuid() or stat.S_IMODE(quarantined.st_mode) & 0o077 or [quarantined.st_dev, quarantined.st_ino] != expected)):
                refuse("QUARANTINE_TERMINAL_UNCONFIRMED")
        if action == "rollback":
            quarantine_terminal()
        if action == "apply":
            if journal["phase"] == "staged":
                if not pair(applications, APP_NAME, receipt["source"], journal["sourceInode"], "staged.app", receipt["target"], journal["targetInode"]):
                    refuse("PAIR_CHANGED")
                intent("swap_intent")
            if journal["phase"] == "swap_intent":
                if pair(applications, APP_NAME, receipt["source"], journal["sourceInode"], "staged.app", receipt["target"], journal["targetInode"]):
                    guard()
                    swap(applications, APP_NAME, container, "staged.app")
                    hook(request, "swapped")
                elif not pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "staged.app", receipt["source"], journal["sourceInode"]):
                    refuse("SWAP_OUTCOME_UNKNOWN")
                intent("save_intent")
            if journal["phase"] == "save_intent":
                if present(container, "previous.app") is None:
                    if not pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "staged.app", receipt["source"], journal["sourceInode"]):
                        refuse("SAVE_PAIR_CHANGED")
                    guard()
                    os.rename("staged.app", "previous.app", src_dir_fd=container, dst_dir_fd=container)
                    os.fsync(container)
                    hook(request, "saved")
                if present(container, "staged.app") is not None or not pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "previous.app", receipt["source"], journal["sourceInode"]):
                    refuse("SAVE_OUTCOME_UNKNOWN")
                intent("quarantine_intent")
            if journal["phase"] == "quarantine_intent":
                quarantine_name = "installed-updates-quarantine-" + op
                original = present(profile, "installed-updates")
                quarantined = present(profile, quarantine_name)
                expected = journal["updatesInode"]
                if expected is None:
                    if original is not None or quarantined is not None:
                        refuse("QUARANTINE_CHANGED")
                elif original is not None and quarantined is None:
                    if updates_check(profile, user_data) != expected:
                        refuse("QUARANTINE_CHANGED")
                    guard()
                    os.rename("installed-updates", quarantine_name, src_dir_fd=profile, dst_dir_fd=profile)
                    os.fsync(profile)
                    hook(request, "quarantined")
                elif original is not None or quarantined is None or [quarantined.st_dev, quarantined.st_ino] != expected or not stat.S_ISDIR(quarantined.st_mode) or stat.S_IMODE(quarantined.st_mode) & 0o077:
                    refuse("QUARANTINE_OUTCOME_UNKNOWN")
                intent("receipt_intent")
            if journal["phase"] in ("receipt_intent", "installed"):
                if not pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "previous.app", receipt["source"], journal["sourceInode"]):
                    refuse("INSTALLED_PAIR_CHANGED")
                if journal["phase"] == "receipt_intent":
                    guard()
                    quarantined = present(profile, "installed-updates-quarantine-" + op)
                    if journal["updatesInode"] is not None and (quarantined is None or not stat.S_ISDIR(quarantined.st_mode) or [quarantined.st_dev, quarantined.st_ino] != journal["updatesInode"]):
                        refuse("QUARANTINE_TERMINAL_UNCONFIRMED")
                    publish(applications, REPAIR_RECEIPT, receipt)
                    hook(request, "receipt_published")
                    intent("installed")
        else:
            if journal["phase"] == "installed":
                saved = read_json(applications, REPAIR_RECEIPT)
                if saved != receipt or not pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "previous.app", receipt["source"], journal["sourceInode"]):
                    refuse("ROLLBACK_PAIR_CHANGED")
                receipt["quitDigest"] = request["quitDigest"]
                intent("rollback_intent")
            if journal["phase"] == "rollback_intent":
                if receipt["quitDigest"] != request["quitDigest"]:
                    refuse("ROLLBACK_QUIT_CHANGED")
                if pair(applications, APP_NAME, receipt["target"], journal["targetInode"], "previous.app", receipt["source"], journal["sourceInode"]):
                    guard()
                    quarantine_terminal()
                    swap(applications, APP_NAME, container, "previous.app")
                    hook(request, "rollback_swapped")
                elif not pair(applications, APP_NAME, receipt["source"], journal["sourceInode"], "previous.app", receipt["target"], journal["targetInode"]):
                    refuse("ROLLBACK_OUTCOME_UNKNOWN")
                receipt["phase"] = "rolled_back"
                intent("rollback_receipt_intent")
            if journal["phase"] in ("rollback_receipt_intent", "rolled_back"):
                if not pair(applications, APP_NAME, receipt["source"], journal["sourceInode"], "previous.app", receipt["target"], journal["targetInode"]):
                    refuse("ROLLBACK_PAIR_CHANGED")
                if journal["phase"] == "rollback_receipt_intent":
                    guard()
                    quarantined = present(profile, "installed-updates-quarantine-" + op)
                    if journal["updatesInode"] is not None and (quarantined is None or not stat.S_ISDIR(quarantined.st_mode) or [quarantined.st_dev, quarantined.st_ino] != journal["updatesInode"]):
                        refuse("QUARANTINE_TERMINAL_UNCONFIRMED")
                    publish(applications, REPAIR_RECEIPT, receipt)
                    hook(request, "rollback_receipt_published")
                    intent("rolled_back")
        guard()
        quarantine_terminal()
        if journal["phase"] not in ("installed", "rolled_back") or read_json(applications, REPAIR_RECEIPT) != receipt:
            refuse("TERMINAL_UNCONFIRMED")
        return receipt
    finally:
        for descriptor in reversed(locks + descriptors):
            os.close(descriptor)


def main():
    try:
        receipt = run(read_request())
        print(json.dumps({"schema": SCHEMA, "outcome": receipt["phase"], "receipt": receipt}, separators=(",", ":")))
    except Refusal as error:
        print(json.dumps({"schema": SCHEMA, "outcome": "unconfirmed", "code": str(error)}, separators=(",", ":")))
        raise SystemExit(1)
    except BaseException:
        print(json.dumps({"schema": SCHEMA, "outcome": "unconfirmed", "code": "INTERNAL_UNCONFIRMED"}, separators=(",", ":")))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
