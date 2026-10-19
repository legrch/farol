"""Physical-input negatives for a separately selected dependency reference."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from dependency_seal import ALGORITHM, fingerprint, reference


class Dependencies(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.modules = self.root / "node_modules"
        (self.modules / "pkg").mkdir(parents=True)
        (self.modules / "pkg/runner.js").write_bytes(b"original runner\n")
        (self.modules / ".bin").mkdir()
        (self.modules / ".bin/runner").symlink_to("../pkg/runner.js")

    def test_copy_and_new_inodes_keep_the_same_logical_content_binding(self):
        expected = fingerprint(self.modules)
        copied = self.root / "independent-copy"
        shutil.copytree(self.modules, copied, symlinks=True)
        self.assertEqual(fingerprint(copied), expected)

    def test_altered_runner_is_detected_even_with_unchanged_package_metadata(self):
        expected = fingerprint(self.modules)
        (self.modules / "pkg/runner.js").write_bytes(b"forged passing\n")
        self.assertNotEqual(fingerprint(self.modules)["treeSha256"], expected["treeSha256"])

    def test_missing_extra_mode_and_link_changes_cannot_match(self):
        original = fingerprint(self.modules)
        runner = self.modules / "pkg/runner.js"
        original_mode = runner.stat().st_mode & 0o777
        runner.chmod(0o755)
        self.assertNotEqual(fingerprint(self.modules), original)
        runner.chmod(original_mode)
        extra = self.modules / "pkg/extra.js"
        extra.write_bytes(b"extra")
        self.assertNotEqual(fingerprint(self.modules), original)
        extra.unlink()
        link = self.modules / ".bin/runner"
        link.unlink()
        link.symlink_to("../pkg")
        self.assertNotEqual(fingerprint(self.modules), original)
        runner.unlink()
        with self.assertRaisesRegex(ValueError, "DEPENDENCY_TREE_EMPTY"):
            fingerprint(self.modules)

    def test_only_fresh_runtime_cache_contents_are_excluded(self):
        expected = fingerprint(self.modules)
        for name in (".vite", ".vite-temp"):
            (self.modules / name).mkdir()
            (self.modules / name / "generated.js").write_bytes(b"generated")
        self.assertEqual(fingerprint(self.modules), expected)
        (self.modules / "pkg/.vite").mkdir()
        self.assertNotEqual(fingerprint(self.modules), expected)

    def test_redirected_root_or_runtime_cache_and_escaping_links_refuse(self):
        alias = self.root / "alias"
        alias.symlink_to(self.modules, target_is_directory=True)
        with self.assertRaises(ValueError):
            fingerprint(alias)
        (self.modules / ".vite").symlink_to("pkg", target_is_directory=True)
        with self.assertRaises(ValueError):
            fingerprint(self.modules)
        (self.modules / ".vite").unlink()
        (self.root / "outside.js").write_bytes(b"outside")
        (self.modules / "escape").symlink_to("../outside.js")
        with self.assertRaises(ValueError):
            fingerprint(self.modules)

    def test_reference_is_bound_to_selected_bytes_lock_image_and_producer(self):
        value = {"schema": 1, **fingerprint(self.modules), "lockSha256": "a" * 64,
                 "image": "selected-image", "nodeSha256": "b" * 64,
                 "producer": "fresh-npm-ci-ignore-scripts-and-explicit-esbuild", "npmVersion": "11.19.0"}
        path = self.root / "reference.json"
        path.write_text(json.dumps(value))
        selected = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(reference(path, selected, "a" * 64, "selected-image", "b" * 64), value)
        for field, replacement in (("lockSha256", "c" * 64), ("image", "another-image"),
                                   ("producer", "observed-current-volume"), ("schema", True)):
            with self.subTest(field=field):
                invalid = dict(value)
                invalid[field] = replacement
                path.write_text(json.dumps(invalid))
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                with self.assertRaises(ValueError):
                    reference(path, digest, "a" * 64, "selected-image", "b" * 64)
        with self.assertRaisesRegex(ValueError, "REFERENCE_CHANGED"):
            reference(path, selected, "a" * 64, "selected-image", "b" * 64)


if __name__ == "__main__":
    unittest.main()
