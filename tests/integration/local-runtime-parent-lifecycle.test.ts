import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeLocalRuntime } from "../../src/apps/desktop/local-runtime-lifetime";

// Actual source bundled for a disposable Node/IPC/server fixture. This is not
// packaged Electron, an installed profile, arbitrary descendants or provider use.
let root: string;
let entry: string;
let cleanupUnconfirmed = false;
beforeAll(async () => {
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-local-runtime-parent-"),
  );
  entry = path.join(root, "runtime.cjs");
  await build({
    entryPoints: ["src/apps/runtime/main.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node26",
  });
});
afterAll(async () => {
  if (!cleanupUnconfirmed) await fs.rm(root, { recursive: true, force: true });
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("FIXTURE_ORIGINAL_CHILD_TIMEOUT")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function launch() {
  const child = spawn(process.execPath, [entry], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      FAROL_NEXT_PREVIEW_MODE: "empty",
      FAROL_NEXT_RUNTIME_IDENTITY: "farol-dev-runtime",
    },
  });
  const closed = once(child, "close");
  const exited = once(child, "exit");
  void closed.catch(() => undefined);
  void exited.catch(() => undefined);
  const lifetime = observeLocalRuntime(child);
  return { child, closed, exited, lifetime };
}
async function portClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(Error("FIXTURE_SERVER_REMAINED_OPEN"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}
async function cleanup(fixture: ReturnType<typeof launch>) {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null)
    fixture.child.kill("SIGKILL");
  try {
    await bounded(fixture.exited);
  } catch (error) {
    cleanupUnconfirmed = true;
    throw error;
  }
}
describe("actual local runtime parent lifecycle", () => {
  it.each(["shutdown", "disconnect"])(
    "closes the original service and root after %s",
    async (mode) => {
      const fixture = launch();
      try {
        const [ready] = await bounded(once(fixture.child, "message"));
        expect(ready.kind).toBe("runtime.ready");
        expect(Number.isInteger(ready.port)).toBe(true);
        if (mode === "shutdown") fixture.lifetime.requestStop();
        else fixture.child.disconnect();
        await bounded(fixture.lifetime.closed);
        expect(await bounded(fixture.exited)).toEqual([0, null]);
        if (mode === "shutdown")
          expect(await bounded(fixture.closed)).toEqual([0, null]);
        await portClosed(ready.port);
      } finally {
        await cleanup(fixture);
      }
    },
  );
  it("exits cleanly when IPC is disconnected before runtime initialization", async () => {
    const fixture = launch();
    try {
      await bounded(once(fixture.child, "spawn"));
      fixture.child.disconnect();
      await bounded(fixture.lifetime.closed);
      expect(await bounded(fixture.exited)).toEqual([0, null]);
    } finally {
      await cleanup(fixture);
    }
  });
});
