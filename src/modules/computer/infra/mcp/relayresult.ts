import type { CallToolResult } from "@modelcontextprotocol/server";
import type { CodexCallerRelayResponse } from "../../../../pkg/caller-relay/protocol";
import { taskResponse } from "./envelope";

// A relay that cannot be reached is refused for good, never retried.
export const RELAY_UNAVAILABLE: CodexCallerRelayResponse = {
  ok: false,
  error: { code: "CALLER_RELAY_UNAVAILABLE", retry: "never" },
};

export function relayResult(
  response: CodexCallerRelayResponse,
): CallToolResult {
  if (!response.ok) return taskResponse(response, true);
  return {
    content: [
      {
        type: "text",
        text:
          response.operation === "invoke"
            ? response.output
            : JSON.stringify(response.catalogue),
      },
    ],
    structuredContent: response,
  };
}
