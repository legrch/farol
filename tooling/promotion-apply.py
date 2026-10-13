"""Descriptor-bound Farol Next preview promotion helper.

The reviewed Node launcher sends these exact bytes to ``/usr/bin/python3 -``
and one bounded JSON request on descriptor 3. Descriptor 6 inherits the original
exclusive kernel lease and stays open through cleanup and process exit, including
when its parent dies. The helper opens the owner's
home and Applications directories component by component, changes directory
through the verified Applications descriptor, and performs every mutation
relative to that pinned directory.  Failures are content-free exit statuses.
"""

import errno
import hashlib
import json
import os
import posixpath
import stat
import struct
import sys


APP_NAME = "Farol.app"
RECEIPT_NAME = "Farol.app.receipt.json"
MAGIC = b"FAROL_PROMOTION_OK\n"
MAX_REQUEST_BYTES = 128 * 1024
MAX_RECEIPT_BYTES = 64 * 1024
MAX_ENTRIES = 100_000
MAX_BYTES = 1024 * 1024 * 1024
MAX_DEPTH = 128

# Must match TREE_DIGEST_VERSION and the record encoding in
# tooling/artifact-digest.mjs: a version tag, then per entry a length-prefixed
# UTF-8 path, one kind byte, the mode as a big-endian u32 and the SHA-256 of a
# file's bytes or a length-prefixed symlink target.
TREE_DIGEST_VERSION = "farol.next.tree-digest/v2"
KIND_CODES = {"file": b"f", "directory": b"d", "symlink": b"l"}

EXIT_INVALID = 70
EXIT_PATH = 71
EXIT_EXISTS = 72
EXIT_COPY = 73
EXIT_DIGEST = 74
EXIT_RECEIPT = 75
EXIT_LEASE = 76
EXIT_INTERNAL = 79

DIRECTORY_FLAGS = (
    os.O_RDONLY
    | os.O_DIRECTORY
    | os.O_NOFOLLOW
    | os.O_CLOEXEC
    | getattr(os, "O_NONBLOCK", 0)
)
FILE_FLAGS = (
    os.O_RDONLY
    | os.O_NOFOLLOW
    | os.O_CLOEXEC
    | getattr(os, "O_NONBLOCK", 0)
)


class Refusal(Exception):
    def __init__(self, status):
        super().__init__()
        self.status = status


def refuse(status):
    raise Refusal(status)


