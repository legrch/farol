#!/usr/bin/env python3
"""Offline derivation/format checks; not installed Dock or menu-bar acceptance."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from PIL import Image, ImageChops

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("make-signal-color-assets.py")
spec = importlib.util.spec_from_file_location("signal_assets", SCRIPT)
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class SignalAssetsTests(unittest.TestCase):
    def test_approved_source_and_reproducible_derivation(self):
        outputs = assets.derive(assets.ASSETS / "approved.png")
        manifest = json.loads(outputs["manifest.json"])
        self.assertEqual(manifest["approvedSha256"], assets.APPROVED_SHA256)
        self.assertEqual(manifest["appearance"], "fixed-color")
        self.assertEqual(set(manifest["files"]), set(outputs) - {"manifest.json"})
        for name, raw in outputs.items():
            self.assertEqual(assets.regular_bytes(assets.ASSETS / name), raw, name)
            if name != "manifest.json":
                self.assertEqual(manifest["files"][name], {
                    "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                })
        master = Image.open(io.BytesIO(outputs["master.png"]))
        self.assertEqual(master.size, (1024, 1024))
        self.assertEqual(master.mode, "RGBA")
        self.assertEqual(outputs["master.png"], outputs["farol.iconset/icon_512x512@2x.png"])

    def test_cleanup_preserves_canvas_color_and_interior_alpha(self):
        original = assets.approved_image(assets.ASSETS / "approved.png")
        cleaned = assets.cleaned_reference(original)
        self.assertEqual(cleaned.size, original.size)
        self.assertIsNone(ImageChops.difference(original.convert("RGB"), cleaned.convert("RGB")).getbbox())
        self.assertEqual(cleaned.getchannel("A").getbbox(), (77, 84, 1177, 1171))
        self.assertEqual(cleaned.crop((260, 310, 990, 940)).tobytes(), original.crop((260, 310, 990, 940)).tobytes())
        self.assertLess(sum(cleaned.getchannel("A").get_flattened_data()), sum(original.getchannel("A").get_flattened_data()))

    def test_native_slots_have_exact_png_payloads_and_alpha(self):
        raw = (assets.ASSETS / "farol.icns").read_bytes()
        self.assertEqual(raw[:4], b"icns")
        self.assertEqual(struct.unpack(">I", raw[4:8])[0], len(raw))
        offset = 8
        for name, pixels, kind in assets.ICON_SLOTS:
            self.assertEqual(raw[offset:offset + 4], kind)
            length = struct.unpack(">I", raw[offset + 4:offset + 8])[0]
            payload = raw[offset + 8:offset + length]
            png = (assets.ASSETS / "farol.iconset" / name).read_bytes()
            image = Image.open(io.BytesIO(png))
            if kind in (b"is32", b"il32"):
                self.assertEqual(payload, assets.small_rgb(image))
                offset += length
                mask = b"s8mk" if pixels == 16 else b"l8mk"
                self.assertEqual(raw[offset:offset + 4], mask)
                length = struct.unpack(">I", raw[offset + 4:offset + 8])[0]
                self.assertEqual(raw[offset + 8:offset + length], image.getchannel("A").tobytes())
            else:
                self.assertEqual(payload, png)
            self.assertEqual(image.size, (pixels, pixels))
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.getpixel((0, 0))[3], 0)
            # Coral center remains distinct from cool white arcs at every size.
            red, green, blue, alpha = image.getpixel((pixels // 2, pixels // 2))
            self.assertGreater(red, green)
            self.assertGreater(green, blue)
            self.assertGreater(alpha, 240)
            offset += length
        self.assertEqual(offset, len(raw))

    def test_macos_decodes_all_native_representations(self):
        with tempfile.TemporaryDirectory(prefix="farol-signal-native-") as temporary:
            target = Path(temporary) / "decoded.iconset"
            subprocess.run([
                "/usr/bin/iconutil", "--convert", "iconset", "--output", str(target),
                str(assets.ASSETS / "farol.icns"),
            ], check=True, capture_output=True)
            self.assertEqual({f.name for f in target.iterdir()}, {slot[0] for slot in assets.ICON_SLOTS})
            for name, size, _ in assets.ICON_SLOTS:
                decoded = Image.open(target / name).convert("RGBA")
                source = Image.open(assets.ASSETS / "farol.iconset" / name)
                self.assertEqual(decoded.size, (size, size))
                self.assertEqual(decoded.tobytes(), source.tobytes())

    def test_menu_template_is_alpha_only_with_open_gaps(self):
        for scale, suffix in ((1, ""), (2, "@2x")):
            image = Image.open(assets.ASSETS / f"menu-bar-template{suffix}.png")
            self.assertEqual(image.size, (18 * scale, 18 * scale))
            self.assertEqual(image.mode, "RGBA")
            self.assertTrue(all(pixel[:3] == (0, 0, 0) for pixel in image.get_flattened_data()))
            alpha = image.getchannel("A")
            self.assertGreater(alpha.getpixel((9 * scale, 9 * scale)), 240)
            for y in (0, 3 * scale, 14 * scale, 18 * scale - 1):
                self.assertEqual(alpha.getpixel((9 * scale, y)), 0)
            self.assertGreater(alpha.getpixel((3 * scale, 9 * scale)), 240)
            self.assertGreater(alpha.getpixel((14 * scale, 9 * scale)), 240)

    def test_substituted_or_linked_source_fails_before_output(self):
        with tempfile.TemporaryDirectory(prefix="farol-signal-rejection-") as temporary:
            root = Path(temporary)
            changed = root / "changed.png"
            changed.write_bytes((assets.ASSETS / "approved.png").read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "SIGNAL_SOURCE_DIGEST_MISMATCH"):
                assets.derive(changed)
            linked = root / "linked.png"
            linked.symlink_to(assets.ASSETS / "approved.png")
            with self.assertRaisesRegex(ValueError, "SIGNAL_SOURCE_TYPE_INVALID"):
                assets.derive(linked)


if __name__ == "__main__":
    unittest.main(verbosity=2)
