"""Physical tree digest regression for verify(). Synthetic only; no guest or network.

Builds a synthetic physical app tree, uses the EXACT supplied canonical Node
v2 digest, then repacks changed bytes with matching outer ZIP checksums.
The producer (tooling/package.mjs) computes artifactSha256 with the same
Node implementation, so verify() must recompute it from the extracted tree.
"""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).parents[2]
spec = importlib.util.spec_from_file_location('digest_regression_vm', ROOT / 'tooling/vm-smoke.py')
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)
vm.IDENTITY = dict(name='SyntheticProduct', bundleId='test.synthetic',
                   dataLeaf='test.synthetic', devDataLeaf='SyntheticDev')


def canonical_digest(app):
    node = shutil.which('node')
    if node is None:
        raise RuntimeError('BLOCKED: Node with TypeScript type stripping is required')
    program = 'const {treeDigest}=await import(process.argv[1]); console.log(await treeDigest(process.argv[2]));'
    result = subprocess.run([node, '--experimental-strip-types', '--input-type=module', '-e', program,
                             (ROOT / 'tooling/artifact-digest.mjs').as_uri(), str(app)],
                            capture_output=True, text=True, timeout=10,
                            env={'PATH': os.environ.get('PATH', ''), 'NODE_NO_WARNINGS': '1'})
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def package(root):
    app = root / 'SyntheticProduct.app'
    (app / 'Contents/Resources').mkdir(parents=True)
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(dict(
        CFBundleIdentifier='test.synthetic', CFBundleShortVersionString='1.2.3')))
    (app / 'Contents/Resources/payload').write_text('synthetic original bytes')
    artifact = dict(schema=5, treeDigestVersion='farol.tree-digest/v2',
                    product='SyntheticProduct', bundleId='test.synthetic',
                    version='1.2.3', sourceCommit='a'*40, sourceDirty=False,
                    sourceTreeDigest='b'*64, buildId='c'*64,
                    artifactSha256=canonical_digest(app), notarized=False,
                    signing={'kind': 'unsigned'})
    return app, artifact


def pack(root, app, artifact):
    archive = root / 'SyntheticProduct-1.2.3-darwin-arm64.zip'
    with zipfile.ZipFile(archive, 'w') as z:
        z.write(app, app.name)
        for item in sorted(app.rglob('*')):
            relative = str(item.relative_to(root))
            if item.is_symlink():
                # zipfile.write would resolve the link; store the target like the producer.
                link = zipfile.ZipInfo(relative)
                link.create_system = 3
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(link, os.readlink(item))
            else:
                z.write(item, relative)
        z.writestr('artifact.json', json.dumps(artifact))
    m = dict(artifact, schema='farol.github-release/1', repository='legrch/farol',
             channel='stable', platform='darwin', arch='arm64', signing='unsigned',
             archiveName=archive.name, archiveSize=archive.stat().st_size,
             archiveSha256=vm.digest(archive))
    (root / 'farol-release.json').write_text(json.dumps(m))
    (root / 'SHA256SUMS').write_text(f"{m['archiveSha256']}  {archive.name}\n")
    return archive


class PhysicalDigestRegressionTests(unittest.TestCase):
    def test_valid_canonical_synthetic_tree_is_admitted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            self.assertEqual(vm.verify(pack(root, app, artifact))['artifactSha256'], canonical_digest(app))

    def test_changed_physical_payload_with_rehashed_zip_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            (app / 'Contents/Resources/payload').write_text('synthetic substituted bytes')
            self.assertNotEqual(canonical_digest(app), artifact['artifactSha256'])
            with self.assertRaisesRegex(vm.Refused, 'DIGEST'):
                vm.verify(pack(root, app, artifact))

    def test_changed_mode_with_rehashed_zip_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            payload = app / 'Contents/Resources/payload'
            payload.chmod(0o755 if payload.stat().st_mode & 0o777 != 0o755 else 0o644)
            self.assertNotEqual(canonical_digest(app), artifact['artifactSha256'])
            with self.assertRaisesRegex(vm.Refused, 'DIGEST'):
                vm.verify(pack(root, app, artifact))

    def test_contained_symlink_package_is_admitted_with_matching_digest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            (app / 'Contents/Resources/alias').symlink_to('payload')
            artifact['artifactSha256'] = canonical_digest(app)
            self.assertEqual(vm.verify(pack(root, app, artifact))['artifactSha256'], canonical_digest(app))

    def test_missing_node_tool_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            with patch.object(vm.shutil, 'which', return_value=None):
                with self.assertRaisesRegex(vm.Refused, 'DIGEST_TOOL_UNAVAILABLE'):
                    vm.verify(pack(root, app, artifact))

    def test_mismatched_artifact_digest_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            app, artifact = package(root)
            artifact['artifactSha256'] = 'e' * 64
            with self.assertRaisesRegex(vm.Refused, 'DIGEST'):
                vm.verify(pack(root, app, artifact))


if __name__ == '__main__':
    unittest.main()
