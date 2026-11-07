#!/usr/bin/env python3
"""Plan or provision one declared guest; never import a profile or credential."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess


def plan(spec, binary, root, ipsw):
    if set(spec) != {'schema', 'name', 'cpu', 'memoryGiB', 'diskGiB', 'width', 'height', 'network', 'guestBootstrap'}:
        raise ValueError('VM_SPEC_FIELDS_INVALID')
    if spec['schema'] != 1 or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,63}', spec['name']):
        raise ValueError('VM_SPEC_IDENTITY_INVALID')
    for key, minimum, maximum in [('cpu', 2, 32), ('memoryGiB', 2, 128), ('diskGiB', 16, 1024), ('width', 640, 8192), ('height', 480, 8192)]:
        if type(spec[key]) is not int or not minimum <= spec[key] <= maximum:
            raise ValueError('VM_SPEC_RESOURCE_INVALID')
    if spec['network'] not in ('nat', 'offline') or spec['guestBootstrap'] != 'interactive-account-and-helper-permissions':
        raise ValueError('VM_SPEC_BOOTSTRAP_INVALID')
    command = [str(binary), 'create', spec['name'], '--ipsw', str(ipsw or 'APPLE_RESTORE_IPSW_REQUIRED')]
    for option, key in [('cpus', 'cpu'), ('memory', 'memoryGiB'), ('disk', 'diskGiB'), ('width', 'width'), ('height', 'height')]:
        command += ['--' + option, str(spec[key])]
    if spec['network'] == 'offline':
        command += ['--offline']
    return command


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', action='store_true')
    p.add_argument('--spec', default=str(Path(__file__).parents[1] / 'config/vm/pilot.json'))
    p.add_argument('--ipsw')
    a = p.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    home = Path.home()
    binary = home / 'Applications/TerminalMac.app/Contents/MacOS/terminal-mac'
    root = home / 'Library/Application Support/terminal-mac'
    command = plan(spec, binary, root, a.ipsw)
    if a.plan:
        print(json.dumps({'status': 'PLAN', 'vmHome': str(root), 'create': command, 'start': [str(binary), 'start', spec['name']], 'bootstrap': spec['guestBootstrap']}))
        return
    if not binary.is_file() or plistlib.loads((binary.parent.parent / 'Info.plist').read_bytes()).get('CFBundleIdentifier') != 'dev.terminal-mac.host':
        raise ValueError('INSTALL_TERMINAL_MAC_PACKAGE_FIRST')
    env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
    env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(root))
    machine = root / 'machines' / spec['name'] / 'machine.json'
    created = False
    if not machine.exists():
        if not a.ipsw or not Path(a.ipsw).is_file():
            raise ValueError('APPLE_RESTORE_IPSW_REQUIRED')
        subprocess.run(command, env=env, check=True, timeout=1800)
        created = True
    existing = json.loads(machine.read_text())
    for key in ('name', 'cpu', 'memoryGiB', 'diskGiB', 'width', 'height'):
        if existing[key] != spec[key]:
            raise ValueError('EXISTING_VM_SPEC_DRIFT_NO_MUTATION')
    if existing['network'] != (spec['network'] == 'nat'):
        raise ValueError('EXISTING_VM_NETWORK_DRIFT_NO_MUTATION')
    subprocess.run([str(binary), 'start', spec['name']], env=env, check=True, timeout=60)
    settings_leaf = os.environ['FAROL_VM_TESTING_DIRECTORY']
    if Path(settings_leaf).name != settings_leaf:
        raise ValueError('TESTING_DIRECTORY_INVALID')
    settings = home / 'Library/Application Support' / settings_leaf
    if settings.is_symlink():
        raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    settings.mkdir(parents=True, exist_ok=True, mode=0o700)
    private = settings / 'vm-smoke.json'
    if not private.exists():
        template = json.loads((Path(__file__).parents[1] / 'config/vm/runner.example.json').read_text())
        template['vm'] = spec['name']
        with private.open('x') as out:
            private.chmod(0o600)
            out.write(json.dumps(template, indent=2) + '\n')
    print(json.dumps({'status': 'NEEDS_OWNER' if created else 'STARTED', 'reason': 'New guests need interactive account/helper permission bootstrap; no password or security policy in source.' if created else 'Existing guest retained; run smoke helper preflight separately.'}))


if __name__ == '__main__':
    main()
