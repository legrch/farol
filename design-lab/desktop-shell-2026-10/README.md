# Farol desktop shell — approved design handoff

Owner decision: **UI approved; Dock icon pending** on 2026-10-02, Europe/Lisbon.
This is a nonshipping design reference. It is ready for implementation planning;
visual approval does not mean these interactions are integrated into Farol.

## Start here

Open `start.html` in a browser. All prototype code, fonts, images and screenshots
are bundled locally; viewing the package requires no build, server or account.

- [Interactive UI](index.html?revision=4) — current revision 4, synthetic fixtures.
- [Review gallery](gallery.html) — matched light/dark screens and state examples.
- [Implementation handoff](HANDOFF.md) — scope, source gaps and acceptance checklist.
- [Detailed interaction contract](design-notes.md) — behavior and implementation limits.
- [Acceptance decision](DECISIONS.md) — approved surfaces and rejected icon materials.
- [Menu-bar study](menu-bar.html?mark=lens) — accepted minimal interaction direction.
- [Rejected Dock studies](brand.html) — retained only as comparison history.

`design-lab/desktop-shell-2026-10/` is the intended repository location. It is
preserved on the local `desktop-shell-design-handoff` branch. The self-contained
copy beside the repository is an export, not an independent implementation.
Neither copy imports production modules or connects to a real ChatGPT session.

## What to implement

One desktop composition: a narrow icon rail, a contextual sidebar and a single
upper toolbar. Home is first, Settings uses a gear at the bottom. Back/Forward,
sidebar visibility, the active leaf title and page search belong to that toolbar.
Light, Graphite and System use the same geometry. Iris is the default accent;
Cobalt and Amber remain user choices. Geist and the native system font remain
appearance choices. Settings, Home, task slots, Activity and update interaction
follow the revision-4 contract.

The five numbered ChatGPT slots contain the actual existing embedded pages.
Friendly task names and fixture history are examples. Farol must not redraw the
ChatGPT conversation or claim an archived conversation exists after slot reuse.

## Dock icon is not approved

The owner rejected Iris Glass, Prism and Aurora Enamel as too glossy, glamorous,
plastic or glass-like. **Do not ship any of these three images.** Signal Lens is
only a preferred abstract direction for a separate icon iteration: simpler,
interesting and colorful, without this material treatment. Keep the existing
production icon until a replacement is separately approved. This does not block
implementation of the approved interface.

## Package map

| File or directory                                                       | Role                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `start.html`                                                            | Stable entry point for review and handoff                                            |
| `index.html`, `app.js`, `styles.css`, `update-ui.js`                    | Current interactive DOM reference                                                    |
| `DECISIONS.md`, `HANDOFF.md`, `design-notes.md`                         | Decision, implementation order and behavior                                          |
| `gallery.html`, `screenshots-v4/`                                       | Current review surfaces and preserved visual evidence                                |
| `menu-bar.*`, `mark-library.js`                                         | Menu-bar/emblem reference; native integration still required                         |
| `brand.*`, `assets/dock-v4/`                                            | Rejected Dock studies, visibly marked as such                                        |
| `v1.html`, `gallery-v1.html`, `v2/`, `v3/`, earlier screenshots/reports | Historical proposals, not competing current contracts                                |
| `verify.mjs`                                                            | Portable rerun of the current 19 prototype checks                                    |
| `verification/original/`                                                | Original inspection scripts, retained as provenance; not a portable test entry point |
| `assets/PROVENANCE.md`, `assets/OFL.txt`                                | Bundled font provenance and license                                                  |
| `MANIFEST.sha256`                                                       | Relative file paths and SHA-256 hashes for archive verification                      |

## Verification and limitations

The original revision-4 reports document 19 DOM checks and six focused follow-up
checks, with 24 preserved current screenshots. They cover a local prototype,
not native update installation, provider cancellation, actual file grants or
production persistence. See `inspection-v4*.json` for their original evidence.
The packaging pass separately reruns the 19 checks and verifies local links and
assets without overwriting these historical reports or screenshots.

To rerun from a Farol checkout with dependencies already installed:

```sh
CHROMIUM_EXECUTABLE=/path/to/chromium node design-lab/desktop-shell-2026-10/verify.mjs
```

For a standalone export, also set `FAROL_PROJECT_ROOT=/path/to/farol` so the
runner can resolve the checkout's `playwright-core`. On macOS the runner defaults
to the standard Google Chrome executable. It uses a fresh headless browser
context, blocks external requests and creates only a synthetic temporary folder.
Generated evidence goes to the checkout's ignored `_output/design-handoff/`.

Double-clicking `start.html` is sufficient for visual review. Browser-origin
storage is preview-only; moving between file and loopback origins can change the
remembered demo preferences. No production setting is modified.
