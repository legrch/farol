# Farol illustrations

The README stories and the setup series are built from source in this directory. Everything is synthetic: no account, tunnel, real project, local grant or service is used during generation. The illustrations are not screen recordings, live acceptance or fresh-install evidence.

## Stories

`stories/scene.html` draws three deterministic scenes for a given time `t`, and `stories/render.mjs` captures every frame with headless Chromium and encodes GIFs with ffmpeg at 1600 × 1000, 25 fps, in both palettes.

| Output                                    | Shows                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Farol-ask-your-files-{dark,light}.gif`   | A typed question, the request reaching the Mac, files being read in a Read only folder, an answer with its sources.                                                                  |
| `Farol-change-your-code-{dark,light}.gif` | A typed request, the code being read, new code added to a file, a new test file, a summary to review. It assumes an existing Read & write grant and shows no program being executed. |
| `Farol-install-{dark,light}.gif`          | The install command in Terminal with its real output lines, the icon bouncing in the Dock, and the app opening on Setup.                                                             |

The central mark is a flat monochrome reinterpretation of Farol's concentric light, drawn as SVG without a bitmap, blur or opacity. Only the Dock in the install story uses the real app icon. Fonts are Geist and Geist Mono from `design-lab/fonts/geist/` ([SIL OFL](../../../design-lab/fonts/geist/OFL.txt)).

## Setup series

`build-setup.py` copies the [onboarding package](../onboarding/README.md) to a disposable directory, enables `FAROL_MEDIA_THEME=dark` through `palette.py`, and writes eight dark GIFs with the same steps, values and click targets. The light GIFs stay in `../onboarding/output/`.

## Rebuild

Stories need the repository's Node dependencies, ffmpeg and a Chromium build (`FAROL_CHROMIUM` overrides discovery). The setup series and verifier need Python with `requirements.txt` and Poppler/Pango; on macOS set `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`.

```sh
node docs/media/dark/stories/render.mjs
python docs/media/dark/build-setup.py
python docs/media/dark/preview.py
python docs/media/dark/verify.py
```

Pass `--theme=dark|light` or `--scene=read|edit|install` to `render.mjs` to rebuild part of a set, and `--sheet=DIR` to save frames for inspection outside the repository. PNG frames are never committed.

`preview.py` generates the light comparison page from the root README; rerun it after editing the README. `verify.py` checks hashes, dimensions, timing, loop metadata, every decoded frame's canvas and luminance, preserved setup click bounds, and selected text/background contrast pairs. It is not a full accessibility audit, so inspect the decoded GIFs too.
