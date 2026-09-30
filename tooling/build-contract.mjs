import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const BUILD_ENTRIES = Object.freeze([
  "Geist-OFL.txt",
  "Geist-Variable.woff2",
  "GeistMono-Variable.woff2",
  "build-identity.json",
  "computer-mcp.cjs",
  "computer-safe-open.py",
  "input-manifest.json",
  "main.cjs",
  "preload.cjs",
  "resource-manifest.json",
  "runtime.cjs",
  "shell.css",
  "shell.html",
  "shell.js",
  "update-archive.py",
  "update-helper.py",
  "update-obligations.mjs",
  "update-package.mjs",
  "update-slot.mjs",
]);

const CAPABILITY_BOUNDARY_ENTRIES = Object.freeze([
  "computer-mcp.cjs",
  "main.cjs",
  "preload.cjs",
  "runtime.cjs",
  "shell.js",
]);
const FORBIDDEN_INTEGRATION_TOKENS = Object.freeze([
  "setLoginItemSettings",
  "setAsDefaultProtocolClient",
  "autoUpdater",
  "registerSchemesAsPrivileged",
  "codex-chatgpt-web",
  "synthetic://workspace/status",
]);

async function digestFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`BUILD_ENTRY_TYPE_INVALID:${path.basename(file)}`);
  }
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

export async function snapshotBuildEntries(root) {
  return Object.fromEntries(
    await Promise.all(
      BUILD_ENTRIES.map(async (entry) => [
        entry,
        await digestFile(path.join(root, entry)),
      ]),
    ),
  );
}

export async function verifyBuildEntries(root, expected) {
  if (
    expected === null ||
    typeof expected !== "object" ||
    Array.isArray(expected)
  ) {
    throw new Error("BUILD_ENTRY_SET_INVALID");
  }
  const keys = Object.keys(expected).sort();
  if (
    keys.length !== BUILD_ENTRIES.length ||
    !keys.every((entry, index) => entry === [...BUILD_ENTRIES].sort()[index])
  ) {
    throw new Error("BUILD_ENTRY_SET_INVALID");
  }
  for (const entry of BUILD_ENTRIES) {
    const claimed = expected[entry];
    if (!/^[a-f0-9]{64}$/u.test(claimed ?? "")) {
      throw new Error(`BUILD_ENTRY_DIGEST_INVALID:${entry}`);
    }
    if ((await digestFile(path.join(root, entry))) !== claimed) {
      throw new Error(`BUILD_ENTRY_DIGEST_MISMATCH:${entry}`);
    }
  }
}

export async function verifyAbsentIntegrations(root) {
  for (const entry of CAPABILITY_BOUNDARY_ENTRIES) {
    const source = await fs.readFile(path.join(root, entry), "utf8");
    for (const token of FORBIDDEN_INTEGRATION_TOKENS) {
      if (source.includes(token)) {
        throw new Error(`BUILD_FORBIDDEN_INTEGRATION:${entry}:${token}`);
      }
    }
  }
}

// The build ledger of every source and dependency input, retained as the exact
// bytes whose SHA-256 the build manifest records as inputLedgerSha256.  A
// label that nothing can recompute is not evidence of which inputs were built.
export async function verifyInputManifest(directory, manifest) {
  let bytes;
  try {
    bytes = await fs.readFile(path.join(directory, "input-manifest.json"));
  } catch {
    throw new Error("BUILD_INPUT_MANIFEST_MISSING");
  }
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    manifest.inputLedgerSha256
  ) {
    throw new Error("BUILD_INPUT_MANIFEST_DIGEST_MISMATCH");
  }
  let ledger;
  try {
    ledger = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("BUILD_INPUT_MANIFEST_INVALID");
  }
  if (!Array.isArray(ledger)) throw new Error("BUILD_INPUT_MANIFEST_INVALID");
  let sources = 0;
  let dependencies = 0;
  let previous = null;
  for (const entry of ledger) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") ||
      (previous !== null && entry.path <= previous)
    ) {
      throw new Error("BUILD_INPUT_MANIFEST_INVALID");
    }
    previous = entry.path;
    if (entry.kind === "source") {
      sources += 1;
      if (manifest.inputExact === true && entry.exact !== true) {
        throw new Error("BUILD_INPUT_MANIFEST_NOT_EXACT");
      }
    } else if (entry.kind === "dependency") {
      dependencies += 1;
    } else {
      throw new Error("BUILD_INPUT_MANIFEST_INVALID");
    }
  }
  if (
    sources !== manifest.sourceInputCount ||
    dependencies !== manifest.dependencyInputCount
  ) {
    throw new Error("BUILD_INPUT_MANIFEST_COUNT_MISMATCH");
  }
  return ledger;
}
