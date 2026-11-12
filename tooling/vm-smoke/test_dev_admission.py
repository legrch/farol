"""Offline local Dev commitment tests; no VM or account/profile reads."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import stat
import struct
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("dev_producer", ROOT / "vm_app_service.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class DevAdmissionTests(unittest.TestCase):
    def fixture(self, root):
        launcher = (ROOT / "vm-dev-launcher.sh").read_bytes()
        files = {"Contents/Info.plist": plistlib.dumps(dict(CFBundleIdentifier="local.farol.dev", CFBundleShortVersionString="1.0.0", CFBundleExecutable="Farol")),
                 "Contents/MacOS/Farol": launcher,
                 "Contents/Resources/app/farol-backend": b"synthetic backend, never executed"}
        dirs = {"Contents", "Contents/MacOS", "Contents/Resources", "Contents/Resources/app"}
        archive = root / "Farol-Dev.zip"
        with zipfile.ZipFile(archive, "w") as z:
            for name in sorted(dirs):
                info = zipfile.ZipInfo("Farol Dev.app/" + name + "/"); info.external_attr = (stat.S_IFDIR | 0o755) << 16; z.writestr(info, b"")
            for name, data in files.items():
                info = zipfile.ZipInfo("Farol Dev.app/" + name); info.external_attr = (stat.S_IFREG | (0o644 if name.endswith(".plist") else 0o755)) << 16; z.writestr(info, data)
        archive.chmod(0o600)
        release = dict(product="Farol Dev", bundleId="local.farol.dev", version="1.0.0", archiveSha256=m.sha256_file(archive), artifactSha256="a"*64)
        payload, _ = m._tree(archive, release, dict(name="Farol Dev", bundleId="local.farol.dev"))
        receipt = dict(schema="farol.vm-dev-artifact/1", kind="local-dev-derivative", appName="Farol Dev.app", bundleId="local.farol.dev", environment="dev", version="1.0.0", hostLaunch=False, profileImport=False, officialRelease=False, sourceCommit="a"*40, sourceTreeDigest="b"*64, parentBuildId="c"*64, buildManifestSHA256="d"*64, launcherSHA256=hashlib.sha256(launcher).hexdigest(), artifactSha256=m._inventory_tree_digest(payload["entries"]))
        file = root / "vm-dev-artifact.json"; file.write_text(json.dumps(receipt)); file.chmod(0o600)
        stage = root / ("run-" + "e"*32); stage.mkdir(mode=0o700)
        return archive, file, m.sha256_file(file), stage

    def testAcceptedDevBindsExactTreeAndFixedLauncher(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.fixture(Path(temp).resolve())
            value = m.prepare_dev_session(*args)
            self.assertEqual(value["runId"], args[3].name)
            self.assertEqual(json.loads((args[3]/"app-payload.json").read_text())["bundleID"], "local.farol.dev")
            policy = json.loads((args[3]/"verification-policy.json").read_text())
            self.assertEqual(policy["checks"][0]["sha256"], hashlib.sha256((ROOT/"vm-dev-launcher.sh").read_bytes()).hexdigest())
            with self.assertRaises(FileExistsError): m.prepare_dev_session(*args)

    def testChangedReceiptOrProductionIdentityRefusesBeforePublication(self):
        for field, value in [("bundleId", "io.github.legrch.farol"), ("environment", "prod"), ("artifactSha256", "f"*64), ("launcherSHA256", "f"*64), ("profileImport", True)]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
                archive, receipt, digest, stage = self.fixture(Path(temp).resolve())
                document=json.loads(receipt.read_text()); document[field]=value; receipt.write_text(json.dumps(document))
                with self.assertRaises(m.ProducerRefusal): m.prepare_dev_session(archive, receipt, m.sha256_file(receipt), stage)
                self.assertEqual(list(stage.iterdir()), [])

    def testUnacceptedReceiptAndSymlinkRefuse(self):
        with tempfile.TemporaryDirectory() as temp:
            archive, receipt, digest, stage = self.fixture(Path(temp).resolve())
            with self.assertRaises(m.ProducerRefusal): m.prepare_dev_session(archive, receipt, "f"*64, stage)
            alias = receipt.parent / "alias.json"; alias.symlink_to(receipt)
            with self.assertRaises(OSError): m.prepare_dev_session(archive, alias, digest, stage)
            self.assertEqual(list(stage.iterdir()), [])

    def testDigestUsesDirectoryPreorderAndMatchesIndependentEncoding(self):
        entries=[dict(path="A/z", kind="file", mode=0o644, sha256=hashlib.sha256(b"x").hexdigest()), dict(path="A-", kind="directory", mode=0o755), dict(path="A", kind="directory", mode=0o755)]
        digest=hashlib.sha256(b"farol.tree-digest/v2\0")
        for path, kind, mode, data in [("A", b"d", 0o755, b""), ("A/z", b"f", 0o644, hashlib.sha256(b"x").digest()), ("A-", b"d", 0o755, b"")]:
            digest.update(struct.pack(">I", len(path))); digest.update(path.encode()); digest.update(kind); digest.update(struct.pack(">I", mode)); digest.update(data)
        self.assertEqual(m._inventory_tree_digest(entries), digest.hexdigest())

if __name__ == "__main__": unittest.main()
