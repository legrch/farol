# Farol illustrations

Every GIF on the home page is drawn from source in `stories/`. Everything is synthetic: no account, tunnel, real project, local grant or service is used during generation. The illustrations are UI recreations, not screen recordings, live acceptance or fresh-install evidence. Service screens are recreations and can differ from the current services.

`stories/scene.html` draws the three stories (ask, change code, install) for a given time `t`. `stories/flows.js` holds the setup flows, whose page structure follows the storyboard made from the real screens: Farol's rail, OpenAI's settings navigation, ChatGPT's Customize and Settings pages and modals over the page, in our palette (`guide.css`). `stories/guide.js` plays them: one stable window with no camera movement, a cursor gliding to the target, an outline on the target, and the instruction under the window. `stories/render.mjs` captures every frame with headless Chromium and encodes GIFs with ffmpeg, 1600 pixels wide at 25 fps, in both palettes.

| Output                                                       | Shows                                                                                                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Farol-ask-your-files-*.gif`                                 | A typed question, the request reaching the Mac, files being read in a Read only folder, an answer with its sources.                    |
| `Farol-change-your-code-*.gif`                               | A typed request, the code being read, new code in a file, a new test file, a summary. Assumes Read & write; shows no program executed. |
| `Farol-install-*.gif`                                        | The install command with its real output lines, the icon bouncing in the Dock, and the app opening on Setup.                           |
| `Farol-01-sign-in-*.gif` to `Farol-07-test-connection-*.gif` | The setup steps, including the optional `02b` edits and commands.                                                                      |
| `Farol-08-change-access-*.gif`                               | Narrowing a folder to Read only and removing it.                                                                                       |
| `Farol-09-updates-*.gif`                                     | Checking for, downloading and installing an update.                                                                                    |

The central mark is a flat monochrome reinterpretation of Farol's concentric light, drawn as SVG without a bitmap, blur or opacity. Only the Dock in the install story uses the real app icon. Fonts are Geist and Geist Mono from `design-lab/fonts/geist/` ([SIL OFL](../../../design-lab/fonts/geist/OFL.txt)).

## Rebuild

You need the repository's Node dependencies, ffmpeg, Chromium (`FAROL_CHROMIUM` overrides discovery) and Python with Pillow for the verifier.

```sh
node docs/media/dark/stories/render.mjs
python docs/media/dark/preview.py
python docs/media/dark/verify.py
```

Pass `--theme=dark|light` or `--scene=NAME` to `render.mjs` to rebuild part of a set, and `--sheet=DIR` to save frames for inspection outside the repository. PNG frames are never committed.

`preview.py` generates the light comparison page from the root README; rerun it after editing the README. `verify.py` checks hashes, dimensions, timing, loop metadata, every decoded frame's canvas and luminance, and selected text/background contrast pairs. It is not a full accessibility audit, so inspect the decoded GIFs too.