def read_request():
    chunks = []
    remaining = MAX_REQUEST_BYTES + 1
    while remaining:
        chunk = os.read(3, min(8192, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    raw = b"".join(chunks)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        refuse(EXIT_INVALID)
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        refuse(EXIT_INVALID)
    if not isinstance(request, dict):
        refuse(EXIT_INVALID)
    location_fields = {"installLocation"} if "installLocation" in request else set()
    if request.get("installLocation", "legacy") not in ("shared", "legacy"):
        refuse(EXIT_INVALID)
    if set(request) != location_fields | {
        "schema",
        "home",
        "source",
        "artifactSha256",
        "receiptText",
        "testHook",
        "lease",
    }:
        refuse(EXIT_INVALID)
    if request.get("schema") != "farol.next.promotion-apply/1":
        refuse(EXIT_INVALID)
    if not isinstance(request.get("testHook"), bool):
        refuse(EXIT_INVALID)
    lease = request.get("lease")
    if not isinstance(lease, dict) or set(lease) != {"file", "device", "inode"}:
        refuse(EXIT_INVALID)
    components(lease.get("file"))
    if (
        os.path.basename(lease["file"]) != "promotion.lease"
        or os.path.basename(os.path.dirname(lease["file"])) != "farol-next-state"
    ):
        refuse(EXIT_INVALID)
    for key in ("device", "inode"):
        value = lease.get(key)
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 32
            or any(character not in "0123456789" for character in value)
        ):
            refuse(EXIT_INVALID)
    digest = request.get("artifactSha256")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        refuse(EXIT_INVALID)
    receipt = request.get("receiptText")
    if not isinstance(receipt, str):
        refuse(EXIT_INVALID)
    receipt_bytes = receipt.encode("utf-8")
    if not receipt_bytes or len(receipt_bytes) > MAX_RECEIPT_BYTES:
        refuse(EXIT_INVALID)
    try:
        parsed_receipt = json.loads(receipt)
    except ValueError:
        refuse(EXIT_INVALID)
    if not isinstance(parsed_receipt, dict) or parsed_receipt.get("operation") != "applied":
        refuse(EXIT_INVALID)
    request["receiptBytes"] = receipt_bytes
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


def verify_inherited_lease(request):
    """Fence the inherited original descriptor without reopening or unlocking it."""
    lease = request["lease"]
    try:
        opened = os.fstat(6)
        named = os.stat(lease["file"], follow_symlinks=False)
        parent = os.stat(os.path.dirname(lease["file"]), follow_symlinks=False)
        expected = (int(lease["device"]), int(lease["inode"]))
        if (
            not stat.S_ISREG(opened.st_mode)
            or not stat.S_ISREG(named.st_mode)
            or opened.st_nlink != 1
            or named.st_nlink != 1
            or opened.st_uid != os.geteuid()
            or named.st_uid != os.geteuid()
            or (opened.st_mode & 0o077) != 0
            or (named.st_mode & 0o077) != 0
            or (opened.st_dev, opened.st_ino) != expected
            or (named.st_dev, named.st_ino) != expected
            or not stat.S_ISDIR(parent.st_mode)
            or parent.st_uid != os.geteuid()
            or (parent.st_mode & 0o077) != 0
            or os.path.realpath(lease["file"]) != lease["file"]
        ):
            refuse(EXIT_LEASE)
    except OSError:
        refuse(EXIT_LEASE)


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


def sorted_names(descriptor):
    try:
        names = os.listdir(descriptor)
    except OSError:
        refuse(EXIT_COPY)
    return sorted((checked_name(name) for name in names), key=lambda item: item.encode("utf-16-be", "surrogatepass"))


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
    except OSError:
        refuse(EXIT_COPY)
    finally:
        if writer is not None:
            os.close(writer)
        os.close(reader)


def copy_tree(source_fd, destination_fd, state, depth=0):
    if depth > MAX_DEPTH:
        refuse(EXIT_COPY)
    for name in sorted_names(source_fd):
        bump_entry(state)
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
        for name in sorted_names(current_fd):
            bump_entry(state)
            relative = name if not prefix else f"{prefix}/{name}"
            try:
                listed = os.stat(name, dir_fd=current_fd, follow_symlinks=False)
            except OSError:
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


def clear_directory(descriptor, depth=0):
    if depth > MAX_DEPTH:
        refuse(EXIT_INTERNAL)
    for name in sorted_names(descriptor):
        try:
            listed = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISDIR(listed.st_mode) and not stat.S_ISLNK(listed.st_mode):
            child = open_directory(descriptor, name)
            try:
                clear_directory(child, depth + 1)
            finally:
                os.close(child)
            os.rmdir(name, dir_fd=descriptor)
        else:
            os.unlink(name, dir_fd=descriptor)


def write_receipt(parent_fd, payload):
    temporary = f".{RECEIPT_NAME}.{os.urandom(8).hex()}.tmp"
    descriptor = None
    linked = False
    published = False
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=parent_fd,
        )
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                refuse(EXIT_RECEIPT)
            offset += written
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.link(
            temporary,
            RECEIPT_NAME,
            src_dir_fd=parent_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        linked = True
        os.unlink(temporary, dir_fd=parent_fd)
        os.fsync(parent_fd)
        published = True
    except OSError as error:
        if error.errno == errno.EEXIST:
            refuse(EXIT_EXISTS)
        refuse(EXIT_RECEIPT)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if linked and not published:
            try:
                os.unlink(RECEIPT_NAME, dir_fd=parent_fd)
            except OSError:
                pass
        if not published:
            try:
                os.unlink(temporary, dir_fd=parent_fd)
            except OSError:
                pass


def test_hook(enabled):
    if not enabled:
        return
    try:
        os.write(4, b"R")
        if os.read(5, 1) != b"C":
            refuse(EXIT_INTERNAL)
    except OSError:
        refuse(EXIT_INTERNAL)


def require_shared_parent(info):
    # Standard macOS administrator group (80); no permissions are changed.
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o002
            or (info.st_mode & 0o020 and info.st_gid != 80)):
        refuse(EXIT_PATH)


