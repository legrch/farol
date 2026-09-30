#!/usr/bin/python3
"""Verify and unpack one Farol release ZIP into an empty private directory."""

import hashlib
import json
import os
import pathlib
import stat
import struct
import sys
import unicodedata
import zipfile

MAX_ARCHIVE = 2_147_483_648
# No accepted extraction may exceed the installer's one-GiB tree budget.
MAX_EXPANDED = 1_073_741_824
MAX_ENTRIES = 100_000
MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024
MAX_PATH_PARTS = 128
MAX_LINK = 4096
CHUNK = 1024 * 1024


class Refusal(Exception):
    pass


def check(condition, code):
    if not condition:
        raise Refusal(code)


def member_parts(name):
    check(isinstance(name, str) and name and "\\" not in name and "\x00" not in name, "ARCHIVE_PATH_INVALID")
    check(not name.startswith("/") and not name.startswith("//") and ":" not in name.split("/", 1)[0], "ARCHIVE_PATH_INVALID")
    body = name[:-1] if name.endswith("/") else name
    parts = body.split("/")
    check(all(part not in ("", ".", "..") for part in parts), "ARCHIVE_PATH_INVALID")
    check(parts[0] in ("Farol Next Preview.app", "artifact.json"), "ARCHIVE_LAYOUT_INVALID")
    check(parts[0] != "artifact.json" or len(parts) == 1, "ARCHIVE_LAYOUT_INVALID")
    return parts


def normalized(parts):
    return "/".join(unicodedata.normalize("NFD", p).casefold() for p in parts)


def type_of(info):
    mode = (info.external_attr >> 16) & 0xFFFF
    kind = stat.S_IFMT(mode)
    if info.is_dir():
        check(kind in (0, stat.S_IFDIR), "ARCHIVE_ENTRY_TYPE_INVALID")
        return "directory", mode & 0o7777
    if kind == stat.S_IFLNK:
        return "symlink", mode & 0o7777
    check(kind in (0, stat.S_IFREG), "ARCHIVE_ENTRY_TYPE_INVALID")
    return "file", (mode & 0o7777) or 0o644


def admit_central_directory(fd, size):
    # ZipFile allocates its central-directory bytes and ZipInfo objects in its
    # constructor. Bound and count the actual records before giving it the fd.
    tail = os.pread(fd, min(size, 65535 + 22), max(0, size - 65535 - 22))
    end = tail.rfind(b"PK\x05\x06")
    check(end >= 0 and len(tail) - end >= 22, "ARCHIVE_DIRECTORY_INVALID")
    _, disk, cd_disk, disk_count, count, length, offset, comment = struct.unpack_from("<4s4H2IH", tail, end)
    check(end + 22 + comment == len(tail), "ARCHIVE_DIRECTORY_INVALID")
    check(disk == 0 and cd_disk == 0 and disk_count == count, "ARCHIVE_MULTIDISK_UNSUPPORTED")
    # Accepted Farol packages fit below ZIP64's size/count thresholds. Refuse
    # that separate metadata format instead of parsing it through an unbounded reader.
    check(count != 65535 and length != 0xFFFFFFFF and offset != 0xFFFFFFFF, "ARCHIVE_ZIP64_UNSUPPORTED")
    check(0 < length <= MAX_CENTRAL_DIRECTORY, "ARCHIVE_CENTRAL_DIRECTORY_LIMIT")
    check(0 < count <= MAX_ENTRIES, "ARCHIVE_ENTRY_COUNT_INVALID")
    end_offset = size - len(tail) + end
    check(offset + length == end_offset, "ARCHIVE_DIRECTORY_INVALID")
    cursor = offset
    observed = 0
    while cursor < end_offset:
        header = os.pread(fd, 46, cursor)
        check(len(header) == 46 and header[:4] == b"PK\x01\x02", "ARCHIVE_DIRECTORY_INVALID")
        name, extra, note = struct.unpack_from("<3H", header, 28)
        check(struct.unpack_from("<H", header, 34)[0] == 0, "ARCHIVE_MULTIDISK_UNSUPPORTED")
        cursor += 46 + name + extra + note
        observed += 1
        check(observed <= MAX_ENTRIES, "ARCHIVE_ENTRY_COUNT_INVALID")
        check(cursor <= end_offset, "ARCHIVE_DIRECTORY_INVALID")
    check(observed == count, "ARCHIVE_ENTRY_COUNT_INVALID")


