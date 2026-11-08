#!/usr/bin/env python3
"""Plan or provision one declared guest; never import a profile or credential."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess


# Static spec bounds. terminal-mac create remains the authority for the dynamic
# ranges it derives from the restore image (cpus, memory); these pre-filters only
# reject specs that could never be admitted, using the same statically declared
# ranges and the same 1-48 name grammar as the terminal Store validation.
def plan(spec, binary, root, ipsw):
    if set(spec) != {'schema', 'name', 'cpu', 'memoryGiB', 'diskGiB', 'width', 'height', 'network', 'guestBootstrap'}:
        raise ValueError('VM_SPEC_FIELDS_INVALID')
    if spec['schema'] != 1 or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,47}', spec['name']):
        raise ValueError('VM_SPEC_IDENTITY_INVALID')
    for key, minimum, maximum in [('cpu', 2, 32), ('memoryGiB', 2, 128), ('diskGiB', 32, 2048),
                                  ('width', 800, 3840), ('height', 600, 2160)]:
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


def infrastructure(home=None):
    """One configuration owner: the private smoke infrastructure config when it
    exists, else the installed tool and canonical data root. The runtime root
    must stay inside the terminal-mac data root, never a host product profile."""
    home = Path.home() if home is None else home
    leaf = os.environ['FAROL_VM_TESTING_DIRECTORY']
    if Path(leaf).name != leaf:
        raise ValueError('TESTING_DIRECTORY_INVALID')
    settings = home / 'Library/Application Support' / leaf
    if settings.is_symlink():
        raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    source = os.environ.get('FAROL_VM_CONFIG') or (settings / 'vm-smoke.json' if (settings / 'vm-smoke.json').is_file() else None)
    binary = home / 'Applications/TerminalMac.app/Contents/MacOS/terminal-mac'
    root = home / 'Library/Application Support/terminal-mac'
    if source:
        file = Path(source).expanduser()
        if not file.is_file() or file.stat().st_size > 16384:
            raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
        config = json.loads(file.read_text())
        if not isinstance(config, dict) or set(config) - {
                'terminal_mac', 'vm_home', 'vm', 'terminal_point', 'menu_point', 'timeout', 'bootstrap'}:
            raise ValueError('CONFIG_FIELDS_INVALID')
        if not isinstance(config.get('terminal_mac'), str) or not config['terminal_mac']:
            raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
        if not isinstance(config.get('vm_home'), str) or not config['vm_home']:
            raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
        binary = Path(config['terminal_mac']).expanduser()
        root = Path(config['vm_home']).expanduser()
        if not root.is_absolute():
            raise ValueError('INFRASTRUCTURE_CONFIG_INVALID')
        if root.is_symlink():
            raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    if 'terminal-mac' not in root.parts:
        raise ValueError('VM_HOME_OUTSIDE_TERMINAL_MAC_ROOT')
    return binary, root, settings


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', action='store_true')
    p.add_argument('--spec', default=str(Path(__file__).parents[1] / 'config/vm/pilot.json'))
    p.add_argument('--ipsw')
    a = p.parse_args()
    spec = json.loads(Path(a.spec).read_text())
    binary, root, settings = infrastructure()
    command = plan(spec, binary, root, a.ipsw)
    if a.plan:
        print(json.dumps({'status': 'PLAN', 'vmHome': str(root), 'create': command,
                          'start': [str(binary), 'start', spec['name']], 'bootstrap': spec['guestBootstrap']}))
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