def open_applications(request, home_fd):
    location = request.get("installLocation", "legacy")
    if location not in ("shared", "legacy"):
        refuse(EXIT_INVALID)
    if location == "legacy":
        descriptor = open_directory(home_fd, "Applications")
        try:
            require_safe_directory(os.fstat(descriptor), final=True)
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise
    root = os.open("/", DIRECTORY_FLAGS)
    try:
        require_safe_directory(os.fstat(root), final=False)
        if os.fstat(root).st_uid != 0:
            refuse(EXIT_PATH)
        descriptor = open_directory(root, "Applications")
        try:
            require_shared_parent(os.fstat(descriptor))
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise
    finally:
        os.close(root)


def recheck_parent(request, home_fd, parent_fd):
    current_home = open_absolute_directory(request["home"])
    try:
        if identity(os.fstat(current_home)) != identity(os.fstat(home_fd)):
            refuse(EXIT_PATH)
    finally:
        os.close(current_home)
    current = open_applications(request, home_fd)
    try:
        if identity(os.fstat(current)) != identity(os.fstat(parent_fd)):
            refuse(EXIT_PATH)
    finally:
        os.close(current)


def recheck_destination(request, home_fd, parent_fd, expected):
    recheck_parent(request, home_fd, parent_fd)
    try:
        named = os.stat(APP_NAME, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        refuse(EXIT_PATH)
    if identity(named) != expected:
        refuse(EXIT_PATH)


def run(request):
    verify_inherited_lease(request)
    home_fd = open_absolute_directory(request["home"])
    parent_fd = None
    source_fd = None
    destination_fd = None
    destination_identity = None
    destination_created = False
    completed = False
    receipt_published = False
    try:
        verify_inherited_lease(request)
        if request.get("installLocation", "legacy") == "legacy":
            try:
                os.mkdir("Applications", 0o755, dir_fd=home_fd)
            except OSError as error:
                if error.errno != errno.EEXIST:
                    refuse(EXIT_PATH)
        parent_fd = open_applications(request, home_fd)
        test_hook(request["testHook"])
        recheck_parent(request, home_fd, parent_fd)
        os.fchdir(parent_fd)
        for name in (APP_NAME, RECEIPT_NAME):
            try:
                os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    continue
                refuse(EXIT_PATH)
            refuse(EXIT_EXISTS)
        source_fd = open_absolute_directory(request["source"])
        verify_inherited_lease(request)
        try:
            os.mkdir(APP_NAME, 0o700, dir_fd=parent_fd)
        except OSError as error:
            if error.errno == errno.EEXIST:
                refuse(EXIT_EXISTS)
            refuse(EXIT_COPY)
        destination_created = True
        destination_fd = open_directory(parent_fd, APP_NAME)
        destination_identity = identity(os.fstat(destination_fd))
        verify_inherited_lease(request)
        copy_tree(source_fd, destination_fd, {"entries": 0, "bytes": 0})
        os.fchmod(destination_fd, 0o755)
        destination_identity = identity(os.fstat(destination_fd))
        if digest_tree(destination_fd) != request["artifactSha256"]:
            refuse(EXIT_DIGEST)
        os.fsync(destination_fd)
        verify_inherited_lease(request)
        recheck_destination(request, home_fd, parent_fd, destination_identity)
        write_receipt(parent_fd, request["receiptBytes"])
        receipt_published = True
        recheck_destination(request, home_fd, parent_fd, destination_identity)
        completed = True
        os.write(1, MAGIC)
    finally:
        if (destination_created and not completed and not receipt_published
                and destination_fd is not None):
            try:
                current = os.stat(APP_NAME, dir_fd=parent_fd, follow_symlinks=False)
                if identity(current) == destination_identity:
                    clear_directory(destination_fd)
                    os.rmdir(APP_NAME, dir_fd=parent_fd)
            except OSError:
                pass
        for descriptor in (destination_fd, source_fd, parent_fd, home_fd):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def main():
    try:
        run(read_request())
    except Refusal as error:
        raise SystemExit(error.status)
    except BaseException:
        raise SystemExit(EXIT_INTERNAL)


if __name__ == "__main__":
    main()
