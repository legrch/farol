#!/usr/bin/env python3
"""One-shot published 0.5.8 witness on an isolated GitHub macOS runner.

Outputs are observations, not a release verdict. An unclear case blocks every
later launch. The VM owns all files and processes; never run on a user's Mac.
"""

import hashlib
import json
import os
import datetime
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

EXPECTED_ZIP = 'a0c497b09d0940af927e2a77555443a635ce77cd8c16d9f43531fcd86a748ab5'
EXPECTED_MANIFEST = 'e25bbb112d67e8e3cb3e24c3ac7b698420840691a2d286b2a46b806b852fb483'
ROOT = Path(os.environ['RUNNER_TEMP']) / 'farol-v058-witness'
APP = Path('/Applications/Farol.app')
HOME = Path.home()
PROFILE = HOME / 'Library/Application Support/io.github.legrch.farol'
MARKER = PROFILE / 'farol-state/installed-replacement.pending'
URL = 'https://github.com/legrch/farol/releases/download/v0.5.8/'


def fail(message):
    print('BLOCKED:', message, flush=True)
    raise SystemExit(1)


def check(condition, message):
    if not condition:
        fail(message)


def run(args, *, timeout=30):
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)


def download(name, digest):
    target = ROOT / name
    with urllib.request.urlopen(URL + name, timeout=60) as response, target.open('xb') as out:
        while data := response.read(1024 * 1024):
            out.write(data)
    hasher = hashlib.sha256()
    with target.open('rb') as source:
        while data := source.read(1024 * 1024):
            hasher.update(data)
    actual = hasher.hexdigest()
    print(name, 'sha256', actual, flush=True)
    check(actual == digest, 'downloaded asset SHA mismatch')
    return target


def sample(label):
    result = run(['/bin/ps', '-axo', 'pid=,ppid=,command='], timeout=10)
    check(result.returncode == 0, 'process observation refused')
    lines = [line for line in result.stdout.splitlines()
             if '/Applications/Farol.app/' in line or
             ('io.github.legrch.farol' in line and 'farol-v058-witness.py' not in line)]
    with (ROOT / (label + '-processes.txt')).open('a') as out:
        out.write(f'--- {time.time_ns()} ---\n' + '\n'.join(lines) + '\n')
    return lines


