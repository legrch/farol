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
import stat
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


def admit_vm_root(root, home):
    """Require a normalized physical path in the explicitly owned VM store."""
    canonical = home / 'Library/Application Support/terminal-mac'
    if not root.is_absolute() or '..' in root.parts:
        raise ValueError('VM_HOME_OUTSIDE_TERMINAL_MAC_ROOT')
    for directory in [*reversed(root.parents), root]:
        try:
            info = directory.lstat()
        except FileNotFoundError:
            break
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    if root.resolve(strict=False) != root:
        raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    if not root.is_relative_to(canonical):
        raise ValueError('VM_HOME_OUTSIDE_TERMINAL_MAC_ROOT')


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
                'terminal_mac', 'vm_home', 'vm', 'terminal_point', 'menu_point', 'timeout', 'bootstrap',
                'prepared_base'}:
            raise ValueError('CONFIG_FIELDS_INVALID')
        if 'prepared_base' in config and (not isinstance(config['prepared_base'], str) or
                not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,47}', config['prepared_base'])):
            raise ValueError('PREPARED_BASE_INVALID')
        if not isinstance(config.get('terminal_mac'), str) or not config['terminal_mac']:
            raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
        if not isinstance(config.get('vm_home'), str) or not config['vm_home']:
            raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
        binary = Path(config['terminal_mac']).expanduser()
        root = Path(config['vm_home']).expanduser()
        if str(root) != os.path.expanduser(config['vm_home']):
            raise ValueError('INFRASTRUCTURE_CONFIG_INVALID')
        if not root.is_absolute():
            raise ValueError('INFRASTRUCTURE_CONFIG_INVALID')
        if root.is_symlink():
            raise ValueError('TESTING_DIRECTORY_ALIAS_FORBIDDEN')
    admit_vm_root(root, home)
    return binary, root, settings


DEFAULT_BASE = 'farol-base-1'


def prepared_base(settings):
    """The prepared base new run instances are cloned from. The same private
    config source as infrastructure() may name it in `prepared_base`; without a
    config or that key it stays farol-base-1. Readiness is still proved only by
    that base's own receipt in plan_instance()."""
    source = os.environ.get('FAROL_VM_CONFIG') or (
        settings / 'vm-smoke.json' if (settings / 'vm-smoke.json').is_file() else None)
    if not source:
        return DEFAULT_BASE
    file = Path(source).expanduser()
    if not file.is_file() or file.stat().st_size > 16384:
        raise ValueError('INFRASTRUCTURE_CONFIG_REQUIRED')
    value = json.loads(file.read_text()).get('prepared_base', DEFAULT_BASE)
    if not isinstance(value, str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]{0,47}', value):
        raise ValueError('PREPARED_BASE_INVALID')
    return value


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= limit:
            raise ValueError('BASE_RECEIPT_INVALID')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        fields = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
        if len(data) != before.st_size or fields(before) != fields(after) or fields(after) != fields(path.lstat()):
            raise ValueError('BASE_RECEIPT_INVALID')
        return data


def base_binding(root, base, hardware_file):
    """Read-only binding to the physical store, selected machine and hardware."""
    if (not isinstance(hardware_file, str) or
            not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', hardware_file) or
            hardware_file == 'machine.json'):
        raise ValueError('BASE_RECEIPT_INVALID')
    machine = root / 'machines' / base
    for directory in (root, root / 'machines', machine):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or directory.resolve(strict=True) != directory:
            raise ValueError('BASE_RECEIPT_INVALID')
    identity = lambda path: [path.stat().st_dev, path.stat().st_ino]
    return {'vmHome': str(root), 'storeIdentity': identity(root),
            'machineIdentity': identity(machine), 'hardwareFile': hardware_file,
            'machineSha256': hashlib.sha256(read_regular(machine / 'machine.json', 65536)).hexdigest(),
            'hardwareSha256': hashlib.sha256(read_regular(machine / hardware_file, 1024*1024)).hexdigest()}


