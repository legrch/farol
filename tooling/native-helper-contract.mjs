import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// FROZEN COMPATIBILITY ARTIFACT. The bytes of resources/native/safe_open.py
// (shipped as computer-safe-open.py) must stay identical to v0.5.29 for as long
// as updating from 0.5.29 is supported: the installed 0.5.29 verifies every
// downloaded package with its own bundled update-package.mjs, which hard-pins
// this digest, and refuses any package whose helper differs
// (NATIVE_HELPER_IDENTITY_INVALID, surfaced as UPDATE_PACKAGE_MISMATCH).
// A future Go replacement must still ship this exact file. Do not edit
// safe_open.py, not even a comment: the header of that file is part of the pin.
// tests/integration/native-helper-contract.test.mjs fails when the file drifts.
export const NATIVE_SAFE_OPEN_HELPER = Object.freeze({
  source: "resources/native/safe_open.py",
  output: "computer-safe-open.py",
  sha256: "b4b5adc34fea7ee7caa9f5e0400a5f862e61a5d2db8f7b86f381fd1f850e580a",
  size: 133092,
  mode: 0o644,
});

export function assertNativeHelperBytes(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== NATIVE_SAFE_OPEN_HELPER.size ||
    createHash("sha256").update(bytes).digest("hex") !==
      NATIVE_SAFE_OPEN_HELPER.sha256
  ) {
    throw new Error("NATIVE_HELPER_IDENTITY_INVALID");
  }
}

export async function verifyNativeHelper(file) {
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== NATIVE_SAFE_OPEN_HELPER.mode
  ) {
    throw new Error("NATIVE_HELPER_MODE_INVALID");
  }
  assertNativeHelperBytes(await fs.readFile(file));
}
