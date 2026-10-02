// Actual fixture supervisor with modeled process-group/pipe events. This is
// deterministic cancellation policy evidence, not native process cleanup proof.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

it("still escalates the owned group when its wrapper exited but a descendant holds the pipes", async () => {
  const source = fs.readFileSync(
    new URL("./owner-protection.test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function ownedRun(");
  const end = source.indexOf("\nfunction fixture()", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 8123,
    exitCode: 0,
    signalCode: null,
    stdout: Object.assign(new EventEmitter(), { destroy() {} }),
    stderr: Object.assign(new EventEmitter(), { destroy() {} }),
  });
  const signals = [];
  let groupGone = false;
  const absent = () =>
    Object.assign(new Error("fixture absent"), { code: "ESRCH" });
  const activeGroups = new Set();
  const context = vm.createContext({
    activeGroups,
    spawn: () => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    process: {
      kill: (pid, signal) => {
        if (signal === 0) {
          if (groupGone) throw absent();
          return;
        }
        signals.push([pid, signal]);
        if (pid === child.pid) throw absent();
        groupGone = true;
        queueMicrotask(() => child.emit("close", 0, null));
      },
    },
    setTimeout,
    clearTimeout,
    performance,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  vm.runInContext(source.slice(start, end), context);
  const result = await context.ownedRun("fixture", [], {}, 10);
  expect(signals).toEqual([
    [child.pid, "SIGTERM"],
    [-child.pid, "SIGKILL"],
  ]);
  expect(result.error.message).toBe("owned fixture deadline exceeded");
  expect(result.groupCleanup).toBe(true);
  expect(activeGroups.size).toBe(0);
});
