import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SecureMcpConnectorRuntime } from "../../src/apps/desktop/secure-mcp-connector-runtime";

// Retain the exact native spawn handle without replacing its implementation.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

it.skipIf(process.platform !== "darwin")(
  "observes the exited tunnel over actual IPC before stopping its retained native anchor",
  async () => {
    // Real disposable process/IPC/filesystem mechanics. Health alone is injected:
    // no server, tunnel credentials, app, provider, Go owner or shared build output.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-tunnel-terminal-")),
    );
    const executable = path.join(root, "tunnel.cjs");
    const release = path.join(root, "exit-tunnel");
    await fs.writeFile(
      executable,
      `#!${process.execPath}\n` +
        'const fs = require("node:fs");\n' +
        "const option = (name) => process.argv[process.argv.indexOf(name) + 1];\n" +
        'const target = option("--health.url-file");\n' +
        'fs.writeFileSync(target + ".tmp", "http://127.0.0.1:43129\\n", { mode: 0o600 });\n' +
        'fs.renameSync(target + ".tmp", target);\n' +
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);\n` +
        "setTimeout(() => process.exit(0), 8000);\n",
      { mode: 0o700 },
    );
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: path.join(root, "connector"),
        homePath: root,
        tempPath: root,
        readinessTimeoutMs: 3000,
      },
      { get: async () => true },
    );
    const input = {
      executablePath: executable,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    };
    let anchor: ChildProcess | undefined;
    let stopAttempted = false;
    let stopped = false;
    let originalExit: Promise<unknown> | undefined;
    let startupReady = false;
    try {
      const started = await runtime.start(input);
      startupReady = started.state === "ready";
      anchor = vi.mocked(spawn).mock.results.at(-1)?.value as
        ChildProcess | undefined;
      expect(anchor?.pid).toBeGreaterThan(1);
      if (anchor && anchor.exitCode === null && anchor.signalCode === null)
        originalExit = once(anchor, "exit");
      expect(started.state).toBe("ready");
      await fs.writeFile(release, "exit\n", { mode: 0o600 });
      const deadline = Date.now() + 2000;
      while (runtime.getTunnelObservation() === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(runtime.getTunnelObservation()).toEqual({
        state: "exited",
        runtimeGeneration: started.runtimeGeneration,
        terminal: {
          state: "observed",
          source: "connector-tunnel",
          event: "exit",
          code: "CONNECTOR_TUNNEL_EXIT",
          exitCode: 0,
          signal: null,
          forced: false,
        },
      });
      expect(anchor?.exitCode).toBeNull();
      expect(anchor?.signalCode).toBeNull();
      expect(runtime.isRunning()).toBe(true);
      expect(await runtime.checkHealth()).toBe(false);
      const launches = vi.mocked(spawn).mock.calls.length;
      await expect(runtime.start(input)).rejects.toThrow(
        "CONNECTOR_ALREADY_RUNNING",
      );
      expect(vi.mocked(spawn).mock.calls).toHaveLength(launches);
      stopAttempted = true;
      await runtime.stop();
      stopped = true;
      await originalExit;
      expect(runtime.isRunning()).toBe(false);
      expect(anchor?.exitCode !== null || anchor?.signalCode !== null).toBe(
        true,
      );
    } finally {
      // One original stop, never a repeated signal or PID rediscovery after
      // uncertainty. Preserve the root if any part of cleanup is unconfirmed.
      // A non-ready Start may already have attempted cleanup and retained an
      // unconfirmed outcome. It never grants another stop or root removal.
      if (startupReady && !stopAttempted && runtime.isRunning()) {
        stopAttempted = true;
        await runtime.stop();
        stopped = true;
      }
      if (originalExit && stopped) await originalExit;
      if (stopped) await fs.rm(root, { recursive: true, force: true });
    }
  },
  12000,
);
