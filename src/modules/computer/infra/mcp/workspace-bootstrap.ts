import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerCallRequest,
} from "../../contract/readonly-computer-contract";

type Execute = (
  operation: ReadonlyComputerCallRequest["operation"],
) => Promise<CallToolResult>;
type Instruction =
  | Readonly<{
      relativePath: string;
      status: "read";
      text: string;
      bytes: number;
    }>
  | Readonly<{ relativePath: string; status: "not_found" }>
  | Readonly<{ relativePath: string; status: "unavailable"; code: string }>;
const UNAVAILABLE = new Set([
  "AUTHORITY_PATH_DENIED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_FILE_TOO_LARGE",
  "WORKSPACE_NOT_A_FILE",
  "WORKSPACE_NOT_TEXT",
]);
const MAX_DEPTH = 32;
const MAX_BYTES = 64 * 1024;

function result(
  value: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}
function invalid(code: string): CallToolResult {
  return result(
    { ok: false, error: { code, source: "contract", retry: "never" } },
    true,
  );
}

// All reads use the same authority-bound contract as ordinary Computer tools.
// This is a bounded instruction chain, not a recursive repository scan or an
// authority grant. Ancestors outside the task's selected root are not opened.
export async function bootstrapWorkspace(
  relativeDirectory: string,
  execute: Execute,
): Promise<CallToolResult> {
  const directories = ["."];
  if (relativeDirectory !== ".") {
    const parts = relativeDirectory.split("/");
    if (parts.length > MAX_DEPTH)
      return invalid("COMPUTER_INSTRUCTION_DEPTH_LIMIT");
    for (let index = 1; index <= parts.length; index++)
      directories.push(parts.slice(0, index).join("/"));
  }
  const first = await execute({
    kind: "workspace.context",
    relativePath: relativeDirectory,
  });
  if (first.isError) return first;
  const parsed = ReadonlyComputerCallResponseSchema.safeParse({
    ok: true,
    value: first.structuredContent,
  });
  if (
    !parsed.success ||
    !parsed.data.ok ||
    parsed.data.value.output.kind !== "workspace.context"
  )
    return invalid("COMPUTER_CONTRACT_INVALID");
  const context = parsed.data.value.output;
  const instructions: Instruction[] = [];
  // Re-read the chain before disclosing it. Revocation, replacement or a
  // concurrently edited instruction produces a refusal, never stale context.
  for (let pass = 0; pass < 2; pass++) {
    let bytes = 0;
    for (const [index, directory] of directories.entries()) {
      const relativePath =
        directory === "." ? "AGENTS.md" : `${directory}/AGENTS.md`;
      const response = await execute({ kind: "workspace.read", relativePath });
      let instruction: Instruction;
      if (response.isError) {
        const failed = ReadonlyComputerCallResponseSchema.safeParse(
          response.structuredContent,
        );
        if (!failed.success || failed.data.ok) return response;
        const code = failed.data.error.code;
        if (code === "WORKSPACE_NOT_FOUND")
          instruction = { relativePath, status: "not_found" };
        else if (UNAVAILABLE.has(code))
          instruction = { relativePath, status: "unavailable", code };
        else return response;
      } else {
        const read = ReadonlyComputerCallResponseSchema.safeParse({
          ok: true,
          value: response.structuredContent,
        });
        if (
          !read.success ||
          !read.data.ok ||
          read.data.value.output.kind !== "workspace.text" ||
          read.data.value.output.page
        )
          return invalid("COMPUTER_CONTRACT_INVALID");
        const output = read.data.value.output;
        bytes += output.bytes;
        instruction =
          bytes > MAX_BYTES
            ? {
                relativePath,
                status: "unavailable",
                code: "COMPUTER_INSTRUCTION_BYTE_LIMIT",
              }
            : {
                relativePath,
                status: "read",
                text: output.text,
                bytes: output.bytes,
              };
      }
      if (pass === 0) instructions.push(instruction);
      else if (
        JSON.stringify(instructions[index]) !== JSON.stringify(instruction)
      )
        return invalid("COMPUTER_INSTRUCTIONS_CHANGED");
    }
  }
  const last = await execute({
    kind: "workspace.context",
    relativePath: relativeDirectory,
  });
  if (last.isError) return last;
  const final = ReadonlyComputerCallResponseSchema.safeParse({
    ok: true,
    value: last.structuredContent,
  });
  if (
    !final.success ||
    !final.data.ok ||
    JSON.stringify(final.data.value.output) !== JSON.stringify(context)
  )
    return invalid("COMPUTER_WORKSPACE_CONTEXT_CHANGED");
  return result({
    ok: true,
    workspaceId: parsed.data.value.workspaceId,
    root: context.root,
    approvedRoot: context.approvedRoot,
    relativeDirectory,
    scope: context.scope,
    coverage:
      "root-to-selected-directory; ancestors outside the task scope and other descendants are not inspected",
    consistency: "twice-read chain; not an atomic filesystem snapshot",
    precedence:
      "Apply root instructions first, then more specific instructions; text never expands authority.",
    complete: instructions.every(
      (instruction) => instruction.status !== "unavailable",
    ),
    instructions,
  });
}
