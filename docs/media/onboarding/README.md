# Farol onboarding animations

Eight short, light-theme tutorials with synthetic data, a moving cursor, click rings, and complete written instructions. The same light asset is intended for both GitHub page themes. These are **code-rendered UI recreations, not screen recordings or live acceptance-test evidence**.

## Build

The build is local and makes no network requests. It does not open Farol, sign in, create a key, create a tunnel, install a plugin, or send a chat message.

Requirements: Python 3.12 or newer, Poppler (`pdftoppm`), and the Pango / Fontconfig libraries required by WeasyPrint. On Debian/Ubuntu the OS packages are `poppler-utils libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b`. On macOS, install Poppler and Pango using your usual package manager.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python build.py
```

The current rebuild uses Python 3.14.7 and Poppler 26.04.0; the original reference used Python 3.12.14 and Poppler 26.05.0. The listed Python dependencies are pinned, but some transitive dependencies remain unconstrained; this is not a complete dependency lock. Pixel-level output can change with different Poppler, Pango, or Fontconfig versions. `validation.json` records the supplied GIF hashes and event timelines. `python verify.py` validates the output against that manifest, decodes every GIF frame, checks click bounds, verifies local font licenses, checks a light outer canvas and scene luminance in every frame, checks eight specified text/background contrast pairs, and scans publishable text for common credential/private-data patterns. These are scoped checks, not a general secret-scanner guarantee or full accessibility audit.

Pipeline:

1. `source/build_screens.py` generates the first scenes and shared Farol shell.
2. `source/build_remaining.py` adds external forms, connection/test scenes, and the unified light theme.
3. `source/render.py` lays out HTML/CSS with WeasyPrint, then renders the temporary PDFs with the separate Poppler CLI into 1320 × 900 PNGs.
4. `source/assemble.py` overlays the cursor and click rings, creates a global color palette per tutorial, and encodes GIFs with Pillow.

`source/assemble.py` is the scene timeline: each event gives a scene, target element ID, pause duration, and click flag. To change wording or UI states, edit the scene builders. Do not hand-edit generated HTML. Every visual input is bundled locally; no remote font, screenshot, or CDN is needed.

## Reader placement

The repository README is the complete reader journey: both workflow GIFs are visible, followed by requirements, current installation limits, all eight setup GIFs with written steps, a first-file exercise and best practices. The owner-selected presentation keeps animations inline rather than behind disclosure controls. [Focused connection reference](../../start/setup.md) repeats the setup steps with visible GIFs for readers arriving from a support link. The optional access step remains explicitly optional even though its animation is visible. Standalone PNG posters are no longer exported or committed; written steps accompany every GIF. Keep the reproduction scripts and license notices beside these media assets. The setup series is not installation acceptance evidence.

## Tutorials

| Asset                                           | Content                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `output/Farol-01-sign-in-light.gif`             | Start setup, sign in, return, verify sign-in.                                                                     |
| `output/Farol-02-workspace-light.gif`           | Add a sample folder and keep Read only.                                                                           |
| `output/Farol-02b-edits-and-commands-light.gif` | Optional Read & write and shared Commands access.                                                                 |
| `output/Farol-03-create-tunnel-light.gif`       | Name, description, organization/workspace, Create, copy ID, paste into Farol.                                     |
| `output/Farol-04-restricted-key-light.gif`      | Restricted, Tunnels Read + Use only, Save your key, Copy, Done, return.                                           |
| `output/Farol-05-connect-this-mac-light.gif`    | Paste ID and masked key, connect, wait, continue.                                                                 |
| `output/Farol-06-add-plugin-light.gif`          | Add custom MCP server, Tunnel, No authentication, risk warning, Connect, find plugin, Manage, review Permissions. |
| `output/Farol-07-test-connection-light.gif`     | Run one test, wait, return, confirm success.                                                                      |

The published tutorials are GIF-only, with complete written steps in the reader guides. Decorative top-left branding is omitted so that the instructions and demonstrated UI remain the focus. Source images, licensed fonts and verification data remain rebuild inputs; rendered scene PNGs are temporary build intermediates.

## Accuracy and intentionally omitted details

- Farol labels and behavior were checked against its source. New workspaces use `access: "read"`; Read & write is an explicit optional change. Commands access is shared by approved workspaces, not a separate sandbox per folder.
- The OpenAI Platform Tunnels form and restricted-key permission selector, and ChatGPT's Plugins / Add custom MCP server form, were inspected on 6 November 2026. No form was submitted during verification.
- A restricted key selects **Read and Use** under **Tunnels**, with unrelated permissions at None. “All selected” is the selector's label for those two Tunnels choices, not full-key permissions.
- **Project and expiration choices are deliberately omitted.** Their menus were not verified. The animation pauses to tell the viewer to choose both according to their account/organization policy. Bracketed project/expiration values in the next scene are instructional placeholders, not actual menu choices.
- Supplied reference captures from October 2026 were checked for all 42 frames. They establish that the tunnel ID is copied from its row in the Tunnels list, a workspace may display as an ID, and the key result uses Save your key, Copy, and Done. These layouts were rebuilt from code with synthetic values, not copied as images.
- Paste the tunnel ID into Farol before copying the key, so the second Copy action does not erase the only copy of the ID. Then return to paste the key into its masked field.
- The reference used a full-access API key and Allow all tools in ChatGPT. Neither is reproduced. This guide uses Restricted → Tunnels Read + Use, and leaves the demonstrated default Allow low-risk tools unchanged. The optional permission review displays all four choices, including Allow all tools with its Elevated risk warning, without selecting it. Wait for Farol to show Connected before creating the ChatGPT plugin.
- Sign-in provider screens, the macOS folder picker, the restricted-key result’s permission wording, the simulated connection progress and test progress are illustrative. No post-creation result was live-tested. The current flow uses Add custom MCP server → Create as a plugin → Connect. Ten current post-creation reference captures establish the connection dialog and Manage → Permission → Permissions screens.
- The external form layout is a compact recreation. Account-specific labels, available organizations, workspaces, connection prompts, and service UI may vary. In current ChatGPT the authentication option is “No authentication”; Farol's own explanatory UI may say “None” or “No additional sign-in.”
- The setup starts from an already running Farol installation with an existing ChatGPT account. This is not an installer or eligibility guide. Existing product beta and availability restrictions still apply.
- Final successful states are simulated for the tutorial. The files are not proof that a live end-to-end setup succeeded.

## Privacy and licensing

Only synthetic values appear: `demo@example.com`, `/Users/demo/Documents/Farol Demo`, “Demo organization”, a synthetic all-zero-style workspace UUID, an all-zero-style demo tunnel ID, and `DEMO_KEY_NOT_VALID`. No real credentials, IDs, account names, chat contents, source screenshots, browser metadata, or upload receipts are included.

The two bundled fonts are unmodified Liberation Sans files under SIL OFL 1.1. Their full notice is in `licenses/Liberation-Sans-OFL.txt`. No proprietary font files are included. The Farol icon and adapted Farol shell/setup CSS originate from the same Farol project; this package does not declare a new overall license for Farol or change its ownership. See `THIRD_PARTY_NOTICES.md` for build-tool dependencies.

Earlier preview packages are not the publication source. Use this package, which replaces their font assets and includes the complete light series.

## Repository integration

This package lives in `docs/media/onboarding/` alongside the separate story illustrations in `docs/media/dark/`. Keep `source/`, `licenses/`, build/verification scripts, requirements, notices, output GIF/PNG files, and validation files. The generated `captures/` and HTML/CSS intermediates do not need to be committed. The `.gitignore` lists them.

Keep the README and guide language aligned with the current Read only default. Do not replace unrelated README content, change runtime behavior, create releases, or imply that live acceptance tests passed. No publication or push is performed by the build scripts.
