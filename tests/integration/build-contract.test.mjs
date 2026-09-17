import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_ENTRIES,
  snapshotBuildEntries,
  verifyAbsentIntegrations,
  verifyBuildEntries,
} from "../../tooling/build-contract.mjs";

describe("build entry contract", () => {
  it("rejects a build entry changed after its manifest was created", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-build-contract-"),
    );
    try {
      await Promise.all(
        BUILD_ENTRIES.map((entry) =>
          fs.writeFile(path.join(root, entry), `original:${entry}\n`),
        ),
      );
      const snapshot = await snapshotBuildEntries(root);
      await fs.appendFile(path.join(root, "shell.html"), "tampered\n");

      await expect(verifyBuildEntries(root, snapshot)).rejects.toThrow(
        "BUILD_ENTRY_DIGEST_MISMATCH:shell.html",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, additional, and path-shaped manifest entries", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-build-contract-shape-"),
    );
    try {
      await Promise.all(
        BUILD_ENTRIES.map((entry) =>
          fs.writeFile(path.join(root, entry), entry),
        ),
      );
      const snapshot = await snapshotBuildEntries(root);
      await expect(
        verifyBuildEntries(root, { ...snapshot, "../outside": "0".repeat(64) }),
      ).rejects.toThrow("BUILD_ENTRY_SET_INVALID");
      const { [BUILD_ENTRIES[0]]: _removed, ...missing } = snapshot;
      await expect(verifyBuildEntries(root, missing)).rejects.toThrow(
        "BUILD_ENTRY_SET_INVALID",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "setLoginItemSettings",
    "setAsDefaultProtocolClient",
    "autoUpdater",
    "registerSchemesAsPrivileged",
    "codex-chatgpt-web",
    "synthetic://workspace/status",
  ])("rejects the forbidden built capability token %s", async (token) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-absence-contract-"),
    );
    try {
      await Promise.all(
        [
          "computer-mcp.cjs",
          "main.cjs",
          "preload.cjs",
          "runtime.cjs",
          "shell.js",
        ].map((entry) =>
          fs.writeFile(path.join(root, entry), `safe:${entry}\n`),
        ),
      );
      await fs.appendFile(path.join(root, "main.cjs"), `${token}\n`);
      await expect(verifyAbsentIntegrations(root)).rejects.toThrow(
        "BUILD_FORBIDDEN_INTEGRATION",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
