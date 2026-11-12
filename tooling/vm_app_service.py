"""Farol's closed, data-only producer for terminal-mac.app-service/4.

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

    def admit_observation(self, receipt, observation, allow_pending_foreground=False):
        """Bind native retained state to the last ACK, never adopt another run."""
        if not isinstance(observation, dict):
            refuse("APP_SERVICE_REPLY_INVALID")
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
            # required for Farol's windowed UI scenario. A menu-only application
            # can use the generic service but must not claim this GUI gate.
            front = observation.get("foreground")
            windows = observation.get("windows")
            if front not in ("true", "false") or not isinstance(windows, str):
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            count = int(windows) if windows.isdecimal() and len(windows) <= 3 else None
            if count is None and windows != "unconfirmed":
                refuse("APP_SERVICE_PHASE_UNCONFIRMED")
            if front != "true" or count is None or not 1 <= count <= 64:
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
            if command in ("open", "install") and reply.get("rootExit") != "no-owned-root":
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


def farol_release_policy(payload):
    """Finite release checks owned by Farol; no policy comes from the archive."""
    if payload.get("appName") != "Farol.app" or payload.get("bundleID") != "io.github.legrch.farol":
        refuse("APP_PAYLOAD_INCOMPATIBLE")
    return {
        "schema": "terminal-mac.signature-policy/1", "outer": "explicitly-unsigned",
        "checks": [
            {"path": "Contents/MacOS/Farol", "kind": "exact-executable-file",
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
