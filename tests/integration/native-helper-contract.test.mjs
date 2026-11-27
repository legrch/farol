import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  NATIVE_SAFE_OPEN_HELPER,
  verifyNativeHelper,
  verifyPackagedNativeHelper,
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

  // The bundled update verifier of an installed release judges the NEXT
  // release's helper. It must follow the package's own manifest digest, never
  // a compiled-in constant (the 0.5.29 -> 0.5.30 refusal).
  describe("packaged helper verification", () => {
    const digestOf = (bytes) =>
      createHash("sha256").update(bytes).digest("hex");
    const write = async (bytes, mode = 0o644) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-packaged-helper-"),
      );
      temporary.push(directory);
      const file = path.join(directory, "computer-safe-open.py");
      await fs.writeFile(file, bytes);
      await fs.chmod(file, mode);
      return { directory, file };
    };

    it("accepts helper bytes that differ from this build's pin when the manifest digest matches", async () => {
      const bytes = Buffer.from("# a later release's helper\n");
      expect(digestOf(bytes)).not.toBe(NATIVE_SAFE_OPEN_HELPER.sha256);
      const { file } = await write(bytes);
      await expect(
        verifyPackagedNativeHelper(file, digestOf(bytes)),
      ).resolves.toBeUndefined();
    });

    it("refuses bytes that do not match the manifest digest", async () => {
      const { file } = await write(Buffer.from("changed\n"));
      await expect(
        verifyPackagedNativeHelper(file, digestOf(Buffer.from("claimed\n"))),
      ).rejects.toThrow("NATIVE_HELPER_IDENTITY_INVALID");
    });

    it.each([undefined, null, "", "abc", "A".repeat(64), 7])(
      "refuses a missing or malformed manifest digest %j",
      async (claimed) => {
        const { file } = await write(Buffer.from("x\n"));
        await expect(verifyPackagedNativeHelper(file, claimed)).rejects.toThrow(
          "NATIVE_HELPER_MANIFEST_DIGEST_INVALID",
        );
      },
    );

    it("keeps the regular-file and mode checks", async () => {
      const bytes = Buffer.from("x\n");
      const writable = await write(bytes, 0o666);
      await expect(
        verifyPackagedNativeHelper(writable.file, digestOf(bytes)),
      ).rejects.toThrow("NATIVE_HELPER_MODE_INVALID");
      const linked = await write(bytes);
      const link = path.join(linked.directory, "link.py");
      await fs.symlink(linked.file, link);
      await expect(
        verifyPackagedNativeHelper(link, digestOf(bytes)),
      ).rejects.toThrow("NATIVE_HELPER_MODE_INVALID");
      await expect(
        verifyPackagedNativeHelper(linked.directory, digestOf(bytes)),
      ).rejects.toThrow("NATIVE_HELPER_MODE_INVALID");
    });

    it("is what the bundled package verifier uses, not the pinned constant", async () => {
      const content = await fs.readFile(
        path.join(root, "tooling/verify-package-content.mjs"),
        "utf8",
      );
      expect(content).toContain("verifyPackagedNativeHelper(");
      expect(content).toContain("embedded.entrySha256[");
      expect(content).not.toMatch(/\bverifyNativeHelper\b/u);
      expect(content).not.toMatch(/assertNativeHelperBytes/u);
    });
  });
});
