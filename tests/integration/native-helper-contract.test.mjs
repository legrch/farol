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

describe("native helper contract", () => {
  it("binds the reviewed source bytes and non-writable mode", async () => {
    await expect(verifyNativeHelper(source)).resolves.toBeUndefined();
  });

  it("rejects changed bytes and writable helper modes", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-native-helper-"),
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
