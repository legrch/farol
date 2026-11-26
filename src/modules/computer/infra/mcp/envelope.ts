import type { CallToolResult } from "@modelcontextprotocol/server";

// One JSON text part plus the same value as structured content. Task, chat,
// relay and refusal answers all share this shape; only the error flag varies.
export function taskResponse(value: object, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

// A contract's own refusal travels as an error whose structured content is a
// copy, never the parsed value itself.
export function refusalResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
    isError: true,
  };
}

// A guidance answer is an error exactly when its `ok` is false.
export function guidanceResult(value: { ok: boolean }): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.ok ? {} : { isError: true }),
  };
}
