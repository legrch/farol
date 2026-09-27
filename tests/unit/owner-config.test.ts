import { describe, expect, it } from "vitest";
import {
  resolveTaskModel,
  TaskExecutionSettingsSchema,
  taskPolicyIdentity,
} from "../../src/pkg/owner-config/contract";
import { taskPolicy } from "../fixtures/task-policy";

describe("neutral task harness/model settings", () => {
  it("resolves global harness, harness model and model effort defaults", () => {
    expect(resolveTaskModel(taskPolicy(), {}, ["codex"])).toEqual({
      status: "ready",
      selection: {
        harness: "codex",
        modelAlias: "luna",
        model: "gpt-6-luna",
        effort: "medium",
      },
    });
  });
  it("allows any configured model and an explicit effort override, without roles", () => {
    expect(
      resolveTaskModel(taskPolicy(), { model: "sol", effort: "xhigh" }, [
        "codex",
      ]),
    ).toMatchObject({
      status: "ready",
      selection: { modelAlias: "sol", model: "gpt-6-sol", effort: "xhigh" },
    });
    expect(
      resolveTaskModel(taskPolicy(), { model: "sol" }, ["codex"]),
    ).toMatchObject({ selection: { effort: "high" } });
  });
  it("omits effort when neither request nor model provides it", () => {
    const resolved = resolveTaskModel(taskPolicy(), { model: "simple" }, [
      "codex",
    ]);
    expect(resolved).toEqual({
      status: "ready",
      selection: {
        harness: "codex",
        modelAlias: "simple",
        model: "fixture-no-effort",
      },
    });
  });
  it("stores future harness config but never pretends its implementation exists", () => {
    const tasks = taskPolicy();
    tasks.harnesses["claude-code"] = {
      defaultModel: "sonnet",
      models: { sonnet: { model: "future-claude", defaultEffort: "high" } },
    };
    expect(TaskExecutionSettingsSchema.safeParse(tasks).success).toBe(true);
    expect(
      resolveTaskModel(tasks, { harness: "claude-code" }, ["codex"]),
    ).toEqual({ status: "harness-unsupported" });
    tasks.defaultHarness = "claude-code";
    expect(resolveTaskModel(tasks, {}, ["codex"])).toEqual({
      status: "harness-unsupported",
    });
    expect(
      resolveTaskModel(tasks, { harness: "codex" }, ["codex"]),
    ).toMatchObject({ status: "ready", selection: { harness: "codex" } });
  });
  it("fails specifically for missing config, harness and model, never falls back", () => {
    expect(resolveTaskModel(undefined, {}, ["codex"])).toEqual({
      status: "config-missing",
    });
    expect(
      resolveTaskModel(taskPolicy(), { harness: "unknown" }, ["codex"]),
    ).toEqual({ status: "harness-missing" });
    expect(
      resolveTaskModel(taskPolicy(), { model: "unknown" }, ["codex"]),
    ).toEqual({ status: "model-missing" });
    expect(resolveTaskModel(taskPolicy(), { effort: "" }, ["codex"])).toEqual({
      status: "selection-invalid",
    });
  });
  it("requires each default to point to a real configured entry", () => {
    const tasks = taskPolicy();
    tasks.harnesses.codex!.defaultModel = "absent";
    expect(TaskExecutionSettingsSchema.safeParse(tasks).success).toBe(false);
    expect(
      TaskExecutionSettingsSchema.safeParse({
        ...taskPolicy(),
        defaultHarness: "absent",
      }).success,
    ).toBe(false);
  });
  it("accepts new model generations and efforts as data, without a code catalogue", () => {
    const tasks = taskPolicy();
    tasks.harnesses.codex!.models.newone = {
      model: "arbitrary-next-model-42",
      defaultEffort: "future-effort",
    };
    expect(
      resolveTaskModel(tasks, { model: "newone" }, ["codex"]),
    ).toMatchObject({
      status: "ready",
      selection: { model: "arbitrary-next-model-42", effort: "future-effort" },
    });
  });
  it("rejects role profiles, arbitrary adapter commands and old schema fields", () => {
    expect(
      TaskExecutionSettingsSchema.safeParse({ ...taskPolicy(), profiles: {} })
        .success,
    ).toBe(false);
    const tasks = taskPolicy();
    expect(
      TaskExecutionSettingsSchema.safeParse({
        ...tasks,
        harnesses: {
          codex: { ...tasks.harnesses.codex!, adapter: "run-a-command" },
        },
      }).success,
    ).toBe(false);
  });
  it("does not resolve inherited Object.prototype entries", () => {
    expect(
      resolveTaskModel(taskPolicy(), { model: "constructor" }, ["codex"]),
    ).toEqual({ status: "model-missing" });
    expect(
      resolveTaskModel(taskPolicy(), { harness: "constructor" }, ["codex"]),
    ).toEqual({ status: "harness-missing" });
  });
  it("fingerprints policy semantically, independently of object key ordering", () => {
    const original = taskPolicy();
    const reordered = taskPolicy();
    reordered.harnesses.codex!.models = Object.fromEntries(
      Object.entries(reordered.harnesses.codex!.models).reverse(),
    );
    expect(taskPolicyIdentity(reordered)).toBe(taskPolicyIdentity(original));
    reordered.harnesses.codex!.models.luna!.model = "next-version";
    expect(taskPolicyIdentity(reordered)).not.toBe(
      taskPolicyIdentity(original),
    );
  });
});
