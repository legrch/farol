import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREVIEW_SVG_SHA256 =
  "405df2ccd0e12c306bf120cf63c8aee7f1dedc15e877d718c725b77b86a47faf";
export const PREVIEW_ASSET_NAMES = Object.freeze([
  "farol-preview-mark.svg",
  "farol-preview-mark.png",
  "farol-preview.icns",
]);
export const PREVIEW_ASSET_RECIPE = Object.freeze({
  source: "resources/brand/farol-preview-mark.svg",
  sourceSha256: PREVIEW_SVG_SHA256,
  renderer: "/opt/homebrew/bin/rsvg-convert",
  iconCompiler: "/usr/bin/iconutil",
  sizes: [16, 32, 128, 256, 512],
  scales: [1, 2],
  dockPng: "icon_512x512@2x.png",
  iconFormat: "icns",
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function previewSvg(repositoryRoot = root) {
  const source = path.join(
    repositoryRoot,
    "resources/brand/farol-preview-mark.svg",
  );
  const info = await fs.lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw new Error("OWNER_PREVIEW_SVG_INVALID");
  const bytes = await fs.readFile(source);
  if (sha256(bytes) !== PREVIEW_SVG_SHA256)
    throw new Error("OWNER_PREVIEW_SVG_DIGEST_MISMATCH");
  return bytes;
}

// Fixed local build dependencies, never runtime dependencies, downloads or
// commands/paths taken from a manifest. Native determinism still needs a Mac run.
export async function renderPreviewAssets(repositoryRoot = root) {
  const svg = await previewSvg(repositoryRoot);
  if (process.platform !== "darwin")
    throw new Error("OWNER_PREVIEW_ASSETS_REQUIRE_MAC");
  const scratch = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "farol-preview-assets-"),
  );
  await fs.chmod(scratch, 0o700);
  const environment = {
    HOME: scratch,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "en_US.UTF-8",
    TMPDIR: scratch,
  };
  const exact = (executable, args) =>
    execFileSync(executable, args, {
      env: environment,
      timeout: 30000,
      stdio: "pipe",
    });
  try {
    const source = path.join(scratch, "farol-preview-mark.svg");
    await fs.writeFile(source, svg, { flag: "wx", mode: 0o600 });
    const iconset = path.join(scratch, "Preview.iconset");
    await fs.mkdir(iconset, { mode: 0o700 });
    for (const size of PREVIEW_ASSET_RECIPE.sizes) {
      for (const scale of PREVIEW_ASSET_RECIPE.scales) {
        const pixels = String(size * scale);
        exact("/opt/homebrew/bin/rsvg-convert", [
          "--width",
          pixels,
          "--height",
          pixels,
          "--output",
          path.join(
            iconset,
            `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
          ),
          source,
        ]);
      }
    }
    const icon = path.join(scratch, "farol-preview.icns");
    exact("/usr/bin/iconutil", [
      "--convert",
      "icns",
      "--output",
      icon,
      iconset,
    ]);
    const result = {
      "farol-preview-mark.svg": svg,
      "farol-preview-mark.png": await fs.readFile(
        path.join(iconset, "icon_512x512@2x.png"),
      ),
      "farol-preview.icns": await fs.readFile(icon),
    };
    assertPreviewAssets(result);
    await fs.rm(scratch, { recursive: true });
    return result;
  } catch (error) {
    throw new Error(
      `OWNER_PREVIEW_ASSET_GENERATION_FAILED: retained ${scratch}`,
      { cause: error },
    );
  }
}

export function assertPreviewAssets(assets) {
  if (
    Object.keys(assets).sort().join("\0") !==
      [...PREVIEW_ASSET_NAMES].sort().join("\0") ||
    PREVIEW_ASSET_NAMES.some(
      (name) =>
        !Buffer.isBuffer(assets[name]) ||
        assets[name].length < 1 ||
        assets[name].length > 4 * 1024 * 1024,
    ) ||
    sha256(assets["farol-preview-mark.svg"]) !== PREVIEW_SVG_SHA256 ||
    assets["farol-preview-mark.png"].subarray(0, 8).toString("hex") !==
      "89504e470d0a1a0a" ||
    assets["farol-preview.icns"].subarray(0, 4).toString() !== "icns"
  )
    throw new Error("OWNER_PREVIEW_ASSETS_INVALID");
}

// No arbitrary output paths. A manual asset preparation is private build output.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Usage: node tooling/owner-preview-assets.mjs");
    const assets = await renderPreviewAssets();
    const destination = path.join(
      root,
      "_output/preview-assets",
      PREVIEW_SVG_SHA256,
    );
    for (const directory of [
      path.join(root, "_output"),
      path.dirname(destination),
    ]) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const info = await fs.lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
      )
        throw new Error("OWNER_PREVIEW_ASSET_DIRECTORY_INVALID");
    }
    await fs.mkdir(destination, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(assets))
      await fs.writeFile(path.join(destination, name), bytes, {
        flag: "wx",
        mode: 0o644,
      });
    process.stdout.write(`${destination}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
