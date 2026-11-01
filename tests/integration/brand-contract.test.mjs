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
    await verifyBrandAssets(source, { source: true });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-brand-test-"));
    try {
      for (const resource of BRAND_RESOURCES)
        await fs.copyFile(
          path.join(source, resource.source ?? resource.output),
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
    expect(packageLayout(7)).toEqual({
      appName: "Farol.app",
      displayName: "Farol",
      branded: true,
      core: true,
    });
    for (const schema of [undefined, 4, 8, "6", "7", true])
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

it("embeds exact approved native template pixels without expanding the package closure", async () => {
  const source = await fs.readFile(
    "src/apps/desktop/menu-bar-assets.ts",
    "utf8",
  );
  for (const scale of [1, 2]) {
    const match = source.match(
      new RegExp(`menuBarTemplate${scale}x\\s*=\\s*"([A-Za-z0-9+/=]+)"`),
    );
    expect(match).not.toBeNull();
    expect(Buffer.from(match[1], "base64")).toEqual(
      await fs.readFile(
        `resources/brand/signal-color/menu-bar-template${scale === 2 ? "@2x" : ""}.png`,
      ),
    );
  }
  for (const state of ["Hollow", "Attention"]) {
    for (const scale of [1, 2]) {
      const match = source.match(
        new RegExp(
          `menuBar${state}Template${scale}x\\s*=\\s*"([A-Za-z0-9+/=]+)"`,
        ),
      );
      expect(match).not.toBeNull();
      const image = Buffer.from(match[1], "base64");
      expect(image).toEqual(
        await fs.readFile(
          `resources/brand/signal-color/menu-bar-${state.toLowerCase()}-template${scale === 2 ? "@2x" : ""}.png`,
        ),
      );
      expect(image.readUInt32BE(16)).toBe(18 * scale);
      expect(image.readUInt32BE(20)).toBe(18 * scale);
    }
  }
  expect(BRAND_RESOURCES.map((resource) => resource.output)).toEqual([
    "farol-mark.svg",
    "farol-dev-mark.svg",
    "farol-mark.png",
    "farol-dev-mark.png",
    "farol.icns",
  ]);

  const standard = BRAND_RESOURCES.find(
    (resource) => resource.output === "farol-mark.png",
  );
  const development = BRAND_RESOURCES.find(
    (resource) => resource.output === "farol-dev-mark.png",
  );
  const bundle = BRAND_RESOURCES.find(
    (resource) => resource.output === "farol.icns",
  );
  expect(standard?.source).toBe("sunrise-dock/farol-sunrise.png");
  expect(development?.source).toBe("sunrise-dock/farol-sunrise-dev.png");
  expect(development?.sha256).not.toBe(standard?.sha256);
  expect(bundle?.source).toBe("sunrise-dock/farol-sunrise.icns");

  const desktop = await fs.readFile("src/apps/desktop/main.ts", "utf8");
  expect(desktop).toContain('activeDesktopIdentity.environment === "dev"');
  expect(desktop).toContain('"farol-dev-mark.png"');
  expect(desktop).toContain('"farol-mark.png"');
});
