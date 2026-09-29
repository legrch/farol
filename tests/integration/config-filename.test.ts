import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const userData = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-config-name-"),
  );
  roots.push(userData);
  const root = path.join(userData, "farol-next-state");
  const store = new ProductSettingsStore({ root });
  const service = new ProductConfigurationService(store);
  await service.initialize();
  const file = path.join(root, "config.json");
  const legacy = path.join(root, "product-settings.json");
  return { root, userData, store, service, file, legacy };
}
it("uses one config.json in the existing isolated state root", async () => {
  const f = await fixture();
  expect(await fs.readdir(f.root)).toEqual(["config.json"]);
  expect(f.service.snapshot().status).toBe("ready");
  expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
});
it("does not reset an older config or reinterpret it as a fresh installation", async () => {
  const f = await fixture();
  const before = await fs.readFile(f.file);
  await fs.rename(f.file, f.legacy);
  const next = new ProductConfigurationService(f.store);
  await next.initialize();
  expect(next.snapshot()).toEqual({
    status: "error",
    error: "CONFIG_RENAME_REQUIRED",
  });
  expect(await fs.readdir(f.root)).toEqual(["product-settings.json"]);
  expect(await fs.readFile(f.legacy)).toEqual(before);
  // The owner performs the explicit same-directory rename while previews are closed.
  await fs.rename(f.legacy, f.file);
  const reopened = new ProductConfigurationService(f.store);
  await reopened.initialize();
  expect(reopened.snapshot()).toEqual(f.service.snapshot());
  expect(await fs.readFile(f.file)).toEqual(before);
});
it("refuses two competing filenames without merging or overwriting either", async () => {
  const f = await fixture();
  const before = await fs.readFile(f.file);
  await fs.writeFile(f.legacy, "older configuration", { mode: 0o600 });
  await expect(f.store.load()).rejects.toThrow("CONFIG_RENAME_REQUIRED");
  const snapshot = f.service.snapshot();
  if (snapshot.status !== "ready") throw new Error("fixture");
  await expect(f.store.save(snapshot.settings)).rejects.toThrow(
    "CONFIG_RENAME_REQUIRED",
  );
  expect(await fs.readFile(f.file)).toEqual(before);
  expect(await fs.readFile(f.legacy, "utf8")).toBe("older configuration");
});