def preflight(archive):
    infos = archive.infolist()
    check(0 < len(infos) <= MAX_ENTRIES, "ARCHIVE_ENTRY_COUNT_INVALID")
    seen = {}
    expanded = 0
    entries = []
    tree_paths = set()
    for info in infos:
        check(info.flag_bits & 1 == 0, "ARCHIVE_ENCRYPTED")
        check(info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "ARCHIVE_COMPRESSION_INVALID")
        check(info.file_size >= 0 and info.compress_size >= 0, "ARCHIVE_SIZE_INVALID")
        # PKWARE Unix and ASi Unix extras can carry link identity that ZIP's
        # ordinary path/type model does not express. Refuse them explicitly.
        extra = info.extra
        while extra:
            check(len(extra) >= 4, "ARCHIVE_EXTRA_INVALID")
            tag = int.from_bytes(extra[:2], "little")
            length = int.from_bytes(extra[2:4], "little")
            check(len(extra) >= 4 + length and tag not in (0x000D, 0x756E), "ARCHIVE_HARDLINK_INVALID")
            extra = extra[4 + length:]
        parts = member_parts(info.filename)
        check(len(parts) <= MAX_PATH_PARTS, "ARCHIVE_PATH_DEPTH_LIMIT")
        if parts[0] == "Farol Next Preview.app":
            for index in range(2, len(parts) + 1):
                tree_paths.add(normalized(parts[:index]))
                check(len(tree_paths) <= MAX_ENTRIES, "ARCHIVE_ENTRY_COUNT_INVALID")
        kind, mode = type_of(info)
        check(kind != "directory" or info.file_size == 0, "ARCHIVE_DIRECTORY_DATA")
        check(kind != "directory" or mode == 0 or (mode & 0o700) == 0o700, "ARCHIVE_DIRECTORY_MODE")
        check(kind != "symlink" or info.file_size <= MAX_LINK, "ARCHIVE_LINK_INVALID")
        key = normalized(parts)
        check(key not in seen, "ARCHIVE_DUPLICATE_ENTRY")
        seen[key] = kind
        expanded += info.file_size
        check(expanded <= MAX_EXPANDED, "ARCHIVE_EXPANDED_LIMIT")
        check(info.file_size <= max(info.compress_size * 100, CHUNK), "ARCHIVE_RATIO_LIMIT")
        entries.append((info, parts, kind, mode))
    for _, parts, _, _ in entries:
        for i in range(1, len(parts)):
            check(seen.get(normalized(parts[:i])) in (None, "directory"), "ARCHIVE_PARENT_TYPE_INVALID")
    check(seen.get(normalized(["artifact.json"])) == "file", "ARCHIVE_ARTIFACT_MISSING")
    check(any(parts[0] == "Farol Next Preview.app" and len(parts) > 1 for _, parts, _, _ in entries), "ARCHIVE_APP_MISSING")
    return entries


def mkdirs(root, parts):
    current = root
    for part in parts:
        current = current / part
        if not current.exists():
            current.mkdir(mode=0o700)
        check(stat.S_ISDIR(current.lstat().st_mode), "ARCHIVE_PARENT_TYPE_INVALID")
    return current