def plan_instance(name, base, binary, root, settings, offline=False):
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
    if receipt_file.resolve(strict=True) != receipt_file:
        raise ValueError('BASE_RECEIPT_INVALID')
    accepted_receipt = read_regular(receipt_file, 65536)
    receipt = json.loads(accepted_receipt)
    if not isinstance(receipt, dict) or receipt.get('schema') != 'farol.vm-base/1':
        raise ValueError('BASE_RECEIPT_INVALID')
    if receipt.get('helper') == 'NOT_INSTALLED_SETUP_ASSISTANT_PENDING' or receipt.get('helper') != 'READY':
        raise ValueError('OWNER_BASE_NOT_READY')
    if receipt.get('account') != 'tester-ready':
        raise ValueError('OWNER_BASE_NOT_READY')
    if not (root / 'machines' / base / 'machine.json').is_file():
        raise ValueError('BASE_MACHINE_MISSING')
    if receipt.get('base') != base:
        raise ValueError('BASE_RECEIPT_INVALID')
    binding = base_binding(root, base, receipt.get('hardwareFile'))
    if any(receipt.get(key) != value for key, value in binding.items()):
        raise ValueError('BASE_RECEIPT_INVALID')
    if (root / 'machines' / name).exists() or (root / 'machines' / name).is_symlink():
        raise ValueError('INSTANCE_COLLISION_REFUSED')
    command = [str(binary), 'clone', base, name]
    if offline:
        command.append('--offline')
    return command, accepted_receipt, settings / 'instance-receipts' / (name + '.json')


