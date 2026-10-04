#!/usr/bin/env python3
"""Derive the approved Signal / Color raster and native template assets offline."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import subprocess

import PIL
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "resources" / "brand" / "signal-color"
APPROVED_SHA256 = "60fd10f1641d1c4090ce020587998fdc07cb42152b7ef339615294b400b37d62"
PILLOW_VERSION = "12.1.1"
RSVG_VERSION = "rsvg-convert version 2.58.4"
RSVG = "/opt/homebrew/bin/rsvg-convert"
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
        raise ValueError("SIGNAL_SOURCE_TYPE_INVALID")
    return file.read_bytes()


def approved_image(source: Path) -> Image.Image:
    raw = regular_bytes(source)
    if hashlib.sha256(raw).hexdigest() != APPROVED_SHA256:
        raise ValueError("SIGNAL_SOURCE_DIGEST_MISMATCH")
    image = Image.open(io.BytesIO(raw))
    image.load()
    if image.size != (1254, 1254) or image.mode != "RGBA":
        raise ValueError("SIGNAL_SOURCE_FORMAT_INVALID")
    return image


def cleaned_reference(image: Image.Image) -> Image.Image:
    # Keep the central tile's connected >=128 alpha component, plus a one-pixel
    # antialias band. Disconnected generated specks are not part of the artwork.
    # Preserve every retained RGB/alpha value, the original canvas and framing.
    alpha = image.getchannel("A")
    component = alpha.point(lambda value: 255 if value >= 128 else 0)
    ImageDraw.floodfill(component, (627, 627), 128)
    keep = component.point(lambda value: 255 if value == 128 else 0)
    keep = keep.filter(ImageFilter.MaxFilter(3))
    cleaned = image.copy()
    cleaned.putalpha(Image.composite(alpha, Image.new("L", image.size), keep))
    return cleaned


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=9)
    return buffer.getvalue()


def icns_chunk(kind: bytes, data: bytes) -> bytes:
    return kind + struct.pack(">I", len(data) + 8) + data


def small_rgb(image: Image.Image) -> bytes:
    # Native is32/il32 use planar RGB PackBits, with alpha in s8mk/l8mk.
    # Literal runs avoid encoder ambiguity and preserve all channel bytes.
    encoded = bytearray()
    for channel in image.split()[:3]:
        raw = channel.tobytes()
        for offset in range(0, len(raw), 128):
            run = raw[offset:offset + 128]
            encoded.append(len(run) - 1)
            encoded.extend(run)
    return bytes(encoded)


def derive(source: Path) -> dict[str, bytes]:
    image = approved_image(source)  # Validate before any output writes.
    if PIL.__version__ != PILLOW_VERSION:
        raise ValueError("SIGNAL_PILLOW_VERSION_MISMATCH")
    version = subprocess.check_output([RSVG, "--version"], text=True).strip()
    if version != RSVG_VERSION:
        raise ValueError("SIGNAL_RSVG_VERSION_MISMATCH")
    cleaned = cleaned_reference(image)
    outputs = {"approved.png": regular_bytes(source)}
    # Pillow resizes RGBA using premultiplied alpha. No recolor, crop, palette
    # quantization, DEV badge or second appearance-specific artwork is applied.
    outputs["master.png"] = png_bytes(cleaned.resize((1024, 1024), Image.Resampling.LANCZOS))
    chunks = []
    for name, size, kind in ICON_SLOTS:
        raster = cleaned.resize((size, size), Image.Resampling.LANCZOS)
        data = png_bytes(raster)
        outputs[f"farol.iconset/{name}"] = data
        if kind in (b"is32", b"il32"):
            chunks.append(icns_chunk(kind, small_rgb(raster)))
            mask = b"s8mk" if size == 16 else b"l8mk"
            chunks.append(icns_chunk(mask, raster.getchannel("A").tobytes()))
        else:
            chunks.append(icns_chunk(kind, data))
    body = b"".join(chunks)
    outputs["farol.icns"] = b"icns" + struct.pack(">I", len(body) + 8) + body
    # Optical reduction of the approved round-ended open arcs and center disk.
    # Black RGB + alpha only; macOS owns appearance tint through template mode.
    vector = (ASSETS / "menu-bar-template.svg").read_bytes()
    outputs["menu-bar-template.svg"] = vector
    for scale in (1, 2):
        pixels = str(18 * scale)
        outputs[f"menu-bar-template{'@2x' if scale == 2 else ''}.png"] = subprocess.check_output(
            [RSVG, "--width", pixels, "--height", pixels], input=vector
        )
    manifest = {
        "schema": 1,
        "identity": "Signal / Color",
        "approvedSha256": APPROVED_SHA256,
        "appearance": "fixed-color",
        "derivation": {
            "pillow": PILLOW_VERSION,
            "rsvg": RSVG_VERSION,
            "alphaCleanup": "central >=128 connected component plus one-pixel band",
            "resize": "premultiplied-alpha Lanczos from cleaned 1254px reference",
            "icns": "native is32/il32 RGB+alpha; PNG Retina/large slots; big-endian lengths",
        },
        "files": {
            name: {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
            for name, raw in sorted(outputs.items())
        },
    }
    outputs["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    return outputs


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ASSETS / "approved.png")
    parser.add_argument("--output", type=Path, default=ASSETS)
    parser.add_argument("--check", action="store_true", help="Compare only; never write assets")
    args = parser.parse_args()
    outputs = derive(args.source)
    for name, raw in outputs.items():
        target = args.output / name
        if args.check:
            if regular_bytes(target) != raw:
                raise ValueError(f"SIGNAL_DERIVATION_MISMATCH:{name}")
        else:
            if any(parent.is_symlink() for parent in (target, *target.parents)):
                raise ValueError(f"SIGNAL_OUTPUT_LINK_INVALID:{name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
    print(f"Signal / Color: {'verified' if args.check else 'derived'} {len(outputs)} files")


if __name__ == "__main__":
    main()
