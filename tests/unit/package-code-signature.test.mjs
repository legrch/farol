import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPackagedExecutableSignature } from "../../tooling/package-code-signature.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin")(
  "native executable signature",
  () => {
    it("accepts an intact system signature and refuses changed executable bytes", async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-codesign-test-"),
      );
      roots.push(root);
      const executable = path.join(root, "executable");
      await fs.copyFile("/usr/bin/true", executable);
      expect(() => verifyPackagedExecutableSignature(executable)).not.toThrow();
      const bytes = await fs.readFile(executable);
      bytes[4096] ^= 1;
      await fs.writeFile(executable, bytes);
      expect(() => verifyPackagedExecutableSignature(executable)).toThrow(
        "PACKAGE_EXECUTABLE_SIGNATURE_INVALID",
      );
    });
  },
);
