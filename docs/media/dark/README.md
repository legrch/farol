# Dark illustration preview

This optional series keeps the published light assets intact. The two workflow stories are new synthetic demonstrations: a typed question, a request traveling to the Mac, a selected file being read or edited, and a result returned to the conversation. The code example adds a small function through supported file editing with an existing Read & write grant. It is not an Agent-mode, autonomous-programming or live-provider acceptance claim.

The central mark is a flat monochrome reinterpretation of Farol's concentric light, drawn as vector-like geometry without a bitmap icon, blur or fading. Connector motion stays between the edges of the panels and the central node. The setup series preserves the existing steps, synthetic values and target coordinates, using a declaration-aware dark palette during HTML rendering. It is not a screenshot of every service's actual theme.

## Rebuild

Use the same dependencies as the [light workflow pipeline](../workflow/README.md). The current stack is Python 3.14.7, Poppler 26.04.0 and the existing pinned Python requirements. On macOS Pango/Fontconfig must be discoverable; the current build uses `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`.

```sh
python docs/media/dark/build.py
python docs/media/dark/build.py --light
python docs/media/dark/build-setup.py
python docs/media/dark/preview.py
python docs/media/dark/verify.py
```

`build.py` renders matched light/dark versions of the two 24-second stories from retained drawing code and the existing licensed Liberation Sans fonts. `build-setup.py` creates disposable source copies, enables `FAROL_MEDIA_THEME=dark` only for their render, then writes eight separately named dark GIFs. It does not replace light GIFs or their validation files. The normal onboarding pipeline retains its light default. `preview.py` generates the focused light comparison page from the dark README, rebasing local links; regenerate it after editing the preview README.

The verifier checks hashes, dimensions, timing, loop metadata, every decoded frame's canvas/luminance and preserved setup click bounds, plus selected text/background contrast pairs. Full visual inspection is still required: these checks are not a full accessibility audit. Contact sheets are QA evidence, not standalone page illustrations. Source fonts retain their [SIL OFL notice](../workflow/licenses/Liberation-Sans-OFL.txt). No service, account, real project or local grant is used during generation.
