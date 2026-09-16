import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GEIST_RESOURCES,
  GEIST_VERSION,
  verifyGeistBuild,
  verifyGeistSources,
} from "../../tooling/font-contract.mjs";

const vnextRoot = path.resolve(import.meta.dirname, "../..");

describe("Geist distribution contract", () => {
  it("pins the selected font bytes and SIL OFL license", async () => {
    expect(GEIST_VERSION).toBe("1.7.2");
    await expect(verifyGeistSources(vnextRoot)).resolves.toBeUndefined();
    expect(GEIST_RESOURCES.map((resource) => resource.output)).toEqual([
      "Geist-Variable.woff2",
      "GeistMono-Variable.woff2",
      "Geist-OFL.txt",
    ]);
  });

  it("rejects changed packaged font bytes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-geist-contract-"),
    );
    try {
      await Promise.all(
        GEIST_RESOURCES.map((resource) =>
          fs.copyFile(
            path.join(vnextRoot, resource.source),
            path.join(root, resource.output),
          ),
        ),
      );
      await fs.appendFile(path.join(root, "Geist-Variable.woff2"), "changed");
      await expect(verifyGeistBuild(root)).rejects.toThrow(
        "GEIST_BUILD_DIGEST_MISMATCH:Geist-Variable.woff2",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
