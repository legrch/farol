import type { CodexTaskRoute } from "../../../chat/contract/codex-task-route";
import {
  CodexProjectResolutionSchema,
  CodexTaskHistorySchema,
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
