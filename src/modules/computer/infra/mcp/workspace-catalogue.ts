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

// Candidate IDs come only from the selected participant's materialized grant.
// Each root is obtained through the existing authority and native context checks;
// this adapter neither grants access nor reads configuration or ancestor folders.
export async function discoverWorkspaces(
  workspaceIds: readonly string[],
  execute: Execute,
): Promise<CallToolResult> {
  if (
    workspaceIds.length > MAX_WORKSPACES ||
    new Set(workspaceIds).size !== workspaceIds.length ||
    workspaceIds.some(
      (id) => typeof id !== "string" || id.length === 0 || id.length > 120,
    )
  )
    return invalid("COMPUTER_WORKSPACE_CATALOGUE_INVALID");
  const workspaces: {
    workspaceId: string;
    root: string;
    approvedRoot: { path: string; device: string; inode: string };
  }[] = [];
  // Recheck all contexts before disclosure. A refusal or changed physical root
  // discards the complete collection, including previously successful roots.
  for (let pass = 0; pass < 2; pass++) {
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const response = await execute(workspaceId, {
        kind: "workspace.context",
        relativePath: ".",
      });
      if (response.isError) return response;
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
      const entry = {
        workspaceId,
        root: context.root,
        approvedRoot: context.approvedRoot,
      };
      if (pass === 0) workspaces.push(entry);
      else if (JSON.stringify(workspaces[index]) !== JSON.stringify(entry))
        return invalid("COMPUTER_WORKSPACE_CONTEXT_CHANGED");
    }
  }
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
