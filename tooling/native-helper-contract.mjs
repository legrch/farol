import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const NATIVE_SAFE_OPEN_HELPER = Object.freeze({
  source: "resources/native/safe_open.py",
  output: "computer-safe-open.py",
  sha256: "cfcef3833c7f0400940c7876935275d1c5cd1866631570bed9ca77e4ffd9256c",
  size: 65_251,
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
