import importlib.util
import json
import os
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('vm_runner', Path(__file__).parents[1] / 'vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
# Synthetic identity only: these checks never open a real desktop or profile.
vm.IDENTITY = dict(name='TestProduct', bundleId='test.product', dataLeaf='test.product')


class AdmissionTests(unittest.TestCase):
    def asset(self, root, extra=None):
        archive = root / 'TestProduct-1.2.3-darwin-arm64.zip'
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('TestProduct.app/Contents/Info.plist', plistlib.dumps(dict(
                CFBundleIdentifier='test.product', CFBundleShortVersionString='1.2.3')))
        m = dict(schema='farol.github-release/1', repository='legrch/farol',
                 product='TestProduct', bundleId='test.product', channel='stable',
                 sourceDirty=False, platform='darwin', arch='arm64', signing='unsigned',
                 notarized=False, version='1.2.3', sourceCommit='a'*40,
                 sourceTreeDigest='b'*64, buildId='c'*64, artifactSha256='d'*64,
                 archiveName=archive.name,
                 archiveSize=archive.stat().st_size, archiveSha256=vm.digest(archive))
        with zipfile.ZipFile(archive, 'a') as z:
            z.writestr('artifact.json', json.dumps(dict(m, signing={'kind': 'unsigned'})))
            if extra:
                z.writestr(*extra)
        m.update(archiveSize=archive.stat().st_size, archiveSha256=vm.digest(archive))
        (root / 'farol-release.json').write_text(json.dumps(m))
        (root / 'SHA256SUMS').write_text(f"{m['archiveSha256']}  {archive.name}\n")
        return archive

    def test_exact_archive_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(vm.verify(self.asset(Path(d)))['version'], '1.2.3')

    def test_altered_archive_refused(self):
        with tempfile.TemporaryDirectory() as d:
            archive = self.asset(Path(d))
            with archive.open('ab') as f:
                f.write(b'changed')
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_DIGEST'):
                vm.verify(archive)

    def test_traversal_refused_before_guest_install(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_PATH'):
                vm.verify(self.asset(Path(d), ('TestProduct.app/../../host.txt', b'x')))

    def test_escaping_symlink_refused(self):
        with tempfile.TemporaryDirectory() as d:
            link = zipfile.ZipInfo('TestProduct.app/link')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            with self.assertRaisesRegex(vm.Refused, 'ARCHIVE_LINK_'):
                vm.verify(self.asset(Path(d), (link, '../outside')))

    def test_foreign_profile_identity_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            p = root / 'farol-release.json'
            m = json.loads(p.read_text())
            m['bundleId'] = 'foreign.production'
            p.write_text(json.dumps(m))
            with self.assertRaisesRegex(vm.Refused, 'RELEASE_IDENTITY'):
                vm.verify(archive)

    def test_symlink_input_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            link = root / 'link.zip'
            link.symlink_to(archive)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE'):
                vm.verify(link)

    def test_invalid_vm_and_unbounded_timeout(self):
        base = ['--latest', '--terminal-mac', '/unused', '--vm-home', '/unused', '--terminal-point', '100', '100']
        for args in [['--vm', '../prod'], ['--timeout', '100000']]:
            with self.assertRaises(vm.Refused):
                vm.arguments(base + args)

    def test_cli_environment_and_deadline(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'machines/pilot').mkdir(parents=True)
            executable = root / 'app/Contents/MacOS/terminal-mac'
            executable.parent.mkdir(parents=True)
            executable.write_text('test')
            (executable.parent.parent / 'Info.plist').write_bytes(plistlib.dumps(dict(
                CFBundleIdentifier='dev.terminal-mac.host')))
            (executable.parent.parent / 'Resources/guest-tools').mkdir(parents=True)
            args = vm.arguments(['--latest', '--terminal-mac', str(executable),
                                 '--vm-home', str(root), '--terminal-point', '100', '100', '--evidence', str(root / 'evidence')])
            with patch.dict(os.environ, {'FAROL_ENVIRONMENT': 'dev', 'NODE_OPTIONS': 'unsafe',
                                        'HTTPS_PROXY': 'private-proxy'}):
                runner = vm.Runner(args)
            self.assertNotIn('FAROL_ENVIRONMENT', runner.env)
            self.assertNotIn('NODE_OPTIONS', runner.env)
            self.assertNotIn('HTTPS_PROXY', runner.env)
            runner.deadline = 0
            with self.assertRaisesRegex(vm.Refused, 'DEADLINE'):
                runner.cli('status', 'pilot')

    def test_private_config_rejects_profile_or_credential_fields(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d) / 'config.json'
            file.write_text(json.dumps({'profile': '/owner/profile', 'credential': 'not-a-secret'}))
            with self.assertRaisesRegex(vm.Refused, 'CONFIG_FIELDS_INVALID'):
                vm.arguments(['--latest', '--config', str(file)])

    def test_linked_archive_is_not_resolved_by_runner_admission(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            archive = self.asset(root)
            alias = root / 'alias.zip'
            alias.symlink_to(archive)
            with self.assertRaisesRegex(vm.Refused, 'ASSET_FILE_INVALID'):
                vm.verify(alias.absolute())

    def test_expired_deadline_refuses_further_actions(self):
        runner = object.__new__(vm.Runner)
        runner.deadline = 0
        with self.assertRaisesRegex(vm.Refused, 'DEADLINE'):
            runner.remaining()


if __name__ == '__main__':
    unittest.main()
