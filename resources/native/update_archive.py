#!/usr/bin/python3
"""Verify and unpack one Farol release ZIP into an empty private directory."""

import hashlib
import json
import os
import pathlib
import stat
import sys
import unicodedata
import zipfile

MAX_ARCHIVE = 2_147_483_648
MAX_EXPANDED = 4_294_967_296
MAX_ENTRIES = 100_000
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


def preflight(archive):
    infos = archive.infolist()
    check(0 < len(infos) <= MAX_ENTRIES, "ARCHIVE_ENTRY_COUNT_INVALID")
    seen = {}
    expanded = 0
    entries = []
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


def main():
    check(len(sys.argv) == 5, "ARCHIVE_ARGUMENTS_INVALID")
    archive_path, root_path, expected_size, expected_sha = sys.argv[1:]
    check(expected_size.isdecimal() and 0 < int(expected_size) <= MAX_ARCHIVE, "ARCHIVE_SIZE_INVALID")
    check(len(expected_sha) == 64 and all(c in "0123456789abcdef" for c in expected_sha), "ARCHIVE_DIGEST_INVALID")
    check(not pathlib.Path(root_path).is_symlink(), "ARCHIVE_STAGE_INVALID")
    root = pathlib.Path(root_path).resolve(strict=True)
    root_stat = root.lstat()
    check(stat.S_ISDIR(root_stat.st_mode) and root_stat.st_uid == os.getuid() and root_stat.st_mode & 0o077 == 0, "ARCHIVE_STAGE_INVALID")
    fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        check(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size == int(expected_size), "ARCHIVE_SIZE_MISMATCH")
        digest = hashlib.sha256()
        with os.fdopen(os.dup(fd), "rb") as stream:
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
        after = os.fstat(fd)
        check((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "ARCHIVE_CHANGED")
        check(digest.hexdigest() == expected_sha, "ARCHIVE_DIGEST_MISMATCH")
        with os.fdopen(os.dup(fd), "rb") as stream, zipfile.ZipFile(stream) as archive:
            entries = preflight(archive)
            extract(archive, root, entries)
        final = os.fstat(fd)
        check((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) == (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns), "ARCHIVE_CHANGED")
        print(json.dumps({"appPath": str(root / "Farol Next Preview.app"), "artifactPath": str(root / "artifact.json")}))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (Refusal, OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        print(f"ARCHIVE_REFUSED:{error}", file=sys.stderr)
        raise SystemExit(1)
