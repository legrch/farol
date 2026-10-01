import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRAND_RESOURCES,
  verifyBrandAssets,
} from "../../tooling/brand-contract.mjs";
import { packageLayout } from "../../tooling/package-layout.mjs";
import {
  BUILD_ENTRIES,
  LEGACY_BUILD_ENTRIES,
  snapshotBuildEntries,
  verifyBuildEntries,
} from "../../tooling/build-contract.mjs";

describe("owned product branding and immutable legacy packages", () => {
  it("verifies real source-local assets and refuses substituted or linked marks", async () => {
    const source = path.resolve("resources/brand");
    await verifyBrandAssets(source);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-brand-test-"));
    try {
      for (const resource of BRAND_RESOURCES)
        await fs.copyFile(
          path.join(source, resource.output),
          path.join(root, resource.output),
        );
      await verifyBrandAssets(root);
      await fs.appendFile(
        path.join(root, "farol-mark.svg"),
        "<!-- altered -->",
      );
      await expect(verifyBrandAssets(root)).rejects.toThrow(
        "BRAND_RESOURCE_DIGEST_MISMATCH:farol-mark.svg",
      );
      await fs.rm(path.join(root, "farol-mark.svg"));
      await fs.symlink(
        path.join(source, "farol-mark.svg"),
        path.join(root, "farol-mark.svg"),
      );
      await expect(verifyBrandAssets(root)).rejects.toThrow(
        "BRAND_RESOURCE_TYPE_INVALID:farol-mark.svg",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps exact old and branded layouts distinct and rejects undeclared schemas", () => {
    expect(packageLayout(5)).toEqual({
      appName: "Farol Next Preview.app",
      displayName: "Farol Next Preview",
      branded: false,
    });
    expect(packageLayout(6)).toEqual({
      appName: "Farol.app",
      displayName: "Farol",
      branded: true,
    });
    for (const schema of [undefined, 4, 7, "6", true])
      expect(() => packageLayout(schema)).toThrow(
        "PACKAGE_MANIFEST_SCHEMA_INVALID",
      );
  });

  it("preserves the old build entry closure without accepting missing new assets", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-brand-entries-"),
    );
    try {
      for (const entry of BUILD_ENTRIES)
        await fs.writeFile(path.join(root, entry), entry);
      const full = await snapshotBuildEntries(root);
      const legacy = Object.fromEntries(
        LEGACY_BUILD_ENTRIES.map((entry) => [entry, full[entry]]),
      );
      await verifyBuildEntries(root, legacy, LEGACY_BUILD_ENTRIES);
      await verifyBuildEntries(root, full);
      await expect(verifyBuildEntries(root, legacy)).rejects.toThrow(
        "BUILD_ENTRY_SET_INVALID",
      );
      await expect(
        verifyBuildEntries(root, full, LEGACY_BUILD_ENTRIES),
      ).rejects.toThrow("BUILD_ENTRY_SET_INVALID");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
