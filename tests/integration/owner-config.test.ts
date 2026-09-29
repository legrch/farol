import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config";
import { taskPolicy } from "../fixtures/task-policy";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-config-section-"),
  );
  roots.push(root);
  const store = new ProductSettingsStore({ root });
  const service = new ProductConfigurationService(store);
  await service.initialize();
  const snapshot = service.snapshot();
  if (snapshot.status !== "ready")
    throw new Error("fixture initialization failed");
  return { root, store, settings: snapshot.settings };
}

describe("one existing JSON configuration container", () => {
  it("round-trips tasks.harnesses in the existing store without a models file", async () => {
    const { root, store, settings } = await fixture();
    await store.save({ ...settings, tasks: taskPolicy() });
    expect(resolveOwnerTaskModel((await store.load())!)).toMatchObject({
      status: "ready",
      selection: {
        harness: "codex",
        modelAlias: "luna",
        model: "gpt-6-luna",
        effort: "medium",
      },
    });
    expect((await fs.readdir(root)).sort()).toEqual(["config.json"]);
  });
  it("a new settings load applies a model/effort edit without rebuilding", async () => {
    const { store, settings } = await fixture();
    await store.save({ ...settings, tasks: taskPolicy() });
    const before = resolveOwnerTaskModel((await store.load())!);
    const next = taskPolicy();
    next.harnesses.codex!.models.luna = {
      model: "next-model-from-config",
      defaultEffort: "high",
    };
    await store.save({ ...settings, tasks: next });
    const after = resolveOwnerTaskModel((await store.load())!);
    expect(before).toMatchObject({
      status: "ready",
      selection: { model: "gpt-6-luna" },
    });
    expect(after).toMatchObject({
      status: "ready",
      selection: { model: "next-model-from-config", effort: "high" },
    });
    if (before.status !== "ready" || after.status !== "ready")
      throw new Error("resolution failed");
    expect(after.configSha256).not.toBe(before.configSha256);
  });
  it("bad task policy disables task selection, not independent Computer settings", async () => {
    const { store, settings } = await fixture();
    await store.save({
      ...settings,
      tasks: { defaultHarness: "missing", harnesses: {} },
    });
    const loaded = await store.load();
    expect(loaded?.computer).toEqual(settings.computer);
    expect(resolveOwnerTaskModel(loaded!)).toEqual({
      status: "config-invalid",
    });
  });
  it("has no baked-in model or fallback profile", () => {
    expect(resolveOwnerTaskModel({})).toEqual({ status: "config-missing" });
    expect(
      resolveOwnerTaskModel({ tasks: taskPolicy() }, { model: "other" }),
    ).toEqual({ status: "model-missing" });
  });
  it("keeps policy identity stable when unrelated runtime settings change", async () => {
    const { settings } = await fixture();
    const before = { ...settings, tasks: taskPolicy() };
    const after = { ...before, revision: before.revision + 1 };
    expect(resolveOwnerTaskModel(before)).toEqual(resolveOwnerTaskModel(after));
  });
  it("keeps future harness configuration as data, without creating a transport", async () => {
    const { store, settings } = await fixture();
    const tasks = taskPolicy();
    tasks.harnesses["claude-code"] = {
      defaultModel: "opus",
      models: { opus: { model: "fixture-opus" } },
    };
    tasks.defaultHarness = "claude-code";
    await store.save({ ...settings, tasks });
    const loaded = (await store.load())!;
    expect(resolveOwnerTaskModel(loaded)).toEqual({
      status: "harness-unsupported",
    });
    expect(resolveOwnerTaskModel(loaded, { harness: "codex" })).toMatchObject({
      status: "ready",
    });
    expect(loaded.computer).toEqual(settings.computer);
  });
});
