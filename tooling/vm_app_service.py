"""The product's closed, data-only producer for terminal-mac.app-service/4.

Only call after vm-smoke.verify() has qualified the exact local release archive.
These files select *application data*, never an interpreter, guest script, path
to execute, environment, arbitrary CLI command or host process. The compiled
guest helper alone implements the lifecycle. Nothing here proves that a
self-declared manifest is an authenticated publisher identity.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import uuid
import zipfile

PAYLOAD_SCHEMA = "terminal-mac.app-payload/1"
SERVICE_SCHEMA = "terminal-mac.app-service/4"
INSTALL_ROOT = "/Applications"
INSTALL_LOCATION = "guest-applications/1"
def _identity_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "vm_dev_identity", Path(__file__).resolve().with_name("vm_dev_identity.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REASONS = frozenset({
    "APP_PAYLOAD_UNQUALIFIED", "APP_PAYLOAD_UNSAFE", "APP_PAYLOAD_DIGEST",
    "APP_PAYLOAD_TOO_LARGE", "APP_PAYLOAD_INCOMPATIBLE",
    "APP_SERVICE_REPLY_INVALID", "APP_SERVICE_BINDING_INVALID",
    "APP_SERVICE_PHASE_UNCONFIRMED",
})
MAX_ENTRIES = 25000
MAX_BYTES = 4_294_967_296
MAX_FILE = 2_147_483_648


class ProducerRefusal(Exception):
    def __init__(self, reason):
        super().__init__(reason if reason in REASONS else "APP_PAYLOAD_UNSAFE")


def refuse(reason):
    raise ProducerRefusal(reason)


def hexdigest(value):
    return re.fullmatch(r"[a-f0-9]{64}", value or "") is not None


def safe_path(value):
    if not isinstance(value, str) or not (0 < len(value.encode("utf-8")) <= 1024):
        return False
    if any(ord(c) < 32 or ord(c) > 126 or c in "\\:" for c in value):
        return False
    parts = value.split("/")
    return 0 < len(parts) <= 32 and all(
        bool(p) and p not in (".", "..") and len(p.encode("utf-8")) <= 255
        and not p.endswith(" ") for p in parts
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def _zip_kind(info):
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind == stat.S_IFLNK:
        return "symlink"
    if info.is_dir() or kind == stat.S_IFDIR:
        return "directory"
    if kind in (0, stat.S_IFREG):
        return "file"
    refuse("APP_PAYLOAD_UNSAFE")


def _mode(info, kind):
    raw = info.external_attr >> 16
    if raw & 0o7000:
        refuse("APP_PAYLOAD_UNSAFE")
    mode = raw & 0o777
    if mode == 0:
        mode = 0o755 if kind == "directory" else 0o644
    return mode


def _tree(archive, release, identity):
    """Plan against the archive without publishing guest-visible data."""
    if (not isinstance(release, dict) or
        not isinstance(identity, dict) or
        not hexdigest(release.get("archiveSha256")) or
        not hexdigest(release.get("artifactSha256")) or
        release.get("product") != identity.get("name") or
        release.get("bundleId") != identity.get("bundleId") or
        release.get("version") is None):
        refuse("APP_PAYLOAD_UNQUALIFIED")
    app_name = identity["name"] + ".app"
    if not safe_path(app_name) or "/" in app_name:
        refuse("APP_PAYLOAD_UNQUALIFIED")
    nodes = {}
    sources = {}
    total = 0
    seen_zip = set()
    prefix = app_name + "/"
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            raw = info.filename
            if raw in seen_zip:
                refuse("APP_PAYLOAD_UNSAFE")
            seen_zip.add(raw)
            if raw == "artifact.json":
                continue
            if raw in (app_name, prefix):
                if _zip_kind(info) != "directory":
                    refuse("APP_PAYLOAD_UNSAFE")
                continue
            if not raw.startswith(prefix):
                refuse("APP_PAYLOAD_UNSAFE")
            path = raw[len(prefix):]
            if info.is_dir():
                path = path.rstrip("/")
            if not safe_path(path) or path in nodes:
                refuse("APP_PAYLOAD_UNSAFE")
            kind = _zip_kind(info)
            mode = _mode(info, kind)
            entry = {"path": path, "kind": kind, "mode": mode,
                     "bytes": 0, "sha256": "", "blob": "", "target": ""}
            if kind == "file":
                if info.file_size < 0 or info.file_size > MAX_FILE:
                    refuse("APP_PAYLOAD_TOO_LARGE")
                total += info.file_size
                if total > MAX_BYTES:
                    refuse("APP_PAYLOAD_TOO_LARGE")
                digest = hashlib.sha256()
                length = 0
                with package.open(info) as stream:
                    for data in iter(lambda: stream.read(1024 * 1024), b""):
                        length += len(data)
                        if length > info.file_size:
                            refuse("APP_PAYLOAD_DIGEST")
                        digest.update(data)
                if length != info.file_size:
                    refuse("APP_PAYLOAD_DIGEST")
                entry.update(bytes=length, sha256=digest.hexdigest(),
                             blob="blob-" + digest.hexdigest())
                sources[path] = info
            elif kind == "symlink":
                if info.file_size > 4096:
                    refuse("APP_PAYLOAD_UNSAFE")
                try:
                    target = package.read(info).decode("utf-8")
                except UnicodeError:
                    refuse("APP_PAYLOAD_UNSAFE")
                if not safe_path(target):
                    refuse("APP_PAYLOAD_UNSAFE")
                entry["target"] = target
            nodes[path] = entry
            if len(nodes) > MAX_ENTRIES:
                refuse("APP_PAYLOAD_TOO_LARGE")

        # Most ZIP tools omit directory records. Materialize their ordinary
        # parents explicitly; do not treat a symlink parent as a directory.
        for path in list(nodes):
            parts = path.split("/")
            for count in range(1, len(parts)):
                parent = "/".join(parts[:count])
                if parent not in nodes:
                    nodes[parent] = {"path": parent, "kind": "directory", "mode": 0o755,
                                     "bytes": 0, "sha256": "", "blob": "", "target": ""}
        if len(nodes) > MAX_ENTRIES:
            refuse("APP_PAYLOAD_TOO_LARGE")
        folded = set()
        for path, entry in nodes.items():
            if path.lower() in folded:
                refuse("APP_PAYLOAD_UNSAFE")
            folded.add(path.lower())
            parts = path.split("/")
            for i in range(1, len(parts)):
                if nodes["/".join(parts[:i])]["kind"] != "directory":
                    refuse("APP_PAYLOAD_UNSAFE")

        # Mirror the native component-wise symlink check. Never allow a link
        # outside the declared app tree or a cycle, including Versions/Current.
        def resolve(path):
            pending = path.split("/")
            resolved = []
            visited = set()
            hops = 0
            while pending:
                part = pending.pop(0)
                candidate = "/".join(resolved + [part])
                node = nodes.get(candidate)
                if node is None:
                    refuse("APP_PAYLOAD_UNSAFE")
                if node["kind"] == "symlink":
                    if candidate in visited or hops >= 40:
                        refuse("APP_PAYLOAD_UNSAFE")
                    visited.add(candidate)
                    hops += 1
                    pending = node["target"].split("/") + pending
                else:
                    if pending and node["kind"] != "directory":
                        refuse("APP_PAYLOAD_UNSAFE")
                    resolved.append(part)
        for path, entry in nodes.items():
            if entry["kind"] == "symlink":
                resolve(path)

        if nodes.get("Contents", {}).get("kind") != "directory":
            refuse("APP_PAYLOAD_UNSAFE")
        if nodes.get("Contents/Info.plist", {}).get("kind") != "file":
            refuse("APP_PAYLOAD_UNSAFE")
        try:
            info = plistlib.loads(package.read(sources["Contents/Info.plist"]))
        except (ValueError, TypeError, KeyError):
            refuse("APP_PAYLOAD_UNSAFE")
        executable = info.get("CFBundleExecutable")
        if (info.get("CFBundleIdentifier") != identity["bundleId"] or
            info.get("CFBundleShortVersionString") != release["version"] or
            not isinstance(executable, str) or not safe_path(executable) or "/" in executable or
            nodes.get("Contents/MacOS/" + executable, {}).get("kind") != "file" or
            not nodes["Contents/MacOS/" + executable]["mode"] & 0o111):
            refuse("APP_PAYLOAD_INCOMPATIBLE")

    entries = [nodes[p] for p in sorted(nodes)]
    return {
        "schema": PAYLOAD_SCHEMA, "appName": app_name,
        "bundleID": identity["bundleId"], "version": release["version"],
        "artifactSHA256": release["artifactSha256"],
        "archiveSHA256": release["archiveSha256"],
        "entries": entries,
    }, sources


def _write_exclusive(directory_fd, name, data_chunks):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=directory_fd)
    try:
        digest = hashlib.sha256()
        length = 0
        for data in data_chunks:
            length += len(data)
            digest.update(data)
            view = memoryview(data)
            while len(view):
                count = os.write(fd, view)
                if count <= 0:
                    refuse("APP_PAYLOAD_UNSAFE")
                view = view[count:]
        os.fsync(fd)
        return digest.hexdigest(), length
    finally:
        os.close(fd)


def stage_release_payload(archive, verified_release, stage, identity):
    """One qualified no-follow archive descriptor, create-only run-owned output.

    Publication does not follow filenames after opening the original archive;
    an archive replacement, change or alias races fail closed. Any partly
    published stage remains a custody record, never a reason to retry a guest
    operation or adopt partially copied blobs.
    """
    archive, stage = Path(archive), Path(stage)
    if stage.is_symlink() or not stage.is_dir():
        refuse("APP_PAYLOAD_UNSAFE")
    try:
        before_name = archive.lstat()
    except OSError:
        refuse("APP_PAYLOAD_UNSAFE")
    if (not stat.S_ISREG(before_name.st_mode) or before_name.st_nlink != 1 or
        before_name.st_size <= 0 or before_name.st_size > 2 * 1024**3):
        refuse("APP_PAYLOAD_UNSAFE")

    def descriptor_identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_uid,
                info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def digest_stream(stream):
        stream.seek(0)
        value = hashlib.sha256()
        for piece in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(piece)
        stream.seek(0)
        return value.hexdigest()

    original = os.open(archive, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(original, "rb") as source_stream:
        if descriptor_identity(os.fstat(source_stream.fileno())) != descriptor_identity(before_name):
            refuse("APP_PAYLOAD_UNSAFE")
        before = digest_stream(source_stream)
        if before != verified_release.get("archiveSha256"):
            refuse("APP_PAYLOAD_DIGEST")
        payload, source = _tree(source_stream, verified_release, identity)
        source_stream.seek(0)
        stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            s = os.fstat(stage_fd)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.geteuid() or s.st_mode & 0o077:
                refuse("APP_PAYLOAD_UNSAFE")
            published = set()
            with zipfile.ZipFile(source_stream) as package:
                for entry in payload["entries"]:
                    if entry["kind"] != "file":
                        continue
                    blob = entry["blob"]
                    if blob in published:
                        continue
                    published.add(blob)
                    info = source[entry["path"]]
                    with package.open(info) as data:
                        expected = (entry["sha256"], entry["bytes"])
                        actual = _write_exclusive(stage_fd, blob,
                            iter(lambda: data.read(1024 * 1024), b""))
                    if actual != expected:
                        refuse("APP_PAYLOAD_DIGEST")
            # Check the SAME descriptor again before publishing the final
            # manifest. A pathname re-open would allow a TOCTOU replacement.
            if (digest_stream(source_stream) != before or
                descriptor_identity(os.fstat(source_stream.fileno())) != descriptor_identity(before_name) or
                descriptor_identity(archive.lstat()) != descriptor_identity(before_name)):
                refuse("APP_PAYLOAD_DIGEST")
            payload_bytes = (json.dumps(payload, sort_keys=True, ensure_ascii=True,
                           separators=(",", ":")) + "\n").encode("utf-8")
            if len(payload_bytes) > 4 * 1024 * 1024:
                refuse("APP_PAYLOAD_TOO_LARGE")
            actual = _write_exclusive(stage_fd, "app-payload.json", [payload_bytes])
            if actual != (hashlib.sha256(payload_bytes).hexdigest(), len(payload_bytes)):
                refuse("APP_PAYLOAD_DIGEST")
            os.fsync(stage_fd)
        finally:
            os.close(stage_fd)
    return {
        "schema": "farol.vm-app-service.stage/1",
        "manifestSHA256": hashlib.sha256(payload_bytes).hexdigest(),
        "appName": payload["appName"],
        "archiveSHA256": before, "artifactSHA256": verified_release["artifactSha256"],
        "fileCount": sum(e["kind"] == "file" for e in payload["entries"]),
        "blobCount": len(published), "bytes": sum(e["bytes"] for e in payload["entries"]),
    }


class ServiceAdmission:
    """Pure ordered receipts; no guest side effects or IO."""
    steps = ("open", "install", "launch", "activate", "quit", "close")
    states = ("ready", "installed", "running", "running", "installed", "closed")

    def __init__(self, run_id, nonce, manifest, owner, app_name, acceptance, relaunch=False):
        if (not re.fullmatch(r"run-[a-f0-9]{32}", run_id) or
            not re.fullmatch(r"[a-f0-9]{64}", nonce) or
            not hexdigest(manifest) or not hexdigest(acceptance) or not owner or len(owner) > 128 or
            not safe_path(app_name) or "/" in app_name or not app_name.endswith(".app")):
            refuse("APP_PAYLOAD_UNQUALIFIED")
        self.run_id, self.nonce, self.manifest, self.owner = run_id, nonce, manifest, owner
        self.acceptance = acceptance
        self.installed_application = INSTALL_ROOT + "/" + app_name
        if relaunch:
            self.steps = ("open", "install", "launch", "activate", "quit",
                          "launch", "activate", "quit", "close")
            self.states = ("ready", "installed", "running", "running", "installed",
                           "running", "running", "installed", "closed")
        self.next_sequence = 0
        self.helper = None
        self.last_pid = None
        self.launch_pids = []

    def arguments(self, command, operation):
        if command != self.steps[self.next_sequence] or not re.fullmatch(
                r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", operation):
            refuse("APP_SERVICE_BINDING_INVALID")
        return ("app-service", "--service-command", command,
                "--service-run", self.run_id, "--service-nonce", self.nonce,
                "--service-operation", operation, "--service-sequence",
                str(self.next_sequence), "--service-manifest", self.manifest,
                "--service-acceptance", self.acceptance)

    def observation_arguments(self, receipt):
        """A fresh READ-ONLY request; never resends the original mutating ID."""
        operation = str(uuid.uuid4()).lower()
        return ("app-service", "--service-command", "observe",
                "--service-run", self.run_id, "--service-nonce", self.nonce,
                "--service-operation", operation, "--service-sequence",
                str(receipt["sequence"]), "--service-manifest", self.manifest,
                "--service-acceptance", self.acceptance)

    @staticmethod
    def validate_status(value):
        # Every retained native status is a closed value, regardless of phase.
        if (value.get("applicationRunning") not in ("true", "false", "unconfirmed") or
                value.get("foreground") not in ("true", "false", "unconfirmed")):
            refuse("APP_SERVICE_REPLY_INVALID")
        windows = value.get("windows")
        if not isinstance(windows, str) or not (windows == "unconfirmed" or re.fullmatch(r"[0-9]{1,3}", windows)):
            refuse("APP_SERVICE_REPLY_INVALID")

    def admit_observation(self, receipt, observation, allow_pending_foreground=False):
        """Bind native retained state to the last ACK, never adopt another run."""
        if not isinstance(observation, dict):
            refuse("APP_SERVICE_REPLY_INVALID")
        self.validate_status(observation)
        checks = {
            "serviceContract": SERVICE_SCHEMA,
            "executor": "compiled-native-helper", "serverCodeSource": "helper-binary",
            "shell": "not-used", "runId": self.run_id, "nonce": self.nonce,
            "manifestSHA256": self.manifest, "acceptanceSHA256": self.acceptance,
            "operationId": receipt["operationId"],
            "sequence": str(receipt["sequence"]),
            "state": receipt["state"], "pending": "",
            "restoredObservation": "false", "helperInstance": receipt["helperInstance"],
            "applicationPID": receipt["applicationPID"],
            "serviceReady": "false" if receipt["command"] == "close" else "true",
            "installationRoot": INSTALL_ROOT, "installationLocation": INSTALL_LOCATION,
            "installedApplication": receipt["installedApplication"],
            "installationEvidence": receipt["installationEvidence"],
            "rootExit": receipt["rootExit"],
        }
        if any(observation.get(k) != v for k, v in checks.items()):
            refuse("APP_SERVICE_REPLY_INVALID")
        if observation.get("applicationRunning") != receipt["applicationRunning"]:
            refuse("APP_SERVICE_PHASE_UNCONFIRMED")
        if receipt["command"] == "activate":
            # NSWorkspace.activate() may return before a usable window exists.
            # An AX-observed positive window count and foreground PID are
            # required for the product's windowed UI scenario. A menu-only application
            # can use the generic service but must not claim this GUI gate.
            front = observation.get("foreground")
            windows = observation.get("windows")
            if front not in ("true", "false") or not isinstance(windows, str):
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            count = int(windows) if windows.isdecimal() and len(windows) <= 3 else None
            if count is None and windows != "unconfirmed":
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if front != "true" or count != 1:
                if allow_pending_foreground and (front == "false" or windows in ("0", "unconfirmed")):
                    return None
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
        return {
            "schema": "farol.vm-app-service.observation/1",
            "operationId": receipt["operationId"],
            "sequence": receipt["sequence"], "state": observation["state"],
            "helperInstance": observation["helperInstance"],
            "applicationPID": observation["applicationPID"],
            "applicationRunning": observation["applicationRunning"],
            "foreground": observation.get("foreground", "unconfirmed"),
            "windows": observation.get("windows", "unconfirmed"),
            "rootExit": observation.get("rootExit", "unconfirmed"),
            "installationLocation": observation["installationLocation"],
            "installedApplication": observation["installedApplication"],
            "installationEvidence": observation["installationEvidence"],
        }

    def admit_reply(self, command, operation, reply):
        i = self.next_sequence
        if not isinstance(reply, dict) or command != self.steps[i]:
            refuse("APP_SERVICE_REPLY_INVALID")
        self.validate_status(reply)
        checks = {"serviceContract": SERVICE_SCHEMA, "executor": "compiled-native-helper",
                  "serverCodeSource": "helper-binary", "shell": "not-used",
                  "runId": self.run_id, "nonce": self.nonce,
                  "manifestSHA256": self.manifest, "acceptanceSHA256": self.acceptance, "operationId": operation,
                  "sequence": str(i), "state": self.states[i],
                  "pending": "", "restoredObservation": "false",
                  "serviceReady": "false" if command == "close" else "true",
                  "installationRoot": INSTALL_ROOT,
                  "installationLocation": INSTALL_LOCATION,
                  "installedApplication": "" if command == "open" else self.installed_application,
                  "installationEvidence": ("not-installed" if command == "open" else
                                           "verified-at-close" if command == "close" else
                                           "verified-at-install")}
        if any(reply.get(k) != v for k, v in checks.items()):
            refuse("APP_SERVICE_REPLY_INVALID")
        helper = reply.get("helperInstance")
        if not isinstance(helper, str) or not re.fullmatch(
                r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", helper):
            refuse("APP_SERVICE_REPLY_INVALID")
        if self.helper is not None and helper != self.helper:
            refuse("APP_SERVICE_REPLY_INVALID")
        if command in ("launch", "activate"):
            pid = reply.get("applicationPID")
            if not isinstance(pid, str) or not pid.isdecimal() or not 0 < int(pid) <= 2147483647:
                refuse("APP_SERVICE_REPLY_INVALID")
            if reply.get("applicationRunning") != "true" or reply.get("rootExit") != "not-observed":
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if command == "activate" and reply.get("foreground") not in ("true", "false"):
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if self.last_pid is not None and pid != self.last_pid:
                refuse("APP_SERVICE_BINDING_INVALID")
            if command == "launch":
                self.launch_pids.append(pid)
            self.last_pid = pid
        else:
            if reply.get("applicationPID") not in ("", None):
                refuse("APP_SERVICE_REPLY_INVALID")
            if command in ("quit", "close") and (
                    reply.get("applicationRunning") != "false" or reply.get("rootExit") != "observed"):
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if command in ("open", "install") and (
                    reply.get("rootExit") != "no-owned-root" or reply.get("applicationRunning") != "false"):
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if command == "quit":
                self.last_pid = None
        self.helper = helper
        self.next_sequence += 1
        return {
            "command": command, "sequence": i, "operationId": operation,
            "state": reply["state"], "helperInstance": helper,
            "applicationPID": reply.get("applicationPID", ""),
            "applicationRunning": reply.get("applicationRunning", "unconfirmed"),
            "foreground": reply.get("foreground", "unconfirmed"),
            "windows": reply.get("windows", "unconfirmed"),
            "rootExit": reply.get("rootExit", "unconfirmed"),
            "installationLocation": reply["installationLocation"],
            "installedApplication": reply["installedApplication"],
            "installationEvidence": reply["installationEvidence"],
        }


# The release launcher is a fixed product contract, not supplied by the ZIP.
_RELEASE_LAUNCHER = b'''#!/bin/sh
set -eu

launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=${launcher_path%/*}
contents_dir=${macos_dir%/*}
export ELECTRON_FORCE_IS_PACKAGED=true
exec "$contents_dir/Resources/app/farol-backend" run-desktop-launcher "$@"
'''


def farol_release_policy(payload, identity=None):
    """Finite release checks owned by the product; no policy comes from the archive."""
    try:
        identity = identity or _identity_module().release_identity()
    except ValueError:
        refuse("APP_PAYLOAD_INCOMPATIBLE")
    if payload.get("appName") != identity["appName"] or payload.get("bundleID") != identity["bundleId"]:
        refuse("APP_PAYLOAD_INCOMPATIBLE")
    return {
        "schema": "terminal-mac.signature-policy/1", "outer": "explicitly-unsigned",
        "checks": [
            {"path": "Contents/MacOS/" + identity["executable"], "kind": "exact-executable-file",
             "sha256": hashlib.sha256(_RELEASE_LAUNCHER).hexdigest()},
            {"path": "Contents/Resources/app/farol-backend",
             "kind": "static-strict-all-architectures", "sha256": ""},
            {"path": "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
             "kind": "static-strict-all-architectures-no-resources", "sha256": ""},
        ],
    }


def stage_acceptance(stage, receipt, policy):
    """Commit controller-selected policy separately from untrusted payload.

    Caller has already qualified the archive and independently pinned the tree.
    Only the returned acceptance hash travels in the pre-effect command binding.
    This commitment is not a publisher signature or a Gatekeeper exception.
    """
    fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            refuse("APP_PAYLOAD_UNSAFE")
        rawfd = os.open("app-payload.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        with os.fdopen(rawfd, "rb") as stream:
            st = os.fstat(stream.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 4*1024*1024:
                refuse("APP_PAYLOAD_UNSAFE")
            raw = stream.read(4*1024*1024 + 1)
        if hashlib.sha256(raw).hexdigest() != receipt["manifestSHA256"]:
            refuse("APP_PAYLOAD_DIGEST")
        payload = json.loads(raw)
        selected = policy(payload)
        policy_bytes = (json.dumps(selected, sort_keys=True, separators=(",", ":")) + "\n").encode()
        accepted = {key: payload[key] for key in ("appName", "bundleID", "version", "artifactSHA256", "archiveSHA256")}
        accepted.update(schema="terminal-mac.accepted-application/1",
                        payloadManifestSHA256=receipt["manifestSHA256"],
                        signaturePolicySHA256=hashlib.sha256(policy_bytes).hexdigest(),
                        installLocation=INSTALL_LOCATION, allowedJourney="installed-lifecycle")
        accepted_bytes = (json.dumps(accepted, sort_keys=True, separators=(",", ":")) + "\n").encode()
        _write_exclusive(fd, "verification-policy.json", [policy_bytes])
        _write_exclusive(fd, "accepted-application.json", [accepted_bytes])
        os.fsync(fd)
    finally:
        os.close(fd)
    return hashlib.sha256(accepted_bytes).hexdigest()


def _inventory_tree_digest(entries):
    """farol.tree-digest/v2 over an already validated physical inventory.

    Identical length-delimited encoding to artifact-tree-digest/digest.ts;
    directory preorder matters (a global lexicographic path sort is wrong).
    """
    import struct
    children = {}
    for entry in entries:
        parent, _, leaf = entry["path"].rpartition("/")
        children.setdefault(parent, []).append((leaf, entry))
    digest = hashlib.sha256(b"farol.tree-digest/v2\0")
    def text(value):
        raw = value.encode("utf-8")
        digest.update(struct.pack(">I", len(raw))); digest.update(raw)
    def walk(parent):
        for _, entry in sorted(children.get(parent, [])):
            text(entry["path"])
            digest.update({"directory": b"d", "file": b"f", "symlink": b"l"}[entry["kind"]])
            digest.update(struct.pack(">I", entry["mode"]))
            if entry["kind"] == "directory": walk(entry["path"])
            elif entry["kind"] == "file": digest.update(bytes.fromhex(entry["sha256"]))
            else: text(entry["target"])
    walk("")
    return digest.hexdigest()


def _dev_file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _private_regular_bytes(path, limit):
    path = Path(path)
    if not path.is_absolute(): refuse("APP_PAYLOAD_UNSAFE")
    # Every original component is physical. Never resolve an alias into trust.
    for parent in reversed(path.parents):
        if not stat.S_ISDIR(parent.lstat().st_mode): refuse("APP_PAYLOAD_UNSAFE")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or
            before.st_nlink != 1 or before.st_mode & 0o077 or not 0 < before.st_size <= limit):
            refuse("APP_PAYLOAD_UNSAFE")
        raw = stream.read(limit + 1)
        if len(raw) != before.st_size or _dev_file_identity(os.fstat(stream.fileno())) != _dev_file_identity(before) or _dev_file_identity(path.lstat()) != _dev_file_identity(before):
            refuse("APP_PAYLOAD_DIGEST")
    return raw


def prepare_dev_session(archive, receipt, expected_receipt_sha256, stage):
    """Stage a separately accepted local Dev derivative, never a stable ZIP.

    Exact receipt selection precedes staging. Guest native signature checks
    remain mandatory before publishing /Applications; no host profile is read.
    """
    archive, receipt, stage = Path(archive), Path(receipt), Path(stage)
    try:
        dev = _identity_module().dev_identity()
    except ValueError:
        refuse("APP_PAYLOAD_UNQUALIFIED")
    if not hexdigest(expected_receipt_sha256) or not re.fullmatch(r"run-[a-f0-9]{32}", stage.name):
        refuse("APP_PAYLOAD_UNQUALIFIED")
    raw = _private_regular_bytes(receipt, 16384)
    if hashlib.sha256(raw).hexdigest() != expected_receipt_sha256:
        refuse("APP_PAYLOAD_DIGEST")
    selected = json.loads(raw)
    if (selected.get("schema") != "farol.vm-dev-artifact/1" or
        selected.get("kind") != "local-dev-derivative" or selected.get("appName") != dev["appName"] or
        selected.get("bundleId") != dev["bundleId"] or selected.get("environment") != "dev" or
        selected.get("hostLaunch") is not False or selected.get("profileImport") is not False or
        selected.get("officialRelease") is not False or
        not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", selected.get("version", "")) or
        not re.fullmatch(r"[a-f0-9]{40}", selected.get("sourceCommit", "")) or
        not all(hexdigest(selected.get(k)) for k in ("artifactSha256", "launcherSHA256", "parentBuildId", "sourceTreeDigest", "buildManifestSHA256"))):
        refuse("APP_PAYLOAD_UNQUALIFIED")
    launcher = (Path(__file__).parent / "vm-dev-launcher.sh").read_bytes()
    if hashlib.sha256(launcher).hexdigest() != selected["launcherSHA256"]:
        refuse("APP_PAYLOAD_INCOMPATIBLE")
    # Archive pathname components are checked independently of receipt metadata.
    for parent in reversed(archive.parents):
        if not stat.S_ISDIR(parent.lstat().st_mode): refuse("APP_PAYLOAD_UNSAFE")
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 or
            before.st_mode & 0o022 or not 0 < before.st_size <= 2*1024**3): refuse("APP_PAYLOAD_UNSAFE")
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024*1024), b""): digest.update(chunk)
        release = dict(product=dev["product"], bundleId=dev["bundleId"], version=selected["version"],
                       archiveSha256=digest.hexdigest(), artifactSha256=selected["artifactSha256"])
        source.seek(0)
        identity = dict(name=dev["product"], bundleId=dev["bundleId"])
        payload, _ = _tree(source, release, identity)
        if _inventory_tree_digest(payload["entries"]) != selected["artifactSha256"]:
            refuse("APP_PAYLOAD_DIGEST")
        if _dev_file_identity(os.fstat(source.fileno())) != _dev_file_identity(before) or _dev_file_identity(archive.lstat()) != _dev_file_identity(before): refuse("APP_PAYLOAD_DIGEST")
    # stage_release_payload reopens no-follow and checks the independently
    # captured archive digest before AND after publishing its accepted inventory.
    result = stage_release_payload(archive, release, stage, identity)
    def dev_policy(payload):
        if payload["appName"] != dev["appName"] or payload["bundleID"] != dev["bundleId"]:
            refuse("APP_PAYLOAD_INCOMPATIBLE")
        policy = farol_release_policy(payload, dev)
        policy["checks"][0]["sha256"] = hashlib.sha256(launcher).hexdigest()
        return policy
    acceptance = stage_acceptance(stage, result, dev_policy)
    return dict(runId=stage.name, manifestSHA256=result["manifestSHA256"],
                acceptanceSHA256=acceptance, artifactSHA256=result["artifactSHA256"])
