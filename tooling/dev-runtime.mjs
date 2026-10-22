// Dev-only macOS presentation. Never modify the authenticated npm runtime or
// the packaged/Owner Preview bundle. Call only after prepareDevBuild and build.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertEmbeddedRuntime,
  observeEmbeddedRuntime,
} from "./runtime-contract.mjs";

export const DEV_EXECUTABLE_SUFFIX =
  "/_output/dev-runtime/Farol Dev.app/Contents/MacOS/Electron";
export const VENDOR_EXECUTABLE_SUFFIX =
  "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
export const devExecutables = (root) => [
  root + DEV_EXECUTABLE_SUFFIX,
  root + VENDOR_EXECUTABLE_SUFFIX,
];

export function devInfoPlist(plist) {
  for (const [key, before, after] of [
    ["CFBundleName", "Electron", "Farol Dev"],
    ["CFBundleDisplayName", "Electron", "Farol Dev"],
    ["CFBundleIdentifier", "com.github.Electron", "local.farol.dev"],
    ["CFBundleIconFile", "electron.icns", "farol-dev.icns"],
  ]) {
    const pattern = new RegExp(
      `(<key>${key}</key>\\s*<string>)${before.replaceAll(".", "\\.")}(</string>)`,
      "gu",
    );
    if ([...plist.matchAll(pattern)].length !== 1)
      throw Error("DEV_RUNTIME_PLIST_INVALID");
    plist = plist.replace(pattern, `$1${after}$2`);
  }
  return plist;
}

export async function prepareDevRuntime(root) {
  const source = path.join(root, "node_modules/electron/dist/Electron.app");
  // Verify the copy before applying the four presentation-only plist fields.
  const parent = path.join(root, "_output/dev-runtime");
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, ".prepare-"));
  const app = path.join(staging, "Farol Dev.app");
  try {
    await fs.cp(source, app, { recursive: true, verbatimSymlinks: true });
    assertEmbeddedRuntime(await observeEmbeddedRuntime(app));
    const icon = await fs.readFile(
      path.join(root, "resources/brand/sunrise-dock/farol-sunrise-dev.icns"),
    );
    if (
      createHash("sha256").update(icon).digest("hex") !==
      "557009b055071416d90a0c79df9c813978920094b15db5fa3ed09851cfa66eef"
    )
      throw Error("DEV_RUNTIME_ICON_INVALID");
    const plist = path.join(app, "Contents/Info.plist");
    await fs.writeFile(plist, devInfoPlist(await fs.readFile(plist, "utf8")));
    await fs.writeFile(
      path.join(app, "Contents/Resources/farol-dev.icns"),
      icon,
    );
    const destination = path.join(parent, "Farol Dev.app");
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(app, destination);
    return root + DEV_EXECUTABLE_SUFFIX;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
