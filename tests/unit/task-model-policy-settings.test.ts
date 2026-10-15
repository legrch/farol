import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import type { TaskModelPolicyResolver } from "../../apps/desktop/bridge/task-model-policy";
import { fixtureTaskModelPolicy, taskPolicy } from "../fixtures/task-policy";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

async function fixture(resolve?: TaskModelPolicyResolver) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-task-model-settings-"),
  );
  roots.push(root);
  const store = new ProductSettingsStore({ root: path.join(root, "state") });
  const owner = new ProductConfigurationService(
    store,
    resolve ? { taskModelPolicy: resolve } : {},
  );
  await owner.initialize();
  const initial = owner.snapshot();
  if (initial.status !== "ready")
    throw new Error("settings fixture unavailable");
  await store.save({
    ...initial.settings,
    tasks: taskPolicy(),
    revision: initial.settings.revision + 1,
  });
  await owner.initialize();
  return { owner, store };
}

describe("selected Task policy settings boundary", () => {
  it("refuses valid config when the Go policy port is absent", async () => {
    const { owner, store } = await fixture();
    const save = vi.spyOn(store, "save");
    await expect(owner.resolveTaskModel({ harness: "codex" })).resolves.toEqual(
      { status: "unavailable" },
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the original Go loss unavailable and never retries or writes", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("original reply lost");
    });
    const { owner, store } = await fixture(resolve);
    const save = vi.spyOn(store, "save");
    await expect(owner.resolveTaskModel({})).resolves.toEqual({
      status: "unavailable",
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("captures requests before joining the queue and excludes settings writes during Go resolution", async () => {
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve = vi.fn<TaskModelPolicyResolver>(
      async (revision, config, request) => {
        enter();
        await wait;
        return fixtureTaskModelPolicy(revision, config, request);
      },
    );
    const { owner, store } = await fixture(resolve);
    const save = vi.spyOn(store, "save");
    const before = owner.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    const requested = { effort: "high" };
    const selection = owner.resolveTaskModel(requested);
    requested.effort = "low";
    await entered;
    const write = owner.updateGeneral({
      ...before.settings.general,
      openAtLaunch: "settings",
    });
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    release();
    await expect(selection).resolves.toMatchObject({
      status: "ready",
      selection: { effort: "high" },
    });
    expect((await write).ok).toBe(true);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      before.settings.revision,
      before.settings.tasks,
      { effort: "high" },
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it("rejects an old Go reply after settings are reloaded at a newer revision", async () => {
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve: TaskModelPolicyResolver = async (...args) => {
      enter();
      await wait;
      return fixtureTaskModelPolicy(...args);
    };
    const { owner, store } = await fixture(resolve);
    const before = owner.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    const selection = owner.resolveTaskModel({});
    await entered;
    await store.save({
      ...before.settings,
      revision: before.settings.revision + 1,
    });
    await owner.initialize();
    release();
    await expect(selection).resolves.toEqual({ status: "unavailable" });
  });
});
