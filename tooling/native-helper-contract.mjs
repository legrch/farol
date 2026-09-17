import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export const NATIVE_SAFE_OPEN_HELPER = Object.freeze({
  source: "resources/native/safe_open.py",
  output: "computer-safe-open.py",
  sha256: "606321ba1be02457bbed5c9aa8e7538b979dfe6577fcf5416814294ed6764b4a",
  size: 63_949,
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
