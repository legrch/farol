# Signal / Color native icon assets

Asset filenames in this record refer to [resources/brand/signal-color/](../../../resources/brand/signal-color/). The original asset and license files remain there; this move changes only the documentation location.

The owner selected this fixed Color identity on 2026-10-02. The approval is
`icon-study-2026-10-02/APPROVAL.md` in the design handoff. This self-contained
source set requires no sibling checkout to regenerate. `approved.png` is the
unchanged approved 1254 x 1254 RGBA reference, SHA-256
`60fd10f1641d1c4090ce020587998fdc07cb42152b7ef339615294b400b37d62`.

## Derivation

`master.png` is a 1024px raster master. The generator retains the central
connected alpha component at threshold 128 and its one-pixel antialias band;
it removes 6,397 stray alpha pixels outside that component. Retained RGB and
alpha values, the original canvas, framing, white arcs and coral disk remain
unchanged. The cleaned reference has alpha bounds `(77, 84, 1177, 1171)`.
Each output is resized directly from that cleaned 1254px reference using
premultiplied-alpha Lanczos, avoiding repeated downsampling and recoloring.
This is a faithful raster derivation; it is not a vector reconstruction.

`farol.iconset/` contains native point sizes 16, 32, 128, 256 and 512, each at
1x and 2x, covering 16/32/64/128/256/512/1024 physical pixels. `farol.icns`
contains those ten representations. Small 16/32px 1x entries use native
`is32`/`il32` planar RGB with `s8mk`/`l8mk` alpha masks. Retina and large
representations use PNG payloads. Deterministic big-endian ICNS lengths
preserve the exact payloads. macOS `iconutil` decode is verified pixel-for-pixel
for all ten representations, including transparent pixels. Successful decode
alone would miss the small-slot PNG incompatibility this test protects.

`menu-bar-template.svg` is an optical reduction of the approved minimal mark:
two mirrored round-ended open arcs plus a center disk. Geometry on the 18pt
grid uses arc radius 6.2, stroke 2.4 and disk radius 2.16. The transparent
18/36px PNGs contain black RGB only. They are template images, not Color app
icon variants. Use `setTemplateImage(true)` so macOS owns tinting for its menu
bar appearance. No theme or accent-dependent Dock substitution is needed.

`manifest.json` records every source/output SHA-256, size and derivation tool
version. Generator-only requirements are Python 3, Pillow 12.1.1 and
`/opt/homebrew/bin/rsvg-convert` 2.58.4 (the existing renderer). Committed
production bytes require no Python or renderer at build/runtime. A substituted
or symlinked approved source fails before any output is written.

```sh
python3 -B scripts/make-signal-color-assets.py
python3 -B scripts/make-signal-color-assets.py --check
python3 -B scripts/test-signal-color-assets.py
```

The generator and its six tests are offline. The tests verify provenance,
byte-for-byte regeneration, color/alpha preservation, all native slot formats,
native pixel decode, template gaps and rejected source substitution/symlinks.

## Desktop source integration

The Desktop branch now maps the approved raster master and ICNS through
`tooling/brand-contract.mjs` into the existing `farol-mark.png` and `farol.icns`
output names. `tooling/build.mjs` verifies explicit source paths before copying;
built-output verification still uses the output names. Exact input ledger,
regular-file/no-symlink checks and digest checks remain fail closed. Only the
approved ICNS entry has `maxBytes: 1137653`; every other bound is unchanged.

The existing package mapping places the built ICNS in `Contents/Resources`,
using the existing `CFBundleIconFile`. Bundle identity, browser partition,
update channel and state roots are unchanged. The schema-6 output entry closure
is preserved: the monochrome 18/36px template bytes are embedded in
`src/apps/desktop/menu-bar-assets.ts`, with byte-equality coverage against the
committed PNGs, rather than adding package entries. The host builds the native
Tray template at 18pt with both scale representations and enables native tint.
Both Preview and Dev Dock paths use the fixed Color master. Appearance changes
never recolor or substitute it.

Historical top-level lamp assets and their generator remain tracked for their
remaining consumers and compatibility inventory. They are not the approved
Dock/ICNS source mapping for this renderer. Retire historical consumers only
with replacement coverage; a generator rerun must not alter the Signal Color
mapping or its approved digest.

## Evidence limits

Source assets, regeneration and native ICNS decode are offline evidence.
The production source mapping and native menu-bar implementation are committed
on Desktop; Lead has not integrated this branch into main or installed it.
Exact package qualification, historical predecessor/rollback compatibility,
Dock/Finder/app-switcher rendering and visible Tray tint/point sizing remain
pending. Hidden fixture tests suppress Tray creation and cannot prove its
visible appearance. No installation, activation, release or provider call is
claimed. The raster master preserves the approved pre-rounded tile; no Icon
Composer layered/full-bleed asset is claimed. Keep this writer's original
artifact branch until Lead accepts integration.
