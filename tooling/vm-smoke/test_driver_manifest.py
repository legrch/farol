"""Real Runner.stage_driver -> actual guest consumer, synthetic filesystem only.

The Node interpreter runs only the test adapter. The staged runtime is inert
text, never executed. Foundation/NSTask and the full guest.sh require macOS/VM.
"""
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import test_closed_contour as fixture

HERE = Path(__file__).parent
NODE = shutil.which('node')


@unittest.skipUnless(NODE, 'NOT RUN: a local Node test interpreter is required')
class GuestManifestContractTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.runner = fixture.build_runner(self.root)
        self.runner.prepare_stage()
        driver, _ = fixture.build_driver_dir(self.root)
        self.manifest = self.runner.stage_driver(driver)
        self.stage = self.runner.stage

    def consume(self):
        child = subprocess.run([NODE, str(HERE / 'driver-manifest.test-adapter.mjs'), str(self.stage)],
                               text=True, capture_output=True, timeout=10,
                               env={'PATH': os.environ.get('PATH', '')})
        self.assertEqual(child.returncode, 0, child.stderr)
        return json.loads(child.stdout)

    def write_manifest(self, manifest):
        (self.stage / 'driver.manifest.json').write_text(json.dumps(manifest))

    def refused(self):
        result = self.consume()
        self.assertEqual(result['launches'], 0, result)
        self.assertIsNotNone(result['error'])
        return result

    def test_actual_stager_output_reaches_launch_spy(self):
        self.assertEqual(self.manifest['schema'], 'farol.vm-e2e.driver-manifest/1')
        result = self.consume()
        self.assertEqual(result['launches'], 1, result)
        self.assertIsNone(result['error'])

    def test_flat_only_manifest_is_refused(self):
        m = copy.deepcopy(self.manifest)
        m['bundle_sha256'] = m.pop('bundle')['sha256']
        m['node_sha256'] = m.pop('node')['sha256']
        self.write_manifest(m)
        self.refused()

    def test_conflicting_and_even_matching_flat_aliases_are_refused(self):
        for value in ('0' * 64, self.manifest['bundle']['sha256']):
            with self.subTest(value=value):
                self.write_manifest(dict(self.manifest, bundle_sha256=value,
                                         node_sha256=self.manifest['node']['sha256']))
                self.refused()

    def test_schema_fields_and_types_are_strict(self):
        cases = [('schema', 'other/1'), ('schema', None), ('tool', 'other/1'),
                 ('staged', False), ('staged', 'true'), ('bundler', 'magic'),
                 ('entry', '../escape.mjs')]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                m = copy.deepcopy(self.manifest); m[key] = value
                self.write_manifest(m); self.refused()
        for key in self.manifest:
            with self.subTest(missing=key):
                m = copy.deepcopy(self.manifest); del m[key]
                self.write_manifest(m); self.refused()
        for value in (None, [], '', 1):
            with self.subTest(root=value):
                self.write_manifest(value); self.refused()
        (self.stage / 'driver.manifest.json').write_text('{invalid')
        self.refused()

    def test_payload_hash_size_and_names_checked_before_launch(self):
        for section, size_key, path_key, expected_name in (
                ('bundle', 'bytes', 'file', 'driver.bundle.mjs'),
                ('node', 'size', 'path', 'node')):
            for key, value in [('sha256', 'a' * 64), ('sha256', 'A' * 64),
                               ('sha256', None), ('sha256', 'abc'),
                               (size_key, True), (size_key, '1'), (size_key, -1),
                               (size_key, 0), (size_key, 1.5),
                               (size_key, self.manifest[section][size_key] + 1),
                               (path_key, '../' + expected_name), (path_key, '/' + expected_name),
                               (path_key, 'other'), (path_key, './' + expected_name)]:
                with self.subTest(section=section, key=key, value=value):
                    m = copy.deepcopy(self.manifest); m[section][key] = value
                    self.write_manifest(m); self.refused()
        self.write_manifest(self.manifest)
        for name in ('driver.bundle.mjs', 'node'):
            file = self.stage / name; original = file.read_bytes()
            with self.subTest(tampered=name):
                file.write_bytes(b'X' + original[1:]); self.refused()
                file.write_bytes(original)

    def test_symlinks_hardlinks_missing_and_nonregular_files_refused(self):
        for name in ('driver.manifest.json', 'driver.bundle.mjs', 'node'):
            file = self.stage / name; original = file.read_bytes()
            for kind in ('symlink', 'hardlink', 'missing', 'directory'):
                with self.subTest(name=name, kind=kind):
                    file.unlink()
                    if kind in ('symlink', 'hardlink'):
                        target = self.root / ('external-' + name)
                        target.write_bytes(original)
                        if kind == 'symlink': file.symlink_to(target)
                        else: os.link(target, file)
                    elif kind == 'directory': file.mkdir()
                    self.refused()
                    if file.is_symlink() or file.is_file(): file.unlink()
                    elif file.is_dir(): file.rmdir()
                    file.write_bytes(original)

    def test_guest_guard_is_present_and_staged_runtime_never_validates_itself(self):
        source = (self.stage / 'guest.sh').read_text()
        self.assertIn('case "$(/usr/sbin/sysctl -n hw.model)" in VirtualMac*) ;; *) exit 71 ;; esac', source)
        if (self.stage / 'driver-manifest.js').exists():
            consumer = (self.stage / 'driver-manifest.js').read_text()
            self.assertIn('/usr/bin/shasum', consumer)
            self.assertIn('/usr/bin/stat', consumer)
            self.assertNotIn('"$node_bin"', consumer)


if __name__ == '__main__':
    unittest.main()
