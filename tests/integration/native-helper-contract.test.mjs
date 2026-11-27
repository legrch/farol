import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_SAFE_OPEN_HELPER,
  verifyNativeHelper,
} from "../../tooling/native-helper-contract.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const source = path.join(root, NATIVE_SAFE_OPEN_HELPER.source);
const temporary = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((target) => fs.rm(target, { recursive: true, force: true })),
  );
});

// The v0.5.29 pin, written out here on purpose rather than read from the
// contract: the installed 0.5.29 verifier compares the helper of every update
// package with exactly these values, so changing them (or the helper) makes
// 0.5.29 refuse the update with NATIVE_HELPER_IDENTITY_INVALID.
const FROZEN_0_5_29 = Object.freeze({
  sha256: "b4b5adc34fea7ee7caa9f5e0400a5f862e61a5d2db8f7b86f381fd1f850e580a",
  size: 133092,
});

describe("native helper contract", () => {
  it("keeps the helper frozen at its v0.5.29 bytes", async () => {
    const bytes = await fs.readFile(source);
    expect(bytes.length).toBe(FROZEN_0_5_29.size);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      FROZEN_0_5_29.sha256,
    );
    expect(NATIVE_SAFE_OPEN_HELPER.sha256).toBe(FROZEN_0_5_29.sha256);
    expect(NATIVE_SAFE_OPEN_HELPER.size).toBe(FROZEN_0_5_29.size);
  });

  it("binds the reviewed source bytes and non-writable mode", async () => {
    await expect(verifyNativeHelper(source)).resolves.toBeUndefined();
  });

  it("rejects changed bytes and writable helper modes", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-native-helper-"),
    );
    temporary.push(directory);
    const changed = path.join(directory, "changed.py");
    await fs.copyFile(source, changed);
    await fs.appendFile(changed, "# changed\n");
    await fs.chmod(changed, 0o644);
    await expect(verifyNativeHelper(changed)).rejects.toThrow(
      "NATIVE_HELPER_IDENTITY_INVALID",
    );

    const writable = path.join(directory, "writable.py");
    await fs.copyFile(source, writable);
    await fs.chmod(writable, 0o666);
    await expect(verifyNativeHelper(writable)).rejects.toThrow(
      "NATIVE_HELPER_MODE_INVALID",
    );
  });
});