def require_offline_instance(root, name):
    """Check the cloned configuration; this is not runtime network attestation."""
    path = root / 'machines' / name / 'machine.json'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= 65536:
                raise ValueError('unsafe machine configuration')
            data = source.read(65537)
            if len(data) != info.st_size:
                raise ValueError('machine configuration changed while reading')

        def unique_object(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError('duplicate machine configuration key')
                value[key] = item
            return value

        machine = json.loads(data, object_pairs_hook=unique_object)
    except (OSError, ValueError, UnicodeError) as error:
        raise ValueError('OFFLINE_CLONE_CONFIG_INVALID') from error
    if not isinstance(machine, dict) or machine.get('name') != name or machine.get('network') is not False:
        raise ValueError('OFFLINE_CLONE_CONFIG_INVALID')


def write_instance_receipt(path, name, base, accepted_base_receipt, machine_root):
    """Durable provenance for one provisioned instance; names and digests only."""
    receipt = {
        'schema': 'farol.vm-instance/1',
        'name': name,
        'base': base,
        'baseReceiptSha256': hashlib.sha256(accepted_base_receipt).hexdigest(),
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


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def durable_directory(path, settings):
    # Revalidate and republish the complete owned chain, even when a failed
    # earlier parent sync left an ancestor visible. Settings has a trusted
    # existing parent; no recursion or creation extends above that root.
    if path != settings:
        if not path.is_relative_to(settings):
            raise ValueError('PROVISION_EVIDENCE_UNSAFE')
        durable_directory(path.parent, settings)
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path or
            info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise ValueError('PROVISION_EVIDENCE_UNSAFE')
    sync_directory(path.parent)


def operation_directory(settings, name):
    if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,47}', name):
        raise ValueError('VM_SPEC_IDENTITY_INVALID')
    return settings / 'vm-machine-operations' / name


def require_no_operations(settings, name):
    directory = operation_directory(settings, name)
    # lstat, rather than exists(), retains dangling entries and lookup errors.
    for path in (directory.parent, directory):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(info.st_mode) or path.resolve(strict=True) != path:
            raise ValueError('PROVISION_OPERATION_UNRESOLVED')
    if any(directory.iterdir()):
        raise ValueError('PROVISION_OPERATION_UNRESOLVED')


def provision_effect(command, settings, name, kind, env, timeout):
    directory = operation_directory(settings, name)
    durable_directory(directory, settings)
    # Create-only pre-effect evidence is never removed by this controller,
    # even after a controller exit of zero: detached VM state needs separate
    # read-only reconciliation, and a failed/unknown dispatch is never replayed.
    intent = directory / (kind + '-intent.json')
    fd = os.open(intent, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump({'schema': 'farol.vm-machine-operation/1', 'machine': name,
                   'operation': kind, 'status': 'unreconciled',
                   'publication': 'intent-before-effect'}, out)
        out.write('\n')
        out.flush()
        os.fsync(out.fileno())
    sync_directory(directory)
    subprocess.run(command, env=env, check=True, timeout=timeout)


def reconcile_operations(settings, name):
    """Read-only inventory; it never clears a fence or admits another effect."""
    directory = operation_directory(settings, name)
    try:
        require_no_operations(settings, name)
    except (ValueError, OSError):
        return {'status': 'UNRESOLVED', 'machine': name, 'automaticReplay': False}
    return {'status': 'ABSENT', 'machine': name, 'automaticReplay': False}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--plan', action='store_true')
    p.add_argument('--reconcile-operations', metavar='NAME', help='Read-only provisioning fence inventory; never clears evidence')
    p.add_argument('--spec', default=str(Path(__file__).parents[1] / 'config/vm/farol.json'))
    p.add_argument('--ipsw')
    p.add_argument('--provision-instance', metavar='NAME',
                   help='Clone a clean run instance from a prepared base; never starts it')
    p.add_argument('--base', help='Prepared base (default: config prepared_base, else farol-base-1)')
    p.add_argument('--offline', action='store_true', help='Disable networking on a new instance clone')
    a = p.parse_args()
    if a.offline and not a.provision_instance:
        p.error('--offline requires --provision-instance')
    binary, root, settings = infrastructure()
    if a.reconcile_operations:
        if a.provision_instance or a.plan or a.ipsw:
            p.error('--reconcile-operations cannot provision or plan')
        print(json.dumps(reconcile_operations(settings, a.reconcile_operations)))
        return
    a.base = a.base or prepared_base(settings)
    if a.provision_instance:
        command, base_receipt_file, instance_receipt = plan_instance(
            a.provision_instance, a.base, binary, root, settings, offline=a.offline)
        if a.plan:
            print(json.dumps({'status': 'PLAN', 'instance': a.provision_instance, 'base': a.base,
                              'clone': command, 'receipt': str(instance_receipt)}))
            return
        require_no_operations(settings, a.provision_instance)
        if not binary.is_file():
            raise ValueError('INSTALL_TERMINAL_MAC_PACKAGE_FIRST')
        # clone is a pure store operation that starts no VM, so a packaged app
        # is preferred but a bare development build is acceptable here; the
        # clone command validates the machine state itself.
        env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
        env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(root))
        provision_effect(command, settings, a.provision_instance, 'clone', env, 1800)
        if a.offline:
            require_offline_instance(root, a.provision_instance)
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
    require_no_operations(settings, spec['name'])
    if not binary.is_file() or plistlib.loads((binary.parent.parent / 'Info.plist').read_bytes()).get('CFBundleIdentifier') != 'dev.terminal-mac.host':
        raise ValueError('INSTALL_TERMINAL_MAC_PACKAGE_FIRST')
    env = {k: os.environ[k] for k in ('HOME', 'USER', 'TMPDIR') if k in os.environ}
    env.update(PATH='/usr/bin:/bin:/usr/sbin:/sbin', TERMINAL_MAC_HOME=str(root))
    machine = root / 'machines' / spec['name'] / 'machine.json'
    created = False
    if not machine.exists():
        if not a.ipsw or not Path(a.ipsw).is_file():
            raise ValueError('APPLE_RESTORE_IPSW_REQUIRED')
        provision_effect(command, settings, spec['name'], 'create', env, 1800)
        created = True
    existing = json.loads(machine.read_text())
    for key in ('name', 'cpu', 'memoryGiB', 'diskGiB', 'width', 'height'):
        if existing[key] != spec[key]:
            raise ValueError('EXISTING_VM_SPEC_DRIFT_NO_MUTATION')
    if existing['network'] != (spec['network'] == 'nat'):
        raise ValueError('EXISTING_VM_NETWORK_DRIFT_NO_MUTATION')
    provision_effect([str(binary), 'start', spec['name']], settings, spec['name'], 'start', env, 60)
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
