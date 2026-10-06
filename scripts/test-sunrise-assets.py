#!/usr/bin/env python3
"""Offline source/format tests; no application, package or Dock acceptance."""

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
from unittest.mock import patch

from PIL import Image

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).with_name("make-sunrise-assets.py")
spec = importlib.util.spec_from_file_location("sunrise_assets", SCRIPT)
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)
SOURCE_SHA256 = "d1fe70502c90b71755aefc57f99d942d1401f071784b3e49676d557c34e952ec"


class SunriseAssetsTests(unittest.TestCase):
    def test_exact_source_manifest_and_reproducible_bytes(self):
        source = assets.ASSETS / "source.png"
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), SOURCE_SHA256)
        outputs = assets.derive(source)
        self.assertEqual(assets.derive(source), outputs)
        manifest = json.loads(outputs["manifest.json"])
        self.assertEqual(manifest["identity"], "Sunrise")
        self.assertEqual(manifest["source"]["sha256"], SOURCE_SHA256)
        self.assertEqual(manifest["source"]["path"], assets.SOURCE_REFERENCE)
        self.assertEqual(manifest["appearance"], "fixed-color; same artwork for light and dark")
        self.assertEqual(set(manifest["files"]), set(outputs) - {"manifest.json"})
        self.assertEqual(outputs["source.png"], source.read_bytes())
        for name, raw in outputs.items():
            self.assertEqual(assets.regular_bytes(assets.ASSETS / name), raw, name)
            if name != "manifest.json":
                self.assertEqual(manifest["files"][name], {
                    "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                })
        self.assertEqual(outputs["master.png"], outputs["farol.iconset/icon_512x512@2x.png"])

    def test_rasters_preserve_full_canvas_and_opaque_color(self):
        original = Image.open(assets.ASSETS / "source.png")
        self.assertEqual(original.size, (1254, 1254))
        self.assertEqual(original.mode, "RGB")
        for name, size, _ in assets.ICON_SLOTS:
            raster = Image.open(assets.ASSETS / "farol.iconset" / name)
            self.assertEqual(raster.format, "PNG")
            self.assertEqual(raster.size, (size, size))
            self.assertEqual(raster.mode, "RGBA")
            self.assertEqual(raster.getchannel("A").getextrema(), (255, 255))
            expected = original.resize((size, size), Image.Resampling.LANCZOS)
            self.assertEqual(raster.convert("RGB").tobytes(), expected.tobytes())

    def test_icns_structure_and_independent_payload_decode(self):
        raw = (assets.ASSETS / "farol.icns").read_bytes()
        self.assertEqual(raw[:4], b"icns")
        self.assertEqual(struct.unpack(">I", raw[4:8])[0], len(raw))
        offset = 8

        def chunk(expected_kind):
            nonlocal offset
            self.assertLessEqual(offset + 8, len(raw))
            self.assertEqual(raw[offset:offset + 4], expected_kind)
            length = struct.unpack(">I", raw[offset + 4:offset + 8])[0]
            self.assertGreaterEqual(length, 8)
            self.assertLessEqual(offset + length, len(raw))
            payload = raw[offset + 8:offset + length]
            offset += length
            return payload

        for name, size, kind in assets.ICON_SLOTS:
            raster_bytes = (assets.ASSETS / "farol.iconset" / name).read_bytes()
            raster = Image.open(io.BytesIO(raster_bytes))
            payload = chunk(kind)
            if kind in (b"is32", b"il32"):
                self.assertEqual(len(payload), size * size * 4)
                channels = raster.split()
                for channel_offset, channel in enumerate((channels[3], *channels[:3])):
                    self.assertEqual(payload[channel_offset::4], channel.tobytes())
                mask = chunk(b"s8mk" if size == 16 else b"l8mk")
                self.assertEqual(mask, raster.getchannel("A").tobytes())
            else:
                self.assertEqual(payload, raster_bytes)
                decoded = Image.open(io.BytesIO(payload))
                self.assertEqual(decoded.tobytes(), raster.tobytes())
        self.assertEqual(offset, len(raw))

    @unittest.skipUnless(sys.platform == "darwin", "macOS iconutil is unavailable")
    def test_offline_macos_iconutil_decode(self):
        with tempfile.TemporaryDirectory(prefix="farol-sunrise-decode-") as temporary:
            target = Path(temporary) / "decoded.iconset"
            subprocess.run([
                "/usr/bin/iconutil", "--convert", "iconset", "--output", str(target),
                str(assets.ASSETS / "farol.icns"),
            ], check=True, capture_output=True)
            self.assertEqual({p.name for p in target.iterdir()}, {s[0] for s in assets.ICON_SLOTS})
            for name, size, _ in assets.ICON_SLOTS:
                decoded = Image.open(target / name).convert("RGBA")
                raster = Image.open(assets.ASSETS / "farol.iconset" / name)
                self.assertEqual(decoded.size, (size, size))
                self.assertEqual(decoded.tobytes(), raster.tobytes())

    def test_exact_input_and_output_links_refuse_before_writes(self):
        with tempfile.TemporaryDirectory(prefix="farol-sunrise-guards-") as temporary:
            root = Path(temporary).resolve()
            changed = root / "changed.png"
            changed.write_bytes((assets.ASSETS / "source.png").read_bytes() + b"changed")
            linked = root / "linked.png"
            linked.symlink_to(assets.ASSETS / "source.png")
            for source, error in ((changed, "DIGEST_MISMATCH"), (linked, "TYPE_INVALID")):
                output = root / "rejected"
                result = subprocess.run([
                    sys.executable, "-B", str(SCRIPT), "--source", str(source),
                    "--output", str(output),
                ], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"SUNRISE_SOURCE_{error}", result.stderr)
                self.assertFalse(output.exists())
            output = root / "output"
            output.mkdir()
            sentinel = root / "sentinel"
            sentinel.write_bytes(b"unchanged")
            (output / "farol.icns").symlink_to(sentinel)
            result = subprocess.run([
                sys.executable, "-B", str(SCRIPT), "--source", str(assets.ASSETS / "source.png"),
                "--output", str(output),
            ], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SUNRISE_OUTPUT_LINK_INVALID:farol.icns", result.stderr)
            self.assertEqual(sentinel.read_bytes(), b"unchanged")
            self.assertFalse((output / "source.png").exists())

    def test_toolchain_mismatch_fails_closed(self):
        with patch.object(assets.PIL, "__version__", "unexpected"):
            with self.assertRaisesRegex(ValueError, "SUNRISE_PILLOW_VERSION_MISMATCH"):
                assets.derive(assets.ASSETS / "source.png")
        with patch.object(assets.zlib, "ZLIB_RUNTIME_VERSION", "unexpected"):
            with self.assertRaisesRegex(ValueError, "SUNRISE_ZLIB_VERSION_MISMATCH"):
                assets.derive(assets.ASSETS / "source.png")


if __name__ == "__main__":
    unittest.main(verbosity=2)
