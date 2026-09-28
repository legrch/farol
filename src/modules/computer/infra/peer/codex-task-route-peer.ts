import type { CodexTaskRoute } from "../../../chat/contract/codex-task-route";
import { CodexProjectResolutionSchema } from "../../../chat/contract/codex-task-route";

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
