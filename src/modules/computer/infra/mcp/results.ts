import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ShellResponse } from "../native/sandboxed-workspace-shell";

export function failure(code: string): CallToolResult {
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

// A summary-only phase is in progress somewhere in the owner's session: no
// Computer tool executes until it is over. The connector transport carries
// no conversation identity, so the fence covers every caller for that
// bounded time rather than admitting a call it cannot attribute.
export function fenced(code: string): CallToolResult {
  const value = {
    ok: false,
    error: { code, source: "execution-fence", retry: "later" },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

export function shellResult(result: ShellResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: { ...result },
    ...(result.ok ? {} : { isError: true }),
  };
}
