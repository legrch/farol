function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

type TaskPageIdentity = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  label: string;
}>;

export function taskPage(task: TaskPageIdentity, token: string): string {
  const safeIdentity = JSON.stringify({
    ownerId: task.ownerId,
    sessionId: task.sessionId,
    taskId: task.taskId,
    turnId: task.turnId,
    generation: task.generation,
  });
  const safeToken = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:*">
  <title>${escapeHtml(task.label)}</title>
  <style>
    :root { color-scheme: dark; font-family: "Avenir Next", system-ui, sans-serif; background: #10202a; color: #dde8e6; }
    body { margin: 0; padding: 34px clamp(28px, 5vw, 70px); min-height: 100vh; box-sizing: border-box; }
    .eyeline { color: #76c8bb; font-size: 13px; letter-spacing: .04em; }
    h1 { font-size: clamp(27px, 4vw, 42px); line-height: 1.08; margin: 14px 0 26px; max-width: 720px; }
    .answer { max-width: 720px; font-size: 18px; line-height: 1.65; white-space: pre-wrap; }
    .state { min-height: 88px; margin-top: 30px; }
    .status { display: inline-flex; gap: 8px; align-items: center; color: #a9bcba; }
    .recovery { max-width: 680px; min-height: 24px; margin: 10px 0 0 17px; color: #91a5a4; font-size: 14px; line-height: 1.45; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #e9b45d; box-shadow: 0 0 0 5px rgba(233,180,93,.12); }
    body[data-terminal="true"] .dot { background: #54b5a5; box-shadow: none; }
    body[data-failed="true"] .dot { background: #e37369; box-shadow: none; }
  </style>
</head>
<body data-task-id=${JSON.stringify(task.taskId)} data-delta-count="0" data-terminal="false">
  <div class="eyeline">Isolated local fixture · Task-bound Browser</div>
  <h1>${escapeHtml(task.label)}</h1>
  <main class="answer" id="answer" aria-live="polite"></main>
  <div class="state">
    <div class="status"><span class="dot"></span><span id="status">Connecting to local stream…</span></div>
    <p class="recovery" id="recovery"></p>
  </div>
  <script>
    const identity = ${safeIdentity};
    const token = ${safeToken};
    const answer = document.getElementById("answer");
    const status = document.getElementById("status");
    const recovery = document.getElementById("recovery");
    let carry = "";
    let terminalSeen = false;
    document.addEventListener("securitypolicyviolation", (event) => {
      document.body.dataset.deliveryFailure = "csp-" + event.violatedDirective;
    });
    fetch("/events/" + encodeURIComponent(identity.taskId), { headers: { authorization: "Bearer " + token } })
      .then(async (response) => {
        if (!response.ok) {
          document.body.dataset.deliveryFailure = "stream-status-" + response.status;
          throw new Error("stream unavailable");
        }
        if (!response.body) {
          document.body.dataset.deliveryFailure = "stream-body";
          throw new Error("stream unavailable");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const part = await reader.read();
          if (part.done) {
            if (!terminalSeen) throw new Error("stream ended before terminal");
            break;
          }
          carry += decoder.decode(part.value, { stream: true });
          const frames = carry.split("\\n\\n");
          carry = frames.pop() || "";
          for (const frame of frames) {
            const eventId = Number(frame.split("\\n").find((line) => line.startsWith("id: "))?.slice(4));
            const data = frame.split("\\n").find((line) => line.startsWith("data: "));
            if (!data) continue;
            if (!Number.isSafeInteger(eventId) || eventId < 1) throw new Error("invalid delivery frame");
            const event = JSON.parse(data.slice(6));
            if (event.ownerId !== identity.ownerId || event.sessionId !== identity.sessionId || event.taskId !== identity.taskId || event.turnId !== identity.turnId || event.generation !== identity.generation) {
              throw new Error("foreign event");
            }
            if (event.kind === "text.delta") {
              answer.textContent += event.text;
              document.body.dataset.deltaCount = String(Number(document.body.dataset.deltaCount) + 1);
              status.textContent = "Streaming response…";
            }
            if (event.kind === "computer.requested") status.textContent = "Waiting for fixture Computer approval";
            if (event.kind === "computer.completed") status.textContent = "Computer result returned to this turn";
            if (event.kind === "turn.terminal") {
              terminalSeen = true;
              document.body.dataset.terminal = "true";
              document.body.dataset.failed = String(event.phase === "failed" || event.phase === "outcome_unknown");
              if (event.phase === "completed") {
                status.textContent = "Completed";
                recovery.textContent = "The final result is retained by this local task.";
              } else if (event.phase === "outcome_unknown") {
                status.textContent = "Outcome unknown";
                recovery.textContent = "The operation may have been submitted. Do not retry automatically; inspect Activity first.";
              } else {
                status.textContent = "Stopped before completion";
                recovery.textContent = "Open Activity for the recorded reason before trying again.";
              }
            }
            if (event.kind === "client.delivery_acknowledged") continue;
            const acknowledged = await fetch("/ack/" + encodeURIComponent(identity.taskId) + "/" + eventId, {
              method: "POST",
              headers: {
                authorization: "Bearer " + token,
                "content-type": "application/json"
              },
              body: JSON.stringify(identity)
            });
            if (!acknowledged.ok) {
              document.body.dataset.deliveryFailure = "status-" + acknowledged.status;
              throw new Error("delivery acknowledgement unavailable");
            }
          }
        }
      })
      .catch(() => {
        if (!document.body.dataset.deliveryFailure) document.body.dataset.deliveryFailure = "network";
        document.body.dataset.failed = "true";
        document.body.dataset.offline = "true";
        status.textContent = "Local runtime offline";
        recovery.textContent = "This view will not resubmit the task automatically. Reopen it after the runtime is available.";
      });
  </script>
</body>
</html>`;
}
