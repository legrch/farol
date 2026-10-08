import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SecureMcpConnectorRuntime,
  observedConnectorChild,
  type ConnectorChild,
  type ConnectorCommand,
  type ConnectorCommandRunner,
  type ConnectorProcessStarter,
} from "../../src/apps/desktop/secure-mcp-connector-runtime";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-secure-mcp-runtime-"),
  );
  roots.push(root);
  const runtimeRoot = path.join(root, "connector");
  const credentialPath = path.join(root, "private", "control-plane-api-key");
  await fs.mkdir(path.dirname(credentialPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(credentialPath, "sk-runtime-example-1234567890", {
    mode: 0o600,
  });
  return {
    root,
    runtimeRoot,
    credentialPath,
    executablePath: "/opt/homebrew/bin/tunnel-client",
    electronPath:
      "/Applications/Farol Next Preview.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    mcpEntry:
      "/Applications/Farol Next Preview.app/Contents/Resources/app/computer-mcp.cjs",
    launchContract: path.join(root, "launch", "computer-launch.json"),
  };
}

class FakeChild implements ConnectorChild {
  readonly pid = 4321;
  exitCode: number | null = null;
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.exitCode = 0;
    return true;
  }

  async waitForExit(): Promise<boolean> {
    return this.exitCode !== null;
  }
}

