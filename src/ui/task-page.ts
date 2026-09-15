function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function taskPage(taskId: string, label: string, token: string): string {
  const safeTask = JSON.stringify(taskId);
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:*">
  <title>${escapeHtml(label)}</title>
  <style>
    :root { color-scheme: dark; font-family: "Avenir Next", system-ui, sans-serif; background: #10202a; color: #dde8e6; }
    body { margin: 0; padding: 34px clamp(28px, 5vw, 70px); min-height: 100vh; box-sizing: border-box; }
    .eyeline { color: #76c8bb; font-size: 13px; letter-spacing: .04em; }
    h1 { font-size: clamp(27px, 4vw, 42px); line-height: 1.08; margin: 14px 0 26px; max-width: 720px; }
    .answer { max-width: 720px; font-size: 18px; line-height: 1.65; white-space: pre-wrap; }
    .status { display: inline-flex; gap: 8px; align-items: center; margin-top: 30px; color: #a9bcba; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #e9b45d; box-shadow: 0 0 0 5px rgba(233,180,93,.12); }
    body[data-terminal="true"] .dot { background: #54b5a5; box-shadow: none; }
    body[data-failed="true"] .dot { background: #e37369; box-shadow: none; }
  </style>
</head>
<body data-task-id=${JSON.stringify(taskId)} data-delta-count="0" data-terminal="false">
  <div class="eyeline">Isolated local fixture · ${escapeHtml(taskId)}</div>
  <h1>${escapeHtml(label)}</h1>
  <main class="answer" id="answer" aria-live="polite"></main>
  <div class="status"><span class="dot"></span><span id="status">Connecting to local stream…</span></div>
  <script>
    const taskId = ${safeTask};
    const token = ${safeToken};
    const answer = document.getElementById("answer");
    const status = document.getElementById("status");
    let carry = "";
    fetch("/events/" + encodeURIComponent(taskId), { headers: { authorization: "Bearer " + token } })
      .then(async (response) => {
        if (!response.ok || !response.body) throw new Error("stream unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          carry += decoder.decode(part.value, { stream: true });
          const frames = carry.split("\\n\\n");
          carry = frames.pop() || "";
          for (const frame of frames) {
            const data = frame.split("\\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            const event = JSON.parse(data.slice(6));
            if (event.kind === "text.delta") {
              answer.textContent += event.text;
              document.body.dataset.deltaCount = String(Number(document.body.dataset.deltaCount) + 1);
            }
            if (event.kind === "computer.requested") status.textContent = "Waiting for fixture Computer approval";
            if (event.kind === "computer.completed") status.textContent = "Computer result returned to this turn";
            if (event.kind === "turn.terminal") {
              document.body.dataset.terminal = "true";
              document.body.dataset.failed = String(event.phase === "failed" || event.phase === "outcome_unknown");
              status.textContent = event.phase === "completed" ? "Completed" : "Stopped: " + event.code;
            }
          }
        }
      })
      .catch(() => { document.body.dataset.failed = "true"; status.textContent = "Local runtime offline"; });
  </script>
</body>
</html>`;
}
