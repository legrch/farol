import type { CallToolResult } from "@modelcontextprotocol/server";

export function encode(value: object, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
    ...(isError ? { isError: true } : {}),
  };
}

// Only Go's exact Read only explanation earns an owner remedy. Path, hardlink,
// other authority refusals and UNKNOWN keep their own codes without this advice,
// and the original refusal is never retried or upgraded by the text.
export function explainReadOnlyRefusal<
  T extends { readonly status: string; readonly refusalReason?: string },
>(
  result: T,
  workspace: string,
  effect: "written" | "removed" = "written",
): T | (T & { message: string }) {
  if (
    result.status !== "refused" ||
    result.refusalReason !== "workspace_read_only"
  )
    return result;
  return {
    ...result,
    message: `Nothing was ${effect}. Workspace ${workspace} is Read only. If writing is needed, the owner can enable Setup → Workspaces → ${workspace} → Access → Read & write. Do not repeat this operation; after the owner changes access, use a new operationId.`,
  };
}
