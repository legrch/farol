// Disposable current-process caller fixture, never a product entrypoint.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  captureInstalledProcessStart,
  startInstalledUpdateHelper,
} from "../../../src/modules/release/infra/native/installed-update-helper.ts";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const { home, helperPath, request } = JSON.parse(text);
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
if (launched.status !== "ready") {
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