def extract(archive, root, entries):
    links = []
    for info, parts, kind, mode in entries:
        parent = mkdirs(root, parts[:-1])
        target = parent / parts[-1]
        if kind == "directory":
            if not target.exists():
                target.mkdir(mode=0o700)
            check(stat.S_ISDIR(target.lstat().st_mode), "ARCHIVE_ENTRY_TYPE_INVALID")
        elif kind == "symlink":
            with archive.open(info) as source:
                payload = source.read(MAX_LINK + 1)
                check(len(payload) == info.file_size, "ARCHIVE_LINK_INVALID")
            try:
                link = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise Refusal("ARCHIVE_LINK_INVALID") from error
            check(link and "\x00" not in link and "\\" not in link and not link.startswith("/"), "ARCHIVE_LINK_INVALID")
            lexical = os.path.abspath(os.path.join(parent, link))
            check(os.path.commonpath((root, lexical)) == str(root), "ARCHIVE_LINK_ESCAPE")
            links.append((target, link))
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                copied = 0
                with archive.open(info) as source:
                    while True:
                        chunk = source.read(CHUNK)
                        if not chunk:
                            break
                        copied += len(chunk)
                        check(copied <= info.file_size, "ARCHIVE_SIZE_INVALID")
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(fd, view):]
                check(copied == info.file_size, "ARCHIVE_SIZE_INVALID")
                os.fchmod(fd, mode)
            finally:
                os.close(fd)
    for target, link in links:
        os.symlink(link, target)
    for target, _ in links:
        resolved = target.resolve(strict=True)
        check(os.path.commonpath((root, resolved)) == str(root), "ARCHIVE_LINK_ESCAPE")
    # Directory modes affect the tree digest; set them after all children.
    for _, parts, kind, mode in sorted(entries, key=lambda e: -len(e[1])):
        if kind == "directory":
            os.chmod(root.joinpath(*parts), mode or 0o755, follow_symlinks=False)


def file_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_nlink,
            value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns,
            value.st_ctime_ns)


def unchanged_archive(archive_path, fd, before):
    after = os.fstat(fd)
    current = os.lstat(archive_path)
    check(stat.S_ISREG(after.st_mode) and
          file_identity(before) == file_identity(after) == file_identity(current),
          "ARCHIVE_CHANGED")


def main():
    check(len(sys.argv) == 5, "ARCHIVE_ARGUMENTS_INVALID")
    archive_path, root_path, expected_size, expected_sha = sys.argv[1:]
    check(expected_size.isdecimal() and 0 < int(expected_size) <= MAX_ARCHIVE, "ARCHIVE_SIZE_INVALID")
    check(len(expected_sha) == 64 and all(c in "0123456789abcdef" for c in expected_sha), "ARCHIVE_DIGEST_INVALID")
    check(not pathlib.Path(root_path).is_symlink(), "ARCHIVE_STAGE_INVALID")
    root = pathlib.Path(root_path).resolve(strict=True)
    root_stat = root.lstat()
    check(stat.S_ISDIR(root_stat.st_mode) and root_stat.st_uid == os.getuid() and root_stat.st_mode & 0o077 == 0, "ARCHIVE_STAGE_INVALID")
    expected_size = int(expected_size)
    named = os.lstat(archive_path)
    check(stat.S_ISREG(named.st_mode), "ARCHIVE_TYPE_INVALID")
    check(named.st_nlink == 1 and named.st_size == expected_size, "ARCHIVE_SIZE_MISMATCH")
    fd = os.open(archive_path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        check(stat.S_ISREG(before.st_mode) and file_identity(named) == file_identity(before), "ARCHIVE_CHANGED")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(fd, min(CHUNK, expected_size - total + 1))
            if not chunk:
                break
            total += len(chunk)
            check(total <= expected_size, "ARCHIVE_SIZE_MISMATCH")
            digest.update(chunk)
        check(total == expected_size, "ARCHIVE_SIZE_MISMATCH")
        unchanged_archive(archive_path, fd, before)
        check(digest.hexdigest() == expected_sha, "ARCHIVE_DIGEST_MISMATCH")
        admit_central_directory(fd, expected_size)
        unchanged_archive(archive_path, fd, before)
        with os.fdopen(os.dup(fd), "rb") as stream, zipfile.ZipFile(stream) as archive:
            entries = preflight(archive)
            extract(archive, root, entries)
        unchanged_archive(archive_path, fd, before)
        print(json.dumps({"appPath": str(root / "Farol Next Preview.app"), "artifactPath": str(root / "artifact.json")}))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        print(f"ARCHIVE_REFUSED:{error}", file=sys.stderr)
        raise SystemExit(1)
