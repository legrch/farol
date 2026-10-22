import { createHash } from "node:crypto";
import fs from "node:fs/promises";

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
