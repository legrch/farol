// Renders the synthetic story scenes to GIFs. No account, service or real file is used.
// Usage: node docs/media/dark/stories/render.mjs [--theme=dark|light] [--scene=read|edit|install] [--sheet=DIR]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const here = import.meta.dirname;
const output = path.resolve(here, "../output");
const arg = (name) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.split("=")[1];
const themes = arg("theme") ? [arg("theme")] : ["dark", "light"];
const only = arg("scene");
const sheetDir = arg("sheet");
const FPS = 25;
const WIDTH = 1600;
const HEIGHT = 1000;
const NAMES = {
  read: "Farol-ask-your-files",
  edit: "Farol-change-your-code",
  install: "Farol-install",
};

function browserPath() {
  if (process.env.FAROL_CHROMIUM) return process.env.FAROL_CHROMIUM;
  const declared = chromium.executablePath();
  if (fs.existsSync(declared)) return declared;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const found = fs
    .readdirSync(cache)
    .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
    .sort()
    .reverse()
    .map((name) =>
      path.join(cache, name, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    )
    .find((file) => fs.existsSync(file));
  if (!found) throw new Error("No Chromium found. Set FAROL_CHROMIUM.");
  return found;
}

const browser = await chromium.launch({ executablePath: browserPath() });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "farol-stories-"));
try {
  for (const theme of themes) {
    const entries = [];
    const page = await browser.newPage({
      viewport: { width: WIDTH / 2, height: HEIGHT / 2 },
      deviceScaleFactor: 2,
    });
    await page.goto(
      `${pathToFileURL(path.join(here, "scene.html")).href}?theme=${theme}`,
    );
    await page.evaluate(async () => {
      await Promise.all(
        ["400 13px Geist", "600 13px Geist", "700 13px Geist", "400 11px GeistMono", "600 11px GeistMono"].map((font) =>
          document.fonts.load(font),
        ),
      );
      await document.fonts.ready;
      if (document.fonts.check("13px Geist") !== true) throw new Error("Geist did not load");
    });
    const seconds = await page.evaluate(() => window.scenes);
    for (const [scene, length] of Object.entries(seconds)) {
      if (only && only !== scene) continue;
      const directory = path.join(scratch, `${theme}-${scene}`);
      fs.mkdirSync(directory);
      const frames = Math.round(length * FPS);
      for (let index = 0; index < frames; index += 1) {
        await page.evaluate(([name, t]) => window.draw(name, t), [scene, index / FPS]);
        if (index === 0) await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: path.join(directory, `${String(index).padStart(5, "0")}.png`),
        });
      }
      const file = path.join(output, `${NAMES[scene]}-${theme}.gif`);
      const encoded = spawnSync(
        "ffmpeg",
        [
          "-y", "-loglevel", "error",
          "-framerate", String(FPS),
          "-i", path.join(directory, "%05d.png"),
          "-filter_complex",
          "[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
          "-loop", "0",
          file,
        ],
        { stdio: "inherit" },
      );
      if (encoded.status !== 0) throw new Error(`ffmpeg failed for ${file}`);
      if (sheetDir) {
        fs.mkdirSync(sheetDir, { recursive: true });
        const step = Math.floor(frames / 6);
        for (let shot = 0; shot < 6; shot += 1) {
          fs.copyFileSync(
            path.join(directory, `${String(shot * step + step - 1).padStart(5, "0")}.png`),
            path.join(sheetDir, `${scene}-${theme}-${shot}.png`),
          );
        }
      }
      fs.rmSync(directory, { recursive: true });
      const bytes = fs.readFileSync(file);
      entries.push({
        file: path.basename(file),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        dimensions: [WIDTH, HEIGHT],
        duration_ms: frames * 40,
        frames,
        illustrative: true,
      });
      console.log(path.basename(file), (bytes.length / 1048576).toFixed(2), "MiB");
    }
    await page.close();
    if (!only) {
      fs.writeFileSync(
        path.resolve(here, `../${theme === "dark" ? "validation" : "light-validation"}.json`),
        `${JSON.stringify({ theme, artifacts: entries }, null, 2)}\n`,
      );
    }
  }
} finally {
  await browser.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
