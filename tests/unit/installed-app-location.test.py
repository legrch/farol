"""Pure and disposable native boundaries; no installed app, owner profile or process observation."""
import importlib.util
import json
from pathlib import Path
import stat
import os
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import ExitStack

ROOT = Path(__file__).resolve().parents[2]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

update = load("update_location", "resources/native/update_helper.py")
promotion = load("promotion_location", "tooling/promotion-apply.py")

def info(uid=0, gid=80, mode=0o775, inode=3):
    return SimpleNamespace(st_mode=stat.S_IFDIR | mode, st_uid=uid, st_gid=gid,
                           st_dev=1, st_ino=inode)

def request(location=None):
    source = dict(digest="1" * 64, buildId="2" * 64, version="0.2.4")
    target = dict(digest="3" * 64, buildId="4" * 64, version="0.2.5")
    value = dict(schema="farol.installed-update/1", action="apply", home="/Users/fixture",
                 operationId="a" * 32, source=source, target=target,
                 drain=dict(status="reconciled", acceptedSource=source["buildId"], acceptedTarget=target["buildId"]),
                 pid=123, processStart="fixture", waitSeconds=1, relaunch=False)
    if location is not None:
        value["installLocation"] = location
    return value

class LocationTests(unittest.TestCase):
    def test_shared_parent_policy_is_narrow_in_both_helpers(self):
        for module in (update, promotion):
            for metadata in (info(), info(gid=0, mode=0o755)):
                module.require_shared_parent(metadata)
            for metadata in (info(uid=501), info(mode=0o777), info(gid=20),
                             SimpleNamespace(**{**vars(info()), "st_mode": stat.S_IFLNK | 0o775})):
                with self.assertRaises(module.Refusal):
                    module.require_shared_parent(metadata)

    def test_cross_device_apply_refuses_before_ready_quit_or_journal(self):
        # Pure adapter fixture: real run ordering, synthetic descriptor devices.
        for location in ("shared", "legacy"):
            with ExitStack() as stack:
                for name, result in (("open_home", 10), ("open_applications", 20),
                                     ("open_owner_state", 30), ("open_dir", 40),
                                     ("update_lock", 50), ("initial_marker", "fixture"),
                                     ("verify_slot_binding", None), ("checked_tree", None)):
                    stack.enter_context(patch.object(update, name, return_value=result))
                stack.enter_context(patch.object(update, "entry", side_effect=lambda fd, name: info() if fd == 20 and name == update.APP else None))
                stack.enter_context(patch.object(update.os, "fstat", side_effect=lambda fd: SimpleNamespace(st_dev=1 if fd == 20 else 2)))
                stack.enter_context(patch.object(update.os, "close"))
                ready = stack.enter_context(patch.object(update, "emit_handoff"))
                journal = stack.enter_context(patch.object(update, "write_operation_journal"))
                wait = stack.enter_context(patch.object(update, "wait_exit"))
                swap = stack.enter_context(patch.object(update, "exchange_checked"))
                with self.assertRaises(update.Refusal) as refused:
                    update.run(request(location))
                self.assertEqual(refused.exception.code, "exchange_unsupported")
                ready.assert_not_called()
                journal.assert_not_called()
                wait.assert_not_called()
                swap.assert_not_called()

    def test_updater_request_legacy_and_explicit_selection(self):
        for location in (None, "legacy", "shared"):
            value = request(location)
            with patch.object(update.os, "read", side_effect=[json.dumps(value).encode(), b""]):
                self.assertEqual(update.parse_request(), value)
            expected = "/Applications/Farol.app" if location == "shared" else "/Users/fixture/Applications/Farol.app"
            self.assertEqual(update.selected_slot(value), expected)
            with patch.object(update, "process_start", return_value="fixture"):
                self.assertEqual(update.relaunch_arguments(value, "completed")[2], expected)

    def test_malformed_selection_never_becomes_legacy(self):
        for location in (None, False, 0, "SHARED", "/Applications/Farol.app", {}, []):
            value = {**request(), "installLocation": location}
            with patch.object(update.os, "read", side_effect=[json.dumps(value).encode(), b""]):
                with self.assertRaises(update.Refusal):
                    update.parse_request()

    def test_promotion_request_legacy_and_explicit_selection(self):
        base = dict(schema="farol.next.promotion-apply/1", home="/Users/fixture", source="/candidate/Farol.app",
                    artifactSha256="1" * 64, receiptText='{"operation":"applied"}', testHook=False,
                    lease=dict(file="/Users/fixture/Library/Application Support/Farol Next Preview/farol-next-state/promotion.lease", device="1", inode="2"))
        for location in (None, "legacy", "shared"):
            value = dict(base)
            if location is not None:
                value["installLocation"] = location
            with patch.object(promotion.os, "read", side_effect=[json.dumps(value).encode(), b""]):
                self.assertEqual(promotion.read_request()["home"], base["home"])
        for location in (None, False, "/Applications/Farol.app", {}, []):
            with patch.object(promotion.os, "read", side_effect=[json.dumps({**base, "installLocation": location}).encode(), b""]):
                with self.assertRaises(promotion.Refusal):
                    promotion.read_request()

    def test_selected_shared_open_never_uses_legacy_on_failure(self):
        with patch.object(update.os, "open", return_value=10), patch.object(update.os, "close"), patch.object(update.os, "fstat", return_value=info(gid=0, mode=0o755)), patch.object(update.os, "stat", return_value=info(gid=20)), patch.object(update, "open_dir") as legacy:
            with self.assertRaises(update.Refusal):
                update.open_applications(11, "shared")
            legacy.assert_not_called()

    def test_shared_open_and_recheck_pin_same_parent(self):
        for module in (update, promotion):
            if module is update:
                with patch.object(module.os, "open", side_effect=[10, 12]), patch.object(module.os, "close"), patch.object(module.os, "stat", return_value=info()), patch.object(module.os, "fstat", side_effect=[info(gid=0, mode=0o755), info(inode=99)]):
                    with self.assertRaises(module.Refusal):
                        module.open_applications(11, "shared")
                with patch.object(module, "open_home", return_value=11), patch.object(module, "open_applications", return_value=12) as opened, patch.object(module.os, "close"), patch.object(module.os, "fstat", side_effect=[info(inode=1), info(inode=1), info(inode=3), info(inode=99)]):
                    with self.assertRaises(module.Refusal):
                        module.assert_parent_path("/Users/fixture", 11, 13, "shared")
                    opened.assert_called_once_with(11, "shared")
            else:
                with patch.object(module, "open_absolute_directory", return_value=11), patch.object(module, "open_applications", return_value=12) as opened, patch.object(module.os, "close"), patch.object(module.os, "fstat", side_effect=[info(inode=1), info(inode=1), info(inode=3), info(inode=99)]):
                    with self.assertRaises(module.Refusal):
                        module.recheck_parent({"home": "/Users/fixture", "installLocation": "shared"}, 11, 13)
                    opened.assert_called_once()

    def test_shared_exception_does_not_loosen_owned_directory_checks(self):
        with patch.object(update.os, "geteuid", return_value=501), patch.object(update.os, "stat", return_value=info()), patch.object(update.os, "open") as opened:
            with self.assertRaises(update.Refusal):
                update.open_dir(10, "staged.app")
            opened.assert_not_called()
        with patch.object(promotion.os, "geteuid", return_value=501):
            with self.assertRaises(promotion.Refusal):
                promotion.require_safe_directory(info(), final=True)

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="farol-slot-binding-")
        self.path = Path(self.directory.name)
        self.fd = os.open(str(self.path), update.DIR_FLAGS)
        self.request = request("shared")
        self.data = update.slot_binding_bytes(self.request)

    def tearDown(self):
        os.close(self.fd)
        self.directory.cleanup()

    def test_no_overwrite_publication_and_selected_slot_build_pair(self):
        update.publish_slot_binding(self.fd, self.data)
        original = os.stat(update.SLOT_BINDING, dir_fd=self.fd)
        update.publish_slot_binding(self.fd, self.data)
        self.assertEqual(os.stat(update.SLOT_BINDING, dir_fd=self.fd).st_ino, original.st_ino)
        self.assertEqual(stat.S_IMODE(original.st_mode), 0o600)
        update.verify_slot_binding(self.fd, self.request)
        for changed in ({**self.request, "installLocation": "legacy"},
                        {**self.request, "operationId": "b" * 32},
                        {**self.request, "source": {**self.request["source"], "digest": "5" * 64}},
                        {**self.request, "target": {**self.request["target"], "buildId": "6" * 64}}):
            with self.assertRaises(update.Refusal):
                update.verify_slot_binding(self.fd, changed)
            with self.assertRaises(update.Refusal):
                update.publish_slot_binding(self.fd, update.slot_binding_bytes(changed))
        self.assertEqual((self.path / update.SLOT_BINDING).read_bytes(), self.data)

    def test_missing_binding_fences_modern_journal_and_legacy_wire_is_unchanged(self):
        for location in ("shared", "legacy"):
            with patch.object(update, "write_record") as write:
                with self.assertRaises(update.Refusal):
                    update.write_operation_journal(self.fd, {**self.request, "installLocation": location}, "prepared")
                write.assert_not_called()
        with patch.object(update, "write_record") as write:
            update.write_operation_journal(self.fd, request(), "prepared")
            write.assert_called_once()
        (self.path / "journal.json").write_bytes(b"authoritative fixture")
        with self.assertRaises(update.Refusal):
            update.publish_slot_binding(self.fd, self.data)
        self.assertFalse((self.path / update.SLOT_BINDING).exists())

    def test_canonical_bytes_and_strict_file_layout(self):
        for data in (json.dumps(json.loads(self.data)).encode(), self.data + b" ", self.data.replace(b'"shared"', b'"shared", "extra":true')):
            with self.assertRaises(update.Refusal):
                update.publish_slot_binding(self.fd, data)
        for variant in ("symlink", "hardlink", "mode", "size", "different", "owner", "directory"):
            with self.subTest(variant=variant):
                file = self.path / update.SLOT_BINDING
                if variant == "symlink":
                    (self.path / "elsewhere").write_bytes(self.data)
                    file.symlink_to(self.path / "elsewhere")
                elif variant == "directory":
                    file.mkdir()
                else:
                    file.write_bytes(self.data if variant != "size" else b"x" * 8193)
                    file.chmod(0o600 if variant != "mode" else 0o644)
                    if variant == "hardlink": os.link(str(file), str(self.path / "second"))
                    if variant == "different": file.write_bytes(update.slot_binding_bytes({**self.request, "installLocation": "legacy"}))
                if variant == "owner":
                    with patch.object(update.os, "geteuid", return_value=-1):
                        with self.assertRaises(update.Refusal): update.verify_slot_binding(self.fd, self.request)
                else:
                    with self.assertRaises((update.Refusal, OSError)): update.verify_slot_binding(self.fd, self.request)
                if file.is_dir() and not file.is_symlink(): file.rmdir()
                else: file.unlink()
                for name in ("second", "elsewhere"):
                    extra = self.path / name
                    if extra.exists(): extra.unlink()

    def test_same_descriptor_does_not_redirect_publication(self):
        moved = self.path.with_name(self.path.name + "-pinned")
        self.path.rename(moved)
        self.path.mkdir(mode=0o700)
        try:
            update.publish_slot_binding(self.fd, self.data)
            self.assertFalse((self.path / update.SLOT_BINDING).exists())
            self.assertEqual((moved / update.SLOT_BINDING).read_bytes(), self.data)
        finally:
            (moved / update.SLOT_BINDING).unlink()
            moved.rmdir()


if __name__ == "__main__":
    unittest.main()
