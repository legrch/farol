"""Content binding for an independently prepared, locked Linux dependency tree.

The reference must come from a fresh integrity-checked npm install, not from the
tree being admitted. A digest identifies bytes; it does not approve its producer.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat

ALGORITHM = "node-modules-tree-v1"
CACHES = {".vite", ".vite-temp"}


def signature(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def fingerprint(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("DEPENDENCY_ROOT_REDIRECT_OR_MISSING")
    root = root.resolve(strict=True)
    entries = []
    files = 0
    logical_bytes = 0

    def walk(directory):
        nonlocal files, logical_bytes
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda e: e.name)
        for item in children:
            path = Path(item.path)
            relative = path.relative_to(root).as_posix()
            info = item.stat(follow_symlinks=False)
            mode = stat.S_IMODE(info.st_mode)
            if directory == root and item.name in CACHES:
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError("DEPENDENCY_RUNTIME_CACHE_REDIRECT")
                continue  # Fresh per-container tmpfs, never reused executable inputs.
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                lexical = Path(os.path.normpath(path.parent / target))
                if (Path(target).is_absolute() or not lexical.is_relative_to(root)
                        or not path.resolve(strict=True).is_relative_to(root)):
                    raise ValueError("DEPENDENCY_LINK_OUTSIDE_TREE")
                entries.append([relative, "link", target])
            elif stat.S_ISDIR(info.st_mode):
                entries.append([relative, "directory", mode])
                walk(path)
            elif stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256()
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    before = os.fstat(descriptor)
                    if signature(before) != signature(info):
                        raise ValueError("DEPENDENCY_FILE_REPLACED")
                    while True:
                        chunk = os.read(descriptor, 1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                    after = os.fstat(descriptor)
                    check = path.lstat()
                    if signature(before) != signature(after) or signature(before) != signature(check):
                        raise ValueError("DEPENDENCY_FILE_CHANGED_DURING_READ")
                finally:
                    os.close(descriptor)
                entries.append([relative, "file", mode, before.st_size, digest.hexdigest()])
                files += 1
                logical_bytes += before.st_size
            else:
                raise ValueError("DEPENDENCY_SPECIAL_FILE_REFUSED")
    walk(root)
    if files == 0:
        raise ValueError("DEPENDENCY_TREE_EMPTY")
    data = json.dumps(entries, ensure_ascii=True, separators=(",", ":")).encode()
    return {"algorithm": ALGORITHM, "treeSha256": hashlib.sha256(ALGORITHM.encode() + b"\0" + data).hexdigest(),
            "files": files, "logicalBytes": logical_bytes}


def reference(path, expected_sha256, lock_sha256, image, node_sha256):
    path = Path(path)
    if (path.is_symlink() or not path.is_file() or path.stat().st_size > 16384
            or not isinstance(expected_sha256, str) or len(expected_sha256) != 64):
        raise ValueError("INDEPENDENT_DEPENDENCY_REFERENCE_REQUIRED")
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("DEPENDENCY_REFERENCE_CHANGED")
    value = json.loads(data)
    if (not isinstance(value, dict) or value.get("schema") != 1 or type(value.get("schema")) is not int
            or value.get("algorithm") != ALGORITHM or value.get("lockSha256") != lock_sha256
            or value.get("image") != image or value.get("nodeSha256") != node_sha256
            or value.get("producer") != "fresh-npm-ci-ignore-scripts-and-explicit-esbuild"
            or value.get("npmVersion") != "11.19.0"
            or not isinstance(value.get("treeSha256"), str) or len(value["treeSha256"]) != 64
            or any(c not in "0123456789abcdef" for c in value["treeSha256"])
            or type(value.get("files")) is not int or value["files"] <= 0
            or type(value.get("logicalBytes")) is not int or value["logicalBytes"] < 0):
        raise ValueError("DEPENDENCY_REFERENCE_PROVENANCE_MISMATCH")
    return value
