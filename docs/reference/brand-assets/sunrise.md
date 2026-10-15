# Sunrise source resources

Asset filenames in this record refer to [resources/brand/sunrise/](../../../resources/brand/sunrise/). The original asset and license files remain there; this move changes only the documentation location.

This is the current Sunrise artwork referenced by `farol-design/README.md` and
`CURRENT-DESIGN.md`, with the owner preference recorded on 2026-10-06. It does
not rewrite the historical Signal / Color approval. Home remains a separate
proposal under review. Package and visible Dock acceptance are pending.

`source.png` is a byte-for-byte copy of
`farol-design/light-palette-expanded-2026-10-04/assets/sunrise.png`:

- SHA-256: `d1fe70502c90b71755aefc57f99d942d1401f071784b3e49676d557c34e952ec`
- 1,125,137 bytes; PNG; RGB; 1254 x 1254; opaque full canvas.

The same fixed-color artwork serves light and dark appearances. The generator
does not clean alpha, remove background, crop, recolor, add rounded corners,
add a badge, reconstruct vectors or generate artwork. Every output size comes
directly from the unchanged source with Lanczos resizing, then converts to
opaque RGBA. Source metadata stays in the exact source copy; derived PNGs have
no copied source metadata.

`master.png` is 1024 x 1024 and equals the largest iconset representation.
`farol.iconset/` provides native point sizes 16, 32, 128, 256 and 512 at 1x/2x.
`farol.icns` wraps ten representations with deterministic big-endian lengths.
Small `is32`/`il32` slots use uncompressed interleaved ARGB with `s8mk`/`l8mk`
alpha masks; other slots use the exact PNG bytes. This retains the historical
generator's slot layout and container encoder without importing its source or
artwork. Literal-only planar PackBits lost the last blue byte in macOS's decoder
for this opaque reference, so these new small slots use native ARGB instead.
All ten slots are verified against the PNGs by offline macOS `iconutil` decode.

`manifest.json` records reference provenance, source and derived file hashes,
byte sizes, tool versions and the scope of evidence. The source is read and
hashed once before decoding, and rejected before any output writes when its
digest or file type differs. Output symlinks are rejected in a full preflight.

## Offline regeneration

The default source is local to this directory; no design checkout is needed.
Generation uses the existing Python 3, Pillow 12.1.1 and zlib 1.2.12. Toolchain
mismatches fail closed. Committed resource consumers need no Python dependency.

```sh
python3 -B scripts/make-sunrise-assets.py
python3 -B scripts/make-sunrise-assets.py --check
python3 -B scripts/test-sunrise-assets.py
```

The six tests cover exact source digest/provenance, byte reproducibility,
PNG dimensions/modes and full-canvas colors, independent ICNS structure/payload
checks, offline macOS decode, altered/symlinked inputs, output links and toolchain
mismatch. The macOS decode test is explicitly skipped on other platforms.

## Current source integration

`tooling/brand-contract.mjs` maps this exact master to `farol-mark.png` and
`farol-dev-mark.png`, and this ICNS to `farol.icns`. The source paths, hashes and
single larger ICNS bound are:

```js
{
  output: "farol-mark.png",
  source: "sunrise/master.png",
  sha256: "d97ba675a63d121ba0f8b6b9f4b7f3511f2a3b697b9ee623551baae80162ea1d",
},
{
  output: "farol.icns",
  source: "sunrise/farol.icns",
  maxBytes: 1413163,
  sha256: "58a47e3db012eeec25f4cf3569c396a73c2b91c6e0347e99aa94c00f264aed5f",
},
```

The inspected desktop main loads `farol-mark.png` into the Dock, so this mapping
supplies Sunrise without changing that call. Keep the existing output names
and source-path/digest/file-type checks. Both inputs must be in the exact
committed candidate so `readBuildInput` records their real source identities in
the input ledger. The Dev raster output uses this same master and hash; the
application's existing Dev name and profile separation remain unchanged.

Lead owns integration review, aggregate checks, packaging and native acceptance.
No menu-bar redesign, application/Electron/browser execution, provider call,
package build, installation, publication or visible Dock verification was done
for this bounded offline resource preparation.
