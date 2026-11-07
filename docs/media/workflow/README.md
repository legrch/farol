# Farol workflow animations

Two short light-theme diagrams explain the product before the detailed onboarding guide. They use the same HTML/CSS → WeasyPrint → Poppler → Pillow stack, Liberation Sans fonts, Farol icon and light palette as the onboarding animations. The diagrams are schematic illustrations with synthetic files, requests and outcomes, not screen recordings or live acceptance evidence.

## Assets

- `output/Farol-how-it-works-light.gif`: a read-only request travels from ChatGPT through OpenAI Tunnel to Farol, which reads the selected workspace; the results return to ChatGPT.
- `output/Farol-read-and-edit-light.gif`: a specific typo correction is made in a workspace that already has Read & write access; the result returns to ChatGPT.
- GIFs are the published illustrations. The build does not export standalone PNG posters. Source-scene and decoded-frame PNG contact sheets remain visual QA evidence; regenerate and inspect both after animation changes.

Both GIFs are 1320 × 740, loop every 15 seconds, and have identical first and final frames. Motion is rendered at 20 fps, with identical frames coalesced into longer reading pauses. The same light GIF is suitable on either GitHub page theme. The owner-selected README presentation embeds both GIFs directly, with no disclosure step. The original icon and fonts remain rebuild inputs.

Read-only access prevents edits; it does not prevent requested file contents from being returned to ChatGPT. The edit illustration does not grant access or depict a universal confirmation policy. Action confirmations continue to depend on the user's ChatGPT settings and applicable rules.

## Rebuild

Use Python 3.12 or newer and install Poppler (`pdftoppm`) plus Pango and Fontconfig. The current rebuild uses Python 3.14.7 and Poppler 26.04.0; the original reference used Poppler 26.05.0. Python packages are listed in `requirements.txt`.

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python build.py
```

The build itself makes no network or service calls. It never opens Farol, reads a real workspace, signs in, changes permissions, generates credentials or sends a chat message.

Edit `source/build_scenes.py` for the story and text, `source/workflow.css` for layout and colors, and `source/assemble.py` for timing and moving request/result dots. The render and GIF assembly are deterministic for a fixed rendering stack; system font/rasterizer differences may change output pixels.

`python verify.py` checks the GIF hashes, decodes every frame, verifies size, duration, light theme, loop endpoints, and the one-page/no-page-overflow HTML layout checks. It is an artifact check, not a runtime test or full accessibility/security audit. Visual inspection of the final decoded GIF scenes remains required.

## Sources and licensing

The story preserves the original Farol read-only and read-and-edit overview illustrations. This version is rendered from new HTML/CSS using the onboarding pipeline rather than recoloring their image pixels. The Farol icon comes from the same project and its ownership is unchanged.

The bundled Liberation Sans font files are unmodified and covered by `licenses/Liberation-Sans-OFL.txt`. Build tools remain external dependencies, not vendored executable code. No real account, credential, conversation, path or file content is included.
