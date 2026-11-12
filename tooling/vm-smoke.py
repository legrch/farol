#!/usr/bin/env python3
"""Bounded exact-release UI smoke via terminal-mac guest actions only."""
import argparse
import fcntl
import hashlib
import json
import math
import os
import plistlib
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile

MAX_ZIP = 2 * 1024**3
REPO = "legrch/farol"
IDENTITY = json.loads(os.environ.get("FAROL_VM_PRODUCT_IDENTITY", "{}"))
# Same discriminator tooling/vm-e2e/bundle-driver.mjs writes into manifest.json.
DRIVER_MANIFEST_SCHEMA = 'farol.vm-e2e.driver-manifest/1'
DRIVER_STAGE_NAMES = ('driver.bundle.mjs', 'node', 'driver.manifest.json')


class Refused(Exception):
    pass


# Failure evidence is a closed, content-free projection of untrusted tool output.
# Raw stderr, argv, exception messages and process output are NEVER persisted.
SAFE_ACTION_REASONS = frozenset((
    'TERMINAL_GUARD_INVALID', 'TERMINAL_FOCUS_UNVERIFIED',
    'TERMINAL_LAUNCH_UNAVAILABLE', 'TERMINAL_LAUNCH_UNCONFIRMED',
    'TERMINAL_CAPABILITY_UNSUPPORTED', 'MAILBOX_TIMEOUT',
    'CANCELLED', 'UNCLASSIFIED',
    # terminal-mac compiled app-service closed OutcomeFailure reasons
    'APP_SERVICE_INVALID', 'APP_SERVICE_BINDING', 'APP_SERVICE_BUSY', 'APP_SERVICE_UNRESOLVED',
    'APP_SERVICE_EXPIRED', 'APP_SERVICE_REPLAY', 'APP_SERVICE_CUSTODY', 'APP_SERVICE_PAYLOAD_INVALID',
    'APP_SERVICE_DIGEST', 'APP_SERVICE_UNSAFE_PATH', 'APP_SERVICE_IO', 'APP_SERVICE_NOT_INSTALLED',
    'APP_SERVICE_RUNNING', 'APP_SERVICE_NOT_RUNNING', 'APP_SERVICE_APP_IDENTITY', 'APP_SERVICE_INSTALLED_COLLISION',
    'APP_SERVICE_LAUNCH_UNKNOWN', 'APP_SERVICE_QUIT_UNKNOWN', 'APP_SERVICE_PUBLICATION_UNKNOWN',
))

# Closed vocabulary: arbitrary error strings (even uppercase) are not codes.
# Keep this source-owned allowlist synchronized with deliberate failure contracts.
SAFE_FAILURE_CODES = frozenset((
    'UNCLASSIFIED',
    # asset
    'ASSET_FILE_INVALID', 'MANIFEST_INVALID', 'VERSION_INVALID', 'RELEASE_IDENTITY_INVALID',
    'ARCHIVE_NAME_INVALID', 'SOURCE_IDENTITY_INVALID', 'DIGEST_INVALID', 'CHECKSUMS_INVALID',
    'ARCHIVE_DIGEST_INVALID', 'ARCHIVE_PATH_INVALID', 'ARCHIVE_EXPANSION_LIMIT', 'ARCHIVE_ENTRY_INVALID',
    'ARCHIVE_LINK_INVALID', 'ARCHIVE_LINK_ESCAPE', 'APP_MISSING', 'BUNDLE_IDENTITY_INVALID',
    'ARTIFACT_MISSING', 'ARTIFACT_IDENTITY_MISMATCH', 'ARTIFACT_DIGEST_MISMATCH', 'DIGEST_TOOL_UNAVAILABLE',
    'DIGEST_TOOL_FAILED',
    # infra
    'DOWNLOAD_DEADLINE_EXCEEDED', 'LATEST_NOT_STABLE', 'LATEST_TAG_INVALID', 'LATEST_ASSET_MISSING',
    'LATEST_ASSET_URL_INVALID', 'DOWNLOAD_LIMIT', 'DOWNLOAD_SIZE_INVALID', 'HOST_DEV_STILL_RUNNING',
    'DEV_SOURCE_IDENTITY_INVALID', 'DEV_PROFILE_UNSAFE', 'DEV_CONFIG_INVALID', 'DEV_EFFECT_UNKNOWN',
    'DEV_TUNNEL_MISSING', 'DEV_CREDENTIAL_NOT_STORED', 'DEV_KEY_UNSAFE', 'DEV_KEY_CHANGED',
    'DEV_KEY_INVALID', 'DEV_CONNECTION_CHANGED', 'HOST_PRODUCT_PROFILE_FORBIDDEN', 'ARTIFACT_SHARE_REQUIRED',
    'INSTANCE_RECEIPT_UNSAFE', 'INSTANCE_RECEIPT_INVALID', 'INFRASTRUCTURE_CONFIG_REQUIRED', 'CONFIG_FIELDS_INVALID',
    'BOOTSTRAP_MODE_INVALID', 'TIMEOUT_INVALID', 'TERMINAL_POINT_REQUIRED', 'TERMINAL_POINT_INVALID',
    'TERMINAL_POINT_OUTSIDE_DISPLAY', 'MENU_POINT_INVALID', 'MENU_POINT_OUTSIDE_DISPLAY', 'VM_NAME_INVALID',
    'VM_MISSING', 'VM_BUSY', 'VM_NOT_RUNNING', 'VM_MACHINE_FILE_INVALID',
    'TERMINAL_MAC_PACKAGE_REQUIRED', 'TERMINAL_MAC_IDENTITY_INVALID', 'GUEST_TOOLS_MISSING', 'EXCHANGE_SHARE_REQUIRED',
    'CLOSED_DOWNLOAD_FORBIDDEN', 'CLOSED_MODE_INVALID', 'CLOSED_REQUIRES_OFFLINE_MACHINE', 'CLOSED_REQUIRES_FRESH_VM_BOOT',
    'CLOSED_NETWORK_CONFIG_CHANGED',
    # guest
    'DEADLINE_EXCEEDED', 'GUEST_CLI_TIMEOUT', 'GUEST_CLI_LAUNCH_FAILED', 'GUEST_CLI_FAILED',
    'GUEST_CLI_REPLY_INVALID', 'GUEST_ACTION_FAILED', 'GUEST_PERMISSIONS_MISSING', 'GUEST_PHASE_FAILED',
    'GUEST_APP_NOT_RUNNING', 'GUEST_APP_QUIT', 'GUEST_BUDGET_TOO_SHORT', 'GUEST_CLEANUP_UNCONFIRMED',
    'GUEST_CLOSE_NOT_OBSERVED', 'GUEST_QUIT_DRAIN_UNCONFIRMED', 'GUEST_SERVER_NOT_STOPPED', 'GUEST_STATE_INVALID',
    'GUEST_INPUT_LEASE_LOCK_UNSAFE', 'GUEST_INPUT_LEASE_HELD', 'GUEST_INPUT_LEASE_METADATA_CHANGED', 'GUEST_INPUT_LEASE_METADATA_UNCONFIRMED',
    'GUEST_LEASE_RELEASE_UNCONFIRMED', 'GUEST_OPERATION_FENCE_CHANGED', 'GUEST_OPERATION_FENCE_UNINSPECTABLE', 'HELPER_UPDATE_CUSTODY_CHANGED',
    'HELPER_UPDATE_CUSTODY_UNCONFIRMED', 'HELPER_UPDATE_CUSTODY_UNRESOLVED', 'UNRESOLVED_GUEST_OPERATION', 'UNRECONCILED_STAGING_RESIDUE',
    'STAGING_CLEANUP_UNCONFIRMED', 'CAPTURE_INVALID', 'MENU_NOT_OBSERVED', 'MULTIPLE_GUEST_WINDOWS',
    'RELAUNCH_PID_UNCHANGED', 'RUN_INTERRUPTED', 'HOST_IO_UNCONFIRMED', 'NEEDS_OWNER',
    'TERMINAL_CAPABILITY_UNSUPPORTED', 'TERMINAL_FOCUS_UNVERIFIED', 'TERMINAL_GUARD_INVALID', 'TERMINAL_LAUNCH_UNAVAILABLE',
    'TERMINAL_LAUNCH_UNCONFIRMED', 'TERMINAL_SHELL_READINESS_UNPROVEN',
    # driver
    'DRIVER_MANIFEST_INVALID', 'DRIVER_BUNDLE_MISSING', 'DRIVER_BUNDLE_UNSAFE', 'DRIVER_BUNDLE_DIGEST_INVALID',
    'DRIVER_NODE_MISSING', 'DRIVER_NODE_UNSAFE', 'DRIVER_NODE_DIGEST_INVALID', 'E2E_CONTRACT_INVALID',
    'E2E_ENTRY_NOT_DECLARED', 'E2E_CASE_SELECTION_INVALID', 'E2E_CASES_INVALID', 'E2E_CASES_INCOMPLETE',
    'E2E_RESULT_SCHEMA_UNSUPPORTED', 'E2E_RESULT_BINDING_MISMATCH', 'E2E_RESULT_SHAPE_INVALID', 'E2E_RESULT_DETAILS_INVALID',
    'E2E_PASS_INCOMPLETE', 'E2E_REPORTED_INVALID', 'E2E_FAIL_WITHOUT_FAILURE', 'E2E_REASON_INVALID',
    'E2E_STATUS_UNSUPPORTED', 'E2E_PROCESS_UNCONFIRMED', 'E2E_PROCESS_FAILED', 'E2E_ASSERTIONS_FAILED',
    'E2E_TEARDOWN_UNCONFIRMED', 'E2E_EVIDENCE_WRITE_FAILED', 'E2E_PROCESS_MISSING', 'E2E_PROCESS_UNSAFE',
    'E2E_PROCESS_CHANGED', 'E2E_PROCESS_JSON_INVALID', 'E2E_RESULT_MISSING', 'E2E_RESULT_UNSAFE',
    'E2E_RESULT_CHANGED', 'E2E_RESULT_JSON_INVALID',
    # finite native guest app service and data-only payload producer
    'APP_PAYLOAD_UNQUALIFIED', 'APP_PAYLOAD_UNSAFE', 'APP_PAYLOAD_DIGEST',
    'APP_PAYLOAD_TOO_LARGE', 'APP_PAYLOAD_INCOMPATIBLE',
    'APP_SERVICE_UNAVAILABLE', 'APP_SERVICE_UNRESOLVED', 'APP_SERVICE_OPTIONS_INVALID',
    'APP_SERVICE_REPLY_INVALID', 'APP_SERVICE_BINDING_INVALID',
    'APP_SERVICE_PHASE_UNCONFIRMED',
)) | SAFE_ACTION_REASONS


def safe_failure_code(error):
    if isinstance(error, subprocess.TimeoutExpired):
        return 'GUEST_CLI_TIMEOUT'
    if isinstance(error, (InterruptedError, KeyboardInterrupt)):
        return 'RUN_INTERRUPTED'
    if isinstance(error, Refused) and error.args and isinstance(error.args[0], str):
        value = error.args[0]
        if value in SAFE_FAILURE_CODES:
            return value
        for prefix in ('GUEST_ACTION_FAILED:', 'GUEST_INPUT_LEASE_HELD:',
                       'UNRECONCILED_STAGING_RESIDUE:'):
            if value.startswith(prefix):
                return prefix[:-1]
        if value.startswith('FAILED:'):
            return 'STAGING_CLEANUP_UNCONFIRMED'
    if isinstance(error, OSError):
        return 'HOST_IO_UNCONFIRMED'
    return 'UNCLASSIFIED'


def action_failure_envelope(output):
    if not isinstance(output, str) or not 0 < len(output) <= 4096:
        return None
    try:
        def unique_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate key')
                value[key] = item
            return value
        value = json.loads(output, object_pairs_hook=unique_object)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(value, dict) or set(value) != {'schema', 'reason', 'outcome', 'phase'}:
        return None
    if value['schema'] != 'terminal-mac.action-error/1' or not isinstance(value['reason'], str) or value['reason'] not in SAFE_ACTION_REASONS:
        return None
    if value['outcome'] not in ('noEffect', 'mutationUnknown', 'confirmedNoCopy'):
        return None
    if value['phase'] not in ('validation', 'admission', 'dispatch', 'output', 'unknown'):
        return None
    return value


def require(ok, reason):
    if not ok:
        raise Refused(reason)


def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def regular(file, limit):
    info = file.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= limit,
            "ASSET_FILE_INVALID")
    return info


