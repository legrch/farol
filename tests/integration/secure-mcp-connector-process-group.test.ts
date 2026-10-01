import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { SecureMcpConnectorRuntime } from "../../src/apps/desktop/secure-mcp-connector-runtime";

// Record only the actual native handle; the production spawn still executes.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const execute = promisify(execFile);

it.skipIf(process.platform !== "darwin")(
  "keeps one owned connector outside the terminal foreground process group",
  async () => {
    // Local signal/file fixture only: no sockets, accounts or live tunnel client.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-connector-group-")),
    );
    const executable = path.join(root, "local-child.cjs");
    await fs.writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        'const fs = require("node:fs");\n' +
        "const option = (name) => process.argv[process.argv.indexOf(name) + 1];\n" +
        'fs.writeFileSync(option("--pid.file"), String(process.pid));\n' +
        'const healthFile = option("--health.url-file"); fs.writeFileSync(healthFile + ".tmp", "http://127.0.0.1:41329\\n", { mode: 0o600 }); fs.renameSync(healthFile + ".tmp", healthFile);\n' +
        'process.on("SIGTERM", () => process.exit(0));\n' +
        "setInterval(() => {}, 1000);\n",
      { mode: 0o700 },
    );
    const runtimeRoot = path.join(root, "connector");
    const runtime = new SecureMcpConnectorRuntime(
      { root: runtimeRoot, homePath: root, tempPath: root },
      { get: async () => true },
    );
    let stopAttempted = false;
    let stopped = false;
    try {
      const result = await runtime.start({
        executablePath: executable,
        executableSha256: "a".repeat(64),
        connectorGeneration: 1,
        computerGeneration: 1,
        buildId: "b".repeat(64),
        launchContractSha256: "c".repeat(64),
      });
      expect(result.state).toBe("ready");
      const pid = Number(
        await fs.readFile(
          path.join(runtimeRoot, "runtime/tunnel-client.pid"),
          "utf8",
        ),
      );
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      const group = async (selected: number) =>
        Number(
          (
            await execute("/bin/ps", ["-p", String(selected), "-o", "pgid="])
          ).stdout.trim(),
        );
      expect(await group(pid)).toBe(
        Number(
          (
            await execute("/bin/ps", ["-p", String(pid), "-o", "ppid="])
          ).stdout.trim(),
        ),
      );
      expect(await group(pid)).not.toBe(await group(process.pid));
      // Stop is tracked through the owned anchor and whole-group terminal observation.
      stopAttempted = true;
      await runtime.stop();
      stopped = true;
      expect(runtime.isRunning()).toBe(false);
    } finally {
      if (!stopAttempted) {
        stopAttempted = true;
        await runtime.stop();
        stopped = true;
      }
      if (stopped) await fs.rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(process.platform !== "darwin")(
  "confirms the owned connector descendants are gone before reporting stop",
  async () => {
    // Real local process group, with file-controlled fixture cleanup. No endpoint.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-connector-descendant-")),
    );
    const executable = path.join(root, "leader.cjs");
    const descendant = path.join(root, "descendant.cjs");
    const descendantPid = path.join(root, "descendant.pid");
    const release = path.join(root, "fixture-release");
    await fs.writeFile(
      descendant,
      'const fs = require("node:fs");\n' +
        `fs.writeFileSync(${JSON.stringify(descendantPid)} + ".tmp", String(process.pid), { mode: 0o600 }); fs.renameSync(${JSON.stringify(descendantPid)} + ".tmp", ${JSON.stringify(descendantPid)});\n` +
        'process.on("SIGTERM", () => process.exit(0));\n' +
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        'const fs = require("node:fs");\n' +
        'const { spawn } = require("node:child_process");\n' +
        "const option = (name) => process.argv[process.argv.indexOf(name) + 1];\n" +
        `const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });\n` +
        'child.once("exit", () => process.exit(0));\n' +
        'process.on("SIGTERM", () => {});\n' +
        'fs.writeFileSync(option("--pid.file"), String(process.pid));\n' +
        `const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantPid)})) { clearInterval(ready); const healthFile = option("--health.url-file"); fs.writeFileSync(healthFile + ".tmp", "http://127.0.0.1:41329\\n", { mode: 0o600 }); fs.renameSync(healthFile + ".tmp", healthFile); } }, 20);\n` +
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)}) && child.exitCode !== null) process.exit(0); }, 20);\n`,
      { mode: 0o700 },
    );
    const runtimeRoot = path.join(root, "connector");
    const runtime = new SecureMcpConnectorRuntime(
      { root: runtimeRoot, homePath: root, tempPath: root },
      { get: async () => true },
    );
    let pid: number | undefined;
    let stopAttempted = false;
    const groupGone = () => {
      if (pid === undefined) return false;
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    };
    try {
      expect(
        (
          await runtime.start({
            executablePath: executable,
            executableSha256: "a".repeat(64),
            connectorGeneration: 1,
            computerGeneration: 1,
            buildId: "b".repeat(64),
            launchContractSha256: "c".repeat(64),
          })
        ).state,
      ).toBe("ready");
      const leaderPid = Number(
        await fs.readFile(
          path.join(runtimeRoot, "runtime/tunnel-client.pid"),
          "utf8",
        ),
      );
      pid = Number(
        (
          await execute("/bin/ps", ["-p", String(leaderPid), "-o", "pgid="])
        ).stdout.trim(),
      );
      const childPid = Number(await fs.readFile(descendantPid, "utf8"));
      const group = Number(
        (
          await execute("/bin/ps", ["-p", String(childPid), "-o", "pgid="])
        ).stdout.trim(),
      );
      expect(group).toBe(pid);
      stopAttempted = true;
      await runtime.stop();
      expect(
        groupGone(),
        "stop must confirm the whole owned group, including the descendant",
      ).toBe(true);
      expect(runtime.isRunning()).toBe(false);
    } finally {
      // This unique file is understood only by our disposable fixture. Never
      // retry an unconfirmed runtime stop or signal an untracked/reused PID.
      await fs.writeFile(release, "release\n", { mode: 0o600 });
      if (!stopAttempted) {
        stopAttempted = true;
        await runtime.stop();
      }
      for (let attempt = 0; attempt < 100 && !groupGone(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!groupGone())
        throw new Error("LOCAL_CONNECTOR_FIXTURE_CLEANUP_UNCONFIRMED");
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(process.platform !== "darwin")(
  "cleans a surviving descendant when the connector leader exits on SIGTERM",
  async () => {
    // Real local process group, with file-controlled fixture cleanup. No endpoint.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-connector-descendant-")),
    );
    const executable = path.join(root, "leader.cjs");
    const descendant = path.join(root, "descendant.cjs");
    const descendantPid = path.join(root, "descendant.pid");
    const release = path.join(root, "fixture-release");
    await fs.writeFile(
      descendant,
      'const fs = require("node:fs");\n' +
        `fs.writeFileSync(${JSON.stringify(descendantPid)} + ".tmp", String(process.pid), { mode: 0o600 }); fs.renameSync(${JSON.stringify(descendantPid)} + ".tmp", ${JSON.stringify(descendantPid)});\n` +
        'process.on("SIGTERM", () => {});\n' +
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 20);\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        'const fs = require("node:fs");\n' +
        'const { spawn } = require("node:child_process");\n' +
        "const option = (name) => process.argv[process.argv.indexOf(name) + 1];\n" +
        `const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" });\n` +
        'child.once("exit", () => process.exit(0));\n' +
        'process.on("SIGTERM", () => process.exit(0));\n' +
        'fs.writeFileSync(option("--pid.file"), String(process.pid));\n' +
        `const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantPid)})) { clearInterval(ready); const healthFile = option("--health.url-file"); fs.writeFileSync(healthFile + ".tmp", "http://127.0.0.1:41329\\n", { mode: 0o600 }); fs.renameSync(healthFile + ".tmp", healthFile); } }, 20);\n` +
        `setInterval(() => { if (fs.existsSync(${JSON.stringify(release)}) && child.exitCode !== null) process.exit(0); }, 20);\n`,
      { mode: 0o700 },
    );
    const runtimeRoot = path.join(root, "connector");
    const runtime = new SecureMcpConnectorRuntime(
      { root: runtimeRoot, homePath: root, tempPath: root },
      { get: async () => true },
    );
    let pid: number | undefined;
    let stopAttempted = false;
    const groupGone = () => {
      if (pid === undefined) return false;
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
        throw error;
      }
    };
    try {
      expect(
        (
          await runtime.start({
            executablePath: executable,
            executableSha256: "a".repeat(64),
            connectorGeneration: 1,
            computerGeneration: 1,
            buildId: "b".repeat(64),
            launchContractSha256: "c".repeat(64),
          })
        ).state,
      ).toBe("ready");
      const leaderPid = Number(
        await fs.readFile(
          path.join(runtimeRoot, "runtime/tunnel-client.pid"),
          "utf8",
        ),
      );
      pid = Number(
        (
          await execute("/bin/ps", ["-p", String(leaderPid), "-o", "pgid="])
        ).stdout.trim(),
      );
      const childPid = Number(await fs.readFile(descendantPid, "utf8"));
      const group = Number(
        (
          await execute("/bin/ps", ["-p", String(childPid), "-o", "pgid="])
        ).stdout.trim(),
      );
      expect(group).toBe(pid);
      stopAttempted = true;
      await runtime.stop();
      expect(
        groupGone(),
        "stop must confirm the whole owned group, including the descendant",
      ).toBe(true);
      expect(runtime.isRunning()).toBe(false);
    } finally {
      // This unique file is understood only by our disposable fixture. Never
      // retry an unconfirmed runtime stop or signal an untracked/reused PID.
      await fs.writeFile(release, "release\n", { mode: 0o600 });
      if (!stopAttempted) {
        stopAttempted = true;
        await runtime.stop();
      }
      for (let attempt = 0; attempt < 100 && !groupGone(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!groupGone())
        throw new Error("LOCAL_CONNECTOR_FIXTURE_CLEANUP_UNCONFIRMED");
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

it.skipIf(process.platform !== "darwin")(
  "kills the owned group when Desktop's lifetime pipe closes",
  async () => {
    // Native EOF through the production pipe, not an owner crash/live claim.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-connector-eof-")),
    );
    const executable = path.join(root, "local-child.cjs");
    await fs.writeFile(
      executable,
      "#!/usr/bin/env node\n" +
        'const fs = require("node:fs");\n' +
        "const option = name => process.argv[process.argv.indexOf(name) + 1];\n" +
        'process.on("SIGTERM", () => {});\n' +
        'fs.writeFileSync(option("--pid.file"), String(process.pid));\n' +
        'const healthFile = option("--health.url-file"); fs.writeFileSync(healthFile + ".tmp", "http://127.0.0.1:41329\\n", { mode: 0o600 }); fs.renameSync(healthFile + ".tmp", healthFile);\n' +
        "setInterval(() => {}, 1000);\n",
      { mode: 0o700 },
    );
    const runtime = new SecureMcpConnectorRuntime(
      { root: path.join(root, "connector"), homePath: root, tempPath: root },
      { get: async () => true },
    );
    let lifetimeClosed = false;
    let stopped = false;
    try {
      expect(
        (
          await runtime.start({
            executablePath: executable,
            executableSha256: "a".repeat(64),
            connectorGeneration: 1,
            computerGeneration: 1,
            buildId: "b".repeat(64),
            launchContractSha256: "c".repeat(64),
          })
        ).state,
      ).toBe("ready");
      const result = vi.mocked(spawn).mock.results.at(-1);
      expect(result?.type).toBe("return");
      const anchor = result!.value as ChildProcess;
      expect(anchor.stdin).not.toBeNull();
      lifetimeClosed = true;
      anchor.stdin!.end();
      await vi.waitFor(() => expect(runtime.isRunning()).toBe(false), {
        timeout: 2_000,
        interval: 20,
      });
      stopped = true;
    } finally {
      if (!lifetimeClosed) {
        await runtime.stop();
        stopped = true;
      }
      if (stopped) await fs.rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
