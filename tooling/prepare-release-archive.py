#!/usr/bin/env python3
"""Prepare three public release assets from this checkout's exact package."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import time
import unicodedata
import zipfile

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Farol.app"
PACKAGE = ROOT / "_output/package"
APP = PACKAGE / APP_NAME
ARTIFACT = PACKAGE / "artifact.json"
MAX_ARCHIVE = 2_147_483_648
MAX_EXPANDED = 1_073_741_824
MAX_ENTRIES = 100_000
MAX_CENTRAL = 16 * 1024 * 1024
CLEAN_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
VERIFY_ENV = {"PATH": CLEAN_PATH, "HOME": "/var/empty", "LC_ALL": "C",
              "TMPDIR": "/private/tmp"}
FIELDS = (
    "product", "bundleId", "version", "buildVersion", "sourceCommit",
    "sourceTreeDigest", "buildId", "artifactSha256",
)
ARTIFACT_FIELDS = {
    "schema", "treeDigestVersion", *FIELDS, "builtAt", "sourceDirty",
    "artifactPath", "electronSourceSha256", "runtime", "signing",
    "notarized", "updateChannel",
}
GIT_ENV = {
    "PATH": "/usr/bin:/bin", "HOME": "/var/empty",
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C",
}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def git(*args):
    return subprocess.check_output(
        ["/usr/bin/git", "-C", str(ROOT), *args], env=GIT_ENV, timeout=30
    )


def sha256_file(path, expected):
    digest = hashlib.sha256()
    for chunk in regular_chunks(path, MAX_ARCHIVE, expected):
        digest.update(chunk)
    return digest.hexdigest()


def file_identity(info):
    return (
        info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid, info.st_gid,
        info.st_size, info.st_mtime_ns, info.st_ctime_ns,
    )


def regular_file(path, limit=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "INPUT_FILE_INVALID")
    if limit is not None:
        require(0 <= info.st_size <= limit, "INPUT_FILE_OVERSIZE")
    return info


def unchanged(path, info):
    require(file_identity(path.lstat()) == file_identity(info), "INPUT_CHANGED")


def regular_chunks(path, limit, expected=None):
    before = regular_file(path, limit)
    require(expected is None or file_identity(before) == file_identity(expected), "INPUT_CHANGED")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1, "INPUT_FILE_INVALID")
        require(file_identity(opened) == file_identity(before), "INPUT_CHANGED")
        total = 0
        while True:
            # One extra byte detects growth without following a growing stream.
            chunk = os.read(fd, min(1024 * 1024, before.st_size - total + 1))
            if not chunk:
                break
            total += len(chunk)
            require(total <= before.st_size, "INPUT_SIZE_CHANGED")
            yield chunk
        require(total == before.st_size, "INPUT_SIZE_CHANGED")
        require(file_identity(os.fstat(fd)) == file_identity(before), "INPUT_CHANGED")
        unchanged(path, before)
    finally:
        os.close(fd)


def clean_source(expected, artifact):
    require(re.fullmatch(r"[a-f0-9]{40}", expected) is not None, "HEAD_INVALID")
    require(git("rev-parse", "--verify", "HEAD").decode().strip() == expected, "HEAD_MISMATCH")
    require(not git("status", "--porcelain=v1", "-z", "--untracked-files=all"), "SOURCE_DIRTY")
    flags = git("ls-files", "-v", "-z").split(b"\0")
    require(all(not flag or flag.startswith(b"H ") for flag in flags), "SOURCE_INDEX_FLAGS")
    tree = git("ls-tree", "-r", "-z", "--full-tree", expected, "--", ".")
    require(bool(tree), "SOURCE_TREE_EMPTY")
    source_digest = hashlib.sha256(b"git-ls-tree-v1\0" + tree).hexdigest()
    require(
        artifact["sourceCommit"] == expected
        and artifact["sourceTreeDigest"] == source_digest
        and artifact["sourceDirty"] is False,
        "CANDIDATE_SOURCE_MISMATCH",
    )
    # Git status can trust a stale index/stat cache. Authenticate the physical
    # bytes and executable modes before importing any checkout-owned verifier.
    for record in tree.split(b"\0"):
        if not record:
            continue
        metadata, relative = record.split(b"\t", 1)
        mode, kind, object_id = metadata.split(b" ")
        require(kind == b"blob" and mode in (b"100644", b"100755"), "SOURCE_ENTRY_INVALID")
        path = ROOT / relative.decode("utf8")
        for parent in path.parents:
            require(stat.S_ISDIR(parent.lstat().st_mode), "SOURCE_PARENT_INVALID")
            if parent == ROOT:
                break
        info = regular_file(path, MAX_ARCHIVE)
        require(bool(info.st_mode & 0o111) == (mode == b"100755"), "SOURCE_MODE_MISMATCH")
        digest = hashlib.sha1(b"blob " + str(info.st_size).encode() + b"\0")
        for chunk in regular_chunks(path, MAX_ARCHIVE, info):
            digest.update(chunk)
        require(digest.hexdigest().encode() == object_id, "SOURCE_PHYSICAL_MISMATCH")
    # Keep the owning source/candidate contracts in the gate. The Python check
    # above additionally pins no-follow reads and checks physical file modes.
    return trusted_run([node_executable(), "--input-type=module", "--eval", """
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, artifactFile] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(path.join(root, 'tooling', name)));
const { sourceIdentity } = await load('source-identity.mjs');
const { assertExactSourceIdentity } = await load('candidate-contract.mjs');
const { packageLayout, GO_PACKAGE_SCHEMA } = await load('package-layout.mjs');
const { NATIVE_ARCHIVE_SHA256, NATIVE_ARCHIVE_MAX_BYTES } = await load('native-archive-build.mjs');
const artifact = JSON.parse(await fs.readFile(artifactFile, 'utf8'));
const current = sourceIdentity(root, '.');
assertExactSourceIdentity(current, artifact);
const layout = packageLayout(artifact.schema);
if (artifact.schema !== GO_PACKAGE_SCHEMA || layout.core !== true || layout.appName !== 'Farol.app')
  throw new Error('RELEASE_GO_LAYOUT_REQUIRED');
