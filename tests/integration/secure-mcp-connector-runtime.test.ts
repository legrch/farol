import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorRuntimeEffectUnknown,
  SecureMcpConnectorRuntime,
  observedConnectorChild,
  type ConnectorChild,
  type ConnectorCommand,
  type ConnectorCommandRunner,
  type ConnectorProcessStarter,
} from "../../src/apps/desktop/secure-mcp-connector-runtime";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

const startInput = {
  executablePath: "/opt/homebrew/bin/tunnel-client",
  executableSha256: "a".repeat(64),
  connectorGeneration: 1,
  computerGeneration: 1,
  buildId: "b".repeat(64),
  launchContractSha256: "c".repeat(64),
};

async function observedRuntime() {
  const selected = await fixture();
  const anchor = Object.assign(new EventEmitter(), {
    pid: 4330,
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
  });
  const child = observedConnectorChild(
    anchor as unknown as ChildProcess,
    true,
    true,
  );
  const start = vi.fn<ConnectorProcessStarter>(async (command) => {
    await fs.writeFile(
      option(command, "--health.url-file"),
      "http://127.0.0.1:43128\n",
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
  return { runtime, anchor, child, start, get };
}

describe("secure MCP connector runtime", () => {
  it("forwards one content-free direct tunnel exit while its anchor stays alive (VM doubles)", async () => {
    const source = await fs.readFile(
      new URL(
        "../../src/apps/desktop/secure-mcp-connector-runtime.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const declaration = source.match(
      /const CONNECTOR_GROUP_ANCHOR = `[\s\S]*?`;/u,
    )?.[0];
    expect(declaration).toBeDefined();
    const script = runInNewContext(`${declaration}\nCONNECTOR_GROUP_ANCHOR`, {
      TUNNEL_EXITED: "farol-tunnel-exited-v1",
      TUNNEL_UNKNOWN: "farol-tunnel-unknown-v1",
    }) as string;
    const tunnel = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() });
    const anchor = Object.assign(new EventEmitter(), {
      pid: 4331,
      argv: ["node", "/fixture/tunnel", "run"],
      env: { ELECTRON_RUN_AS_NODE: "1", LANG: "en_US.UTF-8" },
      connected: true,
      stdin,
      send: vi.fn(),
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => tunnel);
    runInNewContext(script, {
      require: (name: string) => {
        expect(name).toBe("node:child_process");
        return { spawn };
      },
      process: anchor,
    });
    expect(spawn).toHaveBeenCalledExactlyOnceWith("/fixture/tunnel", ["run"], {
      env: { LANG: "en_US.UTF-8" },
      stdio: "ignore",
      windowsHide: true,
    });
    tunnel.emit("exit", 137, "SIGKILL");
    tunnel.emit("exit", 0, null);
    expect(anchor.send).toHaveBeenCalledExactlyOnceWith(
      "farol-tunnel-exited-v1",
      expect.any(Function),
    );
    expect(anchor.kill).not.toHaveBeenCalled();
    // Parent loss still closes the original owned group.
    stdin.emit("end");
    expect(anchor.kill).toHaveBeenCalledExactlyOnceWith(-4331, "SIGKILL");

    const errorTunnel = new EventEmitter();
    const errorAnchor = Object.assign(new EventEmitter(), {
      ...anchor,
      stdin: Object.assign(new EventEmitter(), { resume: vi.fn() }),
      send: vi.fn(),
      kill: vi.fn(),
    });
    runInNewContext(script, {
      require: () => ({ spawn: () => errorTunnel }),
      process: errorAnchor,
    });
    errorTunnel.emit("error", new Error("private child content"));
    errorTunnel.emit("exit", 0, null);
    expect(errorAnchor.send).toHaveBeenCalledExactlyOnceWith(
      "farol-tunnel-unknown-v1",
      expect.any(Function),
    );
    expect(errorAnchor.kill).toHaveBeenCalledExactlyOnceWith(-4331, "SIGKILL");
  });

  it("retains group ownership after tunnel exit and performs the original group cleanup", async () => {
    const { runtime, anchor, child, start, get } = await observedRuntime();
    const signal = vi.spyOn(process, "kill").mockImplementation(() => true);
    const ready = await runtime.start(startInput);
    expect(ready.state).toBe("ready");
    expect(runtime.getTunnelObservation()).toBeNull();
    anchor.emit("message", "farol-tunnel-exited-v1");
    anchor.emit("message", { content: "ignored late payload" });
    anchor.emit("error", new Error("ignored late error"));
    anchor.emit("disconnect");
    expect(child.exitCode).toBeNull();
    expect(runtime.isRunning()).toBe(true);
    expect(runtime.getTunnelObservation()).toEqual({
      state: "exited",
      runtimeGeneration: ready.runtimeGeneration,
    });
    get.mockClear();
    expect(await runtime.checkHealth()).toBe(false);
    expect(get).not.toHaveBeenCalled();
    await expect(runtime.start(startInput)).rejects.toThrow(
      "CONNECTOR_ALREADY_RUNNING",
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(signal).not.toHaveBeenCalled();
    // Model TERM timeout, then group closure after KILL without a real process.
    const waits = vi
      .spyOn(child, "waitForExit")
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        anchor.exitCode = 0;
        return true;
      });
    await runtime.stop();
    expect(signal.mock.calls).toEqual([
      [-4330, "SIGTERM"],
      [-4330, "SIGKILL"],
    ]);
    expect(waits.mock.calls).toEqual([[500], [1_000]]);
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.getTunnelObservation()).toBeNull();
  });

  it.each([
    ["start", "farol-tunnel-exited-v1"],
    ["health", "farol-tunnel-exited-v1"],
    ["start", "farol-tunnel-unknown-v1"],
    ["health", "farol-tunnel-unknown-v1"],
  ] as const)(
    "rechecks terminal tunnel identity after an async %s probe (%s)",
    async (phase, message) => {
      const { runtime, anchor, get } = await observedRuntime();
      if (phase === "health") await runtime.start(startInput);
      let release!: (ready: boolean) => void;
      let entered!: () => void;
      const probing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      get.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
            entered();
          }),
      );
      const pending =
        phase === "start" ? runtime.start(startInput) : runtime.checkHealth();
      await probing;
      anchor.emit("message", message);
      release(true);
      const result = await pending;
      if (phase === "start")
        expect(result).toMatchObject({
          state:
            message === "farol-tunnel-exited-v1"
              ? "unreachable"
              : "outcome_unknown",
          code:
            message === "farol-tunnel-exited-v1"
              ? "CONNECTOR_EXITED_BEFORE_READY"
              : "CONNECTOR_TUNNEL_OBSERVATION_UNKNOWN",
        });
      else expect(result).toBe(false);
      expect(runtime.isRunning()).toBe(true);
    },
  );

  it("ignores the old anchor when a new current child replaces an in-flight probe", async () => {
    const { runtime, anchor, start, get } = await observedRuntime();
    await runtime.start(startInput);
    let release!: (ready: boolean) => void;
    get.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const pending = runtime.checkHealth();
    anchor.exitCode = 0;
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    });
    const replacement = new FakeChild();
    start.mockImplementationOnce(async (command) => {
      await fs.writeFile(
        option(command, "--health.url-file"),
        "http://127.0.0.1:43128\n",
      );
      return replacement;
    });
    expect((await runtime.start(startInput)).state).toBe("ready");
    anchor.emit("message", "farol-tunnel-exited-v1");
    release(true);
    expect(await pending).toBe(false);
    expect(runtime.getTunnelObservation()).toBeNull();
    expect(await runtime.checkHealth()).toBe(true);
  });

  it.each([
    "probe",
    "before-read",
    "read",
    "timeout",
    "term-false",
    "term-true",
    "kill-false",
    "kill-true",
  ] as const)(
    "preserves replacement ownership when pending Start resumes at %s",
    async (phase) => {
      const selected = await fixture();
      // Supported injected A intentionally has no tunnelObservation.
      const original = new FakeChild();
      const kill = vi.spyOn(original, "kill");
      const replacement = Object.assign(new FakeChild(), {
        tunnelObservation: null as Exclude<
          ConnectorChild["tunnelObservation"],
          undefined
        >,
      });
      let now = 0;
      let release!: () => void;
      let entered!: () => void;
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const defer = async () => {
        entered();
        await gate;
      };
      const get = vi.fn(async (_url: string) => true);
      const wait = vi.fn(async (milliseconds: number) => {
        now += milliseconds;
      });
      let issued = 0;
      const start = vi.fn<ConnectorProcessStarter>(async (command) => {
        const first = issued++ === 0;
        if (
          first &&
          (phase === "timeout" ||
            phase.startsWith("term-") ||
            phase.startsWith("kill-"))
        )
          return original;
        await fs.writeFile(
          option(command, "--health.url-file"),
          first ? "http://127.0.0.1:43129\n" : "http://127.0.0.1:43130\n",
          { mode: 0o600 },
        );
        return first ? original : replacement;
      });
      const id = vi
        .fn()
        .mockReturnValueOnce("pending-A")
        .mockReturnValueOnce("ready-B");
      const runtime = new SecureMcpConnectorRuntime(
        {
          root: selected.runtimeRoot,
          homePath: selected.root,
          tempPath: selected.root,
          readinessTimeoutMs: 100,
        },
        { start, get, wait, now: () => now, id },
      );
      const read = vi.spyOn(
        runtime as unknown as {
          readHealthBaseUrl: () => Promise<string | null>;
        },
        "readHealthBaseUrl",
      );
      if (phase === "probe")
        get.mockImplementationOnce(async () => {
          await defer();
          return true;
        });
      if (phase === "read")
        read.mockImplementationOnce(async () => {
          await defer();
          return "http://127.0.0.1:43129";
        });
      if (phase === "before-read") get.mockResolvedValueOnce(false);
      if (phase === "before-read" || phase === "timeout")
        wait.mockImplementationOnce(async () => {
          await defer();
          now += phase === "timeout" ? 101 : 50;
        });
      if (phase.startsWith("term-") || phase.startsWith("kill-")) {
        kill.mockImplementation(() => true);
        const exit = vi.spyOn(original, "waitForExit");
        if (phase.startsWith("kill-")) exit.mockResolvedValueOnce(false);
        exit.mockImplementationOnce(async () => {
          await defer();
          return phase.endsWith("true");
        });
        // Subsequent Stop supplies the independent confirmation of A's closure.
        exit.mockImplementation(async () => {
          original.exitCode = 0;
          return true;
        });
      }
      const pending = runtime.start(startInput);
      await paused;
      await runtime.stop();
      expect(original.exitCode).toBe(0);
      const current = await runtime.start(startInput);
      expect(current.state).toBe("ready");
      const readsBefore = read.mock.calls.length;
      const signalsBefore = original.signals.length;
      const killCallsBefore = kill.mock.calls.length;
      release();
      expect(await pending).toEqual({
        state: "unreachable",
        runtimeGeneration: createHash("sha256")
          .update(
            [
              "pending-A",
              startInput.executableSha256,
              "1",
              "1",
              startInput.buildId,
              startInput.launchContractSha256,
            ].join("\0"),
          )
          .digest("hex"),
        code: "CONNECTOR_EXITED_BEFORE_READY",
      });
      expect(read.mock.calls).toHaveLength(readsBefore);
      expect(original.signals).toHaveLength(signalsBefore);
      expect(kill.mock.calls).toHaveLength(killCallsBefore);
      expect(replacement.signals).toEqual([]);
      expect(runtime.isRunning()).toBe(true);
      get.mockClear();
      expect(await runtime.checkHealth()).toBe(true);
      expect(get).toHaveBeenCalledExactlyOnceWith(
        "http://127.0.0.1:43130/readyz",
      );
      await expect(runtime.start(startInput)).rejects.toThrow(
        "CONNECTOR_ALREADY_RUNNING",
      );
      expect(start).toHaveBeenCalledTimes(2);
      expect(id).toHaveBeenCalledTimes(2);
      replacement.tunnelObservation = { state: "exited" };
      expect(runtime.getTunnelObservation()).toEqual({
        state: "exited",
        runtimeGeneration: current.runtimeGeneration,
      });
    },
  );

  it.each([
    undefined,
    null,
    0,
    {},
    { state: "exited" },
    "farol-tunnel-exited-v1-extra",
    "x".repeat(65_536),
    "farol-tunnel-unknown-v1",
  ])(
    "keeps malformed or unknown IPC sticky without a second Start (case %#)",
    async (message) => {
      const { runtime, anchor, start, get } = await observedRuntime();
      const ready = await runtime.start(startInput);
      anchor.emit("message", message);
      anchor.emit("message", "farol-tunnel-exited-v1");
      expect(runtime.getTunnelObservation()).toEqual({
        state: "outcome_unknown",
        runtimeGeneration: ready.runtimeGeneration,
      });
      get.mockClear();
      expect(await runtime.checkHealth()).toBe(false);
      expect(get).not.toHaveBeenCalled();
      expect(runtime.isRunning()).toBe(true);
      await expect(runtime.start(startInput)).rejects.toThrow(
        "CONNECTOR_ALREADY_RUNNING",
      );
      expect(start).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["disconnect", "error", "exit"])(
    "retains unknown after anchor %s without interpreting it as group closure",
    async (event) => {
      const { runtime, anchor, child } = await observedRuntime();
      await runtime.start(startInput);
      anchor.emit(event, new Error("private child content"));
      anchor.emit("message", "farol-tunnel-exited-v1");
      expect(runtime.getTunnelObservation()?.state).toBe("outcome_unknown");
      expect(child.exitCode).toBeNull();
      expect(runtime.isRunning()).toBe(true);
      expect(await runtime.checkHealth()).toBe(false);
    },
  );

  it("rejects readiness for unknown observation before the first probe", async () => {
    const { runtime, anchor, get, start } = await observedRuntime();
    anchor.emit("message", "farol-tunnel-unknown-v1");
    expect(await runtime.start(startInput)).toMatchObject({
      state: "outcome_unknown",
      code: "CONNECTOR_TUNNEL_OBSERVATION_UNKNOWN",
    });
    expect(get).not.toHaveBeenCalled();
    await expect(runtime.start(startInput)).rejects.toThrow(
      "CONNECTOR_ALREADY_RUNNING",
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("retains terminal observation and ownership when group cleanup is unconfirmed", async () => {
    const { runtime, anchor, child, start } = await observedRuntime();
    await runtime.start(startInput);
    anchor.emit("message", "farol-tunnel-exited-v1");
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(child, "waitForExit").mockResolvedValue(false);
    await expect(runtime.stop()).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
    expect(runtime.getTunnelObservation()?.state).toBe("exited");
    expect(runtime.isRunning()).toBe(true);
    await expect(runtime.start(startInput)).rejects.toThrow(
      "CONNECTOR_ALREADY_RUNNING",
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps an uncertain configure effect latched under its original invocation", async () => {
    const selected = await fixture();
    const run = vi.fn<ConnectorCommandRunner>(async () => {
      throw new Error("init reply lost after profile write");
    });
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      { run },
    );
    const input = {
      executablePath: selected.executablePath,
      tunnelId: "tunnel_farol_next",
      credentialReference: `file:${selected.credentialPath}`,
      mcp: {
        electronPath: selected.electronPath,
        entryPath: selected.mcpEntry,
        launchContractPath: selected.launchContract,
      },
    };
    await expect(runtime.configure(input)).rejects.toBeInstanceOf(
      ConnectorRuntimeEffectUnknown,
    );
    expect(runtime.hasUnresolvedEffect()).toBe(true);
    await expect(runtime.configure(input)).rejects.toThrow(
      "CONNECTOR_CONFIGURE_OUTCOME_UNKNOWN",
    );
    expect(run).toHaveBeenCalledTimes(1);
    await expect(runtime.stop()).rejects.toThrow("CONNECTOR_STOP_UNCONFIRMED");
  });

  it("treats a refused executable launch as known without latching a profile write", async () => {
    const selected = await fixture();
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      {
        run: async () => {
          throw Object.assign(new Error("not launched"), { code: "ENOENT" });
        },
      },
    );
    await expect(
      runtime.configure({
        executablePath: selected.executablePath,
        tunnelId: "tunnel_farol_next",
        credentialReference: `file:${selected.credentialPath}`,
        mcp: {
          electronPath: selected.electronPath,
          entryPath: selected.mcpEntry,
          launchContractPath: selected.launchContract,
        },
      }),
    ).rejects.toThrow("CONNECTOR_CONFIGURE_FAILED");
    expect(runtime.hasUnresolvedEffect()).toBe(false);
  });
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

  it("does not latch a refused child spawn before the spawn event", async () => {
    const selected = await fixture();
    const runtime = new SecureMcpConnectorRuntime(
      {
        root: selected.runtimeRoot,
        homePath: selected.root,
        tempPath: selected.root,
      },
      {
        id: () => {
          // Cwd disappears after preflight but before Node emits `spawn`.
          rmSync(selected.runtimeRoot, { recursive: true, force: true });
          return "missing-cwd";
        },
      },
    );
    const result = await runtime.start({
      executablePath: process.execPath,
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
    expect(runtime.hasUnresolvedEffect()).toBe(false);
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
