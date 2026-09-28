import type { CodexTaskRoute } from "../../../chat/contract/codex-task-route";
import {
  CodexProjectResolutionSchema,
  CodexTaskHistorySchema,
  CodexTaskTitleSchema,
  CodexProjectTasksSchema,
  CodexProjectPreferenceSchema,
} from "../../../chat/contract/codex-task-route";

export function parseTaskHistory(
  value: unknown,
  request: {
    threadId: string;
    turnId: string;
    cursor?: string | undefined;
    tail?: boolean | undefined;
  },
) {
  const parsed = CodexTaskHistorySchema.safeParse(value);
  return parsed.success &&
    parsed.data.threadId === request.threadId &&
    parsed.data.turnId === request.turnId &&
    (parsed.data.status !== "history" ||
      (parsed.data.sortDirection === (request.tail ? "desc" : "asc") &&
        !(request.cursor !== undefined && parsed.data.complete) &&
        !(
          parsed.data.nextCursor !== null &&
          parsed.data.nextCursor === request.cursor
        )))
    ? parsed.data
    : {
        status: "refused" as const,
        threadId: request.threadId,
        turnId: request.turnId,
        code: "HANDOFF_HISTORY_CORRELATION",
      };
}

export function parseProjectPreference(
  value: unknown,
  request: {
    key: string;
    workspaceId: string;
    projectId: string;
    operation: "remember" | "read";
  },
) {
  const parsed = CodexProjectPreferenceSchema.safeParse(value);
  return parsed.success &&
    parsed.data.key === request.key &&
    parsed.data.workspaceId === request.workspaceId &&
    parsed.data.projectId === request.projectId &&
    ((parsed.data.status !== "remembered" &&
      parsed.data.status !== "resolved") ||
      parsed.data.status ===
        (request.operation === "remember" ? "remembered" : "resolved"))
    ? parsed.data
    : {
        status:
          request.operation === "remember"
            ? ("outcome_unknown" as const)
            : ("unavailable" as const),
        key: request.key,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        code: "HANDOFF_PROJECT_PREFERENCE_CORRELATION",
      };
}

export function parseProjectTasks(
  value: unknown,
  request: {
    workspaceId: string;
    projectId: string;
    scope?: "selected-writer" | "canonical-and-selected-writer" | undefined;
    cursor?: string | undefined;
  },
) {
  const parsed = CodexProjectTasksSchema.safeParse(value);
  return parsed.success &&
    parsed.data.workspaceId === request.workspaceId &&
    parsed.data.projectId === request.projectId &&
    (parsed.data.status !== "tasks" ||
      (parsed.data.scope === (request.scope ?? "selected-writer") &&
        !(request.cursor !== undefined && parsed.data.complete) &&
        !(
          parsed.data.nextCursor !== null &&
          parsed.data.nextCursor === request.cursor
        )))
    ? parsed.data
    : {
        status: "unavailable" as const,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        code: "HANDOFF_PROJECT_TASKS_CORRELATION",
      };
}

export function parseTaskTitle(
  value: unknown,
  request: { dispatchId: string; title: string },
) {
  const parsed = CodexTaskTitleSchema.safeParse(value);
  return parsed.success &&
    (parsed.data.status === "refused" ||
      (parsed.data.dispatchId === request.dispatchId &&
        ((parsed.data.status !== "renamed" &&
          parsed.data.status !== "recorded") ||
          parsed.data.title === request.title)))
    ? parsed.data
    : { status: "outcome_unknown" as const, dispatchId: request.dispatchId };
}

export function parseProjectResolution(value: unknown, workspaceId: string) {
  const parsed = CodexProjectResolutionSchema.safeParse(value);
  return parsed.success && parsed.data.workspaceId === workspaceId
    ? parsed.data
    : {
        status: "refused" as const,
        workspaceId,
        code: "HANDOFF_PROJECT_RESOLVE_CORRELATION",
      };
}

export type CodexTaskRoutePeer = CodexTaskRoute;
