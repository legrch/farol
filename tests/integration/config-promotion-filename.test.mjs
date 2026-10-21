import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { activationObligations } from "../../tooling/promotion-obligations.mjs";

it("promotion cannot ignore an older filename and its pending obligations", async () => {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-config-promotion-"),
  );
  try {
    const root = path.join(userData, "farol-state");
    await new ProductConfigurationService(
      new ProductSettingsStore({ root }),
    ).initialize();
    await fs.rename(
      path.join(root, "config.json"),
      path.join(root, "product-settings.json"),
    );
    const result = await activationObligations(userData);
    expect(JSON.stringify(result)).toContain(
      "legacy-config:CONFIG_RENAME_REQUIRED",
    );
    expect(await fs.readdir(root)).toEqual(["product-settings.json"]);
  } finally {
    await fs.rm(userData, { recursive: true, force: true });
  }
});
