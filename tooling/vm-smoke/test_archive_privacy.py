"""Synthetic Dev archive parity: no build, VM, network or owner data."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

TOOLING = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


archive = load('dev_archive_privacy', TOOLING / 'vm-dev-archive.py')
helper = load('public_archive_privacy', TOOLING / 'prepare-release-archive.py')
IDENTITY = dict(product='Example Dev', appName='Example Dev.app',
                bundleId='test.example.dev', archiveName='Example-Dev.zip', executable='Example')


class ArchivePrivacyTests(unittest.TestCase):
    def test_creation_and_existing_archive_reject_identical_private_bytes(self):
        for inspect in (False, True):
            with self.subTest(inspect=inspect), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                (root / 'tooling').symlink_to(TOOLING, target_is_directory=True)
                output = root / '_output/vm-dev/run1'
                output.mkdir(parents=True, mode=0o700)
                app = output / IDENTITY['appName']
                app.mkdir()
                (app / 'owned.bin').write_bytes(b'x' * (1024*1024 - 4) + b'/Users/synthetic/private')
                receipt = dict(schema='farol.vm-dev-artifact/1', kind='local-dev-derivative',
                    appName=app.name, bundleId=IDENTITY['bundleId'], environment='dev',
                    artifactPath=str(app), officialRelease=False, hostLaunch=False, profileImport=False)
                raw = json.dumps(receipt).encode()
                (output / 'vm-dev-artifact.json').write_bytes(raw)
                if inspect:
                    # Matching ZIP made without privacy admission, simulating an
                    # existing artifact supplied after interrupted metadata publication.
                    with mock.patch.object(helper, 'APP', app), mock.patch.object(helper, 'APP_NAME', app.name), mock.patch.object(helper, 'PACKAGE', output):
                        members = helper.members()
                    with zipfile.ZipFile(output / IDENTITY['archiveName'], 'x') as package:
                        for file, name, info in members:
                            entry = zipfile.ZipInfo(name)
                            entry.create_system = 3
                            entry.external_attr = info.st_mode << 16
                            package.writestr(entry, b'' if file.is_dir() else file.read_bytes())
                with mock.patch.object(archive, 'ROOT', root), mock.patch.dict(os.environ, FAROL_VM_DEV_IDENTITY=json.dumps(IDENTITY)):
                    with self.assertRaisesRegex(ValueError, 'PRIVATE_PATH_IN_APP'):
                        archive.archive_dev(output, hashlib.sha256(raw).hexdigest(), inspect)
                self.assertFalse((output / 'vm-dev-archive.json').exists())

    def test_vendor_exception_and_chunk_boundary_are_shared(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp).resolve()
            vendor = app / 'Contents/Frameworks/Electron Runtime.app/vendor'
            vendor.parent.mkdir(parents=True)
            vendor.write_bytes(b'/Users/public/compiler')
            owned = app / 'owned'
            owned.write_bytes(b'synthetic')
            with mock.patch.object(helper, 'APP', app):
                self.assertEqual(b''.join(helper.public_chunks(vendor, vendor.lstat())), vendor.read_bytes())
                with mock.patch.object(helper, 'regular_chunks', return_value=iter([b'prefix/Us', b'ers/synthetic/private'])):
                    with self.assertRaisesRegex(ValueError, 'PRIVATE_PATH_IN_APP'):
                        list(helper.public_chunks(owned, owned.lstat()))