def verify(archive):
    regular(archive, MAX_ZIP)
    root = archive.parent
    manifest = root / 'farol-release.json'
    regular(manifest, 16384)
    m = json.loads(manifest.read_text())
    require(isinstance(m, dict), 'MANIFEST_INVALID')
    version = m.get('version', '')
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'VERSION_INVALID')
    require(m.get('schema') == 'farol.github-release/1' and m.get('repository') == REPO
            and m.get('product') == IDENTITY['name'] and m.get('bundleId') == IDENTITY['bundleId']
            and m.get('channel') == 'stable' and m.get('sourceDirty') is False
            and m.get('platform') == 'darwin' and m.get('arch') == 'arm64'
            and m.get('signing') == 'unsigned' and m.get('notarized') is False,
            'RELEASE_IDENTITY_INVALID')
    require(archive.name == m.get('archiveName') == f"{IDENTITY['name']}-{version}-darwin-arm64.zip",
            'ARCHIVE_NAME_INVALID')
    require(re.fullmatch('[a-f0-9]{40}', m.get('sourceCommit', '')) and
            all(re.fullmatch('[a-f0-9]{64}', m.get(k, '')) for k in
                ('sourceTreeDigest', 'buildId', 'artifactSha256')), 'SOURCE_IDENTITY_INVALID')
    expected = m.get('archiveSha256', '')
    require(re.fullmatch('[a-f0-9]{64}', expected), 'DIGEST_INVALID')
    sums = root / 'SHA256SUMS'
    regular(sums, 1024)
    require(sums.read_text() == f'{expected}  {archive.name}\n', 'CHECKSUMS_INVALID')
    require(archive.stat().st_size == m.get('archiveSize') and digest(archive) == expected,
            'ARCHIVE_DIGEST_INVALID')
    # ditto is used only in the guest, after rejecting traversal and escaping symlinks.
    total = 0
    seen = set()
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            name = entry.filename.rstrip('/')
            p = PurePosixPath(name)
            require(name not in seen and not p.is_absolute() and '\\' not in name
                    and '..' not in p.parts and p.parts and (p.parts[0] == IDENTITY['name'] + '.app' or name == 'artifact.json'),
                    'ARCHIVE_PATH_INVALID')
            seen.add(name)
            total += entry.file_size
            require(total <= 4 * 1024**3, 'ARCHIVE_EXPANSION_LIMIT')
            mode = entry.external_attr >> 16
            require(name != 'artifact.json' or not stat.S_ISLNK(mode), 'ARCHIVE_ENTRY_INVALID')
            if stat.S_ISLNK(mode):
                require(entry.file_size < 4096, 'ARCHIVE_LINK_INVALID')
                target = z.read(entry).decode('utf8')
                require(not target.startswith('/') and '\\' not in target and '..' not in PurePosixPath(target).parts,
                        'ARCHIVE_LINK_INVALID')
                parts = list(p.parent.parts)
                for part in PurePosixPath(target).parts:
                    if part == '..':
                        require(len(parts) > 1, 'ARCHIVE_LINK_ESCAPE')
                        parts.pop()
                    elif part != '.':
                        parts.append(part)
            else:
                require(not mode or stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                        'ARCHIVE_ENTRY_INVALID')
        info_path = IDENTITY['name'] + '.app/Contents/Info.plist'
        require(info_path in seen and z.getinfo(info_path).file_size <= 65536, 'APP_MISSING')
        info = plistlib.loads(z.read(info_path))
        require(info.get('CFBundleIdentifier') == IDENTITY['bundleId'] and
                info.get('CFBundleShortVersionString') == version, 'BUNDLE_IDENTITY_INVALID')
        require('artifact.json' in seen and z.getinfo('artifact.json').file_size <= 65536,
                'ARTIFACT_MISSING')
        artifact = json.loads(z.read('artifact.json'))
        require(all(artifact.get(k) == m.get(k) for k in
                    ('product', 'bundleId', 'version', 'sourceCommit', 'sourceDirty',
                     'sourceTreeDigest', 'buildId', 'artifactSha256', 'notarized')) and
                isinstance(artifact.get('signing'), dict) and artifact['signing'].get('kind') == m['signing'],
                'ARTIFACT_IDENTITY_MISMATCH')
        # Every structural check passed. A tampered tree repacked with a fresh
        # outer ZIP hash is still refused: restore the physical app tree the
        # archive would actually produce and recompute the canonical digest
        # (farol.tree-digest/v2) with the repository's own Node implementation.
        node = shutil.which('node')
        require(node is not None, 'DIGEST_TOOL_UNAVAILABLE')
        app_name = IDENTITY['name'] + '.app'
        with tempfile.TemporaryDirectory() as extract:
            modes = {}
            links = []
            for entry in z.infolist():
                name = entry.filename.rstrip('/')
                p = PurePosixPath(name)
                if p.parts[0] != app_name:
                    continue  # artifact.json is release metadata, not tree content.
                mode = entry.external_attr >> 16
                dest = Path(extract).joinpath(*p.parts)
                if stat.S_ISLNK(mode):
                    # Same classification order as the validation pass above.
                    links.append((dest, z.read(entry).decode('utf8')))
                elif entry.is_dir() or stat.S_IFMT(mode) == stat.S_IFDIR:
                    modes[p.parts] = mode & 0o7777
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(entry) as source, dest.open('xb') as out:
                        shutil.copyfileobj(source, out)
                    if mode & 0o7777:
                        dest.chmod(mode & 0o7777)
            for dest, target in links:
                dest.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(target, dest)
            # Directory modes last, deepest first, so restrictive trees restore.
            for parts in sorted(modes, key=len, reverse=True):
                if modes[parts]:
                    Path(extract).joinpath(*parts).chmod(modes[parts])
            program = ('const {treeDigest}=await import(process.argv[1]); '
                       'console.log(await treeDigest(process.argv[2]));')
            try:
                computed = subprocess.run(
                    [node, '--experimental-strip-types', '--input-type=module', '-e', program,
                     (Path(__file__).resolve().parent / 'artifact-digest.mjs').as_uri(),
                     str(Path(extract, app_name))],
                    capture_output=True, text=True, timeout=60,
                    env={'PATH': os.environ.get('PATH', ''), 'NODE_NO_WARNINGS': '1'})
            except (OSError, subprocess.TimeoutExpired) as error:
                raise Refused('DIGEST_TOOL_FAILED') from error
            require(computed.returncode == 0, 'DIGEST_TOOL_FAILED')
            require(computed.stdout.strip() == artifact['artifactSha256'], 'ARTIFACT_DIGEST_MISMATCH')
    return m


def download_latest(directory, deadline):
    def budget():
        left = deadline - time.monotonic()
        require(left > 0, 'DOWNLOAD_DEADLINE_EXCEEDED')
        return min(left, 10)

    request = urllib.request.Request('https://api.github.com/repos/legrch/farol/releases/latest',
                                     headers={'User-Agent': 'farol-vm-smoke'})
    with urllib.request.urlopen(request, timeout=budget()) as response:
        release = json.loads(response.read(2 * 1024 * 1024))
    require(not release.get('draft') and not release.get('prerelease'), 'LATEST_NOT_STABLE')
    tag = release.get('tag_name', '')
    require(re.fullmatch(r'v\d+\.\d+\.\d+', tag), 'LATEST_TAG_INVALID')
    names = [f"{IDENTITY['name']}-{tag[1:]}-darwin-arm64.zip", 'farol-release.json', 'SHA256SUMS']
    assets = {a['name']: a for a in release['assets']}
    for name in names:
        require(name in assets, 'LATEST_ASSET_MISSING')
        a = assets[name]
        url = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
        limit = MAX_ZIP if name.endswith('.zip') else 16384
        require(a.get('browser_download_url') == url and 0 < a['size'] <= limit,
                'LATEST_ASSET_URL_INVALID')
        with urllib.request.urlopen(url, timeout=budget()) as source, (directory / name).open('xb') as out:
            count = 0
            while True:
                budget()
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                require(count <= limit, 'DOWNLOAD_LIMIT')
                out.write(chunk)
        require(count == a['size'], 'DOWNLOAD_SIZE_INVALID')
    (directory / 'latest.json').write_text(json.dumps(release, indent=2))
    return directory / names[0]


def require_host_dev_stopped(identity, home=None):
    home = Path.home() if home is None else home
    root = home / 'Library/Application Support' / identity['devDataLeaf']
    rows = subprocess.check_output(['/bin/ps', '-ax', '-o', 'command='], text=True)
    # APFS may retain the supported legacy DEV spelling of the same directory.
    require(not any(str(root).casefold() in row.casefold() for row in rows.splitlines()),
            'HOST_DEV_STILL_RUNNING')


def export_dev_connection(stage, identity, home=None):
    """The fixed Dev profile is the only source. Never return or log the key."""
    home = Path.home() if home is None else home
    require(identity['devDataLeaf'] != identity['dataLeaf'] and Path(identity['devDataLeaf']).name == identity['devDataLeaf'], 'DEV_SOURCE_IDENTITY_INVALID')
    root = home / 'Library/Application Support' / identity['devDataLeaf']
    require(root.is_dir() and not root.is_symlink(), 'DEV_PROFILE_UNSAFE')
    config_file = root / 'farol-state/config.json'
    key_file = root / 'farol-private/secure-mcp-connector/control-plane-api-key'
    for ancestor in (config_file.parent, key_file.parent, key_file.parent.parent):
        require(ancestor.is_dir() and not ancestor.is_symlink(), 'DEV_PROFILE_UNSAFE')
    config_before = regular(config_file, 4 * 1024 * 1024)
    config = json.loads(config_file.read_text())
    connector = config['connectors']['secureMcp']
    setup = config.get('setup', {})
    require(isinstance(setup, dict) and isinstance(setup.get('connect', {}), dict), 'DEV_CONFIG_INVALID')
    runtime = connector.get('runtime')
    require(not setup.get('connect', {}).get('outcomeUnknown') and
            not connector.get('appVerificationPending') and
            not (isinstance(runtime, dict) and runtime.get('state') == 'outcome_unknown'),
            'DEV_EFFECT_UNKNOWN')
    tunnel = connector['tunnelId']
    require(isinstance(tunnel, str) and re.fullmatch('[0-9A-Za-z._:-]{1,160}', tunnel), 'DEV_TUNNEL_MISSING')
    require(connector.get('credential') == 'stored', 'DEV_CREDENTIAL_NOT_STORED')
    require_host_dev_stopped(identity, home)
    fd = os.open(key_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
                info.st_nlink == 1 and info.st_mode & 0o077 == 0 and 20 <= info.st_size <= 512,
                'DEV_KEY_UNSAFE')
        key = os.read(fd, 513)
        after = os.fstat(fd)
        named = key_file.lstat()
        require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == (named.st_dev, named.st_ino, named.st_size, named.st_mtime_ns), 'DEV_KEY_CHANGED')
        require(len(key) == info.st_size and all(33 <= x <= 126 for x in key), 'DEV_KEY_INVALID')
    finally:
        os.close(fd)
    after_config = config_file.lstat()
    require((config_before.st_dev, config_before.st_ino, config_before.st_mtime_ns, config_before.st_size) == (after_config.st_dev, after_config.st_ino, after_config.st_mtime_ns, after_config.st_size), 'DEV_CONNECTION_CHANGED')
    private = stage / 'dev-key'
    with private.open('xb') as out:
        private.chmod(0o600)
        out.write(key)
    del key
    (stage / 'dev-connection.json').write_text(json.dumps({'schema': 1, 'tunnelId': tunnel}))
    (stage / 'dev-connection.json').chmod(0o600)


def refuse_host_profile_path(path, identity, home=None):
    home = Path.home() if home is None else home
    actual = str(path).casefold().rstrip('/')
    for leaf in (identity['dataLeaf'], identity['devDataLeaf']):
        protected = str(home / 'Library/Application Support' / leaf).casefold().rstrip('/')
        require(actual != protected and not actual.startswith(protected + '/'),
                'HOST_PRODUCT_PROFILE_FORBIDDEN')


def staging_residue(inbox):
    """Raw staging left by pre-fence failures in run-* directories.

    Detected strictly by owned name and path existence; file contents are
    never read and nothing is deleted or rewritten here.
    """
    found = []
    if not inbox.is_dir() or inbox.is_symlink():
        return found
    for entry in sorted(inbox.iterdir()):
        if not entry.name.startswith('run-') or entry.is_symlink() or not entry.is_dir():
            continue
        owned = [name for name in ('dev-key', 'dev-connection.json', 'app-payload.json')
                 if (entry / name).exists()]
        try:
            if any(item.name.startswith('blob-') for item in entry.iterdir()):
                owned.append('blob-*')  # content-free evidence of partial native staging
        except OSError:
            owned.append('uninspectable')
        if owned:
            found.append({'directory': entry.name, 'entries': owned})
    return found


