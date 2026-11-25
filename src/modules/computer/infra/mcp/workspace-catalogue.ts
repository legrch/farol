import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerCallRequest,
} from "../../contract/readonly-computer-contract";

type Execute = (
  workspaceId: string,
  operation: ReadonlyComputerCallRequest["operation"],
) => Promise<CallToolResult>;
const MAX_WORKSPACES = 32;

function invalid(code: string): CallToolResult {
  const value = {
    ok: false,
    error: { code, source: "contract", retry: "never" },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

export type CatalogueEntry = Readonly<{
  workspaceId: string;
  root?: string;
  approvedRoot?: { path: string; device: string; inode: string };
  writableByOthers?: true;
  refusal?: Readonly<{ code: string; source: string }>;
}>;

// Only a refusal about this one folder is reported on its own entry: its path
// is refused (policy, ownership, link) or it is gone. Authority, contract,
// cancellation, race and helper failures keep failing the whole call.
const ENTRY_REFUSAL_CODES = new Set([
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_NOT_FOUND",
]);

function entryRefusal(response: CallToolResult): CatalogueEntry["refusal"] {
  const error: unknown = (
    response.structuredContent as { error?: unknown } | undefined
  )?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const { code, source } = error as { code?: unknown; source?: unknown };
  return typeof code === "string" &&
    ENTRY_REFUSAL_CODES.has(code) &&
    source === "native-workspace"
    ? { code, source }
    : undefined;
}

// Candidate IDs come only from the selected participant's materialized grant.
// Each root is obtained through the existing authority and native context checks;
// this adapter neither grants access nor reads configuration or ancestor folders.
// A workspace whose folder is refused is reported on its own entry and does not
// hide the usable ones. That entry carries no root: the unverified grant and
// approval records are not visible at this layer.
export async function discoverWorkspaces(
  workspaceIds: readonly string[],
  execute: Execute,
  // The final disclosure check over every collected entry, usable and refused
  // alike. A per-call recheck covers only its own workspace, so this is what
  // stops an earlier entry being published after its grant was withdrawn while
  // a later call ran. A failure discards the whole collection.
  verify?: (
    entries: readonly CatalogueEntry[],
  ) => Promise<CallToolResult | null>,
): Promise<CallToolResult> {
  if (
    workspaceIds.length > MAX_WORKSPACES ||
    new Set(workspaceIds).size !== workspaceIds.length ||
    workspaceIds.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 120,
    )
  )
    return invalid("COMPUTER_WORKSPACE_CATALOGUE_INVALID");
  const workspaces: CatalogueEntry[] = [];
  // Recheck all contexts before disclosure. Any other failure or changed
  // physical root discards the complete collection, including previously
  // successful roots; a changed refusal counts as a change too.
  for (let pass = 0; pass < 2; pass++) {
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const response = await execute(workspaceId, {
        kind: "workspace.context",
        relativePath: ".",
      });
      let entry: CatalogueEntry;
      if (response.isError) {
        const refusal = entryRefusal(response);
        if (!refusal) return response;
        entry = { workspaceId, refusal };
      } else {
        const parsed = ReadonlyComputerCallResponseSchema.safeParse({
          ok: true,
          value: response.structuredContent,
        });
        if (
          !parsed.success ||
          !parsed.data.ok ||
          parsed.data.value.workspaceId !== workspaceId ||
          parsed.data.value.operation.kind !== "workspace.context" ||
          parsed.data.value.relativePath !== "." ||
          parsed.data.value.output.kind !== "workspace.context"
        )
          return invalid("COMPUTER_CONTRACT_INVALID");
        const context = parsed.data.value.output;
        entry = {
          workspaceId,
          root: context.root,
          approvedRoot: context.approvedRoot,
          ...(context.writableByOthers ? { writableByOthers: true } : {}),
        };
      }
      if (pass === 0) workspaces.push(entry);
      else if (JSON.stringify(workspaces[index]) !== JSON.stringify(entry))
        return invalid("COMPUTER_WORKSPACE_CONTEXT_CHANGED");
    }
  }
  const refusedFinal = await verify?.(workspaces);
  if (refusedFinal) return refusedFinal;
  const value = {
    ok: true,
    workspaces,
    consistency:
      "twice-checked current authority and physical roots; not an atomic filesystem snapshot",
    next: "Use the exact workspaceId with computer_workspace_bootstrap before working in that folder. Folder names and paths are not workspace IDs.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
