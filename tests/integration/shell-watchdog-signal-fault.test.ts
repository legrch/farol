import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { SandboxedWorkspaceShell } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

// Trusted watchdog bytes in a VM with synthetic child/IPC/timers/signals only.
// Native child creation and process.kill are never used by this fixture.
function watchdogFixture(refuse: (signal: string) => boolean = () => false) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4243,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  const messages: unknown[] = [];
  const signals: string[] = [];
  const processFixture = Object.assign(new EventEmitter(), {
    pid: 4242,
    connected: true,
    exitCode: 0,
    exit: vi.fn(),
    send(value: unknown, callback?: () => void): boolean {
      messages.push(value);
      callback?.();
      return true;
    },
    kill(pid: number, signal: string) {
      expect(pid).toBe(-4242);
      signals.push(signal);
      if (refuse(signal))
        throw Object.assign(new Error("synthetic signal refusal"), {
          code: "EPERM",
        });
    },
  });
  const launch = vi.fn(() => child);
  vm.runInNewContext(SHELL_WATCHDOG_SOURCE, {
    process: processFixture,
    require(name: string) {
      if (name !== "node:child_process") throw Error("NO_OTHER_VM_MODULE");
      return { spawn: launch };
    },
    Date: { now: () => 1000 },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  const start = () =>
    processFixture.emit("message", {
      type: "start",
      executable: "/fixture/executable",
      args: [],
      cwd: "/fixture/workspace",
      environment: {},
      authorityDeadlineAt: 100_000,
      commandDeadlineAt: 100_000,
      stdin: "",
    });
  const tick = (maximumDelay: number) => {
    const ready = [...timers].filter(
      ([, timer]) => timer.delay <= maximumDelay,
    );
    for (const [id, timer] of ready) {
      if (!timers.delete(id)) continue;
      timer.callback();
    }
  };
  return {
    child,
    timers,
    messages,
    signals,
    processFixture,
    launch,
    start,
    tick,
  };
}

describe("watchdog signal refusal without native effects", () => {
  it.each(["cancel", "deadline"])(
    "drains bounded final diagnostics after %s without another stop signal",
    (reason) => {
      const f = watchdogFixture();
      f.start();
      f.child.stdout.emit("data", Buffer.from("A"));
      if (reason === "cancel")
        f.processFixture.emit("message", { type: "stop" });
      else f.tick(100_000);
      f.child.stdout.emit("data", Buffer.from("B"));
      f.child.stderr.emit("data", Buffer.from("E"));
      f.child.emit("close", 7, null);
      const bytes = (stream: string) =>
        f.messages
          .filter((message) => (message as { type: string }).type === stream)
          .map((message) =>
            Buffer.from((message as { data: string }).data, "base64"),
          );
      expect(Buffer.concat(bytes("stdout")).toString()).toBe("AB");
      expect(Buffer.concat(bytes("stderr")).toString()).toBe("E");
      expect(f.messages).not.toContainEqual({ type: "output-limit" });
      expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    },
  );

  it("enforces the output ceiling while draining after cancellation", () => {
    const f = watchdogFixture();
    f.start();
    f.child.stdout.emit("data", Buffer.alloc(4 * 1024 * 1024));
    f.processFixture.emit("message", { type: "stop" });
    f.child.stderr.emit("data", Buffer.from("overflow"));
    f.child.stderr.emit("data", Buffer.from("more overflow"));
    f.child.emit("close", 7, null);
    expect(
      f.messages.filter(
        (message) => (message as { type: string }).type === "output-limit",
      ),
    ).toHaveLength(1);
    expect(f.messages).toContainEqual({
      type: "close",
      code: 7,
      signal: null,
      reason: "output-limit",
    });
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("stops forwarding tail output when cancellation encounters IPC backpressure", () => {
    const f = watchdogFixture();
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    const send = f.processFixture.send.bind(f.processFixture);
    f.processFixture.send = (value, callback) => {
      send(value, callback);
      return false;
    };
    f.child.stdout.emit("data", Buffer.from("last forwarded"));
    f.child.stderr.emit("data", Buffer.from("must not forward"));
    f.child.emit("close", 7, null);
    expect(
      f.messages.filter(
        (message) => (message as { type: string }).type === "stderr",
      ),
    ).toEqual([]);
    expect(f.messages).toContainEqual({
      type: "close",
      code: 7,
      signal: null,
      reason: "backpressure",
    });
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not escalate or resend after a refused TERM", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    f.tick(100_000);
    f.processFixture.emit("disconnect");
    f.processFixture.emit("message", { type: "stop" });
    f.child.emit("close", 0, null);
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.messages).toContainEqual({ type: "signal-refused" });
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
    expect(f.timers.size).toBe(0);
  });

  it("never repeats a refused escalation from the close callback", () => {
    const f = watchdogFixture((signal) => signal === "SIGKILL");
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    f.tick(1000);
    f.child.emit("close", null, "SIGTERM");
    f.processFixture.emit("disconnect");
    f.tick(100_000);
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(
      f.messages.filter(
        (v) => (v as { type: string }).type === "signal-refused",
      ),
    ).toHaveLength(1);
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("preserves refusal through disconnected IPC and terminal exit", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.processFixture.connected = false;
    f.processFixture.emit("disconnect");
    f.child.emit("close", 7, null);
    f.tick(100_000);
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("does not repeat a successful escalation in a synthetic close interleaving", () => {
    const f = watchdogFixture();
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    f.tick(1000);
    f.child.emit("close", null, "SIGTERM");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.messages).not.toContainEqual({ type: "signal-refused" });
  });

  it("does not mistake signalling success for a child exit", () => {
    const f = watchdogFixture();
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(
      f.messages.some((v) => (v as { type: string }).type === "close"),
    ).toBe(false);
    expect(f.processFixture.exit).not.toHaveBeenCalled();
  });

  it("keeps the owned controller waiting for the real command after refusal", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    f.tick(100_000);
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.processFixture.exit).not.toHaveBeenCalled();
    expect(
      f.messages.some((v) => (v as { type: string }).type === "close"),
    ).toBe(false);
    f.child.emit("close", 7, null);
    expect(f.messages).toContainEqual({
      type: "close",
      code: 7,
      signal: null,
      reason: "cancel",
    });
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("preserves a refused KILL after ordinary command completion", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.child.emit("close", 7, null);
    f.processFixture.emit("message", { type: "stop" });
    f.tick(100_000);
    expect(f.signals).toEqual(["SIGKILL"]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("retains refusal exit status when the final IPC send throws", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    f.processFixture.send = () => {
      throw Error("synthetic IPC loss");
    };
    expect(() => f.child.emit("close", 0, null)).not.toThrow();
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("does not spawn or signal after cancellation before start", () => {
    const f = watchdogFixture();
    f.processFixture.emit("message", { type: "stop" });
    f.start();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.signals).toEqual([]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(0);
  });

  it("does not lose sticky refusal on an asynchronous IPC error", () => {
    const f = watchdogFixture(() => true);
    f.start();
    f.processFixture.emit("message", { type: "stop" });
    expect(() =>
      f.processFixture.emit("error", Error("synthetic IPC error")),
    ).not.toThrow();
    f.child.emit("close", 0, null);
    expect(f.signals).toEqual(["SIGTERM"]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(84);
  });

  it("does not spawn after an IPC error before command start", () => {
    const f = watchdogFixture();
    expect(() =>
      f.processFixture.emit("error", Error("synthetic IPC error")),
    ).not.toThrow();
    f.start();
    expect(f.launch).not.toHaveBeenCalled();
    expect(f.signals).toEqual([]);
    expect(f.processFixture.exit).toHaveBeenCalledWith(0);
  });
});

const fixtureRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  for (const root of fixtureRoots.splice(0))
    await fs.rm(root, { recursive: true });
});

// Disposable filesystem, actual shell service; its watchdog is an EventEmitter.
// No command, sandbox-exec, OS signal, daemon or owner state is accessed.
async function shellFixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-shell-signal-fault-")),
  );
  fixtureRoots.push(root);
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "fixture-home");
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(home, { mode: 0o700 });
  const identity = await fs.lstat(workspace, { bigint: true });
  const binding = {
    ownerId: "fixture-owner",
    sessionId: "fixture-session",
    taskId: "fixture-task",
    taskEpoch: 1,
  };
  const expiresAt = Date.now() + 60_000;
  const approval: ComputerApproval = {
    ownerId: binding.ownerId,
    computerId: "fixture-computer",
    generation: 1,
    workspaces: [
      {
        workspaceId: "fixture",
        root: workspace,
        access: "write",
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
        },
        gitHistoryApproved: false,
        shellVerified: true,
      },
    ],
    capabilities: ["workspace.shell", "workspace.write"],
    network: "none",
    commands: "workspace",
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: "fixture-authority",
    ...binding,
    computerId: approval.computerId,
    computerGeneration: 1,
    workspaces: [
      {
        workspaceId: "fixture",
        mode: "subtree",
        root: workspace,
        access: "write",
      },
    ],
    capabilities: approval.capabilities,
    network: "none",
    commands: "workspace",
    expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, Date.now());
  if (!grant.ok) throw Error(grant.error.code);
  const participant = createParticipantAuthority(grant.value, {
    participantId: "fixture-main",
    role: "main",
    mutationOwnership: "task",
  });
  if (!participant.ok) throw Error(participant.error.code);
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    connected: true,
    send: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  const signals = vi.spyOn(process, "kill").mockImplementation(() => true);
  const shell = new SandboxedWorkspaceShell(
    approval,
    participant.value,
    binding,
    path.join(root, "private"),
    Date.now,
    home,
  );
  const started = await shell.start({
    operationId: "signal-fault",
    workspaceId: "fixture",
    relativeCwd: ".",
    command: "fixture-never-executed",
    timeoutMs: 30_000,
    write: true,
  });
  if (!started.ok) throw Error(started.error.code);
  expect(spawn).toHaveBeenCalledTimes(1);
  const terminal = shell.waitForTerminal(started.value.handle);
  const exitController = (code: number | null) => {
    child.connected = false;
    child.emit("disconnect");
    child.emit("exit", code, null);
    child.emit("close", code, null);
  };
  return {
    shell,
    child,
    signals,
    handle: started.value.handle,
    terminal,
    exitController,
  };
}

describe("actual shell service preserves watchdog signal refusal", () => {
  it("keeps IPC failure nonterminal and cancellation active until controller close", async () => {
    const f = await shellFixture();
    let terminal = false;
    void f.terminal.then(() => {
      terminal = true;
    });
    try {
      f.child.emit("message", { type: "ready", pid: 4243 });
      f.child.emit(
        "error",
        Object.assign(Error("synthetic IPC failure"), { code: "EPIPE" }),
      );
      await Promise.resolve();
      expect(terminal).toBe(false);
      expect(
        f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
      ).toMatchObject({
        ok: true,
        value: {
          state: "running",
          groupCleanup: "unverified",
          errorCode: "SHELL_WATCHDOG_LOST",
        },
      });
      expect(() =>
        f.child.emit(
          "error",
          Object.assign(Error("second synthetic IPC failure"), {
            code: "EPIPE",
          }),
        ),
      ).not.toThrow();
      f.child.send.mockClear();
      expect(f.shell.cancel(f.handle)).toMatchObject({
        ok: true,
        value: { state: "running", cancelRequested: true },
      });
      expect(f.child.send).toHaveBeenCalledExactlyOnceWith({ type: "stop" });
      expect(f.signals).not.toHaveBeenCalled();
      f.child.emit("message", { type: "signal-refused" });
    } finally {
      f.exitController(84);
      expect(await f.terminal).toBe("unverified");
    }
  });

  it("retains spawn failure until close without signalling an absent controller PID", async () => {
    const f = await shellFixture();
    let terminal = false;
    void f.terminal.then(() => {
      terminal = true;
    });
    Reflect.deleteProperty(f.child, "pid");
    f.child.emit(
      "error",
      Object.assign(Error("synthetic spawn failure"), { code: "ENOENT" }),
    );
    await Promise.resolve();
    expect(terminal).toBe(false);
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        state: "running",
        groupCleanup: "unverified",
        errorCode: "SHELL_SPAWN_FAILED",
      },
    });
    f.exitController(null);
    expect(await f.terminal).toBe("unverified");
    expect(f.signals).not.toHaveBeenCalled();
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        state: "exited",
        groupCleanup: "unverified",
        errorCode: "SHELL_SPAWN_FAILED",
      },
    });
  });

  it.each(["event", "exit-code"])(
    "keeps %s refusal unverified without backup signal or group probe",
    async (proof) => {
      const f = await shellFixture();
      if (proof === "event")
        f.child.emit("message", { type: "signal-refused" });
      f.exitController(proof === "exit-code" ? 84 : 0);
      expect(await f.terminal).toBe("unverified");
      expect(f.signals).not.toHaveBeenCalled();
      expect(
        f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
      ).toMatchObject({
        ok: true,
        value: {
          state: "exited",
          groupCleanup: "unverified",
          detachedCleanup: "unverified",
          errorCode: "SHELL_GROUP_CLEANUP_UNVERIFIED",
          exitCode: null,
          exitSignal: null,
        },
      });
      expect(await f.shell.closeAndWait()).toBe("unverified");
    },
  );

  it("does not classify a live controller as terminal on refusal receipt", async () => {
    const f = await shellFixture();
    try {
      f.child.emit("message", { type: "signal-refused" });
      expect(
        f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
      ).toMatchObject({
        ok: true,
        value: {
          state: "running",
          groupCleanup: "unverified",
          errorCode: "SHELL_GROUP_CLEANUP_UNVERIFIED",
          exitCode: null,
          exitSignal: null,
        },
      });
      expect(f.signals).not.toHaveBeenCalled();
    } finally {
      f.exitController(84);
      expect(await f.terminal).toBe("unverified");
    }
  });

  it("preserves the reported root exit without proving group cleanup", async () => {
    const f = await shellFixture();
    f.child.emit("message", { type: "signal-refused" });
    f.child.emit("message", { type: "close", code: 7, signal: null });
    f.exitController(84);
    expect(await f.terminal).toBe("unverified");
    expect(f.signals).not.toHaveBeenCalled();
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        state: "exited",
        groupCleanup: "unverified",
        exitCode: 7,
        exitSignal: null,
      },
    });
  });

  it("does not probe or retry when the parent's one lost-watchdog signal is refused", async () => {
    const f = await shellFixture();
    f.signals.mockImplementation(() => {
      throw Object.assign(Error("synthetic parent refusal"), { code: "EPERM" });
    });
    f.exitController(1);
    expect(await f.terminal).toBe("unverified");
    expect(f.signals.mock.calls).toEqual([[-4242, "SIGKILL"]]);
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        groupCleanup: "unverified",
        errorCode: "SHELL_GROUP_CLEANUP_UNVERIFIED",
      },
    });
  });

  it("distinguishes an observed absent lost-watchdog group from permission refusal", async () => {
    const f = await shellFixture();
    f.signals.mockImplementation(() => {
      throw Object.assign(Error("synthetic absent group"), { code: "ESRCH" });
    });
    f.exitController(1);
    expect(await f.terminal).toBe("confirmed");
    expect(f.signals.mock.calls).toEqual([[-4242, "SIGKILL"]]);
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        groupCleanup: "confirmed",
        detachedCleanup: "unverified",
        errorCode: "SHELL_WATCHDOG_LOST",
        exitCode: null,
        exitSignal: null,
      },
    });
  });

  it("keeps a late refusal sticky between group probes", async () => {
    const f = await shellFixture();
    let entered: () => void = () => {};
    const firstProbe = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.signals.mockImplementation((_pid, signal) => {
      if (signal === 0) entered();
      return true;
    });
    f.child.connected = false;
    f.child.emit("exit", 1, null);
    f.child.emit("close", 1, null);
    await firstProbe;
    f.child.emit("message", { type: "signal-refused" });
    f.signals.mockImplementation(() => {
      throw Object.assign(Error("synthetic absent group"), { code: "ESRCH" });
    });
    expect(await f.terminal).toBe("unverified");
    expect(f.signals.mock.calls).toEqual([
      [-4242, "SIGKILL"],
      [-4242, 0],
    ]);
  });

  it("awaits the final controller close before parent cleanup effects", async () => {
    const f = await shellFixture();
    f.signals.mockImplementation(() => {
      throw Object.assign(Error("synthetic absent group"), { code: "ESRCH" });
    });
    f.child.emit("exit", 1, null);
    expect(f.signals).not.toHaveBeenCalled();
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: { state: "running", groupCleanup: "pending" },
    });
    f.child.emit("message", { type: "signal-refused" });
    f.child.connected = false;
    f.child.emit("disconnect");
    f.child.emit("close", 1, null);
    expect(await f.terminal).toBe("unverified");
    expect(f.signals).not.toHaveBeenCalled();
  });

  it("waits for IPC disconnect even when close is already observed", async () => {
    const f = await shellFixture();
    f.child.emit("close", 1, null);
    expect(f.signals).not.toHaveBeenCalled();
    f.child.emit("message", { type: "signal-refused" });
    f.child.connected = false;
    f.child.emit("disconnect");
    expect(await f.terminal).toBe("unverified");
    expect(f.signals).not.toHaveBeenCalled();
  });

  it("retains normal reported exit and confirms only observed group absence", async () => {
    const f = await shellFixture();
    f.signals.mockImplementation(() => {
      throw Object.assign(Error("synthetic absent group"), { code: "ESRCH" });
    });
    f.child.emit("message", { type: "close", code: 7, signal: null });
    f.exitController(0);
    expect(await f.terminal).toBe("confirmed");
    expect(f.signals.mock.calls).toEqual([[-4242, 0]]);
    expect(
      f.shell.read({ handle: f.handle, stdoutOffset: 0, stderrOffset: 0 }),
    ).toMatchObject({
      ok: true,
      value: {
        state: "exited",
        groupCleanup: "confirmed",
        detachedCleanup: "unverified",
        exitCode: 7,
        exitSignal: null,
      },
    });
  });
});
