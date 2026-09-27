import { createHash } from "node:crypto";

import {
  resolveTaskModel,
  taskPolicyIdentity,
  TaskExecutionSettingsSchema,
  type ResolvedTaskModel,
  type TaskExecutionSettings,
  type TaskModelResolution,
  type TaskSelectionRequest,
} from "../../pkg/owner-config/contract";

// This registry describes implemented transports, never permitted model names.
export const IMPLEMENTED_TASK_HARNESSES = Object.freeze(["codex"]);

export type ResolvedOwnerTaskModel =
  | Readonly<{
      status: "ready";
      configSha256: string;
      selection: ResolvedTaskModel;
      tasks: TaskExecutionSettings;
    }>
  | Exclude<TaskModelResolution, { status: "ready" }>;

/** Resolve one snapshot of the tasks section in the existing settings container. */
export function resolveOwnerTaskModel(
  settings: Readonly<{ tasks?: unknown }>,
  requested: TaskSelectionRequest = {},
): ResolvedOwnerTaskModel {
  const resolved = resolveTaskModel(
    settings.tasks,
    requested,
    IMPLEMENTED_TASK_HARNESSES,
  );
  if (resolved.status !== "ready") return resolved;
  const tasks = TaskExecutionSettingsSchema.parse(settings.tasks);
  return Object.freeze({
    status: "ready",
    selection: resolved.selection,
    tasks,
    configSha256: createHash("sha256")
      .update(taskPolicyIdentity(tasks), "utf8")
      .digest("hex"),
  });
}
