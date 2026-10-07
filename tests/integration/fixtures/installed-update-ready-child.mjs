// Disposable current-process caller fixture, never a product entrypoint.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const { home, helperPath, request, moduleURL } = JSON.parse(text);
const { captureInstalledProcessStart, startInstalledUpdateHelper } =
  await import(moduleURL);
const user = os.userInfo();
os.userInfo = () => ({ ...user, homedir: home });
const state = path.join(
  home,
  "Library/Application Support/Farol Next Preview/farol-next-state",
);
const processStart = await captureInstalledProcessStart(process.pid);
await fs.writeFile(
  path.join(state, "running.json"),
  JSON.stringify({
    schema: 1,
    pid: process.pid,
    processStart,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    bootTime: null,
  }),
  { mode: 0o600 },
);
const launched = await startInstalledUpdateHelper(
  helperPath,
  { ...request, pid: process.pid, processStart },
  { readinessTimeoutMs: 5000 },
);
if (launched.status === "refused") {
  // The launcher unrefs its child and pipes. Hold this caller only on refusal
  // while its original observer awaits close; keep the ready exit unchanged.
  let deadline;
  let completion;
  try {
    completion = await Promise.race([
      launched.operation.completion,
      new Promise((resolve) => {
        deadline = setTimeout(() => resolve(null), 1500);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  process.stdout.write(
    JSON.stringify(
      completion
        ? {
            status: "refused",
            completion: {
              code: completion.code,
              signal: completion.signal,
              protocolError: completion.protocolError,
              terminalPhase: completion.terminal?.phase ?? null,
            },
          }
        : {
            status: "outcome_unknown",
            reason: "fixture_refused_helper_completion_unknown",
          },
    ),
  );
  process.exitCode = 1;
} else if (launched.status !== "ready") {
  process.stdout.write(JSON.stringify({ status: launched.status }));
  process.exitCode = 1;
} else {
  await fs.writeFile(
    path.join(state, "last-quit.json"),
    JSON.stringify({
      schema: 1,
      at: new Date().toISOString(),
      drained: true,
      unconfirmed: [],
    }),
    { mode: 0o600 },
  );
  await fs.unlink(path.join(state, "running.json"));
  process.stdout.write(
    JSON.stringify({ status: "ready", helperPid: launched.operation.pid }),
  );
  // Fall off naturally with an unresolved completion promise. The helper and
  // its observation pipes must not keep this exact caller PID alive.
}
