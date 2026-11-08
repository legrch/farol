#!/usr/bin/env python3
"""Bounded exact-release UI smoke via terminal-mac guest actions only."""
import argparse
import fcntl
import hashlib
import json
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


class Refused(Exception):
    pass


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
        owned = [name for name in ('dev-key', 'dev-connection.json') if (entry / name).exists()]
        if owned:
            found.append({'directory': entry.name, 'entries': owned})
    return found


def fence_metadata(machine):
    """Presence plus the metadata the fence itself legitimately carries."""
    fence_file = machine / '.farol-smoke-pending.json'
    if not fence_file.exists():
        return None
    meta = {'present': True, 'runId': None, 'evidence': None}
    try:
        value = json.loads(fence_file.read_text())
    except (OSError, ValueError):
        return meta
    if isinstance(value, dict):
        for key in ('runId', 'evidence'):
            if isinstance(value.get(key), str):
                meta[key] = value[key]
    return meta


def reconcile_staging(args, home=None):
    """Read-only staging reconciliation report; touches nothing on disk.

    No Runner is constructed, no VM is started or contacted, no lock is taken
    and no file is written or deleted. Clearing a fence or removing residue
    stays a manual owner action outside this tool.
    """
    machine = Path(args.vm_home).expanduser().resolve(strict=True) / 'machines' / args.vm
    refuse_host_profile_path(machine, IDENTITY, home)
    require(machine.is_dir() and not machine.is_symlink(), 'VM_MISSING')
    residue = staging_residue(machine / 'artifacts')
    fence = fence_metadata(machine)
    for item in residue:
        item['fence'] = fence is not None
    found = bool(residue) or fence is not None
    return {'status': 'STAGING_RESIDUE_FOUND' if found else 'CLEAN',
            'fence': fence,
            'residue': residue,
            'requiredAction': ('Confirm the unresolved guest outcome manually, then delete the listed '
                               'staging directories and clear the effect fence by hand; vm-smoke never '
                               'deletes residue or clears a fence.'
                               if found else 'None; the staging inbox is residue-free.')}


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
        self.effect_owned = False
        self.effect_file = self.machine / '.farol-smoke-pending.json'
        # Never forward product configuration, proxy, Electron or loader environment.
        self.env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
        self.env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(self.home))

    def remaining(self):
        left = self.deadline - time.monotonic()
        require(left > 0, 'DEADLINE_EXCEEDED')
        return min(left, 30)

    def cli(self, *args):
        p = subprocess.run([str(self.binary), *map(str, args)], env=self.env,
                           capture_output=True, text=True, timeout=self.remaining())
        require(p.returncode == 0, 'GUEST_ACTION_FAILED:' + str(args[0]))
        return json.loads(p.stdout)

    def action(self, *args):
        return self.cli('action', self.a.vm, *args)

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
        # Bootstrap once, then use the read-only request share. Application launch
        # can change Dock geometry; repeated clicks must not type commands elsewhere.
        self.pending = 'bootstrap'
        self.action('click', *self.a.terminal_point)
        time.sleep(0.5)
        if self.a.bootstrap == 'finder':
            # A first bottom-edge click can reveal the Dock before its icon is
            # ready to activate. Keep shell typing behind a separate activation.
            self.action('click', *self.a.terminal_point)
            time.sleep(0.8)
            self.screenshot('bootstrap-activated')
            self.action('key', 'cmd+shift+g')
            time.sleep(0.8)
            self.action('type', '/System/Applications/Utilities/Terminal.app')
            self.action('key', 'return')
            # Finder navigation completes asynchronously after the key ACK.
            # Preserve the selected target before sending Open; a cold Finder
            # can otherwise receive Open while the Go to Folder sheet closes.
            time.sleep(1.5)
            self.screenshot('bootstrap-finder-selection')
            self.action('key', 'cmd+o')
            time.sleep(1.5)
        self.action('key', 'cmd+n')
        time.sleep(1)
        self.screenshot('bootstrap-terminal')
        command = '/bin/bash ' + shlex.quote('/Volumes/My Shared Files/artifacts/' +
                                           self.run_id + '/guest.sh') + ' serve'
        self.action('type', command)
        self.action('key', 'return')
        self.wait_result(self.report / 'server.result')
        self.sequence = 0
        self.pending = None

    def phase(self, name):
        if name in ('install', 'launch', 'relaunch', 'import-dev', 'cleanup'):
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

    def sync_effect_directory(self):
        fd = os.open(self.effect_file.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def finish_effect(self):
        if self.effect_owned:
            regular(self.effect_file, 4096)
            require(json.loads(self.effect_file.read_text()).get('runId') == self.run_id,
                    'GUEST_OPERATION_FENCE_CHANGED')
            require(self.log and self.log[-1] == 'stop', 'GUEST_SERVER_NOT_STOPPED')
            self.effect_file.unlink()
            self.sync_effect_directory()
            self.effect_owned = False

    def quit_proof(self):
        self.phase('quit-proof')
        file = self.report / 'quit-proof.json'
        regular(file, 32768)
        return json.loads(file.read_text())

    def require_quit_drain(self, before):
        after = self.quit_proof()
        require(after.get('running') is False and after.get('drained') is True and
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
                self.cleanup_note = 'FAILED:' + str(error)
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
                self.cleanup_note = 'FAILED:' + str(error)
            else:
                self.cleanup_note = 'CLEARED'
        return self.cleanup_note

    def prepare_stage(self):
        self.stage.mkdir(parents=True, exist_ok=False, mode=0o700)
        self.report.mkdir(parents=True, exist_ok=False, mode=0o700)
        for name in ('guest.sh', 'inspect.js', 'no-tunnel.js', 'activate.js', 'import-dev.js', 'connection-proof.js', 'quit-proof.js'):
            shutil.copyfile(Path(__file__).parent / 'vm-smoke' / name, self.stage / name)
        (self.stage / 'identity.json').write_text(json.dumps(IDENTITY))
        budget = int(self.deadline - time.monotonic())
        require(budget >= 30, 'GUEST_BUDGET_TOO_SHORT')
        (self.stage / 'timeout').write_text(str(budget))

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
                      cleanup=self.finish_staging(), phases=self.log)
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
            require(proof.get('running') is False and
                    (proof.get('receipt') is None or proof.get('drained') is True),
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
                      cleanup=self.finish_staging(), phases=self.log)
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
                      profile='guest-package-only', cleanup=self.finish_staging(), phases=self.log)
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

    def run(self):
        with (self.machine / '.farol-smoke.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as e:
                raise Refused('VM_BUSY') from e
            # connection_proof still starts/bootstrap-controls the guest and
            # activates the app. It is not a read-only reconciliation route.
            require(not self.effect_file.exists(), 'UNRESOLVED_GUEST_OPERATION')
            residue = staging_residue(self.inbox)
            require(not residue, 'UNRECONCILED_STAGING_RESIDUE:' +
                    ','.join(item['directory'] for item in residue))
            status = self.cli('status', self.a.vm)
            if status.get('state') == 'stopped':
                self.pending = 'vm-start'
                status = self.cli('start', self.a.vm)
                self.pending = None
                self.log.append('vm-started')
                if status.get('state') == 'already-running':
                    status = self.cli('status', self.a.vm)
            require(status.get('state') == 'running', 'VM_NOT_RUNNING')
            self.cli('show' if self.a.visible else 'hide', self.a.vm)
            grants = self.wait_guest_ready()
            (self.out / 'guest-status.json').write_text(json.dumps(grants, indent=2))
            require(self.a.terminal_point[0] < int(grants['width']) and self.a.terminal_point[1] < int(grants['height']), 'TERMINAL_POINT_OUTSIDE_DISPLAY')
            self.screenshot('preflight')
            if self.a.connect_dev:
                return self.connect_dev()
            if self.a.connection_proof:
                return self.connection_proof()
            if self.a.release_dev:
                return self.release_dev()
            # Returning packaged profiles can resume the approved Dev endpoint.
            require_host_dev_stopped(IDENTITY)
            archive = Path(self.a.artifact).expanduser().absolute() if self.a.artifact else download_latest(self.out, self.deadline)
            manifest = verify(archive)
            self.prepare_stage()
            shutil.copyfile(archive, self.stage / 'app.zip')
            (self.stage / 'archive.sha256').write_text(manifest['archiveSha256'])
            (self.stage / 'version').write_text(manifest['version'])
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
                          cleanup=self.finish_staging(), phases=self.log)
            (self.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            if self.a.latest and result['cleanup'] == 'CLEARED':
                archive.unlink()
            return result


def arguments(argv=None):
    config_parser = argparse.ArgumentParser(add_help=False)
    default_config = Path.home() / 'Library/Application Support' / (IDENTITY['name'] + ' Testing') / 'vm-smoke.json'
    config_parser.add_argument('--config', default=os.environ.get('FAROL_VM_CONFIG') or (str(default_config) if default_config.exists() else None))
    early, _ = config_parser.parse_known_args(argv)
    config = {}
    if early.config:
        file = Path(early.config).expanduser()
        regular(file, 16384)
        config = json.loads(file.read_text())
        require(isinstance(config, dict) and not (set(config) - {
            'terminal_mac', 'vm_home', 'vm', 'terminal_point', 'menu_point', 'timeout', 'bootstrap'}),
            'CONFIG_FIELDS_INVALID')
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
    p.add_argument('--terminal-mac', default=config.get('terminal_mac'), help='Signed packaged terminal-mac executable, not launcher')
    p.add_argument('--vm-home', default=config.get('vm_home'), help='Dedicated TERMINAL_MAC_HOME; never host product state')
    p.add_argument('--vm', default=config.get('vm', 'pilot'))
    p.add_argument('--prepare-test-guest', action='store_true', help='Mark this dedicated guest as test-only; never imports any profile or credential')
    p.add_argument('--visible', action='store_true', help='Show guest window (default: hidden)')
    p.add_argument('--evidence', default=str(Path.home() / 'Library/Application Support' / (IDENTITY['name'] + ' Testing') / 'evidence'))
    p.add_argument('--timeout', type=int, default=config.get('timeout', 180))
    p.add_argument('--bootstrap', choices=['finder', 'terminal'], default=config.get('bootstrap', 'terminal'))
    p.add_argument('--terminal-point', '--bootstrap-point', nargs=2, type=int, default=config.get('terminal_point'), metavar=('X', 'Y'), help='Guest Terminal window or Dock icon coordinates confirmed from current screenshot')
    p.add_argument('--menu-point', nargs=2, type=int, default=config.get('menu_point'), metavar=('X', 'Y'), help='Guest menu icon coordinates confirmed from current screenshot')
    a = p.parse_args(argv)
    if a.reconcile_staging:
        # Read-only report: only the VM home and name are resolved; binary,
        # evidence, display and guest-input requirements do not apply.
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', a.vm), 'VM_NAME_INVALID')
        require(isinstance(a.vm_home, str) and a.vm_home, 'INFRASTRUCTURE_CONFIG_REQUIRED')
        return a
    require(all(isinstance(x, str) and x for x in (a.terminal_mac, a.vm_home, a.vm)), 'INFRASTRUCTURE_CONFIG_REQUIRED')
    require(isinstance(a.terminal_point, list) and len(a.terminal_point) == 2 and all(type(x) is int for x in a.terminal_point), 'TERMINAL_POINT_REQUIRED')
    require(a.menu_point is None or (isinstance(a.menu_point, list) and len(a.menu_point) == 2 and all(type(x) is int for x in a.menu_point)), 'MENU_POINT_INVALID')
    require(a.bootstrap in ('finder', 'terminal'), 'BOOTSTRAP_MODE_INVALID')
    require(type(a.timeout) is int, 'TIMEOUT_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', a.vm), 'VM_NAME_INVALID')
    require(30 <= a.timeout <= 600, 'TIMEOUT_INVALID')
    require(all(0 <= x <= 8192 for x in a.terminal_point), 'TERMINAL_POINT_INVALID')
    require(a.menu_point is None or all(0 <= x <= 8192 for x in a.menu_point), 'MENU_POINT_INVALID')
    return a


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
        return 0  # NEEDS_REVIEW is deliberately explicit; no UI PASS is fabricated.
    except (Refused, OSError, ValueError, TypeError, KeyError, KeyboardInterrupt, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        result = dict(status='NEEDS_OWNER' if str(error) == 'NEEDS_OWNER' else 'BLOCKED',
                      reason='RUN_INTERRUPTED' if isinstance(error, KeyboardInterrupt) else str(error), phases=runner.log if runner else [],
                      pending=runner.pending if runner else None,
                      outcome='UNKNOWN' if runner and (runner.pending or runner.log) else 'NOT_STARTED')
        if runner:
            try:
                result['cleanup'] = runner.cleanup_disposition()
            except Exception as cleanup_error:
                result['cleanup'] = 'FAILED:' + str(cleanup_error)
            try:
                (runner.out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
            except OSError:
                pass  # Evidence fallout must never mask the primary result.
        print(json.dumps(result))
        return 2
    finally:
        try:
            if runner:
                runner.cleanup_disposition()
        finally:
            signal.signal(signal.SIGTERM, previous_term)


if __name__ == '__main__':
    sys.exit(main())
