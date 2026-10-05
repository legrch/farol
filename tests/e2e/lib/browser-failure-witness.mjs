// Only the content-free production marker is retained. Raw process output is
// neither persisted nor returned, including on malformed or oversized input.
export function browserFailureCollector() {
  let pending = "";
  let droppingLine = false;
  const failures = [];
  return {
    failures,
    ingest(chunk) {
      // Pipe chunks have no relationship to records. Bound each retained line,
      // discard an oversized line through its newline, then resume parsing.
      const data = String(chunk);
      for (let start = 0; start < data.length;) {
        const newline = data.indexOf("\n", start);
        const end = newline === -1 ? data.length : newline;
        if (!droppingLine) {
          if (pending.length + end - start > 8192) {
            pending = "";
            droppingLine = true;
          } else pending += data.slice(start, end);
        }
        if (newline === -1) break;
        const line = droppingLine ? "" : pending;
        pending = "";
        droppingLine = false;
        start = newline + 1;
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
