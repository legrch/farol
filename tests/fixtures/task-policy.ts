import { createHash } from "node:crypto";
import {
  taskPolicyIdentity,
  type TaskExecutionSettings,
} from "../../src/pkg/owner-config/contract";
import { resolveOwnerTaskModel } from "../../src/apps/desktop/owner-config";
import type { TaskModelPolicyResolver } from "../../apps/desktop/bridge/task-model-policy";

// Synthetic policy port for existing settings tests. Real Go/TS parity and
// inherited-pipe dispatch are tested separately; this is never a host fallback.
export const fixtureTaskModelPolicy: TaskModelPolicyResolver = async (
  _revision,
  config,
  selection,
) => {
  const result = resolveOwnerTaskModel({ tasks: config }, selection);
  return result.status === "ready"
    ? {
        status: "ready",
        selection: result.selection,
        configSha256: result.configSha256,
      }
    : result;
};

/** Synthetic model names; these do not assert any live account capability. */
export function taskPolicy(): TaskExecutionSettings {
  return {
    defaultHarness: "codex",
    harnesses: {
      codex: {
        defaultModel: "luna",
        models: {
          luna: { model: "gpt-6-luna", defaultEffort: "medium" },
          sol: { model: "gpt-6-sol", defaultEffort: "high" },
          simple: { model: "fixture-no-effort" },
        },
      },
    },
  };
}

export function taskGrantPolicy(tasks = taskPolicy()) {
  return {
    harness: "codex" as const,
    tasks,
    configSha256: createHash("sha256")
      .update(taskPolicyIdentity(tasks), "utf8")
      .digest("hex"),
  };
}