def bounded_custody_record(path, kind):
    """Classify a named evidence file without following links or reading secrets.

    Only a successful ENOENT establishes absence. The bounded descriptor is
    checked against the path before and after the read. Values returned here
    are allowlisted metadata, never key bytes, arbitrary paths or owner text.
    """
    try:
        before = path.lstat()
    except FileNotFoundError:
        return {'state': 'absent'}
    except OSError:
        return {'state': 'unreadable'}
    if not (stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
            before.st_uid == os.geteuid() and before.st_mode & 0o077 == 0 and
            0 < before.st_size <= 4096):
        return {'state': 'unsafe'}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as source:
            opened = os.fstat(source.fileno())
            ident = lambda x: (x.st_dev, x.st_ino, x.st_mode, x.st_nlink,
                               x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            if not stat.S_ISREG(opened.st_mode) or ident(opened) != ident(before):
                return {'state': 'unsafe'}
            data = source.read(4097)
            if len(data) != opened.st_size or ident(os.fstat(source.fileno())) != ident(before):
                return {'state': 'unsafe'}
        if ident(path.lstat()) != ident(before):
            return {'state': 'unsafe'}
    except FileNotFoundError:
        return {'state': 'unsafe'}  # vanished between lstat and open
    except OSError:
        return {'state': 'unreadable'}
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate key')
                value[key] = item
            return value
        value = json.loads(data, object_pairs_hook=unique)
        if not isinstance(value, dict):
            return {'state': 'malformed'}
        if kind == 'lease':
            if (set(value) != {'schema', 'owner', 'generation', 'acquiredAt'} or
                value['schema'] != 'terminal-mac.input-lease/1' or
                not isinstance(value['owner'], str) or not 0 < len(value['owner']) <= 128 or
                type(value['generation']) is not int or value['generation'] < 0 or
                type(value['acquiredAt']) is not int):
                return {'state': 'malformed'}
            return {'state': 'valid', 'ownerPresent': True, 'generation': value['generation']}
        if kind == 'marker':
            if (set(value) != {'schema', 'owner', 'deadline'} or
                value['schema'] != 'terminal-mac.input-lease-flag/1' or
                not isinstance(value['owner'], str) or not 0 < len(value['owner']) <= 128 or
                type(value['deadline']) not in (int, float) or
                not math.isfinite(value['deadline'])):
                return {'state': 'malformed'}
            return {'state': 'valid', 'expired': value['deadline'] <= time.time()}
        if kind == 'fence':
            run_id = value.get('runId')
            if not isinstance(run_id, str) or not re.fullmatch(r'run-[A-Za-z0-9_-]{1,64}', run_id):
                return {'state': 'malformed'}
            return {'state': 'valid', 'runId': run_id}
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        return {'state': 'malformed'}
    return {'state': 'malformed'}


def evidence_directory(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 'absent'
    except OSError:
        return 'unreadable'
    return 'ready' if stat.S_ISDIR(info.st_mode) and not path.is_symlink() else 'unsafe'


def fence_metadata(machine):
    record = bounded_custody_record(machine / '.farol-smoke-pending.json', 'fence')
    return None if record['state'] == 'absent' else {'present': True, **record}


def phase_receipt_names(machine):
    """Only guest phase receipt NAMES, not their text or script/payload bytes."""
    root = machine / 'exchange' / 'farol-smoke'
    if evidence_directory(root) != 'ready':
        return []
    names = []
    try:
        for run in sorted(root.iterdir()):
            if len(names) >= 32:
                break
            if not re.fullmatch(r'run-[a-f0-9]{32}', run.name) or evidence_directory(run) != 'ready':
                continue
            receipts = []
            for entry in sorted(run.iterdir()):
                if len(receipts) >= 64:
                    break
                if re.fullmatch(r'[0-9]{4}-[a-z-]{1,48}\.result', entry.name):
                    receipts.append(entry.name)
            if receipts:
                names.append({'runId': run.name, 'receiptNames': receipts})
    except OSError:
        return [{'state': 'unreadable'}]
    return names


def reconcile_staging(args, home=None):
    """Read-only evidence inventory. Never takes a lock or clears custody."""
    root = Path(args.vm_home).expanduser().resolve(strict=True)
    machine = root / 'machines' / args.vm
    refuse_host_profile_path(machine, IDENTITY, home)
    require(evidence_directory(root / 'machines') == 'ready' and
            evidence_directory(machine) == 'ready', 'VM_MISSING')
    artifacts = machine / 'artifacts'
    staging_state = evidence_directory(artifacts)
    residue = staging_residue(artifacts) if staging_state == 'ready' else []
    fence = fence_metadata(machine)
    lease = bounded_custody_record(machine / 'input-lease.json', 'lease')
    exchange = machine / 'exchange'
    exchange_state = evidence_directory(exchange)
    marker = (bounded_custody_record(exchange / '.input-lease.json', 'marker')
              if exchange_state == 'ready' else
              {'state': 'absent' if exchange_state == 'absent' else exchange_state})
    for item in residue:
        item['fence'] = fence is not None
    retained = (fence is not None or lease['state'] != 'absent' or marker['state'] != 'absent')
    found = bool(residue) or retained or staging_state in ('unsafe', 'unreadable')
    status = ('STAGING_RESIDUE_FOUND' if residue or fence is not None else
              'CUSTODY_UNRESOLVED' if found else 'CLEAN')
    return {'status': status, 'fence': fence, 'residue': residue,
            'stagingState': staging_state,
            'custody': {'lease': lease, 'helperMarker': marker, 'exchangeState': exchange_state},
            'phaseReceipts': phase_receipt_names(machine) if exchange_state == 'ready' else [],
            'requiredAction': ('Manual review of original guest effects and retained evidence is required '
                               'before clearing anything; no records are automatically cleared.'
                               if found else 'None; staging and custody evidence are residue-free.')}


class Runner:
    def __init__(self, args):
        self.a = args
        self.deadline = time.monotonic() + args.timeout
        self.run_id = 'run-' + uuid.uuid4().hex
        self.home = Path(args.vm_home).expanduser().resolve(strict=True)
        refuse_host_profile_path(self.home, IDENTITY)
        self.binary = Path(args.terminal_mac).expanduser().resolve(strict=True)
        require(self.binary.is_file() and self.binary.name == 'terminal-mac' and
                self.binary.parent.name == 'MacOS' and self.binary.parent.parent.name == 'Contents',
                'TERMINAL_MAC_PACKAGE_REQUIRED')
        info = self.binary.parent.parent / 'Info.plist'
        regular(info, 65536)
        require(plistlib.loads(info.read_bytes()).get('CFBundleIdentifier') == 'dev.terminal-mac.host',
                'TERMINAL_MAC_IDENTITY_INVALID')
        self.machine = self.home / 'machines' / args.vm
        require(self.machine.is_dir() and not self.machine.is_symlink(), 'VM_MISSING')
        self.tools = self.binary.parent.parent / 'Resources' / 'guest-tools'
        require(self.tools.is_dir(), 'GUEST_TOOLS_MISSING')
        self.out = Path(args.evidence).expanduser().resolve() / self.run_id
        refuse_host_profile_path(self.out, IDENTITY)
        self.out.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.inbox = self.machine / 'artifacts'
        require(self.inbox.is_dir() and not self.inbox.is_symlink(), 'ARTIFACT_SHARE_REQUIRED')
        self.stage = self.inbox / self.run_id
        self.report = self.machine / 'exchange' / 'farol-smoke' / self.run_id
        self.log = []
        self.pending = None
        self.cleanup_note = None
        self.network_policy = None
        self.driver_result = None
        self.e2e_context = None
        self.driver_process_confirmed = False
        self.e2e_phase_error = None
        self.effect_owned = False
        self.first_failure = None
        self.first_failure_persistence = 'NOT_RUN'
        self.secondary_failures = []
        self.native_service_evidence = None
        self.effect_file = self.machine / '.farol-smoke-pending.json'
        # Never forward product configuration, proxy, Electron or loader environment.
        self.env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
        self.env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(self.home))

    def remaining(self, limit=30):
        left = self.deadline - time.monotonic()
        require(left > 0, 'DEADLINE_EXCEEDED')
        return min(left, limit)

    def record_first_failure(self, reason, command='unknown', operation='unknown',
                             return_code=None, outcome='UNKNOWN'):
        if getattr(self, 'first_failure', None) is not None:
            return
        reason = reason if isinstance(reason, str) and reason in SAFE_FAILURE_CODES else 'UNCLASSIFIED'
        stage = getattr(self, 'pending', None)
        if not isinstance(stage, str) or not re.fullmatch(r'[a-z][a-z0-9:-]{0,95}', stage):
            stage = 'unknown'
        command = command if command in ('action', 'status', 'start', 'show', 'hide', 'stop', 'unknown') else 'unknown'
        operation = operation if isinstance(operation, str) and re.fullmatch(r'[a-z][a-z-]{0,63}', operation) else 'unknown'
        if outcome not in ('noEffect', 'mutationUnknown', 'confirmedNoCopy', 'UNKNOWN'):
            outcome = 'UNKNOWN'
        record = {'schema': 'farol.bootstrap-failure/1', 'runId': getattr(self, 'run_id', None),
                  'stage': stage, 'command': command, 'operation': operation,
                  'reason': reason, 'returnCode': return_code if type(return_code) is int and 0 <= return_code <= 255 else None,
                  'outcome': outcome}
        self.first_failure = record
        self.first_failure_persistence = 'NOT_RUN'
        try:
            directory = getattr(self, 'out', None)
            if directory is not None and directory.is_dir():
                with (directory / 'first-failure.json').open('x') as target:
                    target.flush()
                    os.fchmod(target.fileno(), 0o600)
                    json.dump(record, target, sort_keys=True)
                    target.flush()
                    os.fsync(target.fileno())
                self.sync_directory(directory)
                self.first_failure_persistence = 'DURABLE'
        except (OSError, ValueError, TypeError):
            # Never mask the first guest failure with an evidence-write failure.
            self.first_failure_persistence = 'FAILED'

    def record_secondary_failure(self, error):
        entries = getattr(self, 'secondary_failures', None)
        if entries is None:
            self.secondary_failures = []
            entries = self.secondary_failures
        if len(entries) < 8:
            entries.append(safe_failure_code(error))

    def cli(self, *args):
        command = args[0] if args and isinstance(args[0], str) else 'unknown'
        operation = args[2] if command == 'action' and len(args) > 2 else command
        # Status polling is explicitly read-only; transient missing-helper
        # observations are not a completed bootstrap failure.
        polling_status = command == 'action' and operation == 'status'
        try:
            # Only the finite native app-service gets a longer deadline:
            # 90s guest request, 100s host wait, 120s owned marker lifetime.
            # Legacy commands retain the original 30s cap.
            native = (getattr(getattr(self, 'a', None), 'native_app_service', False) and command == 'action'
                      and len(args) > 2 and args[2] == 'app-service')
            p = subprocess.run([str(self.binary), *map(str, args)], env=self.env,
                               capture_output=True, text=True,
                               timeout=self.remaining(100) if native else self.remaining())
        except subprocess.TimeoutExpired:
            if not polling_status:
                self.record_first_failure('GUEST_CLI_TIMEOUT', command, operation, outcome='UNKNOWN')
            raise Refused('GUEST_CLI_TIMEOUT') from None
        except OSError:
            if not polling_status:
                self.record_first_failure('GUEST_CLI_LAUNCH_FAILED', command, operation, outcome='noEffect')
            raise Refused('GUEST_CLI_LAUNCH_FAILED') from None
        if p.returncode != 0:
            envelope = action_failure_envelope(p.stdout) if command == 'action' else None
            if not polling_status:
                self.record_first_failure(envelope['reason'] if envelope else 'GUEST_CLI_FAILED',
                                          command, operation, p.returncode,
                                          envelope['outcome'] if envelope else 'UNKNOWN')
            raise Refused('GUEST_ACTION_FAILED:' + command)
        try:
            value = json.loads(p.stdout)
            if not isinstance(value, dict):
                raise ValueError('response not an object')
        except (ValueError, TypeError, RecursionError):
            if not polling_status:
                self.record_first_failure('GUEST_CLI_REPLY_INVALID', command, operation,
                                          p.returncode, outcome='UNKNOWN')
            raise Refused('GUEST_CLI_REPLY_INVALID') from None
        return value

    @property
    def exchange(self):
        return self.machine / 'exchange'

    def action(self, *args):
        # The structured error flag is a command option, not a guest argument.
        # Keep --owner last for existing cooperative-lease consumers.
        return self.cli('action', self.a.vm, *args,
                        '--structured-errors', '--owner', self.lease_owner)

    def screenshot(self, label):
        file = self.out / (label + '.png')
        self.action('screenshot', '--output', file)
        require(file.read_bytes()[:8] == b'\x89PNG\r\n\x1a\n', 'CAPTURE_INVALID')

    def wait_result(self, target):
        while not target.exists():
            self.remaining()
            time.sleep(0.2)
        regular(target, 64)
        result = target.read_text().strip()
        require(result == 'READY', result if result == 'NEEDS_OWNER' else 'GUEST_PHASE_FAILED')

    def start_guest(self):
        """Launch the fixed guest Terminal via a typed helper capability.

        No Finder navigation, blind text or screenshot-as-focus inference. The
        helper validates PID and focused input element at every event. Shell
        prompt readiness is deliberately NOT claimed by the AX focus contract.
        """
        self.pending = 'bootstrap:capability'
        caps = self.action('status')
        require(caps.get('terminalFocusContract') == 'terminal-input/2' and
                caps.get('terminalLaunchContract') == 'terminal-launch/1',
                'TERMINAL_CAPABILITY_UNSUPPORTED')
        # Current helpers explicitly report shellReadiness=not-proven. The AX
        # focused text area does NOT establish a live shell prompt. Until a
        # separately reviewed guest issuer advertises this readiness contract,
        # refuse before Terminal launch or any keyboard/guest effect.
        self.pending = 'bootstrap:shell-readiness-capability'
        require(caps.get('terminalShellReadinessContract') == 'terminal-shell-readiness/1',
                'TERMINAL_SHELL_READINESS_UNPROVEN')
        self.begin_effect()  # Terminal launch is itself a guest effect.
        self.pending = 'bootstrap:terminal-open'
        launched = self.action('terminal-open')
        require(launched.get('terminalLaunchContract') == 'terminal-launch/1' and
                launched.get('terminalFocusContract') == 'terminal-input/2',
                'TERMINAL_LAUNCH_UNCONFIRMED')
        pid = launched.get('terminalPID')
        require(isinstance(pid, str) and re.fullmatch(r'[1-9][0-9]{0,9}', pid) and
                int(pid) <= 2147483647, 'TERMINAL_LAUNCH_UNCONFIRMED')
        self.pending = 'bootstrap:foreground-proof'
        foreground = self.action('status')
        require(foreground.get('terminalFocusContract') == 'terminal-input/2' and
                foreground.get('terminalPID') == pid and foreground.get('terminalForeground') == 'true',
                'TERMINAL_FOCUS_UNVERIFIED')
        self.pending = 'bootstrap:terminal-new'
        # Foreground-only proof is valid for cmd+n and nothing else.
        self.action('key', 'cmd+n', '--terminal-proof', 'terminal-foreground/2',
                    '--terminal-pid', pid)
        self.pending = 'bootstrap:input-proof'
        focused = self.action('status')
        token = focused.get('terminalWindow')
        try:
            parsed_token = uuid.UUID(token) if isinstance(token, str) else None
        except ValueError:
            parsed_token = None
        require(focused.get('terminalFocusContract') == 'terminal-input/2' and
                focused.get('terminalPID') == pid and focused.get('terminalInput') == 'true' and
                parsed_token is not None and str(parsed_token).upper() == token.upper(),
                'TERMINAL_FOCUS_UNVERIFIED')
        self.shell_readiness = 'NOT_PROVEN'
        self.pending = 'bootstrap:shell-readiness'
        # The future readiness issuer must bind its own proof to THIS exact
        # Terminal PID and focused AX window. No current terminal-mac helper
        # supplies these fields, so real bootstrap is intentionally BLOCKED.
        require(focused.get('terminalShellReadinessContract') == 'terminal-shell-readiness/1' and
                focused.get('shellReadiness') == 'proven' and
                focused.get('terminalShellReadyPID') == pid and
                focused.get('terminalShellReadyWindow') == token,
                'TERMINAL_SHELL_READINESS_UNPROVEN')
        self.shell_readiness = 'REPORTED_PROVEN_NOT_NATIVE_QUALIFIED'
        self.pending = 'bootstrap:terminal-capture'
        self.screenshot('bootstrap-terminal')
        command = '/bin/bash ' + shlex.quote('/Volumes/My Shared Files/artifacts/' +
                                           self.run_id + '/guest.sh') + ' serve'
        guarded = ('--terminal-proof', 'terminal-input/2', '--terminal-pid', pid,
                   '--terminal-window', token)
        self.pending = 'bootstrap:server-command'
        self.action('type', command, *guarded)
        self.pending = 'bootstrap:pre-return'
        current = self.action('status')
        require(current.get('terminalFocusContract') == 'terminal-input/2' and
                current.get('terminalPID') == pid and current.get('terminalInput') == 'true' and
                current.get('terminalWindow') == token, 'TERMINAL_FOCUS_UNVERIFIED')
        require(current.get('terminalShellReadinessContract') == 'terminal-shell-readiness/1' and
                current.get('shellReadiness') == 'proven' and
                current.get('terminalShellReadyPID') == pid and
                current.get('terminalShellReadyWindow') == token,
                'TERMINAL_SHELL_READINESS_UNPROVEN')
        self.pending = 'bootstrap:server-start'
        # Return must use full input proof; foreground-only is prohibited.
        self.action('key', 'return', *guarded)
        self.pending = 'bootstrap:server-ready'
        self.wait_result(self.report / 'server.result')
        self.sequence = 0
        self.pending = None

    @staticmethod
    def native_service_module():
        """Load this repo's finite producer without changing test import paths."""
        import importlib.util
        source = Path(__file__).with_name('vm_app_service.py')
        spec = importlib.util.spec_from_file_location('farol_vm_app_service', source)
        require(spec is not None and spec.loader is not None, 'APP_PAYLOAD_UNQUALIFIED')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def native_app_action(self, session, command):
        """Publish exactly one original intent before one guest action.

        A lost/invalid acknowledgement leaves the intent and guest outcome
        UNKNOWN; no retry, retry-by-new-id, or automatic clean-up.
        """
        sequence = session.next_sequence
        operation = str(uuid.uuid4()).lower()
        parameters = session.arguments(command, operation)
        self.pending = 'native:' + command
        # Maintain only THIS run's existing owned helper marker. A stale or
        # different marker refuses before any new guest command is dispatched.
        self.publish_lease_flag()
        self.write_durable_json_exclusive(
            self.out / ('native-intent-%02d-%s.json' % (sequence, command)),
            {'schema': 'farol.vm-app-service.intent/1', 'runId': self.run_id,
             'nonce': session.nonce, 'manifestSHA256': session.manifest,
             'acceptanceSHA256': session.acceptance,
             'owner': session.owner, 'sequence': sequence,
             'operationId': operation, 'command': command})
        try:
            reply = self.action(*parameters, '--timeout', '90')
        except Refused:
            failure = getattr(self, 'first_failure', None)
            # Only the first open, before any service effect, may end with an
            # explicit typed noEffect ACK. Never apply this to a lost ACK,
            # malformed reply, later operation, or a previous successful effect.
            if (command == 'open' and sequence == 0 and not self.log and
                    isinstance(failure, dict) and failure.get('runId') == self.run_id and
                    failure.get('stage') == 'native:open' and
                    failure.get('command') == 'action' and failure.get('operation') == 'app-service' and
                    failure.get('outcome') == 'noEffect' and failure.get('returnCode') == 1):
                self.finish_no_effect_open(operation, failure)
                raise Refused(failure['reason']) from None
            raise
        # Retain a content-free projection BEFORE admission, including for a
        # malformed ACK. Never persist arbitrary guest text, paths or exceptions.
        projection = {'schema': 'farol.native-ack-diagnostic/1',
                      'command': command, 'sequence': sequence}
        domains = {
            'serviceReady': {'true', 'false'},
            'state': {'ready', 'installed', 'running', 'closed', 'unknown'},
            'launchIdentityState': {'bound', 'unknown', 'unconfirmed', 'retained-unconfirmed'},
            'launchIdentityReason': {'NONE', 'PROCESS_CENSUS_CHANGED', 'PROCESS_CENSUS_UNAVAILABLE',
                                     'PROCESS_IDENTITY_CHANGED', 'GUI_PRIMARY_NOT_FOUND'},
            'rootExit': {'observed', 'not-observed', 'unconfirmed', 'no-owned-root'},
            'uiPrimaryExit': {'observed', 'not-observed', 'unconfirmed'},
            'foreground': {'true', 'false', 'unconfirmed'},
        }
        for key, allowed in domains.items():
            value = reply.get(key) if isinstance(reply, dict) else None
            projection[key] = value if isinstance(value, str) and value in allowed else 'unclassified'
        windows = reply.get('windows') if isinstance(reply, dict) else None
        projection['windows'] = windows if isinstance(windows, str) and re.fullmatch(r'[0-9]{1,2}', windows) else 'unconfirmed'
        self.write_durable_json_exclusive(
            self.out / ('native-ack-diagnostic-%02d-%s.json' % (sequence, command)), projection)
        # No assumption that an ACK existed when the mailbox times out.
        try:
            receipt = session.admit_reply(command, operation, reply)
        except self.native_service_producer.ProducerRefusal as error:
            raise Refused(str(error)) from None
        self.write_durable_json_exclusive(
            self.out / ('native-receipt-%02d-%s.json' % (sequence, command)),
            {'schema': 'farol.vm-app-service.receipt/1', **receipt})
        self.pending = None
        return receipt

    def finish_no_effect_open(self, operation, failure):
        """End THIS unstarted service after its explicit, retained noEffect ACK."""
        require(self.effect_owned and self.lease_fd is not None,
                'GUEST_OPERATION_FENCE_CHANGED')
        self.require_own_lease_metadata()
        self.require_own_update_marker()
        regular(self.effect_file, 4096)
        require(json.loads(self.effect_file.read_text()) ==
                {'runId': self.run_id, 'evidence': str(self.out)},
                'GUEST_OPERATION_FENCE_CHANGED')
        self.write_durable_json_exclusive(self.out / 'native-open-no-effect.json',
            {'schema': 'farol.native-open-no-effect/1', 'runId': self.run_id,
             'operationId': operation, 'outcome': 'noEffect',
             'reason': failure['reason'], 'replayed': False})
        self.retain_unstarted_native_stage(operation)
        self.effect_file.unlink()
        self.sync_effect_directory()
        self.effect_owned = False
        self.pending = None

    def retain_unstarted_native_stage(self, operation):
        """Move only this no-effect run's active staging out of admission.

        Preserve all bytes and a durable custody receipt. No VM directory or
        predecessor's staging is removed; an incomplete move retains the fence.
        """
        require(self.stage == self.machine / 'artifacts' / self.run_id,
                'GUEST_OPERATION_FENCE_CHANGED')
        if not self.stage.exists() and not self.stage.is_symlink():
            self.cleanup_note = 'RETAINED_NO_EFFECT'
            return
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        descriptors = []
        try:
            machine = os.open(self.machine, flags); descriptors.append(machine)
            source = os.open('artifacts', flags, dir_fd=machine); descriptors.append(source)
            info = os.stat(self.run_id, dir_fd=source, follow_symlinks=False)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(),
                    'STAGING_CLEANUP_UNCONFIRMED')
            try:
                os.mkdir('retained-artifacts', mode=0o700, dir_fd=machine)
            except FileExistsError:
                pass
            retained = os.open('retained-artifacts', flags, dir_fd=machine); descriptors.append(retained)
            info = os.fstat(retained)
            require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                    'STAGING_CLEANUP_UNCONFIRMED')
            os.mkdir(self.run_id, mode=0o700, dir_fd=retained)
            target = os.open(self.run_id, flags, dir_fd=retained); descriptors.append(target)
            self.write_durable_json_exclusive(self.out / 'native-stage-retention-intent.json',
                {'schema':'farol.native-stage-retention/1', 'runId':self.run_id,
                 'operationId':operation, 'outcome':'noEffect', 'deleted':False})
            os.rename(self.run_id, 'payload', src_dir_fd=source, dst_dir_fd=target)
            os.fsync(target); os.fsync(source); os.fsync(retained); os.fsync(machine)
            self.write_durable_json_exclusive(self.out / 'native-stage-retained.json',
                {'schema':'farol.native-stage-retention/1', 'runId':self.run_id,
                 'operationId':operation, 'outcome':'noEffect', 'deleted':False,
                 'retainedAt':str(self.machine / 'retained-artifacts' / self.run_id / 'payload')})
            self.cleanup_note = 'RETAINED_NO_EFFECT'
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)

    def native_app_observe(self, session, receipt):
        """Read bound guest state, without resending any mutating operation.

        A successful activate() ACK may precede macOS reporting the app as
        frontmost. Only a bound foreground=false observation is eligible for a
        bounded cold-start follow-up read. A failed/uninspectable observation is UNKNOWN and
        never retried. Every observation uses a fresh read-only UUID.
        """
        command = receipt['command']
        self.pending = 'native:' + command + ':observe'
        foreground_deadline = min(self.deadline, time.monotonic() + 60)
        while True:
            self.remaining()
            arguments = session.observation_arguments(receipt)
            reply = self.action(*arguments, '--timeout', '15')
            try:
                observed = session.admit_observation(
                    receipt, reply, allow_pending_foreground=(command == 'activate'))
            except self.native_service_producer.ProducerRefusal as error:
                raise Refused(str(error)) from None
            if observed is not None:
                self.write_durable_json_exclusive(
                    self.out / ('native-observation-%02d-%s.json' %
                                (receipt['sequence'], command)), observed)
                self.pending = None
                return observed
            require(time.monotonic() < foreground_deadline,
                    'APP_SERVICE_PHASE_UNCONFIRMED')
            # No GUI or mutating retry: wait only for the original activation
            # to become observable on the same PID/window-bound guest service.
            time.sleep(0.2)

    def run_native_app_service(self, archive, manifest, grants):
        """Guest compiled finite application lifecycle, never staged shell code.

        The release archive is verified BEFORE preparing the guest-visible
        immutable blobs. Full lifecycle is a separate one-shot service;
        'closed' means the guest-reported service ended, not product E2E PASS.
        """
        require(grants.get('appServiceContract') == 'terminal-mac.app-service/4' and
                grants.get('appServiceExecutor') == 'compiled-native-helper' and
                grants.get('appServiceLaunchIdentityContract') == 'terminal-mac.launch-identity/1',
                'APP_SERVICE_UNAVAILABLE')
        require(grants.get('appServiceAdmission') == 'available',
                'APP_SERVICE_UNRESOLVED')
        # Digest from the release's own manifest is NOT a trust anchor.
        # The owner/Lead must select the expected accepted app tree digest
        # independently. Do not infer it from the archive being staged.
        expected = getattr(self.a, 'expected_app_sha256', None)
        require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected) and
                manifest.get('artifactSha256') == expected,
                'APP_PAYLOAD_UNQUALIFIED')
        module = self.native_service_module()
        self.native_service_producer = module  # one exception/class identity per run
        self.pending = 'native:stage'
        self.stage.mkdir(mode=0o700, exist_ok=False)
        try:
            stage = module.stage_release_payload(archive, manifest, self.stage, IDENTITY)
            acceptance = module.stage_acceptance(self.stage, stage, module.farol_release_policy)
        except module.ProducerRefusal as error:
            raise Refused(str(error)) from None
        self.write_durable_json_exclusive(self.out / 'native-stage.json', stage)
        # Staging may be much longer than a marker epoch. No guest effect yet.
        self.remaining()
        nonce = os.urandom(32).hex()
        session = module.ServiceAdmission(
            self.run_id, nonce, stage['manifestSHA256'], self.lease_owner,
            app_name=stage['appName'], acceptance=acceptance, relaunch=getattr(self.a, 'native_relaunch', False))
        # Retained private receipt is necessary to OBSERVE a lost reply; it
        # grants no replay. Never put the nonce in public result.json/logs.
        self.write_durable_json_exclusive(
            self.out / 'native-session.json',
            {'schema': 'farol.vm-app-service.session/1', 'runId': self.run_id,
             'nonce': nonce, 'manifestSHA256': stage['manifestSHA256'],
             'acceptanceSHA256': acceptance,
             'owner': self.lease_owner, 'helperContract': 'terminal-mac.app-service/4',
             'installedApplication': '/Applications/' + stage['appName']})
        self.begin_effect()
        receipts = []
        for command in session.steps:
            receipt = self.native_app_action(session, command)
            receipts.append(receipt)
            # The observation is a fresh read-only mailbox action bound to the
            # recorded effect identity. A mismatch stops all subsequent effects.
            self.native_app_observe(session, receipt)
            self.log.append('native:' + command)
            if command in ('launch', 'activate'):
                # Screenshots document pixels but do not prove UX acceptance.
                self.pending = 'native:%s:screenshot' % command
                self.screenshot('native-%02d-%s' % (receipt['sequence'], command))
                self.pending = None
        require(receipts and receipts[-1]['command'] == 'close' and
                receipts[-1]['state'] == 'closed' and
                session.next_sequence == len(session.steps),
                'APP_SERVICE_PHASE_UNCONFIRMED')
        self.pending = None
        cleanup = self.finish_staging()
        result = {'status': 'NEEDS_REVIEW',
                  'lifecycle': 'NATIVE_APP_SERVICE_CLOSED_REPORTED',
                  'ui': 'NEEDS_REVIEW', 'test': {'status': 'NOT_RUN'},
                  'serverCode': 'guest-compiled-helper', 'shell': 'NOT_USED',
                  'manifestSHA256': stage['manifestSHA256'],
                  'artifactSha256': stage['artifactSHA256'],
                  'archiveSha256': stage['archiveSHA256'],
                  'version': manifest['version'], 'phases': list(self.log),
                  'nativeReceipts': receipts, 'cleanup': cleanup,
                  'lease': self.lease_evidence(),
                  'tunnel': 'NOT_RUN', 'networkPolicy': self.network_policy,
                  'guestInstallation': {'location': 'guest-applications/1',
                                        'application': '/Applications/' + stage['appName'],
                                        'verification': receipts[-1]['installationEvidence'],
                                        'rootExit': receipts[-1]['rootExit'],
                                        'preservedAfterClose': True,
                                        'existingAppWasReplaced': False},
                  'relaunch': {'attempted': len(session.launch_pids) == 2,
                               'distinctPIDsReported': len(session.launch_pids) == 2 and
                               len(set(session.launch_pids)) == 2}}
        clone = self.instance_clone_receipt()
        if clone is not None:
            result['instance'] = clone
        self.write_durable_json_exclusive(self.out / 'result.json', result)
        return result

    def phase(self, name):
        if getattr(self, 'lease_owner', None):
            self.publish_lease_flag()
        if name in ('install', 'launch', 'relaunch', 'import-dev', 'cleanup', 'e2e'):
            self.begin_effect()
        self.pending = name
        self.sequence += 1
        token = f'{self.sequence:04d}-{name}'
        target = self.report / (token + '.result')
        request = self.stage / 'request.tmp'
        request.write_text(token + '\n')
        request.replace(self.stage / 'request')
        self.wait_result(target)
        self.log.append(name)
        self.pending = None

    def begin_effect(self):
        if self.effect_owned:
            return
        try:
            with self.effect_file.open('x') as stream:
                self.effect_file.chmod(0o600)
                json.dump({'runId': self.run_id, 'evidence': str(self.out)}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            # Persist the directory entry before publishing any guest effect.
            self.sync_effect_directory()
        except FileExistsError as error:
            raise Refused('UNRESOLVED_GUEST_OPERATION') from error
        self.effect_owned = True

    def sync_directory(self, path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def sync_effect_directory(self):
        self.sync_directory(self.effect_file.parent)

    def write_durable_json(self, path, payload):
        """Atomic temp+replace publish, fsyncing the file before rename and the
        directory entry after, so an acquired lease survives a crash."""
        temp = path.parent / ('.' + uuid.uuid4().hex + '.tmp')
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(payload, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
        self.sync_directory(path.parent)

    def input_lease_holder(self):
        """Names only, from the published metadata contract; unreadable or
        invalid metadata is 'unknown'."""
        file = self.machine / 'input-lease.json'
        try:
            info = file.lstat()
            if not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 4096):
                return 'unknown'
            value = json.loads(file.read_text())
        except (OSError, ValueError):
            return 'unknown'
        if (isinstance(value, dict) and value.get('schema') == 'terminal-mac.input-lease/1'
                and isinstance(value.get('owner'), str) and value['owner']):
            return value['owner']
        return 'unknown'

    def write_durable_json_exclusive(self, path, payload):
        """Create a custody record without replacing a predecessor's evidence.

        Publication before the directory fsync is uncertain on failure. The
        existing file must be retained for reconciliation, never rolled back.
        This intentionally differs from write_durable_json's replace contract.
        """
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(payload, stream)
            stream.flush()
            os.fsync(stream.fileno())
        self.sync_directory(path.parent)

    def require_no_lease_predecessor(self):
        """A free flock is not evidence that an old guest action has finished."""
        for path in (self.machine / 'input-lease.json', self.exchange / '.input-lease.json'):
            try:
                path.lstat()  # includes dangling symlinks and unsafe file types
            except FileNotFoundError:
                continue
            except OSError as error:
                raise Refused('HELPER_UPDATE_CUSTODY_UNRESOLVED') from error
            raise Refused('HELPER_UPDATE_CUSTODY_UNRESOLVED')

    def effect_fence_definitely_absent(self):
        """Only ENOENT proves absence; dangling links or unreadable paths do not."""
        try:
            self.effect_file.lstat()
        except FileNotFoundError:
            return True
        except OSError as error:
            raise Refused('GUEST_OPERATION_FENCE_UNINSPECTABLE') from error
        return False

    def require_own_lease_metadata(self):
        path = self.machine / 'input-lease.json'
        require(getattr(self, 'lease_metadata_owned', False), 'GUEST_INPUT_LEASE_METADATA_UNCONFIRMED')
        try:
            info = regular(path, 4096)
            metadata = json.loads(path.read_text())
        except (OSError, ValueError, TypeError) as error:
            raise Refused('GUEST_INPUT_LEASE_METADATA_CHANGED') from error
        require(metadata == self.lease_metadata_value and
                (info.st_dev, info.st_ino) == self.lease_metadata_identity,
                'GUEST_INPUT_LEASE_METADATA_CHANGED')

    def require_own_update_marker(self):
        require(getattr(self, 'helper_update_flag_owned', False), 'HELPER_UPDATE_CUSTODY_UNCONFIRMED')
        marker = self.exchange / '.input-lease.json'
        try:
            regular(marker, 4096)
            value = json.loads(marker.read_text())
        except (OSError, ValueError, TypeError) as error:
            raise Refused('HELPER_UPDATE_CUSTODY_CHANGED') from error
        require(isinstance(value, dict) and
                value.get('schema') == 'terminal-mac.input-lease-flag/1' and
                value.get('owner') == 'farol-smoke:' + self.run_id and
                type(value.get('deadline')) in (int, float) and
                math.isfinite(value['deadline']) and value['deadline'] > 0,
                'HELPER_UPDATE_CUSTODY_CHANGED')

    def acquire_input_lease(self):
        """Take the flock before writing a new, exclusively owned metadata pair.

        Failure of either publication or its sync retains possible partial
        records. Never use the clean-release path while ownership is uncertain.
        """
        self.exchange.mkdir(mode=0o700, exist_ok=True)
        require(self.exchange.is_dir() and not self.exchange.is_symlink(), 'EXCHANGE_SHARE_REQUIRED')
        fd = os.open(self.machine / 'input-lease.lock',
                     os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600)
        try:
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                    info.st_uid == os.geteuid() and not info.st_mode & 0o077,
                    'GUEST_INPUT_LEASE_LOCK_UNSAFE')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Refused('GUEST_INPUT_LEASE_HELD:' + self.input_lease_holder()) from error
        except BaseException:
            os.close(fd)  # also on unsafe entries and unexpected flock failures
            raise
        self.lease_fd = fd
        self.lease_owner = 'farol-smoke:' + self.run_id
        self.lease_metadata_owned = False
        self.helper_update_flag_owned = False
        self.lease_metadata_value = None
        self.lease_metadata_identity = None
        try:
            self.require_no_lease_predecessor()
            metadata = {'schema': 'terminal-mac.input-lease/1', 'owner': self.lease_owner,
                        'generation': 1, 'acquiredAt': int(time.time())}
            path = self.machine / 'input-lease.json'
            self.write_durable_json_exclusive(path, metadata)
            info = regular(path, 4096)
            self.lease_metadata_value = metadata
            self.lease_metadata_identity = (info.st_dev, info.st_ino)
            self.lease_metadata_owned = True
            self.publish_lease_flag(initial=True)
            self.helper_update_flag_owned = True
        except BaseException:
            # Do not invoke release_input_lease: metadata or marker may have
            # been published even if its last fsync/ACK failed. In particular,
            # never unlink pre-existing machine metadata on a refused admission.
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
                self.lease_fd = None
                self.lease_owner = None
            raise

    def publish_lease_flag(self, initial=False):
        """Keep a native service marker immutable for the bounded run.

        Atomic replacement of this shared file between native requests can
        race VirtioFS descriptor/name caches. A native marker covers the whole
        bounded run plus its final request margin and is never renewed/adopted.
        Legacy scenarios retain their original refresh contract.
        """
        marker = self.exchange / '.input-lease.json'
        native = getattr(getattr(self, 'a', None), 'native_app_service', False)
        if native and not initial:
            self.require_own_update_marker()
            return
        lifetime = max(120.0, self.deadline - time.monotonic() + 120.0) if native else 120.0
        value = {'schema': 'terminal-mac.input-lease-flag/1', 'owner': self.lease_owner,
                 'deadline': time.time() + lifetime}
        if initial:
            self.write_durable_json_exclusive(marker, value)
        else:
            self.require_own_update_marker()
            self.write_durable_json(marker, value)

    def release_input_lease(self):
        """Clean completion removes only confirmed, unchanged records of this run.

        UNKNOWN/effectful exits retain both records until finish_effect or an
        explicit reconciliation; the host kernel flock itself is released.
        """
        if getattr(self, 'lease_fd', None) is None:
            return
        try:
            finished_without_effect = (not self.effect_owned and self.effect_fence_definitely_absent()
                                       and self.pending is None
                                       and (not self.log or self.log[-1] == 'stop')
                                       and getattr(self, 'cleanup_note', None) in (None, 'CLEARED', 'RETAINED_NO_EFFECT'))
            if finished_without_effect and getattr(self, 'helper_update_flag_owned', False):
                self.require_own_lease_metadata()
                self.require_own_update_marker()
                # Remove metadata first. If removal/sync fails, the marker
                # remains and blocks automatic helper replacement.
                (self.machine / 'input-lease.json').unlink()
                self.sync_directory(self.machine)
                self.lease_metadata_owned = False
                (self.exchange / '.input-lease.json').unlink()
                self.sync_directory(self.exchange)
                self.helper_update_flag_owned = False
        finally:
            fd = self.lease_fd
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)
                self.lease_fd = None
                self.lease_owner = None

    def lease_evidence(self):
        """Guest-input lease facts recorded with every result; names only."""
        return {'owner': getattr(self, 'lease_owner', None), 'generation': 1}

    def finish_effect(self):
        if self.effect_owned:
            regular(self.effect_file, 4096)
            require(json.loads(self.effect_file.read_text()).get('runId') == self.run_id,
                    'GUEST_OPERATION_FENCE_CHANGED')
            require(self.log and self.log[-1] in ('stop', 'native:close'), 'GUEST_SERVER_NOT_STOPPED')
            require(self.cleanup_note == 'CLEARED', 'GUEST_CLEANUP_UNCONFIRMED')
            # This is the delayed clean path for a scenario whose host flock
            # was released in run()'s finally. Exact metadata from THIS run,
            # not a predecessor's lookalike, must remain before removal.
            self.require_own_lease_metadata()
            self.require_own_update_marker()
            (self.machine / 'input-lease.json').unlink()
            self.sync_directory(self.machine)
            self.lease_metadata_owned = False
            # Keep the update inhibitor until the effect fence has durably
            # cleared; a mid-cleanup error leaves it present for recovery.
            self.effect_file.unlink()
            self.sync_effect_directory()
            self.effect_owned = False
            (self.exchange / '.input-lease.json').unlink()
            self.sync_directory(self.exchange)
            self.helper_update_flag_owned = False

    def quit_proof(self):
        self.phase('quit-proof')
        file = self.report / 'quit-proof.json'
        regular(file, 32768)
        return json.loads(file.read_text())

    def require_quit_drain(self, before):
        after = self.quit_proof()
        require(after.get('runningMarker') == 'absent' and
                after.get('receiptMarker') == 'present' and
                after.get('running') is False and after.get('drained') is True and
                after.get('receipt') != before.get('receipt') and
                type(after.get('quitAt')) is int and type(before.get('observedAt')) is int and
                before['observedAt'] <= after['quitAt'] <= after['observedAt'],
                'GUEST_QUIT_DRAIN_UNCONFIRMED')

    def state(self):
        self.phase('inspect')
        file = self.report / 'state.json'
        regular(file, 4096)
        value = json.loads(file.read_text())
        require(isinstance(value.get('pids'), list) and type(value.get('windows')) is int,
                'GUEST_STATE_INVALID')
        return value

    def wait_state(self, running, foreground=False):
        # Bounded state polling, not repeated launch/quit effects.
        while True:
            state = self.state()
            if running and bool(state['pids']) and state['windows'] == 1 and (not foreground or state.get('foreground') is True):
                return state
            if not running and not state['pids']:
                return state
            self.remaining()
            time.sleep(0.4)

    def clear_dev_payload(self):
        # Credentials are never diagnostic evidence, even when the guest outcome
        # is unknown. Keep metadata/receipts, not a duplicate raw host key.
        for name in ('dev-key', 'dev-connection.json'):
            (self.stage / name).unlink(missing_ok=True)

    def instance_clone_receipt(self):
        """Provenance of a cloned run instance, or None for a full machine.
        Reads only the clone receipt the terminal-mac clone command wrote:
        names, digests and timestamps, never credential material."""
        file = self.machine / 'clone.json'
        try:
            info = file.lstat()
        except OSError:
            return None
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 4096,
                'INSTANCE_RECEIPT_UNSAFE')
        try:
            value = json.loads(file.read_text())
        except ValueError:
            raise Refused('INSTANCE_RECEIPT_INVALID') from None
        require(isinstance(value, dict) and value.get('schema') == 'terminal-mac.clone/1'
                and isinstance(value.get('from'), str) and isinstance(value.get('to'), str),
                'INSTANCE_RECEIPT_INVALID')
        return {'clonedFrom': value['from'], 'instance': value['to'],
                'identitySha256': value.get('identitySha256'), 'at': value.get('at')}

    def cleanup_disposition(self):
        """Best-effort raw-payload removal that never masks a primary result.

        The first attempt's disposition is recorded and authoritative: a
        repeated call (except path, then finally) never re-runs the removal,
        so a FAILED attempt can never be upgraded into a residue-free claim.
        """
        if getattr(self, 'cleanup_note', None) is None:
            try:
                self.clear_dev_payload()
            except Exception as error:
                self.cleanup_note = 'FAILED:STAGING_CLEANUP_UNCONFIRMED'
            else:
                self.cleanup_note = 'CLEARED'
        return self.cleanup_note

    def finish_staging(self):
        """Remove exact task-owned host staging, recording failure instead of
        letting it mask the published result."""
        if self.cleanup_disposition() == 'CLEARED':
            try:
                shutil.rmtree(self.stage)
            except FileNotFoundError:
                self.cleanup_note = 'CLEARED'
            except Exception as error:
                self.cleanup_note = 'FAILED:STAGING_CLEANUP_UNCONFIRMED'
            else:
                self.cleanup_note = 'CLEARED'
        return self.cleanup_note

    def prepare_stage(self):
        self.stage.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.report.mkdir(parents=True, exist_ok=False, mode=0o700)
        for name in ('guest.sh', 'inspect.js', 'no-tunnel.js', 'activate.js', 'import-dev.js', 'connection-proof.js', 'quit-proof.js', 'driver-manifest.js'):
            shutil.copyfile(Path(__file__).parent / 'vm-smoke' / name, self.stage / name)
        (self.stage / 'identity.json').write_text(json.dumps(IDENTITY))
        budget = int(self.deadline - time.monotonic())
        require(budget >= 30, 'GUEST_BUDGET_TOO_SHORT')
        (self.stage / 'timeout').write_text(str(budget))

    def driver_payload_info(self, file, prefix):
        """A driver payload must be a real regular file, never a symlink."""
        try:
            info = file.lstat()
        except OSError:
            raise Refused(prefix + '_MISSING') from None
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, prefix + '_UNSAFE')
        return info

    def copy_driver_payload(self, source, target, mode, expected_sha, expected_size, prefix):
        """Exclusive durable copy whose staged bytes are re-verified against the
        manifest, so a source swap between validation and staging is caught."""
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, 'wb') as out:
                with source.open('rb') as stream:
                    shutil.copyfileobj(stream, out)
                out.flush()
                os.fsync(out.fileno())
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        require(target.stat().st_size == expected_size and digest(target) == expected_sha,
                prefix + '_DIGEST_INVALID')

    def stage_driver(self, driver_dir):
        """Stage the vm-e2e in-guest driver payload into this run's stage.

        Host-side only, after prepare_stage: validates the manifest written by
        tooling/vm-e2e/bundle-driver.mjs, verifies the bundle and the pinned
        Node payload against it, copies them in as driver.bundle.mjs and node,
        and publishes driver.manifest.json recording the staged digests. No
        guest action happens here and no secret material is handled.
        """
        source = Path(driver_dir)
        refuse_host_profile_path(source, IDENTITY)
        require(source.is_dir() and not source.is_symlink(), 'DRIVER_MANIFEST_INVALID')
        manifest_file = source / 'manifest.json'
        try:
            info = manifest_file.lstat()
            if not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 65536):
                raise ValueError('driver-manifest-not-regular')
            manifest = json.loads(manifest_file.read_text())
        except (OSError, ValueError):
            raise Refused('DRIVER_MANIFEST_INVALID') from None
        require(isinstance(manifest, dict) and manifest.get('schema') == DRIVER_MANIFEST_SCHEMA,
                'DRIVER_MANIFEST_INVALID')
        require(isinstance(manifest.get('tool'), str) and manifest['tool'] and
                isinstance(manifest.get('entry'), str) and manifest['entry'] and
                manifest.get('bundler') in ('esbuild', 'inline'), 'DRIVER_MANIFEST_INVALID')
        bundle = manifest.get('bundle')
        node = manifest.get('node')
        require(isinstance(bundle, dict) and isinstance(node, dict), 'DRIVER_MANIFEST_INVALID')
        bundle_name = bundle.get('file')
        require(isinstance(bundle_name, str) and
                re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', bundle_name), 'DRIVER_MANIFEST_INVALID')
        require(type(bundle.get('bytes')) is int and 0 < bundle['bytes'] and
                re.fullmatch('[a-f0-9]{64}', bundle.get('sha256') or ''), 'DRIVER_MANIFEST_INVALID')
        node_path = node.get('path')
        require(isinstance(node_path, str) and node_path and Path(node_path).is_absolute(),
                'DRIVER_MANIFEST_INVALID')
        refuse_host_profile_path(node_path, IDENTITY)
        require(type(node.get('size')) is int and 0 < node['size'] and
                re.fullmatch('[a-f0-9]{64}', node.get('sha256') or ''), 'DRIVER_MANIFEST_INVALID')
        # Size and digest must match at every point: source first, then the
        # staged copy inside copy_driver_payload.
        node_source = Path(node_path)
        require(self.driver_payload_info(source / bundle_name, 'DRIVER_BUNDLE').st_size == bundle['bytes'] and
                digest(source / bundle_name) == bundle['sha256'], 'DRIVER_BUNDLE_DIGEST_INVALID')
        require(self.driver_payload_info(node_source, 'DRIVER_NODE').st_size == node['size'] and
                digest(node_source) == node['sha256'], 'DRIVER_NODE_DIGEST_INVALID')
        staged = {'schema': DRIVER_MANIFEST_SCHEMA, 'tool': manifest['tool'], 'entry': manifest['entry'],
                  'bundler': manifest['bundler'],
                  'bundle': {'file': 'driver.bundle.mjs', 'sha256': bundle['sha256'], 'bytes': bundle['bytes']},
                  'node': {'path': 'node', 'size': node['size'], 'sha256': node['sha256']},
                  'staged': True}
        try:
            self.copy_driver_payload(source / bundle_name, self.stage / 'driver.bundle.mjs', 0o600,
                                     bundle['sha256'], bundle['bytes'], 'DRIVER_BUNDLE')
            self.copy_driver_payload(node_source, self.stage / 'node', 0o700,
                                     node['sha256'], node['size'], 'DRIVER_NODE')
            # The staged manifest keeps the producer schema and provenance
            # fields but records the staged names and the verified staged
            # digests; it never carries a host absolute path into the share.
            self.write_durable_json(self.stage / 'driver.manifest.json', staged)
        except BaseException:
            for name in DRIVER_STAGE_NAMES:
                (self.stage / name).unlink(missing_ok=True)
            raise
        return staged

    def prepare_e2e_context(self, staged, artifact):
        """Expected selection is source-declared, never taken from a result file.

        All current entries are infrastructure/diagnostic. None is product E2E.
        The context is staged before app startup and the exact bytes are retained.
        """
        contracts = json.loads((Path(__file__).parent / 'vm-e2e/scenario-contracts.json').read_text())
        require(contracts.get('schema') == 'farol.vm-e2e.scenarios/1', 'E2E_CONTRACT_INVALID')
        selected = contracts.get('entries', {}).get(staged['entry'])
        require(isinstance(selected, dict) and set(selected) == {'scenario', 'evidenceClass', 'selection'},
                'E2E_ENTRY_NOT_DECLARED')
        require(selected['evidenceClass'] in ('infrastructure', 'diagnostic') and
                isinstance(selected['scenario'], str) and re.fullmatch('[a-z][a-z0-9-]{0,127}', selected['scenario']),
                'E2E_CONTRACT_INVALID')
        cases = selected['selection']
        require(isinstance(cases, list) and 0 < len(cases) <= 64 and
                all(isinstance(item, str) and re.fullmatch('[a-z0-9][a-z0-9-]{0,127}', item) for item in cases) and
                len(set(cases)) == len(cases), 'E2E_CASE_SELECTION_INVALID')
        context = {'schema': 'farol.vm-e2e.context/1', 'runId': self.run_id,
                   **selected, 'bundleSha256': staged['bundle']['sha256'],
                   'artifact': {key: artifact[key] for key in
                                ('sourceCommit', 'buildId', 'artifactSha256', 'archiveSha256')}}
        file = self.stage / 'driver.context.json'
        self.write_durable_json(file, context)
        self.e2e_context = context
        self.e2e_context_sha = digest(file)
        self.preserve_e2e_bytes('e2e-context.json', file.read_bytes())

    def preserve_e2e_bytes(self, name, data):
        """Exact raw evidence, including empty/malformed JSON; never overwrite."""
        target = self.out / name
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        self.sync_directory(self.out)

    def read_e2e_file(self, name, limit):
        file = self.report / 'e2e' / (name + '.json')
        try:
            require(file.parent.is_dir() and not file.parent.is_symlink(), 'E2E_' + name.upper() + '_MISSING')
            fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 <= info.st_size <= limit,
                        'E2E_' + name.upper() + '_UNSAFE')
                data = source.read(limit + 1)
                require(len(data) == info.st_size, 'E2E_' + name.upper() + '_CHANGED')
        except FileNotFoundError:
            return None, 'E2E_' + name.upper() + '_MISSING'
        except (OSError, Refused):
            return None, 'E2E_' + name.upper() + '_UNSAFE'
        try:
            self.preserve_e2e_bytes('e2e-' + name + '.raw.json', data)
        except OSError:
            return None, 'E2E_EVIDENCE_WRITE_FAILED'
        try:
            def unique_object(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('duplicate JSON key')
                    result[key] = value
                return result
            def reject_constant(_value):
                raise ValueError('non-JSON constant')
            return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject_constant), None
        except (ValueError, UnicodeError, RecursionError):
            return None, 'E2E_' + name.upper() + '_JSON_INVALID'

    def validate_e2e_result(self, value):
        context = self.e2e_context
        keys = {'schema', 'runId', 'scenario', 'selection', 'evidenceClass', 'bundleSha256',
                'artifact', 'contextSha256', 'status', 'cases', 'reason', 'details'}
        require(isinstance(value, dict) and set(value) == keys, 'E2E_RESULT_SHAPE_INVALID')  # gitleaks:allow (error code, not a secret)
        require(value['schema'] == 'farol.vm-e2e.result/1', 'E2E_RESULT_SCHEMA_UNSUPPORTED')
        require(all(value[key] == context[key] for key in
                    ('runId', 'scenario', 'selection', 'evidenceClass', 'bundleSha256', 'artifact')) and
                value['contextSha256'] == self.e2e_context_sha, 'E2E_RESULT_BINDING_MISMATCH')
        require(isinstance(value['details'], dict), 'E2E_RESULT_DETAILS_INVALID')
        cases = value['cases']
        require(isinstance(cases, list) and len(cases) == len(context['selection']) and
                all(isinstance(item, dict) and set(item) == {'id', 'status'} for item in cases),
                'E2E_CASES_INCOMPLETE')
        require([item['id'] for item in cases] == context['selection'] and
                all(item['status'] in ('PASS', 'FAIL', 'NOT_RUN', 'REPORTED') for item in cases),
                'E2E_CASES_INVALID')
        reason = value['reason']
        require(reason is None or (isinstance(reason, str) and 0 < len(reason) <= 2048), 'E2E_REASON_INVALID')
        status = value['status']
        if status == 'PASS':
            require(context['evidenceClass'] == 'infrastructure' and reason is None and
                    all(item['status'] == 'PASS' for item in cases), 'E2E_PASS_INCOMPLETE')
        elif status == 'REPORTED':
            require(context['evidenceClass'] == 'diagnostic' and reason is None and
                    all(item['status'] == 'REPORTED' for item in cases), 'E2E_REPORTED_INVALID')
        elif status == 'FAIL':
            require(reason is not None or any(item['status'] == 'FAIL' for item in cases),
                    'E2E_FAIL_WITHOUT_FAILURE')
        else:
            raise Refused('E2E_STATUS_UNSUPPORTED')
        return status

    def collect_e2e_result(self, token):
        """A result cannot overrule an unconfirmed/nonzero process terminal."""
        process, process_error = self.read_e2e_file('process', 8192)
        receipt, result_error = self.read_e2e_file('result', 262144)
        process_ok = (process_error is None and isinstance(process, dict) and
                      set(process) == {'schema', 'runId', 'token', 'contextSha256', 'exitCode'} and
                      process['schema'] == 'farol.vm-e2e.process/1' and process['runId'] == self.run_id and
                      process['token'] == token and process['contextSha256'] == self.e2e_context_sha and
                      type(process['exitCode']) is int and 0 <= process['exitCode'] <= 255)
        self.driver_process_confirmed = process_ok
        reported = None
        if result_error is None:
            try:
                reported = self.validate_e2e_result(receipt)
            except Refused as error:
                result_error = str(error)
        if reported == 'FAIL':
            status, reason = 'FAIL', 'E2E_ASSERTIONS_FAILED'
        elif not process_ok:
            status, reason = 'UNKNOWN', 'E2E_PROCESS_UNCONFIRMED'
        elif process['exitCode'] != 0:
            status, reason = 'FAIL', 'E2E_PROCESS_FAILED'
        elif result_error:
            status, reason = 'INVALID', result_error
        else:
            status, reason = reported, None
        self.driver_result = {
            'schema': 'farol.vm-e2e.admission/1', 'runId': self.run_id,
            'scenario': self.e2e_context['scenario'], 'evidenceClass': self.e2e_context['evidenceClass'],
            'status': status, 'reason': reason, 'receipt': receipt, 'process': process,
            'processError': process_error, 'resultError': result_error,
            'rawEvidence': {name: {'file': 'e2e-' + name + '.raw.json',
                                   'sha256': digest(self.out / ('e2e-' + name + '.raw.json'))}
                            for name in ('process', 'result')
                            if (self.out / ('e2e-' + name + '.raw.json')).is_file()},
            # Current declared drivers are probes, not the product's ordinary E2E.
            'qualificationEligible': False}

    def execute_e2e(self):
        token = f'{self.sequence + 1:04d}-e2e'
        try:
            self.phase('e2e')
        except (Refused, OSError, ValueError, KeyError, KeyboardInterrupt, subprocess.TimeoutExpired) as error:
            self.e2e_phase_error = safe_failure_code(error)
            self.collect_e2e_result(token)
            raise  # Preserve the original phase error; do not replay or mutate.
        self.collect_e2e_result(token)
        if not self.driver_process_confirmed:
            self.pending = 'e2e'
            raise Refused('E2E_PROCESS_UNCONFIRMED')

    def attach_e2e_evidence(self, result, error=None):
        """Assertions, smoke lifecycle, and operation completion are distinct."""
        if getattr(self, 'driver_result', None) is None:
            return
        result['e2e'] = self.driver_result
        status = self.driver_result['status']
        result['test'] = {'status': 'FAIL' if status in ('FAIL', 'INVALID') else status,
                          'scenario': self.driver_result['scenario'],
                          'evidenceClass': self.driver_result['evidenceClass']}
        confirmed = (self.driver_process_confirmed and error is None and self.pending is None and
                     self.log and self.log[-1] == 'stop' and result.get('cleanup') == 'CLEARED')
        result['operation'] = {'status': 'CONFIRMED' if confirmed else 'UNKNOWN',
                               'pending': self.pending, 'error': safe_failure_code(error) if error is not None else None}
        result.setdefault('lifecycle', 'UNKNOWN')
        result.setdefault('ui', 'NEEDS_REVIEW')
        if result['test']['status'] == 'FAIL':
            result['status'] = 'FAIL'
            result['reason'] = getattr(self, 'e2e_phase_error', None) or self.driver_result['reason']
        elif not confirmed:
            result['status'] = 'UNKNOWN'
            result['reason'] = safe_failure_code(error) if error is not None else 'E2E_TEARDOWN_UNCONFIRMED'
        else:
            result['status'] = 'NEEDS_REVIEW'

    def finish_failed_e2e(self, manifest, initial):
        # The driver has a confirmed terminal, so only bounded normal teardown
        # follows. Do not continue with another relaunch/scenario after failure.
        self.quit_guest_app()
        self.phase('cleanup')
        self.phase('stop')
        result = dict(status='FAIL', lifecycle='NOT_RUN', ui='NEEDS_REVIEW',
                      version=manifest['version'], archiveSha256=manifest['archiveSha256'],
                      initial=initial, phases=self.log, cleanup=self.finish_staging(),
                      lease=self.lease_evidence(), networkPolicy=self.network_policy)
        self.attach_e2e_evidence(result)
        (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result

    def connection_proof(self):
        self.prepare_stage()
        self.start_guest()
        self.phase('share-probe')
        require(bool(self.state()['pids']), 'GUEST_APP_NOT_RUNNING')
        self.phase('connection-proof')
        file = self.report / 'connection.json'
        regular(file, 4096)
        proof = json.loads(file.read_text())
        (self.out / 'connection.json').write_text(json.dumps(proof, indent=2) + '\n')
        self.phase('activate')
        self.phase('stop')
        result = dict(status='LOCAL_PROOF_CAPTURED', remoteTest='NOT_RUN',
                      cleanup=self.finish_staging(), phases=self.log,
                      lease=self.lease_evidence())
        (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result

    def quit_guest_app(self):
        before = self.state()
        require(before['windows'] <= 1, 'MULTIPLE_GUEST_WINDOWS')
        if before['pids']:
            self.phase('activate')
            self.wait_state(True, foreground=True)
            proof = self.quit_proof()
            self.begin_effect()
            self.action('key', 'cmd+q')
            self.wait_state(False)
            self.require_quit_drain(proof)
        else:
            proof = self.quit_proof()
            require(proof.get('runningMarker') == 'absent' and proof.get('running') is False and
                    ((proof.get('receiptMarker') == 'absent' and proof.get('receipt') is None) or
                     (proof.get('receiptMarker') == 'present' and proof.get('drained') is True)),
                    'GUEST_QUIT_DRAIN_UNCONFIRMED')
        return bool(before['pids'])

    def release_dev(self):
        self.prepare_stage()
        self.start_guest()
        self.phase('share-probe')
        self.phase('admit')
        require(self.quit_guest_app(), 'GUEST_CLOSE_NOT_OBSERVED')
        self.phase('connection-proof')
        shutil.copyfile(self.report / 'connection.json', self.out / 'connection.json')
        self.phase('stop')
        result = dict(status='GUEST_APP_QUIT', profiles='PRESERVED', hostDev='NOT_STARTED',
                      cleanup=self.finish_staging(), phases=self.log,
                      lease=self.lease_evidence())
        (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result

    def connect_dev(self):
        self.prepare_stage()
        self.start_guest()
        self.phase('share-probe')
        self.phase('admit')
        self.quit_guest_app()
        # Prove transport before exposing a credential to this inbox. The guest
        # may already be stopped, so quit_guest_app() need not own an effect.
        # Fence durably BEFORE export: a hard exit during staging must block
        # later runs even when no import request was ever published.
        self.begin_effect()
        export_dev_connection(self.stage, IDENTITY)
        require_host_dev_stopped(IDENTITY)
        self.phase('import-dev')
        # Key material is removed from host staging immediately after guest ACK.
        self.cleanup_disposition()
        self.phase('launch')
        self.wait_state(True)
        self.phase('activate')
        self.wait_state(True, foreground=True)
        self.screenshot('dev-imported')
        self.phase('stop')
        result = dict(status='NEEDS_REVIEW', devConnection='IMPORTED_OFFLINE', tunnel='NOT_STARTED',
                      profile='guest-package-only', cleanup=self.finish_staging(), phases=self.log,
                      lease=self.lease_evidence())
        (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        return result

    def wait_guest_ready(self):
        # Status is read-only. A cold login/helper may not answer immediately;
        # permission denial is a distinct owner prerequisite, never retried.
        while True:
            self.remaining()
            try:
                grants = self.action('status', '--timeout', '2')
            except Refused as error:
                if str(error) != 'GUEST_ACTION_FAILED:action':
                    raise
                self.remaining()
                time.sleep(0.3)
                continue
            require(all(grants.get(k) == 'true' for k in ('accessibility', 'screenRecording')),
                    'GUEST_PERMISSIONS_MISSING')
            return grants

    def admit_closed(self):
        """Closed-contour admission, refusing before any guest action.

        machine.json is the VM configuration source of truth: terminal-mac
        builds the VZ virtual-machine configuration from machine.network
        (source-verified fact), so a recorded network == false proves the VM
        CONFIG is offline. This is config provenance only — no runtime egress
        probe exists here and none is claimed; the in-guest negative probe
        stays a separate receipt.
        """
        file = self.machine / 'machine.json'
        try:
            fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 65536):
                    raise ValueError('machine-file-not-regular')
                data = source.read(65537)
                if len(data) != info.st_size:
                    raise ValueError('machine-file-changed-while-reading')

            def unique_object(pairs):
                value = {}
                for key, item in pairs:
                    if key in value:
                        raise ValueError('duplicate-machine-key')
                    value[key] = item
                return value

            machine = json.loads(data, object_pairs_hook=unique_object)
        except (OSError, ValueError):
            raise Refused('VM_MACHINE_FILE_INVALID') from None
        require(isinstance(machine, dict) and machine.get('name') == self.machine.name, 'VM_MACHINE_FILE_INVALID')
        require(machine.get('network') is False, 'CLOSED_REQUIRES_OFFLINE_MACHINE')
        return {'mode': 'guest-offline-local-fixtures', 'machineNetwork': False,
                'receipt': 'machine.json-offline-verified'}

    def run(self):
        with (self.machine / '.farol-smoke.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise Refused('VM_BUSY') from e
            # connection_proof still starts/bootstrap-controls the guest and
            # activates the app. It is not a read-only reconciliation route.
            require(self.effect_fence_definitely_absent(), 'UNRESOLVED_GUEST_OPERATION')
            residue = staging_residue(self.inbox)
            require(not residue, 'UNRECONCILED_STAGING_RESIDUE:' +
                    ','.join(item['directory'] for item in residue))
            # Closed-contour admission precedes the input lease and every VM
            # or guest effect; args namespaces without the flag are ordinary.
            self.network_policy = self.admit_closed() if getattr(self.a, 'closed', False) else None
            self.acquire_input_lease()
            try:
                status = self.cli('status', self.a.vm)
                # A machine.json edited after a VM boot does not describe the
                # running VZ configuration. Closed runs must start from stopped.
                if getattr(self.a, 'closed', False):
                    require(status.get('state') == 'stopped', 'CLOSED_REQUIRES_FRESH_VM_BOOT')
                if status.get('state') == 'stopped':
                    self.pending = 'vm-start'
                    status = self.cli('start', self.a.vm)
                    self.pending = None
                    if status.get('state') == 'already-running':
                        require(not getattr(self.a, 'closed', False), 'CLOSED_REQUIRES_FRESH_VM_BOOT')
                        status = self.cli('status', self.a.vm)
                    else:
                        self.log.append('vm-started')
                require(status.get('state') == 'running', 'VM_NOT_RUNNING')
                if getattr(self.a, 'native_app_service', False):
                    require(status.get('artifactShareReadOnly') == 'true' and
                            status.get('artifactShareEvidence') == 'live-vz-configuration/1',
                            'APP_SERVICE_UNSAFE_PATH')
                if getattr(self.a, 'closed', False):
                    # Catch configuration drift across boot before guest input;
                    # this still does not attest the live VZ network attachment.
                    require(self.admit_closed() == self.network_policy, 'CLOSED_NETWORK_CONFIG_CHANGED')
                if self.a.visible:
                    # The deliberately shown window stays interactive for its holder.
                    self.cli('show', self.a.vm, '--owner', self.lease_owner)
                else:
                    self.cli('hide', self.a.vm)
                grants = self.wait_guest_ready()
                (self.out / 'guest-status.json').write_text(json.dumps(grants, indent=2))
                if not getattr(self.a, 'native_app_service', False):
                    require(self.a.terminal_point[0] < int(grants['width']) and self.a.terminal_point[1] < int(grants['height']), 'TERMINAL_POINT_OUTSIDE_DISPLAY')
                self.screenshot('preflight')
                if self.a.connect_dev:
                    return self.connect_dev()
                if self.a.connection_proof:
                    return self.connection_proof()
                if self.a.release_dev:
                    return self.release_dev()
                # Native app service does not import or read host Dev state.
                # Legacy shell scenarios retain their existing Dev prerequisite.
                if not getattr(self.a, 'native_app_service', False):
                    require_host_dev_stopped(IDENTITY)
                archive = Path(self.a.artifact).expanduser().absolute() if self.a.artifact else download_latest(self.out, self.deadline)
                manifest = verify(archive)
                if getattr(self.a, 'native_app_service', False):
                    return self.run_native_app_service(archive, manifest, grants)
                self.prepare_stage()
                shutil.copyfile(archive, self.stage / 'app.zip')
                (self.stage / 'archive.sha256').write_text(manifest['archiveSha256'])
                (self.stage / 'version').write_text(manifest['version'])
                if getattr(self.a, 'closed', False) and getattr(self.a, 'e2e_driver', None):
                    staged = self.stage_driver(self.a.e2e_driver)
                    self.prepare_e2e_context(staged, manifest)
                self.start_guest()
                self.phase('share-probe')
                if self.a.prepare_test_guest:
                    self.phase('prepare')
                self.phase('admit')
                self.quit_guest_app()
                self.phase('install')
                self.phase('launch')
                initial = self.wait_state(True)
                # App activation is verified before UI capture or Quit input.
                self.phase('activate')
                self.wait_state(True, foreground=True)
                self.screenshot('setup-or-returning')
                if self.a.menu_point:
                    require(self.a.menu_point[0] < int(grants['width']) and self.a.menu_point[1] < int(grants['height']), 'MENU_POINT_OUTSIDE_DISPLAY')
                    self.action('click', *self.a.menu_point)
                    menu_deadline = min(self.deadline, time.monotonic() + 5)
                    while self.state().get('menus', 0) < 1:
                        require(time.monotonic() < menu_deadline, 'MENU_NOT_OBSERVED')
                    self.screenshot('menubar')
                    self.action('key', 'escape')
                self.phase('activate')
                self.wait_state(True, foreground=True)
                if self.e2e_context is not None:
                    self.execute_e2e()
                    if self.driver_result['status'] in ('FAIL', 'INVALID'):
                        return self.finish_failed_e2e(manifest, initial)
                proof = self.quit_proof()
                self.begin_effect()
                self.action('key', 'cmd+q')
                self.log.append('quit-requested')
                stopped = self.wait_state(False)
                self.require_quit_drain(proof)
                self.screenshot('quit')
                self.phase('relaunch')
                relaunched = self.wait_state(True)
                require(initial['pids'] != relaunched['pids'], 'RELAUNCH_PID_UNCHANGED')
                self.phase('activate')
                self.wait_state(True, foreground=True)
                self.screenshot('relaunch')
                self.phase('connection-proof')
                connection_file = self.report / 'connection.json'
                regular(connection_file, 4096)
                connection = json.loads(connection_file.read_text())
                (self.out / 'connection.json').write_text(json.dumps(connection, indent=2) + '\n')
                self.phase('cleanup')
                self.phase('stop')
                # Structural assertions are automatic; pixel semantics require the agent.
                result = dict(status='NEEDS_REVIEW', lifecycle='PASS', ui='NEEDS_REVIEW',
                              tunnel='NOT_QUALIFIED' if connection.get('approvedDev') else 'NOT_RUN',
                              profile='guest-package-only',
                              version=manifest['version'], archiveSha256=manifest['archiveSha256'],
                              initial=initial, stopped=stopped, relaunched=relaunched,
                              menu='CAPTURED' if self.a.menu_point else 'NOT_RUN',
                              cleanup=self.finish_staging(), phases=self.log,
                              lease=self.lease_evidence())
                if self.network_policy is not None:
                    result['networkPolicy'] = self.network_policy
                clone_receipt = self.instance_clone_receipt()
                if clone_receipt is not None:
                    # A provisioned instance records exactly which base and
                    # identity it came from; ordinary machines add no key.
                    result['instance'] = clone_receipt
                self.attach_e2e_evidence(result)
                (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                if self.a.latest and result['cleanup'] == 'CLEARED':
                    archive.unlink()
                return result
            finally:
                active_error = sys.exc_info()[1]
                if active_error is not None and getattr(self, 'first_failure', None) is None:
                    self.record_first_failure(safe_failure_code(active_error), outcome='UNKNOWN')
                try:
                    self.release_input_lease()
                except Exception as release_error:
                    self.record_secondary_failure(release_error)
                    if active_error is None:
                        raise Refused('GUEST_LEASE_RELEASE_UNCONFIRMED') from None
                    # Do not mask an earlier guest effect failure with cleanup.


def arguments(argv=None):
    config_parser = argparse.ArgumentParser(add_help=False)
    default_config = Path.home() / 'Library/Application Support' / (IDENTITY['name'] + ' Testing') / 'vm-smoke.json'
    config_parser.add_argument('--config', default=os.environ.get('FAROL_VM_CONFIG') or (str(default_config) if default_config.exists() else None))
    config_parser.add_argument('--native-app-service', action='store_true')
    early, _ = config_parser.parse_known_args(argv)
    config = {}
    if early.config:
        file = Path(early.config).expanduser()
        regular(file, 16384)
        config = json.loads(file.read_text())
        require(isinstance(config, dict) and not (set(config) - {
            'terminal_mac', 'vm_home', 'vm', 'terminal_point', 'menu_point', 'timeout', 'bootstrap', 'prepared_base'}),
            'CONFIG_FIELDS_INVALID')
        require('prepared_base' not in config or
                (isinstance(config['prepared_base'], str) and
                 re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,47}', config['prepared_base'])),
                'PREPARED_BASE_INVALID')
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', default=early.config, help='Private infrastructure-only JSON; no profiles or credentials')
    source = p.add_mutually_exclusive_group(required=True)
    source.add_argument('--artifact', help='Release ZIP with adjacent farol-release.json and SHA256SUMS')
    source.add_argument('--release-dev', action='store_true', help='Normal Quit of only the approved guest app before using host Dev; preserve guest profile and VM')
    source.add_argument('--connection-proof', action='store_true', help='Capture guest-local connection identity only; no profile import or tunnel restart')
    source.add_argument('--connect-dev', action='store_true', help='Import only the fixed host Dev tunnel ID/key into the guest package profile, with host Dev stopped; does not start tunnel')
    source.add_argument('--latest', action='store_true', help='Resolve public GitHub Latest now')
    source.add_argument('--reconcile-staging', action='store_true',
                        help='Read-only report of staging residue and effect fences; clears nothing and never touches the VM')
    p.add_argument('--native-app-service', action='store_true',
                   help='Use finite native guest app-service, never staged shell execution')
    p.add_argument('--native-relaunch', action='store_true',
                   help='For native app service only: second launch/activate/quit before close')
    p.add_argument('--expected-app-sha256',
                   help='Independently owner-approved exact application tree digest; never read it from the ZIP')
    p.add_argument('--closed', action='store_true',
                   help='Closed-contour package run on an offline guest with guest-local fixtures; requires --artifact and never downloads')
    p.add_argument('--e2e-driver', help='Directory prepared by tooling/vm-e2e/bundle-driver.mjs: the closed run stages its bundle+Node and executes the e2e phase in the offline guest')
    p.add_argument('--terminal-mac', default=config.get('terminal_mac'), help='Signed packaged terminal-mac executable, not launcher')
    p.add_argument('--vm-home', default=config.get('vm_home'), help='Dedicated TERMINAL_MAC_HOME; never host product state')
    p.add_argument('--vm', default=config.get('vm', 'pilot'))
    p.add_argument('--prepare-test-guest', action='store_true', help='Mark this dedicated guest as test-only; never imports any profile or credential')
    p.add_argument('--visible', action='store_true', help='Show guest window (default: hidden)')
    p.add_argument('--evidence', default=str(Path.home() / 'Library/Application Support' / (IDENTITY['name'] + ' Testing') / 'evidence'))
    p.add_argument('--timeout', type=int, default=config.get('timeout', 180))
    p.add_argument('--bootstrap', choices=['finder', 'terminal'], default=config.get('bootstrap', 'terminal'))
    p.add_argument('--terminal-point', '--bootstrap-point', nargs=2, type=int, default=config.get('terminal_point'), metavar=('X', 'Y'), help='Guest Terminal window or Dock icon coordinates confirmed from current screenshot')
    p.add_argument('--menu-point', nargs=2, type=int, default=None if early.native_app_service else config.get('menu_point'), metavar=('X', 'Y'), help='Guest menu icon coordinates confirmed from current screenshot')
    a = p.parse_args(argv)
    if a.reconcile_staging:
        # Read-only report: only the VM home and name are resolved; binary,
        # evidence, display and guest-input requirements do not apply.
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', a.vm), 'VM_NAME_INVALID')
        require(isinstance(a.vm_home, str) and a.vm_home, 'INFRASTRUCTURE_CONFIG_REQUIRED')
        return a
    require(not a.e2e_driver or a.closed, 'E2E_DRIVER_REQUIRES_CLOSED')
    if a.native_app_service:
        require(bool(a.artifact) and not a.latest and not a.e2e_driver and
                not (a.release_dev or a.connection_proof or a.connect_dev) and
                not a.prepare_test_guest and a.menu_point is None and
                isinstance(a.expected_app_sha256, str) and
                re.fullmatch(r'[a-f0-9]{64}', a.expected_app_sha256),
                'APP_SERVICE_OPTIONS_INVALID')
    else:
        require(not a.native_relaunch and a.expected_app_sha256 is None,
                'APP_SERVICE_OPTIONS_INVALID')
    if a.closed:
        # A closed run never resolves or downloads a release (--artifact is
        # mandatory); the dev/proof sources are separate run kinds.
        require(not a.latest, 'CLOSED_DOWNLOAD_FORBIDDEN')
        require(not (a.release_dev or a.connection_proof or a.connect_dev), 'CLOSED_MODE_INVALID')
        require(bool(a.artifact), 'CLOSED_DOWNLOAD_FORBIDDEN')
    require(all(isinstance(x, str) and x for x in (a.terminal_mac, a.vm_home, a.vm)), 'INFRASTRUCTURE_CONFIG_REQUIRED')
    if not a.native_app_service:
        require(isinstance(a.terminal_point, list) and len(a.terminal_point) == 2 and all(type(x) is int for x in a.terminal_point), 'TERMINAL_POINT_REQUIRED')
    require(a.menu_point is None or (isinstance(a.menu_point, list) and len(a.menu_point) == 2 and all(type(x) is int for x in a.menu_point)), 'MENU_POINT_INVALID')
    require(a.bootstrap in ('finder', 'terminal'), 'BOOTSTRAP_MODE_INVALID')
    require(type(a.timeout) is int, 'TIMEOUT_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', a.vm), 'VM_NAME_INVALID')
    require(30 <= a.timeout <= 600, 'TIMEOUT_INVALID')
    if not a.native_app_service:
        require(all(0 <= x <= 8192 for x in a.terminal_point), 'TERMINAL_POINT_INVALID')
    require(a.menu_point is None or all(0 <= x <= 8192 for x in a.menu_point), 'MENU_POINT_INVALID')
    return a


def result_exit_code(result, fallback=0):
    if result.get('test', {}).get('status') == 'FAIL':
        return 1
    if result.get('operation', {}).get('status') == 'UNKNOWN':
        return 2
    return fallback


def main():
    runner = None
    def interrupted(_signal, _frame):
        raise InterruptedError('RUN_INTERRUPTED')
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        require(set(IDENTITY) == {'name', 'bundleId', 'dataLeaf', 'devDataLeaf'}, 'USE_TASK_VM_SMOKE_ENTRYPOINT')
        args = arguments()
        if getattr(args, 'reconcile_staging', False):
            # Read-only reconciliation: no Runner, no lock, no VM or guest
            # contact; the report only names residue and fence metadata.
            print(json.dumps(reconcile_staging(args)))
            return 0
        runner = Runner(args)
        result = runner.run()
        if getattr(runner, 'cleanup_note', None) == 'CLEARED':
            # A failed staging cleanup keeps the effect fence for reconciliation.
            runner.finish_effect()
        print(json.dumps(dict(result, evidence=str(runner.out))))
        return result_exit_code(result)  # Diagnostic success is not product qualification.
    except (Refused, OSError, ValueError, TypeError, KeyError, KeyboardInterrupt, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        code = safe_failure_code(error)
        if runner and getattr(runner, 'first_failure', None) is None:
            runner.record_first_failure(code, outcome='UNKNOWN' if runner.pending else 'noEffect')
        result = dict(status='NEEDS_OWNER' if code == 'NEEDS_OWNER' else 'BLOCKED',
                      reason=code, phases=runner.log if runner else [],
                      pending=runner.pending if runner else None,
                      outcome='UNKNOWN' if runner and (runner.pending or runner.log) else 'NOT_STARTED')
        if runner:
            result['firstFailure'] = getattr(runner, 'first_failure', None)
            result['firstFailurePersistence'] = getattr(runner, 'first_failure_persistence', 'NOT_RUN')
        if runner:
            try:
                result['cleanup'] = runner.cleanup_disposition()
            except Exception as cleanup_error:
                runner.record_secondary_failure(cleanup_error)
                result['cleanup'] = 'FAILED:STAGING_CLEANUP_UNCONFIRMED'
            result['secondaryFailures'] = getattr(runner, 'secondary_failures', [])
            runner.attach_e2e_evidence(result, error=error)
            try:
                (runner.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            except OSError:
                pass  # Evidence fallout must never mask the primary result.
        print(json.dumps(result))
        return result_exit_code(result, fallback=2)
    finally:
        try:
            if runner:
                runner.cleanup_disposition()
        finally:
            signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    sys.exit(main())
