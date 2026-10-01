#!/usr/bin/env python3
"""Render Farol's owned artboard and the separate Dev badge.

The production ICNS is imported unchanged. This generator reads only this
repository; it never accesses a legacy checkout or application profile.
"""

from copy import deepcopy
from pathlib import Path
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent / "resources" / "brand"
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)


def drawing(board: str, pixels: int, dev: bool) -> bytes:
    source = ET.parse(ROOT / "farol-source.svg").getroot()
    definitions = source.find(f"{{{NS}}}defs")
    selected = next((item for item in source if item.get("id") == board), None)
    if definitions is None or selected is None:
        raise RuntimeError("BRAND_ARTBOARD_MISSING")
    document = ET.Element(f"{{{NS}}}svg", {
        "width": str(pixels), "height": str(pixels), "viewBox": "0 0 1024 1024",
    })
    document.append(deepcopy(definitions))
    for item in selected:
        document.append(deepcopy(item))
    if dev:
        ET.SubElement(document, f"{{{NS}}}rect", {
            "x": "214", "y": "760", "width": "596", "height": "204",
            "rx": "48", "fill": "#f2c66d", "stroke": "#102032", "stroke-width": "16",
        })
        label = ET.SubElement(document, f"{{{NS}}}text", {
            "x": "512", "y": "908", "text-anchor": "middle", "fill": "#102032",
            "font-family": "Helvetica, Arial, sans-serif", "font-weight": "bold", "font-size": "166",
        })
        label.text = "DEV"
    rendered = ET.tostring(document, encoding="utf-8", xml_declaration=True)
    return b"\n".join(line.rstrip() for line in rendered.split(b"\n"))


def png(svg: Path, output: Path) -> None:
    # ImageIO on macOS 27 refused this valid SVG with decoder error 13.
    # The existing local librsvg renderer handles it; no install or UI launch.
    subprocess.run(["/opt/homebrew/bin/rsvg-convert", "--output", str(output), str(svg)],
                   check=True)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="farol-brand-") as temporary:
        scratch = Path(temporary)
        for dev, stem in ((False, "farol-mark"), (True, "farol-dev-mark")):
            vector = ROOT / f"{stem}.svg"
            vector.write_bytes(drawing("artboard-app", 1024, dev))
            png(vector, scratch / f"{stem}.png")
            (ROOT / f"{stem}.png").write_bytes((scratch / f"{stem}.png").read_bytes())


if __name__ == "__main__":
    main()
