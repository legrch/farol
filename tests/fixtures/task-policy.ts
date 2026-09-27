import { createHash } from "node:crypto";
import {
  taskPolicyIdentity,
  type TaskExecutionSettings,
} from "../../src/pkg/owner-config/contract";

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
