import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ReadonlyComputerWorkspaceVerification } from "../../contract/readonly-computer-contract";
import { taskResponse } from "./envelope";
import type { CatalogueEntry } from "./workspace-catalogue";

// The final disclosure check names the task identity of the call and every
// workspace the answer would show, with a root only when one was found.
export function workspaceVerificationRequest<
  Binding extends Readonly<Record<string, unknown>>,
>(binding: Binding, callId: string, entries: readonly CatalogueEntry[]) {
  return {
    ...binding,
    callId,
    workspaces: entries.map((entry) => ({
      workspaceId: entry.workspaceId,
      ...(entry.root !== undefined && entry.approvedRoot
        ? { root: entry.root, approvedRoot: entry.approvedRoot }
        : {}),
    })),
  };
}

// A failed verification is reported as a never-retry error that names only
// its code and source.
export function workspaceVerificationRefusal(
  verified: Extract<ReadonlyComputerWorkspaceVerification, { ok: false }>,
): CallToolResult {
  return taskResponse(
    {
      ok: false,
      error: {
        code: verified.error.code,
        source: verified.error.source,
        retry: "never",
      },
    },
    true,
  );
}