function option(command: ConnectorCommand, name: string): string {
  const index = command.arguments.indexOf(name);
  const value = command.arguments[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${name}`);
  return value;
}

describe("secure MCP connector runtime", () => {
  it("does not mistake a child error for process exit", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 4325,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    }) as unknown as ChildProcess;
    const observed = observedConnectorChild(child);
    const waiting = observed.waitForExit(1_000);
    events.emit("error", new Error("signal delivery failed"));
    expect(await waiting).toBe(false);
    expect(observed.exitCode).toBeNull();
  });

  it("retains a group whose leader exited and never signals it by a stale PID", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 4326,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const observed = observedConnectorChild(child, true);
      expect(observed.exitCode).toBeNull();
      expect(await observed.waitForExit(0)).toBe(false);
      expect(observed.kill("SIGKILL")).toBe(false);
      expect(child.kill).not.toHaveBeenCalled();
      expect(signal.mock.calls).toEqual([
        [-4326, 0],
        [-4326, 0],
      ]);
      signal.mockImplementation(() => {
        throw Object.assign(new Error("absent"), { code: "ESRCH" });
      });
      expect(observed.exitCode).toBe(0);
      signal.mockClear();
      expect(observed.kill("SIGKILL")).toBe(false);
      expect(await observed.waitForExit(0)).toBe(true);
      expect(observed.exitCode).toBe(0);
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });

  it("does not retry a group signal or probe after permission refusal", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 4327,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      const observed = observedConnectorChild(child, true);
      expect(observed.kill("SIGTERM")).toBe(false);
      expect(await observed.waitForExit(0)).toBe(false);
      expect(observed.kill("SIGKILL")).toBe(false);
      Object.assign(child, { exitCode: 0 });
      expect(observed.exitCode).toBeNull();
      expect(await observed.waitForExit(0)).toBe(false);
      expect(signal.mock.calls).toEqual([[-4327, "SIGTERM"]]);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });

  it("requires absence of the whole group and fails closed after a refused probe", async () => {
    const events = new EventEmitter();
    const child = Object.assign(events, {
      pid: 4328,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    try {
      const observed = observedConnectorChild(child, true);
      expect(observed.exitCode).toBeNull();
      expect(await observed.waitForExit(0)).toBe(false);
      expect(observed.kill("SIGKILL")).toBe(false);
      expect(signal.mock.calls).toEqual([[-4328, 0]]);
    } finally {
      signal.mockRestore();
    }
  });

  it("classifies asynchronous spawn failure without crashing desktop", async () => {
    const selected = await fixture();
    const runtime = new SecureMcpConnectorRuntime({
      root: selected.runtimeRoot,
      homePath: selected.root,
      tempPath: selected.root,
    });
    const result = await runtime.start({
      executablePath: path.join(selected.root, "not-installed"),
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });
    expect(result).toMatchObject({
      state: "unreachable",
      code: "CONNECTOR_START_FAILED",
    });
    expect(runtime.isRunning()).toBe(false);
  });

  it("retains the original unknown spawn outcome and refuses a second launch or clean stop", async () => {
    const selected = await fixture();
    const start = vi.fn<ConnectorProcessStarter>(async () => {
      throw new Error("spawn acknowledgement lost after child creation");
    });
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      { start, id: () => "original-spawn" },
    );
    const original = {
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    };
    const first = await runtime.start(original);
    expect(first).toMatchObject({
      state: "outcome_unknown",
      code: "CONNECTOR_START_FAILED",
    });
    expect(runtime.isRunning()).toBe(true);
    expect(await runtime.start({ ...original, connectorGeneration: 2 })).toBe(
      first,
    );
    expect(start).toHaveBeenCalledTimes(1);
    await expect(runtime.stop()).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
    expect(runtime.isRunning()).toBe(true);
  });

  it("configures, diagnoses, starts, proves ready, and stops one owned daemon", async () => {
    const selected = await fixture();
    const run = vi.fn<ConnectorCommandRunner>(async () => ({
      stdout: "{}\n",
      stderr: "",
    }));
    const child = new FakeChild();
    const start = vi.fn<ConnectorProcessStarter>(async (command) => {
      const healthUrlFile = option(command, "--health.url-file");
      await fs.writeFile(healthUrlFile, "http://127.0.0.1:43123\n", {
        mode: 0o600,
      });
      return child;
    });
    let readinessChecks = 0;
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
        readinessTimeoutMs: 1_000,
      },
      {
        run,
        start,
        get: async (url) => {
          expect(url).toBe("http://127.0.0.1:43123/readyz");
          readinessChecks += 1;
          return readinessChecks > 1;
        },
        wait: async () => undefined,
        now: () => 1_789_516_800_000,
        id: () => "runtime-01",
      },
    );

    await runtime.configure({
      executablePath: selected.executablePath,
      tunnelId: "tunnel_farol_next",
      credentialReference: `file:${selected.credentialPath}`,
      mcp: {
        electronPath: selected.electronPath,
        entryPath: selected.mcpEntry,
        launchContractPath: selected.launchContract,
      },
    });
    await runtime.doctor({ executablePath: selected.executablePath });
    const started = await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 4,
      computerGeneration: 7,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });

    expect(run).toHaveBeenCalledTimes(2);
    const init = run.mock.calls[0]?.[0];
    expect(init?.arguments.slice(0, 2)).toEqual(["init", "--force"]);
    expect(init && option(init, "--profile")).toBe("farol-next");
    expect(init && option(init, "--tunnel-id")).toBe("tunnel_farol_next");
    expect(init && option(init, "--control-plane-api-key-ref")).toBe(
      `file:${selected.credentialPath}`,
    );
    expect(init && option(init, "--mcp-command")).toBe(
      [
        "/usr/bin/env",
        "ELECTRON_RUN_AS_NODE=1",
        selected.electronPath,
        selected.mcpEntry,
        "--launch-contract",
        selected.launchContract,
      ]
        .map((value) => `'${value}'`)
        .join(" "),
    );
    expect(run.mock.calls[1]?.[0].arguments).toEqual([
      "doctor",
      "--profile",
      "farol-next",
      "--profile-dir",
      path.join(selected.runtimeRoot, "profiles"),
      "--json",
      "--explain",
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    const runCommand = start.mock.calls[0]?.[0];
    expect(runCommand?.arguments[0]).toBe("run");
    expect(runCommand?.environment.TUNNEL_CLIENT_STATE_DIR).toBe(
      path.join(selected.runtimeRoot, "state"),
    );
    expect(started).toEqual({
      state: "ready",
      runtimeGeneration: createHash("sha256")
        .update(
          [
            "runtime-01",
            "a".repeat(64),
            "4",
            "7",
            "b".repeat(64),
            "c".repeat(64),
          ].join("\0"),
        )
        .digest("hex"),
      healthBaseUrl: "http://127.0.0.1:43123",
    });

    await runtime.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("retains the active child until stop has confirmed exit", async () => {
    const selected = await fixture();
    let exitCode: number | null = null;
    let finishExit!: (exited: boolean) => void;
    const child: ConnectorChild = {
      pid: 4322,
      get exitCode() {
        return exitCode;
      },
      kill: () => true,
      waitForExit: () =>
        new Promise<boolean>((resolve) => {
          finishExit = (exited) => {
            if (exited) exitCode = 0;
            resolve(exited);
          };
        }),
    };
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      {
        start: async (command) => {
          await fs.writeFile(
            option(command, "--health.url-file"),
            "http://127.0.0.1:43126\n",
            { mode: 0o600 },
          );
          return child;
        },
        get: async () => true,
      },
    );
    await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });
    const stopping = runtime.stop();
    await Promise.resolve();
    expect(runtime.isRunning()).toBe(true);
    finishExit(true);
    await stopping;
    expect(runtime.isRunning()).toBe(false);
  });

  it("refuses to confirm stop when the owned child survives both signals", async () => {
    const selected = await fixture();
    const signals: NodeJS.Signals[] = [];
    const child: ConnectorChild = {
      pid: 4323,
      exitCode: null,
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
      waitForExit: async () => false,
    };
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      {
        start: async (command) => {
          await fs.writeFile(
            option(command, "--health.url-file"),
            "http://127.0.0.1:43127\n",
            { mode: 0o600 },
          );
          return child;
        },
        get: async () => true,
      },
    );
    await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });
    await expect(runtime.stop()).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(runtime.isRunning()).toBe(true);
  });

  it("checks the owned ready endpoint without restarting and refuses stale in-flight health", async () => {
    const selected = await fixture();
    const child = new FakeChild();
    const start = vi.fn<ConnectorProcessStarter>(async (command) => {
      await fs.writeFile(
        option(command, "--health.url-file"),
        "http://127.0.0.1:43125\n",
        { mode: 0o600 },
      );
      return child;
    });
    const get = vi.fn(async (_url: string) => true);
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      { start, get },
    );
    expect(await runtime.checkHealth()).toBe(false);
    expect(get).not.toHaveBeenCalled();
    await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });
    get.mockClear();
    expect(await runtime.checkHealth()).toBe(true);
    expect(get).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:43125/readyz",
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual([]);
    get.mockResolvedValueOnce(false);
    expect(await runtime.checkHealth()).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    let release!: (value: boolean) => void;
    get.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const pending = runtime.checkHealth();
    await runtime.stop();
    release(true);
    expect(await pending).toBe(false);
    const before = get.mock.calls.length;
    expect(await runtime.checkHealth()).toBe(false);
    expect(get.mock.calls).toHaveLength(before);
  });

  it("does not auto-restart a daemon with an unknown readiness outcome", async () => {
    const selected = await fixture();
    const child = new FakeChild();
    const start = vi.fn<ConnectorProcessStarter>(async (command) => {
      await fs.writeFile(
        option(command, "--health.url-file"),
        "http://127.0.0.1:43124\n",
        { mode: 0o600 },
      );
      return child;
    });
    let now = 0;
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
        readinessTimeoutMs: 100,
      },
      {
        run: async () => ({ stdout: "", stderr: "" }),
        start,
        get: async () => false,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        now: () => now,
        id: () => "runtime-unknown",
      },
    );

    const result = await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 4,
      computerGeneration: 7,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });

    expect(result).toMatchObject({
      state: "outcome_unknown",
      code: "CONNECTOR_READINESS_TIMEOUT",
    });
    expect(start).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("keeps an unconfirmed child after readiness timeout fail closed", async () => {
    const selected = await fixture();
    const signals: NodeJS.Signals[] = [];
    const child: ConnectorChild = {
      pid: 4324,
      exitCode: null,
      kill: (signal) => {
        signals.push(signal);
        return true;
      },
      waitForExit: async () => false,
    };
    let now = 0;
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
        readinessTimeoutMs: 100,
      },
      {
        start: async () => child,
        wait: async (milliseconds) => {
          now += milliseconds;
        },
        now: () => now,
      },
    );
    const result = await runtime.start({
      executablePath: selected.executablePath,
      executableSha256: "a".repeat(64),
      connectorGeneration: 1,
      computerGeneration: 1,
      buildId: "b".repeat(64),
      launchContractSha256: "c".repeat(64),
    });
    expect(result.state).toBe("outcome_unknown");
    expect(runtime.isRunning()).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
