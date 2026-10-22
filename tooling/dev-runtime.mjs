// Dev-only macOS presentation. Never modify the authenticated npm runtime or
// the packaged/Owner Preview bundle. Call only after prepareDevBuild and build.
import fs from "node:fs/promises";
import { desktopIdentity } from "./harness-identity.ts";

import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { treeDigest } from "./artifact-digest.mjs";
import {
  assertEmbeddedRuntime,
  observeEmbeddedRuntime,
} from "./runtime-contract.mjs";

const devIdentity = desktopIdentity("dev", "/");
const devBundleName = `${devIdentity.applicationName}.app`;

export const DEV_EXECUTABLE_SUFFIX = `/_output/dev-runtime/${devBundleName}/Contents/MacOS/Electron`;
export const VENDOR_EXECUTABLE_SUFFIX =
  "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
export const devExecutables = (root) => [
  root + DEV_EXECUTABLE_SUFFIX,
  root + VENDOR_EXECUTABLE_SUFFIX,
];

export function devInfoPlist(plist) {
  for (const [key, before, after] of [
    ["CFBundleName", "Electron", devIdentity.applicationName],
    ["CFBundleDisplayName", "Electron", devIdentity.applicationName],
    ["CFBundleIdentifier", "com.github.Electron", devIdentity.applicationId],
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

export class DevRuntimeSignatureError extends Error {}

function codesign(args, action) {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new DevRuntimeSignatureError(
      `${devIdentity.applicationName} ${action} failed. No launch was attempted.`,
    );
  return result.stderr;
}

function verifyDevSignature(app) {
  codesign(["--verify", "--deep", "--strict", app], "signature verification");
  const details = codesign(
    ["--display", "--verbose=4", app],
    "signature inspection",
  );
  if (
    !new RegExp(
      `^Identifier=${RegExp.escape(devIdentity.applicationId)}$`,
      "mu",
    ).test(details)
  )
    throw new DevRuntimeSignatureError(
      `${devIdentity.applicationName} signature identifier is invalid. No launch was attempted.`,
    );
}

export async function prepareDevRuntime(root) {
  const source = path.join(root, "node_modules/electron/dist/Electron.app");
  const observed = await observeEmbeddedRuntime(source);
  assertEmbeddedRuntime(observed);
  const icon = await fs.readFile(
    path.join(root, "resources/brand/sunrise-dock/farol-sunrise-dev.icns"),
  );
  if (
    createHash("sha256").update(icon).digest("hex") !==
    "557009b055071416d90a0c79df9c813978920094b15db5fa3ed09851cfa66eef"
  )
    throw Error("DEV_RUNTIME_ICON_INVALID");
  const presentation = devInfoPlist(
    await fs.readFile(path.join(source, "Contents/Info.plist"), "utf8"),
  );
  const inputs = createHash("sha256")
    .update("farol-dev-signed-runtime/1\0")
    .update(observed.extractedTreeDigest)
    .update(presentation)
    .update(icon)
    .digest("hex");
  const parent = path.join(root, "_output/dev-runtime");
  const destination = path.join(parent, devBundleName);
  const receiptPath = path.join(parent, "signed-runtime.json");
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (receipt?.inputs === inputs) {
    if ((await treeDigest(destination)) !== receipt.output)
      throw new DevRuntimeSignatureError(
        `${devIdentity.applicationName} bundle changed. No launch was attempted.`,
      );
    verifyDevSignature(destination);
    return root + DEV_EXECUTABLE_SUFFIX;
  }
  // Verify the copy before applying the four presentation-only plist fields.
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, ".prepare-"));
  const app = path.join(staging, devBundleName);
  try {
    await fs.cp(source, app, { recursive: true, verbatimSymlinks: true });
    assertEmbeddedRuntime(await observeEmbeddedRuntime(app));
    const plist = path.join(app, "Contents/Info.plist");
    await fs.writeFile(plist, devInfoPlist(await fs.readFile(plist, "utf8")));
    await fs.writeFile(
      path.join(app, "Contents/Resources/farol-dev.icns"),
      icon,
    );
    codesign(
      ["--force", "--deep", "--sign", "-", "--timestamp=none", app],
      "signing",
    );
    verifyDevSignature(app);
    const output = await treeDigest(app);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(app, destination);
    await fs.writeFile(receiptPath, JSON.stringify({ inputs, output }));
    return root + DEV_EXECUTABLE_SUFFIX;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
