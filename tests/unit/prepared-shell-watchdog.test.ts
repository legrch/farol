import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source";

// Pure VM: synthetic IPC, child, clock and self-group signals. This proves no
// native sandbox, actual Node IPC, filesystem, fork or cleanup qualification.
function fixture(mode: string | null = "go-prepared-v1", selected = true) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
  });
  const messages: Record<string, unknown>[] = [];
  const signals: [number, string][] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let now = 1000;
  let fault: "none" | "backpressure" | "callback" | "throw" = "none";
  let faultType = "";
  let refuseSignal = false;
  let holdType = "";
  let held: (() => void) | undefined;
  const process = Object.assign(new EventEmitter(), {
    pid: 4242,
    connected: true,
    env: mode === null ? {} : { FAROL_SHELL_WATCHDOG_MODE: mode },
    argv: selected
      ? ["/selected/node", "--farol-go-prepared-v1"]
      : ["/legacy/node"],
    exit: vi.fn(),
    send(message: Record<string, unknown>, callback?: (error?: Error) => void) {
      messages.push(message);
      if (message.type === faultType && fault === "throw")
        throw Error("synthetic IPC failure");
      if (message.type === holdType) held = () => callback?.();
      else
        callback?.(
          message.type === faultType && fault === "callback"
            ? Error("synthetic lost ACK")
            : undefined,
        );
      return !(message.type === faultType && fault === "backpressure");
    },
    kill(pid: number, signal: string) {
      signals.push([pid, signal]);
      if (refuseSignal) throw Error("synthetic signal refusal");
    },
  });
  const spawn = vi.fn(() => child);
  vm.runInNewContext(SHELL_WATCHDOG_SOURCE, {
    process,
    Buffer,
    require(name: string) {
      if (name === "node:child_process") return { spawn };
      if (name === "node:os") return { constants: { signals: { SIGKILL: 9 } } };
      throw Error("unexpected VM dependency");
    },
    Date: { now: () => now },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
  });
  const id = "a".repeat(64);
  const selection = {
    type: "prepare",
    id,
    executable: "/usr/bin/sandbox-exec",
    args: ["-p", "synthetic policy", "/bin/sh", "-c", "synthetic command"],
    cwd: "/fixture/workspace",
    environment: { PATH: "/usr/bin:/bin", HOME: "/fixture/home" },
    stdinBase64: Buffer.from("input\0bytes").toString("base64"),
    deadlineAt: 16000,
  };
  const message = (value: unknown) => process.emit("message", value);
  const prepare = () => message(selection);
  const start = () => {
    message({ type: "start", id });
    child.emit("spawn");
  };
  const stop = () => message({ type: "stop", id });
  const tick = (time: number) => {
    now = time;
    for (const [key, timer] of [...timers]) {
      if (timer.delay > time - 1000 || !timers.delete(key)) continue;
      timer.callback();
    }
  };
  return {
    child,
    process,
    messages,
    signals,
    timers,
    spawn,
    id,
    selection,
    message,
    prepare,
    start,
    stop,
    tick,
    fail(type: string, kind: typeof fault) {
      faultType = type;
      fault = kind;
    },
    refuseSignal() {
      refuseSignal = true;
    },
    hold(type: string) {
      holdType = type;
    },
    deliver() {
      held?.();
    },
  };
}