def inventory(label):
    rows = []
    if PROFILE.exists():
        for directory, names, files in os.walk(PROFILE, followlinks=False):
            for name in sorted(names + files):
                path = Path(directory) / name
                stat = path.lstat()
                rows.append({'path': str(path.relative_to(PROFILE)), 'mode': stat.st_mode,
                             'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns})
    (ROOT / (label + '-profile-inventory.json')).write_text(json.dumps(rows, indent=2) + '\n')


def seed_published_baseline(manifest):
    # Fixture metadata, never a promotion receipt: this is a fresh isolated
    # runner and the owner explicitly selected a preseeded v1 baseline.
    # Never replace an existing profile, record, or pending effect.
    check(not PROFILE.exists(), 'profile exists before baseline seed')
    check(manifest.get('version') == '0.5.8' and manifest.get('buildVersion') == '64', 'manifest version mismatch')
    check(manifest.get('buildId') == '295fbf2ace78b0a9ab7f7111e41df2fa012b73e8beea747e458f7554f7423d4c', 'manifest build mismatch')
    check(manifest.get('sourceCommit') == '35921adece3d5552be3f605edcb3993534237918', 'manifest source mismatch')
    check(manifest.get('artifactSha256') == '98f4e33473a440912112e40ead68370b2f88d47dab0cc6b4c7dae8e3dd001b4a', 'manifest tree mismatch')
    PROFILE.mkdir(mode=0o700)
    updates = PROFILE / 'installed-updates'
    updates.mkdir(mode=0o700)
    record = {'schema':'farol.adopted-baseline/1', 'slot':str(APP), 'userData':str(PROFILE),
              'manifest':manifest, 'adoptedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    data = (json.dumps(record, separators=(',', ':')) + '\n').encode()
    file = updates / 'adopted-baseline.json'
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    directory = os.open(updates, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    check(file.read_bytes() == data and (file.stat().st_mode & 0o777) == 0o600, 'baseline readback mismatch')
    print('fixture v1 baseline sha256', hashlib.sha256(data).hexdigest(), flush=True)


def launch(label):
    # The actual user HOME is not overridden. CI is inherited from the runner;
    # no E2E, hidden-window, Farol or Electron flags are passed.
    env = {k: os.environ[k] for k in ('HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'CI', 'TMPDIR') if k in os.environ}
    stdout = (ROOT / (label + '-stdout.txt')).open('xb')
    stderr = (ROOT / (label + '-stderr.txt')).open('xb')
    proc = subprocess.Popen([str(APP / 'Contents/MacOS/Farol')], stdin=subprocess.DEVNULL,
                            stdout=stdout, stderr=stderr, env=env)
    print(label, 'launcher pid', proc.pid, flush=True)
    return proc, stdout, stderr


def await_ready(proc, label):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        sample(label)
        output = (ROOT / (label + '-stderr.txt')).read_text(errors='replace')
        if 'FAROL_SECOND_INSTANCE_RESULT:primary-started' in output:
            return
        if proc.poll() is not None:
            fail(f'{label} exited before readiness: {proc.returncode}')
        time.sleep(.1)
    fail(f'{label} timed out before readiness; no signal or retry issued')


def await_exit(proc, label, limit=120):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        sample(label)
        result = proc.poll()
        if result is not None:
            return result
        time.sleep(.1)
    fail(f'{label} timed out; no signal or retry issued')


def main():
    check(os.environ.get('GITHUB_ACTIONS') == 'true', 'not a GitHub Actions runner')
    check(run(['/usr/bin/uname', '-m']).stdout.strip() == 'arm64', 'not arm64')
    user = run(['/usr/bin/id', '-un']).stdout.strip()
    directory = run(['/usr/bin/dscl', '.', '-read', '/Users/' + user, 'NFSHomeDirectory'])
    check(directory.returncode == 0 and directory.stdout.strip() == 'NFSHomeDirectory: ' + str(HOME), 'home identity mismatch')
    check(not APP.exists() and not PROFILE.exists() and not ROOT.exists(), 'slot, profile, or witness already exists')
    check(not any(k.startswith(('FAROL_', 'ELECTRON_')) for k in os.environ), 'unexpected runtime override')
    ROOT.mkdir(mode=0o700)
    probe = Path('/Applications') / ('.farol-witness-' + str(os.getpid()))
    probe.mkdir(mode=0o700)
    probe.rmdir()
    archive = download('Farol-0.5.8-darwin-arm64.zip', EXPECTED_ZIP)
    manifest_file = download('farol-release.json', EXPECTED_MANIFEST)
    manifest = json.loads(manifest_file.read_text())
    (ROOT / 'manifest-summary.json').write_text(json.dumps(manifest, indent=2) + '\n')
    unpacked = ROOT / 'unpacked'
    unpacked.mkdir()
    result = run(['/usr/bin/ditto', '-x', '-k', str(archive), str(unpacked)], timeout=120)
    check(result.returncode == 0, 'archive extraction failed: ' + result.stderr)
    check((unpacked / 'Farol.app').is_dir(), 'expected app absent in archive')
    result = run(['/usr/bin/ditto', str(unpacked / 'Farol.app'), str(APP)], timeout=120)
    check(result.returncode == 0, 'app copy failed: ' + result.stderr)
    identity = json.loads((APP / 'Contents/Resources/app/build-identity.json').read_text())
    (ROOT / 'build-identity.json').write_text(json.dumps(identity, indent=2) + '\n')
    check(identity.get('sourceCommit') == '35921adece3d5552be3f605edcb3993534237918', 'unexpected source identity')
    check(identity.get('buildId') == '295fbf2ace78b0a9ab7f7111e41df2fa012b73e8beea747e458f7554f7423d4c', 'unexpected build identity')
    check(identity.get('version') == '0.5.8' and identity.get('buildVersion') == '64', 'unexpected version')
    digest_source = run(['/usr/bin/git', 'diff', '--quiet', '35921ade', 'HEAD', '--',
                         'tooling/artifact-digest.mjs', 'src/pkg/artifact-tree-digest/digest.ts'])
    check(digest_source.returncode == 0, 'tree digest implementation differs from tag')
    digest = run(['node', '--experimental-strip-types', '--input-type=module', '-e',
                  'import {treeDigest} from "./tooling/artifact-digest.mjs"; console.log(await treeDigest(process.argv[1]))',
                  str(APP)], timeout=120)
    print('installed tree digest', digest.stdout.strip(), flush=True)
    check(digest.returncode == 0 and digest.stdout.strip() ==
          '98f4e33473a440912112e40ead68370b2f88d47dab0cc6b4c7dae8e3dd001b4a',
          'installed tree differs from published manifest')
    seed_published_baseline(manifest)
    check(len(sys.argv) == 2 and sys.argv[1] in ('cold', 'control'), 'invalid scenario')
    scenario = sys.argv[1]
    MARKER.parent.mkdir(mode=0o700)
    state = MARKER.parent.lstat()
    print('farol-state mode', oct(state.st_mode & 0o777), 'uid', state.st_uid, 'expected uid', os.geteuid(), flush=True)
    check(state.st_uid == os.geteuid() and (state.st_mode & 0o777) == 0o700 and MARKER.parent.is_dir() and not MARKER.parent.is_symlink(), 'unsafe fixture state directory')
    check(not sample('before-' + scenario), 'unexpected Farol lifetime')
    inventory('before-' + scenario)
    if scenario == 'cold':
        with MARKER.open('xb') as marker:
            marker.write(b'isolated-cold-runner-witness\n')
        inventory('marker-created')
        proc, stdout, stderr = launch('cold')
        result = await_exit(proc, 'cold')
        stdout.close(); stderr.close()
        print('cold exit', result, flush=True)
        inventory('after-cold')
        survivors = sample('after-cold')
        print('surviving Farol processes', len(survivors), flush=True)
        error = (ROOT / 'cold-stderr.txt').read_text(errors='replace')
        check(result == 1, 'cold launch exit not 1')
        check('FAROL_STARTUP_FAILURE:STARTUP_INSTALLED_REPLACEMENT_PENDING' in error, 'exact marker refusal absent')
        check(not survivors, 'Farol process remains after cold marker')
        samples = (ROOT / 'cold-processes.txt').read_text(errors='replace')
        check(' serve --profile ' not in samples and 'tunnel-client' not in samples, 'core or tunnel observed')
        print('OBSERVED: exact cold refusal; sampled processes cannot prove absence of short-lived processes or early effects', flush=True)
    else:
        check(not MARKER.exists(), 'unexpected control marker')
        proc, stdout, stderr = launch('control')
        await_ready(proc, 'control')
        inventory('control-ready')
        quit_result = run(['/usr/bin/osascript', '-e', 'tell application id "io.github.legrch.farol" to quit'], timeout=20)
        check(quit_result.returncode == 0, 'normal Quit refused: ' + quit_result.stderr)
        result = await_exit(proc, 'control')
        stdout.close(); stderr.close()
        print('control exit', result, flush=True)
        inventory('after-control')
        survivors = sample('after-control')
        check(result == 0 and not survivors, 'control or helper did not retire cleanly')
        print('OBSERVED: control ready and original launcher exit confirmed', flush=True)



if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        fail(type(error).__name__ + ': ' + str(error))
    finally:
        if ROOT.is_dir():
            try:
                unified = run(['/usr/bin/log', 'show', '--last', '10m', '--style', 'compact', '--predicate',
                               'process == "Farol" OR process == "farol-backend" OR process == "Electron" OR process == "tunnel-client"'], timeout=60)
                (ROOT / 'unified-log.txt').write_text(unified.stdout + unified.stderr +
                                                      f'\nunified log exit: {unified.returncode}\n')
                if unified.returncode != 0:
                    fail('unified log unavailable')
            except (OSError, subprocess.TimeoutExpired) as error:
                fail('unified log unavailable: ' + str(error))
