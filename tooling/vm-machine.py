#!/usr/bin/env python3
"""Plan or provision one declared guest; never import a profile or credential."""
import argparse
import hashlib
import json
import os
import time
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


def plan_instance(name, base, binary, root, settings):
    """Pure planning for a clean run instance cloned from a prepared base.

    The clone gives the instance a fresh VM identity and a copy-on-write disk;
    the base must have completed owner setup (helper receipt recorded), and
    provisioning never starts the instance — starting is a separate explicit
    step."""
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,47}', name):
        raise ValueError('VM_SPEC_IDENTITY_INVALID')
    if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,47}', base):
        raise ValueError('VM_SPEC_IDENTITY_INVALID')
    if name == base:
        raise ValueError('INSTANCE_IDENTITY_INVALID')
    receipt_file = settings / 'base-receipts' / (base + '.json')
    if not receipt_file.is_file() or receipt_file.stat().st_size > 65536:
        raise ValueError('BASE_RECEIPT_MISSING')
    receipt = json.loads(receipt_file.read_text())
    if not isinstance(receipt, dict) or receipt.get('schema') != 'farol.vm-base/1':
        raise ValueError('BASE_RECEIPT_INVALID')
    if receipt.get('helper') == 'NOT_INSTALLED_SETUP_ASSISTANT_PENDING' or receipt.get('helper') != 'READY':
        raise ValueError('OWNER_BASE_NOT_READY')
    if receipt.get('account') != 'tester-ready':
        raise ValueError('OWNER_BASE_NOT_READY')
    if not (root / 'machines' / base / 'machine.json').is_file():
        raise ValueError('BASE_MACHINE_MISSING')
    if (root / 'machines' / name).exists():
        raise ValueError('INSTANCE_COLLISION_REFUSED')
    command = [str(binary), 'clone', base, name]
    return command, receipt_file, settings / 'instance-receipts' / (name + '.json')


def write_instance_receipt(path, name, base, base_receipt_file, machine_root):
    """Durable provenance for one provisioned instance; names and digests only."""
    receipt = {
        'schema': 'farol.vm-instance/1',
        'name': name,
        'base': base,
        'baseReceiptSha256': hashlib.sha256(base_receipt_file.read_bytes()).hexdigest(),
        'cloneReceipt': json.loads((machine_root / 'machines' / name / 'clone.json').read_text()),
        'provisionedAt': int(time.time()),
    }
    temp = path.parent / ('.' + name + '.tmp')
    path.parent.mkdir(parents=True, exist_ok=True)
    with temp.open('x') as out:
        os.chmod(temp, 0o600)
        out.write(json.dumps(receipt, indent=2) + '\n')
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', action='store_true')
    p.add_argument('--spec', default=str(Path(__file__).parents[1] / 'config/vm/farol.json'))
    p.add_argument('--ipsw')
    p.add_argument('--provision-instance', metavar='NAME',
                   help='Clone a clean run instance from a prepared base; never starts it')
    p.add_argument('--base', default='farol-base-1')
    a = p.parse_args()
    binary, root, settings = infrastructure()
    if a.provision_instance:
        command, base_receipt_file, instance_receipt = plan_instance(
            a.provision_instance, a.base, binary, root, settings)
        if a.plan:
            print(json.dumps({'status': 'PLAN', 'instance': a.provision_instance, 'base': a.base,
                              'clone': command, 'receipt': str(instance_receipt)}))
            return
        if not binary.is_file():
            raise ValueError('INSTALL_TERMINAL_MAC_PACKAGE_FIRST')
        # clone is a pure store operation that starts no VM, so a packaged app
        # is preferred but a bare development build is acceptable here; the
        # clone command validates the machine state itself.
        env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
        env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(root))
        subprocess.run(command, env=env, check=True, timeout=1800)
        write_instance_receipt(instance_receipt, a.provision_instance, a.base, base_receipt_file, root)
        print(json.dumps({'status': 'PROVISIONED', 'instance': a.provision_instance,
                          'base': a.base, 'receipt': str(instance_receipt)}))
        return
    spec = json.loads(Path(a.spec).read_text())
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