describe("explicitly selected prepared watchdog without native effects", () => {
  it("holds dispatch until the Go release and retains immutable selection", () => {
    const f = fixture();
    f.prepare();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.messages).toEqual([{ type: "prepared", id: f.id }]);
    expect([...f.timers.values()].map((timer) => timer.delay)).toEqual([15000]);
    f.selection.args[0] = "changed";
    f.selection.environment.PATH = "changed";
    f.selection.stdinBase64 = "";
    f.message({ type: "start", id: f.id });
    expect(f.messages).not.toContainEqual({ type: "ready", id: f.id });
    f.child.emit("spawn");
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      "/usr/bin/sandbox-exec",
      ["-p", "synthetic policy", "/bin/sh", "-c", "synthetic command"],
      {
        cwd: "/fixture/workspace",
        env: { PATH: "/usr/bin:/bin", HOME: "/fixture/home" },
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    expect(f.child.stdin.end).toHaveBeenCalledExactlyOnceWith(
      Buffer.from("input\0bytes"),
    );
    expect(f.messages).toContainEqual({ type: "ready", id: f.id });
    f.start();
    f.process.emit("disconnect");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each([
    "missing-prepare",
    "crossed-id",
    "expired",
    "extended",
    "extra-field",
    "oversize-args",
    "oversize-input",
    "noncanonical-input",
    "bad-environment",
    "repeated-prepare",
  ])("refuses %s before any command creation", (kind) => {
    const f = fixture();
    if (kind === "missing-prepare") f.message({ type: "start", id: f.id });
    else if (kind === "crossed-id") {
      f.prepare();
      f.message({ type: "start", id: "b".repeat(64) });
    } else if (kind === "expired") {
      f.prepare();
      f.tick(16000);
      f.start();
    } else if (kind === "extended")
      f.message({ ...f.selection, deadlineAt: 16001 });
    else if (kind === "extra-field") f.message({ ...f.selection, extra: true });
    else if (kind === "oversize-args")
      f.message({ ...f.selection, args: ["a".repeat(65537)] });
    else if (kind === "oversize-input")
      f.message({
        ...f.selection,
        stdinBase64: Buffer.alloc(1048577).toString("base64"),
      });
    else if (kind === "noncanonical-input")
      f.message({ ...f.selection, stdinBase64: "QQ" });
    else if (kind === "bad-environment")
      f.message({ ...f.selection, environment: { BAD: "\0" } });
    else {
      f.prepare();
      f.prepare();
    }
    f.prepare();
    f.start();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.signals).toEqual([]);
    expect(f.process.exit).toHaveBeenCalledTimes(1);
  });

  it.each(["prepared", "ready", "stop-requested"])(
    "freezes failed %s ACK without resend/replacement",
    (type) => {
      for (const kind of ["backpressure", "callback", "throw"] as const) {
        const f = fixture();
        f.fail(type, kind);
        f.prepare();
        if (type !== "prepared") f.start();
        if (type === "stop-requested") f.stop();
        f.start();
        f.stop();
        f.process.emit("error", Error("late"));
        f.process.emit("disconnect");
        expect(f.spawn).toHaveBeenCalledTimes(type === "prepared" ? 0 : 1);
        expect(
          f.messages.filter((message) => message.type === type),
        ).toHaveLength(1);
        expect(f.signals).toEqual(
          type === "prepared" ? [] : [[-4242, "SIGKILL"]],
        );
      }
    },
  );

  it("consumes stop before its delayed ACK and signals only its own current group", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stop-requested");
    f.stop();
    f.stop();
    expect(f.signals).toEqual([]);
    expect(
      f.messages.filter((message) => message.type === "stop-requested"),
    ).toHaveLength(1);
    f.deliver();
    f.stop();
    f.tick(16000);
    f.process.emit("disconnect");
    f.child.emit("close", 0, null);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each(["stop", "deadline", "disconnect", "error", "root-close"])(
    "never retries after signal refusal at %s",
    (trigger) => {
      const f = fixture();
      f.prepare();
      f.start();
      f.refuseSignal();
      if (trigger === "stop") f.stop();
      else if (trigger === "deadline") f.tick(16000);
      else if (trigger === "disconnect") f.process.emit("disconnect");
      else if (trigger === "error") f.process.emit("error", Error("synthetic"));
      else {
        f.child.emit("exit", 0, null);
        f.child.emit("close", 0, null);
      }
      f.stop();
      f.start();
      f.process.emit("SIGTERM");
      f.process.emit("SIGINT");
      f.tick(17000);
      f.child.emit("close", 0, null);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    },
  );

  it("keeps root exit independent of open descendant pipes and reports no cleanup proof", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.emit("exit", 7, null);
    f.child.stdout.emit("data", Buffer.from("tail"));
    expect(f.messages).toContainEqual({
      type: "exit",
      id: f.id,
      code: 7,
      signal: null,
    });
    expect(f.messages).toContainEqual({
      type: "stdout",
      id: f.id,
      data: "dGFpbA==",
    });
    expect(f.messages.some((message) => message.type === "close")).toBe(false);
    expect(f.signals).toEqual([]);
    f.tick(16000);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    expect(
      f.messages.every(
        (message) =>
          !Object.hasOwn(message, "groupCleanup") &&
          !Object.hasOwn(message, "descendantCleanup"),
      ),
    ).toBe(true);
  });

  it("flushes known close before its one stop, chunks bytes and caps total output", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.stdout.emit("data", Buffer.alloc(65536, 65));
    const output = f.messages.filter((message) => message.type === "stdout");
    expect(
      output.map(
        (message) => Buffer.from(message.data as string, "base64").length,
      ),
    ).toEqual([49152, 16384]);
    expect(
      output.every(
        (message) => Buffer.byteLength(JSON.stringify(message)) < 96 * 1024,
      ),
    ).toBe(true);
    f.child.emit("exit", null, "SIGKILL");
    f.hold("close");
    f.child.emit("close", null, "SIGKILL");
    expect(f.messages).toContainEqual({
      type: "close",
      id: f.id,
      code: null,
      signal: 9,
    });
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    const overflow = fixture();
    overflow.prepare();
    overflow.start();
    overflow.child.stdout.emit("data", Buffer.alloc(4 * 1024 * 1024));
    overflow.child.stderr.emit("data", Buffer.from("X"));
    overflow.child.stderr.emit("data", Buffer.from("Y"));
    expect(
      overflow.messages.filter((message) => message.type === "output-limit"),
    ).toHaveLength(1);
    expect(overflow.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each([null, "go-prepared-v1"])(
    "preserves legacy dispatch without explicit argv selection (env=%s)",
    (mode) => {
      const f = fixture(mode, false);
      f.message({
        type: "start",
        executable: "/legacy/command",
        args: [],
        cwd: "/legacy/work",
        environment: {},
        stdin: "",
        authorityDeadlineAt: 100000,
        commandDeadlineAt: 100000,
      });
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.messages).toContainEqual({ type: "ready", pid: undefined });
      f.process.emit("message", { type: "stop" });
      expect(f.signals).toEqual([[-4242, "SIGTERM"]]);
      f.tick(2000);
      expect(f.signals).toEqual([
        [-4242, "SIGTERM"],
        [-4242, "SIGKILL"],
      ]);
    },
  );
});
