#!/usr/bin/env python3
"""Derive the exact Sunrise reference into offline raster and native resources."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import zlib

import PIL
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "resources" / "brand" / "sunrise"
SOURCE_SHA256 = "d1fe70502c90b71755aefc57f99d942d1401f071784b3e49676d557c34e952ec"
SOURCE_REFERENCE = "light-palette-expanded-2026-10-04/assets/sunrise.png"
PILLOW_VERSION = "12.1.1"
ZLIB_VERSION = "1.2.12"
# Native point sizes and their 1x/2x representations, in deterministic order.
ICON_SLOTS = (
    ("icon_16x16.png", 16, b"is32"),
    ("icon_16x16@2x.png", 32, b"ic11"),
    ("icon_32x32.png", 32, b"il32"),
    ("icon_32x32@2x.png", 64, b"ic12"),
    ("icon_128x128.png", 128, b"ic07"),
    ("icon_128x128@2x.png", 256, b"ic13"),
    ("icon_256x256.png", 256, b"ic08"),
    ("icon_256x256@2x.png", 512, b"ic14"),
    ("icon_512x512.png", 512, b"ic09"),
    ("icon_512x512@2x.png", 1024, b"ic10"),
)


def regular_bytes(file: Path) -> bytes:
    if file.is_symlink() or not file.is_file():
        raise ValueError("SUNRISE_SOURCE_TYPE_INVALID")
    return file.read_bytes()


def source_image(raw: bytes) -> Image.Image:
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
        raise ValueError("SUNRISE_SOURCE_DIGEST_MISMATCH")
    image = Image.open(io.BytesIO(raw))
    image.load()
    if image.format != "PNG" or image.size != (1254, 1254) or image.mode != "RGB":
        raise ValueError("SUNRISE_SOURCE_FORMAT_INVALID")
    return image


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def icns_chunk(kind: bytes, data: bytes) -> bytes:
    return kind + struct.pack(">I", len(data) + 8) + data


def small_argb(image: Image.Image) -> bytes:
    # Small native slots use uncompressed interleaved ARGB and s8mk/l8mk masks.
    # A literal-only PackBits payload loses its final blue byte in iconutil for
    # this opaque artwork. Native ARGB avoids that decoder edge case entirely.
    raw = image.tobytes()
    encoded = bytearray(len(raw))
    encoded[0::4] = raw[3::4]
    encoded[1::4] = raw[0::4]
    encoded[2::4] = raw[1::4]
    encoded[3::4] = raw[2::4]
    return bytes(encoded)


def derive(source: Path) -> dict[str, bytes]:
    raw = regular_bytes(source)
    image = source_image(raw)  # Validate the exact input before any writes.
    if PIL.__version__ != PILLOW_VERSION:
        raise ValueError("SUNRISE_PILLOW_VERSION_MISMATCH")
    if (zlib.ZLIB_VERSION, zlib.ZLIB_RUNTIME_VERSION) != (ZLIB_VERSION, ZLIB_VERSION):
        raise ValueError("SUNRISE_ZLIB_VERSION_MISMATCH")
    outputs = {"source.png": raw}
    # Preserve the whole opaque RGB canvas. Each size comes directly from the
    # reference: no cleanup, crop, recolor, rounding, badge or alternate theme.
    chunks = []
    for name, size, kind in ICON_SLOTS:
        raster = image.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
        data = png_bytes(raster)
        outputs[f"farol.iconset/{name}"] = data
        if size == 1024:
            outputs["master.png"] = data
        if kind in (b"is32", b"il32"):
            chunks.append(icns_chunk(kind, small_argb(raster)))
            mask = b"s8mk" if size == 16 else b"l8mk"
            chunks.append(icns_chunk(mask, raster.getchannel("A").tobytes()))
        else:
            chunks.append(icns_chunk(kind, data))
    body = b"".join(chunks)
    outputs["farol.icns"] = b"icns" + struct.pack(">I", len(body) + 8) + body
    manifest = {
        "schema": 1,
        "identity": "Sunrise",
        "source": {
            "repository": "farol-design",
            "path": SOURCE_REFERENCE,
            "sha256": SOURCE_SHA256,
            "bytes": len(raw),
            "format": "PNG",
            "mode": "RGB",
            "width": 1254,
            "height": 1254,
        },
        "decision": "Owner preference recorded in CURRENT-DESIGN.md on 2026-10-06",
        "appearance": "fixed-color; same artwork for light and dark",
        "derivation": {
            "pillow": PILLOW_VERSION,
            "zlib": ZLIB_VERSION,
            "resize": "Lanczos directly from unchanged full 1254px RGB canvas",
            "alpha": "opaque RGBA conversion; no alpha cleanup or shape mask",
            "png": "compress_level=9; optimize=False; no copied source metadata",
            "icns": "native is32/il32 uncompressed ARGB+alpha masks; PNG Retina/large slots; big-endian lengths",
        },
        "evidenceScope": "Offline source derivation only; package and visible Dock acceptance pending",
        "files": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for name, data in sorted(outputs.items())
        },
    }
    outputs["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ASSETS / "source.png")
    parser.add_argument("--output", type=Path, default=ASSETS)
    parser.add_argument("--check", action="store_true", help="Compare only; never write assets")
    args = parser.parse_args()
    outputs = derive(args.source)
    # Preflight all output paths before writing even the preserved source.
    for name in outputs:
        target = args.output / name
        if any(parent.is_symlink() for parent in (target, *target.parents)):
            raise ValueError(f"SUNRISE_OUTPUT_LINK_INVALID:{name}")
        if target.exists() and not target.is_file():
            raise ValueError(f"SUNRISE_OUTPUT_TYPE_INVALID:{name}")
    for name, raw in outputs.items():
        target = args.output / name
        if args.check:
            if regular_bytes(target) != raw:
                raise ValueError(f"SUNRISE_DERIVATION_MISMATCH:{name}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    print(f"Sunrise: {'verified' if args.check else 'derived'} {len(outputs)} files")


if __name__ == "__main__":
    main()