process.stdout.write(JSON.stringify({ ...current, archiveHelper: {
  sha256: NATIVE_ARCHIVE_SHA256, maxBytes: NATIVE_ARCHIVE_MAX_BYTES,
} }));
""", str(ROOT), str(ARTIFACT)], code="SOURCE_IDENTITY_REJECTED")


def read_artifact():
    for directory in (ROOT / "_output", PACKAGE):
        require(stat.S_ISDIR(directory.lstat().st_mode), "PACKAGE_DIRECTORY_INVALID")
    info = regular_file(ARTIFACT, 16 * 1024)
    artifact = json.loads(b"".join(regular_chunks(ARTIFACT, 16 * 1024, info)))
    require(type(artifact) is dict and set(artifact) == ARTIFACT_FIELDS, "ARTIFACT_FIELDS_INVALID")
    require(type(artifact["schema"]) is int and artifact["schema"] == 7, "ARTIFACT_SCHEMA_INVALID")
    require(artifact["artifactPath"] == str(APP), "ARTIFACT_PATH_INVALID")
    stable = artifact["updateChannel"] == "github-stable"
    version_pattern = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)" + ("" if stable else r"-owner\.beta\.(0|[1-9][0-9]*)")
    require(re.fullmatch(version_pattern, artifact["version"]) is not None, "VERSION_INVALID")
    require(re.fullmatch(r"[1-9][0-9]{0,8}", artifact["buildVersion"]) is not None, "BUILD_VERSION_INVALID")
    require(
        artifact["product"] == "Farol Next Preview"
        and artifact["bundleId"] == "local.farol.next.preview"
        and artifact["updateChannel"] in ("github-owner-beta", "github-stable")
        and artifact["signing"] == {
            "kind": "unsigned",
            "reason": "stable-distribution" if stable else "owner-beta-distribution",
            "runtimeBytes": "unmodified-vendor-bundle",
        }
        and artifact["notarized"] is False,
        "RELEASE_IDENTITY_INVALID",
    )
    for field, length in (("sourceCommit", 40), ("sourceTreeDigest", 64),
                          ("buildId", 64), ("artifactSha256", 64)):
        require(re.fullmatch(r"[a-f0-9]{" + str(length) + r"}", artifact[field]) is not None, "ARTIFACT_DIGEST_INVALID")
    require(artifact["treeDigestVersion"] == "farol.next.tree-digest/v2", "TREE_DIGEST_VERSION_INVALID")
    require(isinstance(artifact["builtAt"], str) and re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z",
        artifact["builtAt"]), "BUILD_TIME_INVALID")
    require(hex_digest(artifact["electronSourceSha256"]), "ARTIFACT_DIGEST_INVALID")
    public = {field: artifact[field] for field in sorted(ARTIFACT_FIELDS) if field != "artifactPath"}
    public["artifactPath"] = APP_NAME
    assert_public_metadata(public)
    runtime = artifact["runtime"]
    require(type(runtime) is dict and set(runtime) == {
        "electron", "platform", "arch", "distribution", "node", "testerManagedRuntime",
        "layout", "relativePath"}, "RUNTIME_FIELDS_INVALID")
    require(type(runtime["distribution"]) is dict and set(runtime["distribution"]) == {
        "asset", "sha256"}, "RUNTIME_FIELDS_INVALID")
    return artifact, public, info


def hex_digest(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def assert_public_metadata(value):
    # Metadata contains only fixed identifiers, hashes, timestamps and relative
    # runtime paths. No absolute path is meaningful in this public projection.
    if isinstance(value, dict):
        for key, child in value.items():
            assert_public_metadata(key)
            assert_public_metadata(child)
    elif isinstance(value, list):
        for child in value:
            assert_public_metadata(child)
    elif isinstance(value, str):
        require(not value.startswith("/")
                and not re.search(r"(?:/Users/|/private/|/home/|/tmp/|/var/|[A-Za-z]:[\\/]|file://)", value),
                "PRIVATE_PATH_IN_ARTIFACT")


def verify_core(app, artifact):
    # This bounded consumer projection adds the release's exact arm64 binding.
    # The source and bundled package verifiers still own complete build/input,
    # core declaration, native bytes, runtime and package attestation checks.
    resource = app / "Contents/Resources/app"
    def document(name, limit):
        return json.loads(b"".join(regular_chunks(resource / name, limit)))
    embedded = document("build-manifest.json", 16 * 1024 * 1024)
    core_file = resource / "core-artifact.json"
    core_info = regular_file(core_file, 8192)
    core_bytes = b"".join(regular_chunks(core_file, 8192, core_info))
    core = json.loads(core_bytes)
    require(type(embedded) is dict and embedded.get("schema") == 4
            and embedded.get("sourceMode") == "head-exact"
            and embedded.get("inputExact") is True and embedded.get("dirty") is False,
            "GO_CORE_PROOF_INVALID")
    require(type(core) is dict and set(core) == {"schema", "build", "binary"}
            and core["schema"] == "farol-core-artifact/1" and embedded.get("core") == core,
            "GO_CORE_PROOF_INVALID")
    build, binary = core["build"], core["binary"]
    require(build == {"buildId": artifact["buildId"], "sourceSHA": artifact["sourceCommit"],
                      "sourceTreeDigest": artifact["sourceTreeDigest"],
                      "platform": {"goos": "darwin", "goarch": "arm64"}}, "GO_CORE_PROOF_INVALID")
    for field in ("buildId", "sourceCommit", "sourceTreeDigest", "product", "bundleId", "version"):
        require(embedded.get(field) == artifact[field], "GO_CORE_PROOF_INVALID")
    require(type(binary) is dict and set(binary) == {"path", "size", "sha256"}
            and binary["path"] == "farol-backend" and type(binary["size"]) is int
            and 64 <= binary["size"] <= 128 * 1024 * 1024 and hex_digest(binary["sha256"]),
            "GO_CORE_PROOF_INVALID")
    entries, hashes = embedded.get("entries"), embedded.get("entrySha256")
    require(type(entries) is list and type(hashes) is dict
            and all(entries.count(name) == 1 for name in ("core-artifact.json", "farol-backend"))
            and hashes.get("core-artifact.json") == hashlib.sha256(core_bytes).hexdigest()
            and hashes.get("farol-backend") == binary["sha256"], "GO_CORE_PROOF_INVALID")
    backend = resource / "farol-backend"
    info = regular_file(backend, 128 * 1024 * 1024)
    require(info.st_size == binary["size"] and info.st_mode & 0o111, "GO_CORE_BYTES_INVALID")
    digest, header = hashlib.sha256(), b""
    for chunk in regular_chunks(backend, 128 * 1024 * 1024, info):
        if not header:
            header = chunk[:16]
        digest.update(chunk)
    require(header[:8] == bytes.fromhex("cffaedfe0c000001")
            and header[12:16] == b"\x02\x00\x00\x00"
            and digest.hexdigest() == binary["sha256"], "GO_CORE_BYTES_INVALID")
    return core


def members():
    root_info = APP.lstat()
    require(stat.S_ISDIR(root_info.st_mode), "APP_ROOT_INVALID")
    entries = [(APP, APP_NAME + "/", root_info)]
    expanded = 0
    central = 46 + len((APP_NAME + "/").encode()) + 46 + len(b"artifact.json")
    names = {unicodedata.normalize("NFD", APP_NAME).casefold(), "artifact.json"}

    def visit(directory, directory_info):
        nonlocal expanded, central
        unchanged(directory, directory_info)
        for name in sorted(os.listdir(directory)):
            path = directory / name
            info = path.lstat()
            relative = path.relative_to(PACKAGE).as_posix()
            require("\\" not in relative and "\x00" not in relative, "APP_PATH_INVALID")
            key = unicodedata.normalize("NFD", relative).casefold()
            require(key not in names, "APP_PATH_COLLISION")
            names.add(key)
            central += 46 + len(relative.encode()) + int(stat.S_ISDIR(info.st_mode))
            require(central <= MAX_CENTRAL, "APP_CENTRAL_LIMIT")
            private_parts = {part.casefold() for part in Path(relative).parts}
            require(not private_parts.intersection({
                ".git", ".codex", ".claude", ".aws", ".ssh", ".env", "profiles",
                "cookies", "login data", "local storage", "session storage", "auth.json",
            }), "PRIVATE_ENTRY_IN_APP")
            if path.is_relative_to(APP / "Contents/Resources/app"):
                require(not private_parts.intersection({"src", "modules", "node_modules"})
                        and path.suffix.casefold() not in {".map", ".ts", ".tsx", ".go"},
                        "SOURCE_ENTRY_IN_APP")
            require(len(Path(relative).parts) <= 128, "APP_PATH_DEPTH")
            if stat.S_ISDIR(info.st_mode):
                entries.append((path, relative + "/", info))
                visit(path, info)
            elif stat.S_ISLNK(info.st_mode):
                link = os.readlink(path)
                require(link and not os.path.isabs(link) and "\\" not in link, "APP_LINK_INVALID")
                require(len(link.encode()) <= 4096, "APP_LINK_OVERSIZE")
                require(path.resolve(strict=True).is_relative_to(APP), "APP_LINK_ESCAPE")
                unchanged(path, info)
                entries.append((path, relative, info))
                expanded += len(link.encode())
            elif stat.S_ISREG(info.st_mode):
                require(info.st_nlink == 1, "APP_HARDLINK_INVALID")
                entries.append((path, relative, info))
                expanded += info.st_size
            else:
                raise ValueError("APP_SPECIAL_ENTRY")
            require(len(entries) + 1 <= MAX_ENTRIES and expanded <= MAX_EXPANDED - 16 * 1024,
                    "APP_RESOURCE_LIMIT")
        unchanged(directory, directory_info)

    visit(APP, root_info)
    return entries


def add_member(archive, path, name, info):
    unchanged(path, info)
    member = zipfile.ZipInfo(name)
    member.create_system = 3
    member.external_attr = info.st_mode << 16
    member.compress_type = zipfile.ZIP_STORED
    if stat.S_ISDIR(info.st_mode):
        archive.writestr(member, b"")
    elif stat.S_ISLNK(info.st_mode):
        archive.writestr(member, os.readlink(path).encode())
    else:
        with archive.open(member, "w") as target:
            tail = b""
            # The preceding full source package verifier authenticates this
            # exact vendor tree. Public compiler paths inside unmodified
            # Electron are not local owner evidence. Scan every Farol-owned
            # resource/native component; whole-tree entry policy still applies.
            owned = not path.is_relative_to(APP / "Contents/Frameworks/Electron Runtime.app")
            for chunk in regular_chunks(path, MAX_EXPANDED, info):
                inspected = tail + chunk
                # Scan bytes, including native executables, without buffering
                # the bundle. Fixed system sandbox literals are not owner data.
                require(not owned or (str(ROOT).encode() not in inspected and not re.search(
                    rb"(?:/Users/[^/\s\x00\"']+|/home/[^/\s\x00\"']+|/private/var/folders/|/var/folders/|[A-Za-z]:\\Users\\)",
                    inspected)), "PRIVATE_PATH_IN_APP")
                tail = inspected[-max(512, len(str(ROOT).encode())):]
                target.write(chunk)
    unchanged(path, info)


def trusted_run(argv, env=None, code="VERIFICATION_REJECTED", json_output=True):
    # Bound capture while the original child writes. A temporary file with a
    # post-exit size check would still allow unbounded disk consumption.
    child = subprocess.Popen(argv, cwd=ROOT, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env or VERIFY_ENV)
    deadline = time.monotonic() + 180
    stdout, stderr = bytearray(), bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, (stdout, 16 * 1024))
            selector.register(child.stderr, selectors.EVENT_READ, (stderr, 64 * 1024))
            while selector.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, "VERIFICATION_TIMEOUT")
                for key, _ in selector.select(min(remaining, 1)):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    capture, maximum = key.data
                    require(len(capture) + len(chunk) <= maximum,
                            "VERIFICATION_OUTPUT_OVERSIZE")
                    capture.extend(chunk)
        remaining = deadline - time.monotonic()
        require(remaining > 0, "VERIFICATION_TIMEOUT")
        result = child.wait(timeout=remaining)
        require(result == 0,
                f"{code}:{bytes(stderr[:300]).decode('utf8', errors='replace').strip()}")
        output = bytes(stdout)
    finally:
        if child.poll() is None:
            # Terminate only this original read-only verifier, once. Never
            # replay its invocation or adopt another PID as its terminal proof.
            child.kill()
            child.wait(timeout=10)
        child.stdout.close()
        child.stderr.close()
    return json.loads(output) if json_output else output.decode("utf8")


def node_executable():
    node = shutil.which("node", path=CLEAN_PATH)
    require(node is not None, "NODE_TOOLCHAIN_MISSING")
    return node


def verify_source_package():
    # First verify the canonical candidate with committed source tooling.
    # Only then execute helpers from inside the package during ZIP readback.
    return trusted_run([node_executable(), str(ROOT / "tooling/verify-package.mjs")],
                       code="SOURCE_PACKAGE_REJECTED", json_output=False)


def prepare(expected, destination):
    artifact, public, artifact_info = read_artifact()
    source_before = clean_source(expected, artifact)
    entries = members()
    parents = [(directory, directory.lstat()) for directory in (ROOT / "_output", PACKAGE)]

    def unchanged_package():
        unchanged(ARTIFACT, artifact_info)
        for path, _, info in entries:
            unchanged(path, info)
        for directory, before in parents:
            after = directory.lstat()
            # Output may be a new sibling under _output; only its directory
            # object and mode are pinned, not its changing child list.
            require(
                (after.st_dev, after.st_ino, after.st_mode)
                == (before.st_dev, before.st_ino, before.st_mode)
                and stat.S_ISDIR(after.st_mode),
                "PACKAGE_DIRECTORY_CHANGED",
            )

    source_verification = verify_source_package()
    core_before = verify_core(APP, artifact)
    extractor = APP / "Contents/Resources/app/update-archive.py"
    extractor_info = regular_file(extractor, source_before["archiveHelper"]["maxBytes"])
    extractor_bytes = b"".join(regular_chunks(extractor, source_before["archiveHelper"]["maxBytes"], extractor_info))
    require(extractor_info.st_mode & 0o111
            and hashlib.sha256(extractor_bytes).hexdigest() == source_before["archiveHelper"]["sha256"],
            "EXTRACTOR_BYTES_UNTRUSTED")
    unchanged_package()
    require(not destination.exists() and not destination.is_symlink(), "OUTPUT_EXISTS")
    require(not destination.resolve().is_relative_to(APP), "OUTPUT_INSIDE_APP")
    require(destination.parent.resolve(strict=True) == destination.parent, "OUTPUT_PARENT_ALIAS")
    require(not destination.is_relative_to(PACKAGE), "OUTPUT_INSIDE_PACKAGE")
    require(not destination.is_relative_to(ROOT)
            or destination.is_relative_to(ROOT / "_output"), "OUTPUT_INSIDE_SOURCE")
    destination.mkdir(mode=0o700)
    private = destination / "private"
    private.mkdir(mode=0o700)
    archive_name = f"Farol-{artifact['version']}-darwin-arm64.zip"
    # A refused candidate never leaves a ZIP or release manifest at the public
    # output root. All unfinished bytes stay in the private diagnosis directory.
    archive_path = private / archive_name
    with zipfile.ZipFile(archive_path, "x", allowZip64=False) as archive:
        for path, name, info in entries:
            add_member(archive, path, name, info)
        member = zipfile.ZipInfo("artifact.json")
        member.create_system = 3
        member.external_attr = (stat.S_IFREG | 0o644) << 16
        member.compress_type = zipfile.ZIP_STORED
        archive.writestr(member, json.dumps(public, indent=2) + "\n")
    unchanged_package()
    archive_info = regular_file(archive_path, MAX_ARCHIVE)
    size = archive_info.st_size
    require(0 < size <= MAX_ARCHIVE, "ARCHIVE_SIZE_INVALID")
    digest = sha256_file(archive_path, archive_info)
    stage = private / "restore"
    stage.mkdir(mode=0o700)
    # update-archive.py is the attested native Go binary, not Python source.
    extractor_copy = private / "update-archive.py"
    with extractor_copy.open("xb") as target:
        target.write(extractor_bytes)
    extractor_copy.chmod(0o700)
    extracted = trusted_run([str(extractor_copy), str(archive_path), str(stage), str(size), digest])
    require(
        extracted == {"appPath": str(stage / APP_NAME), "artifactPath": str(stage / "artifact.json")},
        "EXTRACTION_IDENTITY_INVALID",
    )
    unchanged_package()
    restored_artifact = json.loads(b"".join(regular_chunks(stage / "artifact.json", 16 * 1024)))
    require(restored_artifact == public and restored_artifact["artifactPath"] == APP_NAME,
            "RESTORED_ARTIFACT_MISMATCH")
    core_after = verify_core(stage / APP_NAME, artifact)
    require(core_after == core_before, "GO_CORE_ROUNDTRIP_MISMATCH")
    actual = trusted_run(
        # Candidate-owned manifest/hash consistency does not authenticate its
        # JavaScript for execution. Use the independently checked checkout's
        # verifier and declared host Node; never execute the packaged JS entry.
        [node_executable(), str(ROOT / "tooling/verify-package-standalone.mjs"), str(stage / "artifact.json"),
         str(stage / APP_NAME), artifact["version"], artifact["buildVersion"],
         artifact["updateChannel"]],
    )
    require(type(actual) is dict and all(actual.get(field) == artifact[field] for field in FIELDS),
            "PHYSICAL_IDENTITY_MISMATCH")
    require(
        actual.get("updateChannel") == artifact["updateChannel"]
        and actual.get("signing") == "unsigned"
        and actual.get("notarized") is False,
        "PHYSICAL_RELEASE_IDENTITY_MISMATCH",
    )
    unchanged_package()
    unchanged(archive_path, archive_info)
    source_after = clean_source(expected, artifact)
    require(source_after == source_before, "SOURCE_IDENTITY_CHANGED")
    unchanged_package()
    unchanged(archive_path, archive_info)
    manifest = {field: actual[field] for field in FIELDS}
    manifest.update(
        schema="farol.github-release/1", repository="legrch/farol",
        channel="stable" if artifact["updateChannel"] == "github-stable" else "owner-beta", archiveSha256=digest, archiveName=archive_name,
        archiveSize=size, platform="darwin", arch="arm64",
        signing=actual["signing"], notarized=actual["notarized"], sourceDirty=False,
    )
    assert_public_metadata(manifest)
    (private / "artifact.local.json").write_text(json.dumps(artifact, indent=2) + "\n")
    (private / "extraction.json").write_text(json.dumps(extracted, indent=2) + "\n")
    (private / "physical-verification.json").write_text(json.dumps(actual, indent=2) + "\n")
    (private / "source-before.json").write_text(json.dumps(source_before, indent=2) + "\n")
    (private / "source-after.json").write_text(json.dumps(source_after, indent=2) + "\n")
    (private / "source-package-verification.txt").write_text(source_verification)
    (private / "core-verification.json").write_text(json.dumps(core_after, indent=2) + "\n")
    (private / "farol-release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (private / "SHA256SUMS").write_text(f"{digest}  {archive_name}\n")
    for name in (archive_name, "farol-release.json", "SHA256SUMS"):
        os.rename(private / name, destination / name)
    print(json.dumps({"archive": str(destination / archive_name), "manifest": manifest,
                      "privateVerification": str(private / "physical-verification.json")}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expected_head", help="full clean HEAD SHA-1")
    parser.add_argument("output_directory", type=Path, help="new private output directory")
    args = parser.parse_args()
    try:
        prepare(args.expected_head, args.output_directory.absolute())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError,
            zipfile.BadZipFile) as error:
        print(f"RELEASE_ARCHIVE_REFUSED:{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
