type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export type ClaudePrintObservation = Readonly<{
  model: string;
  result: null | Readonly<{
    lifecycle: "completed" | "failed" | "needs_input";
    text: string;
  }>;
}>;
/** Bounded print-mode NDJSON, not a native session/browser visibility proof. */
export function observeClaudePrint(
  text: string,
  expected: { sessionId: string; cwd: string; model: string },
  exited: boolean,
): ClaudePrintObservation | null {
  if (new TextEncoder().encode(text).byteLength > 65536 || text.includes("\0"))
    return null;
  const lines = text.split("\n");
  const tail = lines.pop();
  if (exited && tail !== "") return null;
  let initialized = false;
  let result: ClaudePrintObservation["result"] = null;
  for (const line of lines) {
    if (!line.trim()) return null;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!object(event) || result !== null) return null;
    if (event.type === "system" && event.subtype === "init") {
      if (
        initialized ||
        event.session_id !== expected.sessionId ||
        event.cwd !== expected.cwd ||
        event.model !== expected.model ||
        event.permissionMode !== "default"
      )
        return null;
      initialized = true;
      continue;
    }
    // Normal print mode may report hook/plugin startup before system/init.
    // These bounded records carry no initialization, answer or authority proof.
    if (
      !initialized &&
      event.type === "system" &&
      typeof event.subtype === "string" &&
      [
        "plugin_install",
        "hook_started",
        "hook_progress",
        "hook_response",
      ].includes(event.subtype)
    ) {
      if (
        event.session_id !== undefined &&
        event.session_id !== expected.sessionId
      )
        return null;
      continue;
    }
    if (
      !initialized ||
      (event.session_id !== undefined &&
        event.session_id !== expected.sessionId)
    )
      return null;
    if (event.type !== "result") {
      if (
        ![
          "assistant",
          "user",
          "stream_event",
          "system",
          "rate_limit_event",
        ].includes(String(event.type))
      )
        return null;
      continue;
    }
    if (
      event.session_id !== expected.sessionId ||
      typeof event.is_error !== "boolean" ||
      typeof event.subtype !== "string" ||
      !Array.isArray(event.permission_denials) ||
      event.permission_denials.length > 50 ||
      !event.permission_denials.every(object)
    )
      return null;
    const failed = event.is_error;
    if (
      (!failed && event.subtype !== "success") ||
      (failed &&
        ![
          "error_during_execution",
          "error_max_turns",
          "error_max_budget_usd",
          "error_max_structured_output_retries",
        ].includes(event.subtype))
    )
      return null;
    const output = failed && event.result === undefined ? "" : event.result;
    if (
      typeof output !== "string" ||
      new TextEncoder().encode(output).byteLength > 32768 ||
      output.includes("\0")
    )
      return null;
    result = {
      lifecycle: event.permission_denials.length
        ? "needs_input"
        : failed
          ? "failed"
          : "completed",
      text: output,
    };
  }
  return initialized ? { model: expected.model, result } : null;
}
