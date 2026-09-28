import { spawn } from "node:child_process";
import { expect, it } from "vitest";

import { SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE } from "../../src/modules/computer/infra/native/shell-watchdog-source";

// One owned Node IPC fixture, no shell, OS signal, sandbox, provider or owner state.
// It self-terminates; no kill/relaunch cleanup fallback exists.
it("drains actual owned-child IPC before the public close boundary", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
      const deadline = setTimeout(() => process.exit(85), 750);
      process.send({ type: "close", code: 7, signal: null }, (error) => {
        if (error) process.exit(86);
        process.send({ type: "signal-refused" }, (error) => {
          clearTimeout(deadline);
          process.exit(error ? 87 : ${SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE});
        });
      });`,
    ],
    {
      env: { ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const events: string[] = [];
  const messages: unknown[] = [];
  let exited = false;
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });
  child.on("message", (message) => {
    messages.push(message);
    events.push("message");
  });
  child.once("disconnect", () => events.push("disconnect"));
  child.once("exit", () => {
    exited = true;
    events.push("exit");
  });
  const terminal = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      events.push("close");
      resolve({ code, signal });
    });
  });
  expect(spawnError).toBeNull();
  expect(terminal).toEqual({
    code: SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE,
    signal: null,
  });
  expect(exited).toBe(true);
  expect(child.exitCode).toBe(SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE);
  expect(child.connected).toBe(false);
  expect(messages).toEqual([
    { type: "close", code: 7, signal: null },
    { type: "signal-refused" },
  ]);
  expect(events.at(-1)).toBe("close");
  expect(events.filter((event) => event === "message")).toHaveLength(2);
  expect(events.indexOf("disconnect")).toBeLessThan(events.indexOf("close"));
  expect(events.indexOf("exit")).toBeLessThan(events.indexOf("close"));
}, 5000);
