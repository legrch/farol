// Only the content-free production marker is retained. Raw process output is
// neither persisted nor returned, including on malformed or oversized input.
export function browserFailureCollector() {
  let pending = "";
  const failures = [];
  return {
    failures,
    ingest(chunk) {
      if (chunk.length > 8192) {
        pending = "";
        return;
      }
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop();
      if (pending.length > 8192) pending = "";
      for (const line of lines) {
        if (!line.startsWith("FAROL_BROWSER_FAILURE ") || failures.length >= 8)
          continue;
        try {
          const value = JSON.parse(line.slice("FAROL_BROWSER_FAILURE ".length));
          if (
            value === null ||
            Object.keys(value).sort().join(",") !== "code,kind,stage,state" ||
            !["poll", "execute"].includes(value.stage) ||
            ![
              null,
              "prepare",
              "verify-send",
              "send",
              "observe",
              "cancel",
              "dispose",
            ].includes(value.kind) ||
            !["unavailable", "unknown", "refused", "unsupported"].includes(
              value.state,
            ) ||
            typeof value.code !== "string" ||
            !/^(?:browser_|chat_browser_|host_browser_|host_chat_browser_|backend_)[a-z_]{1,80}$/u.test(
              value.code,
            )
          )
            continue;
          failures.push(value);
        } catch {
          // Missing diagnostics are not success or a permission to retry.
        }
      }
    },
  };
}
