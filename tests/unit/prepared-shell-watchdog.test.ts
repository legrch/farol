import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SandboxedWorkspaceShell } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source";

// Pure VM: synthetic IPC, child, clock and self-group signals. This proves no
// native sandbox, actual Node IPC, filesystem, fork or cleanup qualification.
function fixture(mode: string | null = "go-prepared-v1", selected = true) {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
    }),
    stderr: Object.assign(new EventEmitter(), {
      pause: vi.fn(),
      resume: vi.fn(),
    }),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    kill: vi.fn(() => true),
  });
  const messages: Record<string, unknown>[] = [];
  const signals: [number, string][] = [];
  const timers = new Map<
    number,
    { callback: () => void; delay: number; at: number }
  >();
  let nextTimer = 0;
  let now = 1000;
  let fault: "none" | "backpressure" | "callback" | "throw" = "none";
  let faultType = "";
  let refuseSignal = false;
  let holdType = "";
  const held: ((error?: Error) => void)[] = [];
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
      if (message.type === holdType) held.push((error) => callback?.(error));
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
      timers.set(id, { callback, delay, at: now + delay });
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
      if (timer.at > time || !timers.delete(key)) continue;
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
    setNow(time: number) {
      now = time; // Advance only the synthetic clock, without firing timers.
    },
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
    deliver(error?: Error) {
      held.shift()?.(error);
    },
  };
}

describe("explicitly selected prepared watchdog without native effects", () => {
  it("observes the cancelled original root and final output before supervisor shutdown", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stop-requested");
    f.child.stdout.resume.mockClear();
    f.child.stderr.resume.mockClear();
    f.stop();
    f.stop();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(f.signals).toEqual([]);
    expect(f.child.stdout.resume).toHaveBeenCalled();
    expect(f.child.stderr.resume).toHaveBeenCalled();
    f.child.stdout.emit("data", Buffer.from([0, 1, 255]));
    f.child.emit("exit", null, "SIGKILL");
    expect(f.signals).toEqual([]);
    f.hold("close");
    f.child.emit("close", null, "SIGKILL");
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
      "stop-requested",
      "stdout",
      "exit",
      "close",
    ]);
    expect(f.messages[3]?.data).toBe("AAH/");
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
  });

  it("retains an already observed root while cancellation awaits descendant pipe EOF", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.emit("exit", 7, null);
    f.stop();
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.signals).toEqual([]);
    f.child.stderr.emit("data", Buffer.from("tail"));
    f.child.emit("close", 7, null);
    expect(f.messages.at(-1)).toEqual({
      type: "close",
      id: f.id,
      code: 7,
      signal: null,
    });
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it("delivers an already queued stop ACK before final supervisor shutdown", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.emit("exit", 0, null);
    f.hold("close");
    f.child.emit("close", 0, null);
    f.stop();
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
      "exit",
      "close",
      "stop-requested",
    ]);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it("does not renew a cancelled root's deadline for open descendant pipes", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.stop();
    f.child.emit("exit", null, "SIGKILL");
    expect(f.messages.some((message) => message.type === "close")).toBe(false);
    f.tick(16000);
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    expect(f.messages.some((message) => message.type === "close")).toBe(false);
  });

  it.each(["false", "throw", "error-event"])(
    "freezes a %s original-root stop without alternate signals",
    (kind) => {
      const f = fixture();
      f.prepare();
      f.start();
      f.child.kill.mockImplementationOnce(() => {
        if (kind === "throw") throw Error("PRIVATE_NATIVE_ERROR");
        if (kind === "error-event")
          f.child.emit("error", Error("PRIVATE_NATIVE_ERROR"));
        return false;
      });
      f.stop();
      f.stop();
      f.tick(16000);
      f.process.emit("disconnect");
      f.process.emit("SIGTERM");
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
      expect(f.child.kill).toHaveBeenCalledTimes(1);
      expect(f.signals).toEqual([]);
      expect(
        f.messages.filter((message) => message.type === "signal-refused"),
      ).toHaveLength(1);
      expect(JSON.stringify(f.messages)).not.toContain("PRIVATE_NATIVE_ERROR");
    },
  );

  it.each([0, 7, 91])(
    "preserves root exit %i after early stdin EPIPE",
    (code) => {
      const f = fixture();
      f.prepare();
      f.start();
      f.child.stdin.emit("error", { code: "EPIPE", message: "PRIVATE_INPUT" });
      expect(f.signals).toEqual([]);
      f.child.stderr.emit("data", Buffer.from("real child diagnostic"));
      f.child.emit("exit", code, null);
      f.child.emit("close", code, null);
      expect(f.messages.map((message) => message.type)).toEqual([
        "prepared",
        "ready",
        "stderr",
        "exit",
        "close",
      ]);
      expect(f.messages.at(-1)).toEqual({
        type: "close",
        id: f.id,
        code,
        signal: null,
      });
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.messages)).not.toContain("PRIVATE_INPUT");
    },
  );

  it("does not turn stdin EPIPE into command completion or renew its deadline", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.stdin.emit("error", { code: "EPIPE" });
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
    ]);
    expect(f.signals).toEqual([]);
    f.tick(16000);
    expect(f.messages.at(-1)).toEqual({ type: "deadline", id: f.id });
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    f.start();
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps queued output and root facts after stdin EPIPE", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stdout");
    f.child.stdout.emit("data", Buffer.from("tail"));
    f.child.stdin.emit("error", { code: "EPIPE" });
    f.child.emit("exit", 7, null);
    f.child.emit("close", 7, null);
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
      "stdout",
      "exit",
      "close",
    ]);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it("still fences non-EPIPE stdin errors after an early close", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.stdin.emit("error", { code: "EPIPE" });
    f.child.stdin.emit("error", { code: "SYNTHETIC_OTHER" });
    expect(f.messages.at(-1)).toEqual({
      type: "error",
      id: f.id,
      reason: "stdin-error",
    });
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each([
    "invalid-prepare",
    "invalid-control",
    "invalid-start",
    "invalid-exit",
    "invalid-close",
    "command-error",
    "stdin-error",
    "dispatch-exception",
  ])(
    "emits only the closed %s reason and permanently consumes failure",
    (reason) => {
      const f = fixture();
      const privateText =
        "SYNTHETIC_PRIVATE_PATH_ENV_CODE_EXCEPTION_NEVER_SEND";
      const error = Object.assign(Error(privateText), {
        code: privateText,
        path: privateText,
        environment: privateText,
      });
      f.prepare();
      if (reason === "invalid-prepare")
        f.message({ ...f.selection, extra: privateText });
      else if (reason === "invalid-control")
        f.message({ type: "start", id: privateText });
      else if (reason === "dispatch-exception") {
        f.spawn.mockImplementationOnce(() => {
          throw error;
        });
        f.start();
      } else {
        f.start();
        if (reason === "invalid-start") f.start();
        else if (reason === "invalid-exit")
          f.child.emit("exit", null, privateText);
        else if (reason === "invalid-close")
          f.child.emit("close", null, privateText);
        else if (reason === "command-error") f.child.emit("error", error);
        else f.child.stdin.emit("error", error);
      }
      expect(f.messages.filter((message) => message.type === "error")).toEqual([
        { type: "error", id: f.id, reason },
      ]);
      expect(JSON.stringify(f.messages)).not.toContain(privateText);
      const attempted = f.spawn.mock.calls.length;
      const sent = f.messages.length;
      f.prepare();
      f.start();
      f.stop();
      // No child listeners exist when validation/spawn fails before ownership.
      if (f.child.listenerCount("error")) f.child.emit("error", error);
      if (f.child.stdin.listenerCount("error"))
        f.child.stdin.emit("error", error);
      f.child.emit("exit", 0, null);
      f.child.emit("close", 0, null);
      f.process.emit("disconnect");
      f.tick(17000);
      expect(f.spawn).toHaveBeenCalledTimes(attempted);
      expect(f.messages).toHaveLength(sent);
      expect(f.signals).toEqual(
        attempted && reason !== "dispatch-exception"
          ? [[-4242, "SIGKILL"]]
          : [],
      );
      expect(f.process.exit).toHaveBeenCalledTimes(f.signals.length ? 0 : 1);
    },
  );

  it.each([
    undefined,
    null,
    "EPIPE",
    { code: "OTHER_PRIVATE_CODE" },
    Error("EPIPE"),
  ])("does not infer EPIPE from arbitrary stdin text (%s)", (error) => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.stdin.emit("error", error);
    expect(f.messages.at(-1)).toEqual({
      type: "error",
      id: f.id,
      reason: "stdin-error",
    });
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each(["exit", "close"])(
    "classifies %s before ready without root facts",
    (type) => {
      const f = fixture();
      f.prepare();
      f.message({ type: "start", id: f.id });
      f.child.emit(type, 0, null);
      f.child.emit("spawn");
      expect(f.messages.map((message) => message.type)).toEqual([
        "prepared",
        "error",
      ]);
      expect(f.messages.at(-1)).toEqual({
        type: "error",
        id: f.id,
        reason: `invalid-${type}`,
      });
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    },
  );

  it("classifies expired start and start after stop without extending authority", () => {
    for (const kind of ["deadline", "stop"] as const) {
      const f = fixture();
      f.prepare();
      if (kind === "deadline") f.setNow(16000);
      else {
        f.hold("stop-requested");
        f.stop();
      }
      f.start();
      if (kind === "deadline")
        expect(f.messages.at(-1)).toEqual({
          type: "error",
          id: f.id,
          reason: "invalid-start",
        });
      else
        expect(f.messages.map((message) => message.type)).toEqual([
          "prepared",
          "stop-requested",
        ]);
      // A queued diagnostic is discarded by the SAME immediate stop.
      f.deliver();
      f.prepare();
      f.start();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.process.exit).toHaveBeenCalledTimes(1);
    }
  });

  it("redacts a synchronous stdin dispatch exception after the one spawn", () => {
    const f = fixture();
    f.child.stdin.end.mockImplementationOnce(() => {
      throw Error("PRIVATE_STDIN_INPUT");
    });
    f.prepare();
    f.start();
    f.start();
    expect(f.messages).toEqual([
      { type: "prepared", id: f.id },
      { type: "error", id: f.id, reason: "dispatch-exception" },
    ]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
  });

  it.each(["held", "callback", "throw", "behind-output"])(
    "keeps diagnostic failure one-shot under %s backpressure",
    (kind) => {
      const f = fixture();
      f.prepare();
      f.start();
      if (kind === "behind-output") {
        f.hold("stdout");
        f.fail("stdout", "backpressure");
        f.child.stdout.emit("data", Buffer.from("synthetic queued output"));
      } else if (kind === "held") {
        f.hold("error");
        f.fail("error", "backpressure");
      } else f.fail("error", kind as "callback" | "throw");
      f.child.stdin.emit("error", {
        code: "EIO",
        message: "PRIVATE_EXCEPTION",
      });
      const sent = f.messages.length;
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
      expect(f.messages.filter((message) => message.type === "error")).toEqual(
        kind === "behind-output"
          ? []
          : [{ type: "error", id: f.id, reason: "stdin-error" }],
      );
      f.deliver();
      f.deliver(Error("PRIVATE_CALLBACK"));
      f.child.stdin.emit("error", { code: "EIO" });
      f.child.emit("close", 0, null);
      f.start();
      f.stop();
      expect(f.messages).toHaveLength(sent);
      expect(JSON.stringify(f.messages)).not.toContain("PRIVATE");
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.signals).toHaveLength(1);
    },
  );

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
      for (const kind of ["callback", "throw"] as const) {
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

  it("waits for queued output callbacks without resending or losing root events", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stdout");
    f.fail("stdout", "backpressure");
    const bytes = Buffer.alloc(65540, 255);
    f.child.stdout.emit("data", bytes);
    f.child.stderr.emit("data", Buffer.from("tail"));
    f.child.emit("exit", 7, null);
    f.child.emit("close", 7, null);
    expect(f.signals).toEqual([]);
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
      "stdout",
    ]);
    expect(f.child.stdout.pause).toHaveBeenCalled();
    expect(f.child.stderr.pause).toHaveBeenCalled();
    f.deliver();
    expect(
      f.messages.filter((message) => message.type === "stdout"),
    ).toHaveLength(2);
    expect(f.signals).toEqual([]);
    f.deliver();
    expect(f.messages.map((message) => message.type)).toEqual([
      "prepared",
      "ready",
      "stdout",
      "stdout",
      "stderr",
      "exit",
      "close",
    ]);
    expect(
      Buffer.concat(
        f.messages
          .filter((message) => message.type === "stdout")
          .map((message) => Buffer.from(message.data as string, "base64")),
      ),
    ).toEqual(bytes);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    f.deliver();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.signals).toHaveLength(1);
  });

  it.each(["prepared", "ready", "stop-requested"])(
    "retains the single queued %s write until its callback",
    (type) => {
      const f = fixture();
      f.hold(type);
      f.fail(type, "backpressure");
      f.prepare();
      if (type !== "prepared") f.start();
      if (type === "stop-requested") f.stop();
      expect(f.signals).toEqual([]);
      expect(f.process.exit).not.toHaveBeenCalled();
      expect(
        f.messages.filter((message) => message.type === type),
      ).toHaveLength(1);
      f.deliver();
      if (type === "prepared") f.start();
      if (type !== "stop-requested") {
        f.child.emit("exit", 0, null);
        f.child.emit("close", 0, null);
      }
      expect(f.spawn).toHaveBeenCalledTimes(1);
      if (type === "stop-requested") {
        expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
        expect(f.signals).toEqual([]);
      } else expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
      expect(
        f.messages.filter((message) => message.type === type),
      ).toHaveLength(1);
    },
  );

  it("discards queued observations after disconnect without a second send", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stdout");
    f.child.stdout.emit("data", Buffer.from("queued"));
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    f.process.connected = false;
    f.process.emit("disconnect");
    const count = f.messages.length;
    f.deliver();
    expect(f.messages).toHaveLength(count);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("resumes pipes after output delivery but fences a callback failure permanently", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.child.stdout.resume.mockClear();
    f.child.stderr.resume.mockClear();
    f.hold("stdout");
    f.fail("stdout", "backpressure");
    f.child.stdout.emit("data", Buffer.from("first"));
    expect(f.child.stdout.resume).not.toHaveBeenCalled();
    f.deliver();
    expect(f.child.stdout.resume).toHaveBeenCalledTimes(1);
    expect(f.child.stderr.resume).toHaveBeenCalledTimes(1);
    f.child.stdout.emit("data", Buffer.from("second"));
    f.child.emit("exit", 0, null);
    f.child.emit("close", 0, null);
    f.deliver(Error("synthetic write failure"));
    f.deliver();
    f.start();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    expect(
      f.messages.some(
        (message) => message.type === "exit" || message.type === "close",
      ),
    ).toBe(false);
  });

  it.each(["bytes", "frames"])(
    "bounds pending %s when a callback stalls",
    (limit) => {
      const f = fixture();
      f.prepare();
      f.start();
      f.hold("stdout");
      f.fail("stdout", "backpressure");
      for (let index = 0; index < 20; index++)
        f.child.stdout.emit(
          "data",
          Buffer.alloc(limit === "bytes" ? 49152 : 1),
        );
      expect(
        f.messages.filter((message) => message.type === "stdout"),
      ).toHaveLength(1);
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
      f.deliver();
      f.child.emit("close", 0, null);
      expect(f.messages.some((message) => message.type === "close")).toBe(
        false,
      );
    },
  );

  it("keeps the original deadline while a send callback is missing", () => {
    const f = fixture();
    f.prepare();
    f.start();
    f.hold("stdout");
    f.fail("stdout", "backpressure");
    f.child.stdout.emit("data", Buffer.from("pending"));
    expect(f.signals).toEqual([]);
    f.tick(16000);
    expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
    f.deliver();
    expect(f.messages.some((message) => message.type === "deadline")).toBe(
      false,
    );
  });

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

describe("legacy synchronous spawn refusal without native effects", () => {
  const start = {
    type: "start",
    executable: "/synthetic/executor",
    args: ["-c", "synthetic command"],
    cwd: "/synthetic/workspace",
    environment: {},
    stdin: "",
    authorityDeadlineAt: 16000,
    commandDeadlineAt: 17000,
  };
  function refuseSpawn() {
    const f = fixture(null, false);
    f.spawn.mockImplementation(() => {
      throw Error("PRIVATE_SYNCHRONOUS_SPAWN_ERROR");
    });
    return f;
  }

  it("flushes the original generic error before the same controller exits", () => {
    const f = refuseSpawn();
    f.hold("error");
    f.message(start);
    expect(f.messages).toEqual([{ type: "error" }]);
    expect(f.process.exit).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    f.deliver();
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.timers.size).toBe(0);
    expect(f.signals).toEqual([]);
    expect(f.messages).toEqual([{ type: "error" }]);
    expect(JSON.stringify(f.messages)).not.toContain("PRIVATE");
  });

  it("bounds lost error ACK by the original earliest absolute deadline", () => {
    const f = refuseSpawn();
    f.hold("error");
    f.setNow(15000);
    f.message(start);
    expect([...f.timers.values()].map((timer) => timer.delay)).toEqual([1000]);
    f.tick(15999);
    expect(f.process.exit).not.toHaveBeenCalled();
    f.tick(16000);
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    f.deliver();
    f.message(start);
    f.stop();
    f.process.emit("disconnect");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.process.exit).toHaveBeenCalledTimes(1);
    expect(f.messages).toEqual([{ type: "error" }]);
    expect(f.signals).toEqual([]);
  });

  it.each(["throw", "callback"] as const)(
    "settles the same controller on an original error-frame %s failure",
    (fault) => {
      const f = refuseSpawn();
      f.fail("error", fault);
      f.message(start);
      expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.messages).toEqual([{ type: "error" }]);
      expect(f.timers.size).toBe(0);
      expect(f.signals).toEqual([]);
      f.message(start);
      expect(f.spawn).toHaveBeenCalledTimes(1);
    },
  );

  it("waits for the original callback during IPC backpressure", () => {
    const f = refuseSpawn();
    f.hold("error");
    f.fail("error", "backpressure");
    f.message(start);
    expect(f.process.exit).not.toHaveBeenCalled();
    f.deliver();
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.messages).toEqual([{ type: "error" }]);
    expect(f.signals).toEqual([]);
  });

  it.each(["stop", "SIGTERM", "SIGINT"])(
    "honors original %s while the error callback is held",
    (trigger) => {
      const f = refuseSpawn();
      f.hold("error");
      f.message(start);
      if (trigger === "stop") f.stop();
      else f.process.emit(trigger);
      expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.timers.size).toBe(0);
      f.deliver();
      f.message(start);
      expect(f.process.exit).toHaveBeenCalledTimes(1);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.messages).toEqual([{ type: "error" }]);
      expect(f.signals).toEqual([]);
    },
  );

  it.each(["disconnect", "error"])(
    "settles the original controller on %s without inventing a command close",
    (event) => {
      const f = refuseSpawn();
      f.hold("error");
      f.message(start);
      if (event === "disconnect") f.process.connected = false;
      f.process.emit(event);
      expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(f.timers.size).toBe(0);
      f.deliver();
      f.message(start);
      expect(f.spawn).toHaveBeenCalledTimes(1);
      expect(f.process.exit).toHaveBeenCalledTimes(1);
      expect(f.messages).toEqual([{ type: "error" }]);
      expect(f.signals).toEqual([]);
    },
  );

  it("does not start a fresh budget when the synchronous attempt spends its deadline", () => {
    const f = refuseSpawn();
    f.spawn.mockImplementation(() => {
      f.setNow(16000);
      throw Error("PRIVATE_SYNCHRONOUS_SPAWN_ERROR");
    });
    f.message(start);
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.messages).toEqual([]);
    expect(f.timers.size).toBe(0);
    expect(f.signals).toEqual([]);
  });

  it("refuses a NUL command before execution admission or dispatch reservation", async () => {
    const admitExecution = vi.fn(async () => {
      throw Error("UNEXPECTED_ADMISSION");
    });
    const reserve = vi.fn();
    const dispatch = vi.fn();
    type Args = ConstructorParameters<typeof SandboxedWorkspaceShell>;
    // These unused values cannot qualify authority: this fixture proves only
    // refusal before the authority or any workspace/native effect is accessed.
    const shell = new SandboxedWorkspaceShell(
      {} as Args[0],
      {} as Args[1],
      {} as Args[2],
      "/unused/private",
      () => 1000,
      "/unused/home",
      { admitExecution },
    );
    const input = {
      operationId: "synthetic-nul-command",
      workspaceId: "unused-workspace",
      relativeCwd: ".",
      command: "synthetic\0command",
      stdin: "permitted\0stdin",
      timeoutMs: 1000,
      write: false,
    };
    expect(
      await shell.start(input, undefined, dispatch, undefined, reserve),
    ).toEqual({
      ok: false,
      error: { code: "SHELL_INPUT_INVALID", retry: "never" },
    });
    expect(admitExecution).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(
      await shell.start({ ...input, command: "synthetic command" }),
    ).toEqual({
      ok: false,
      error: { code: "SHELL_AUTHORITY_REVOKED", retry: "never" },
    });
    expect(admitExecution).toHaveBeenCalledTimes(1);
  });

  it("revalidates a command changed during the original execution admission", async () => {
    type Args = ConstructorParameters<typeof SandboxedWorkspaceShell>;
    const input = {
      operationId: "synthetic-changed-command",
      workspaceId: "unused-workspace",
      relativeCwd: ".",
      command: "synthetic command",
      timeoutMs: 1000,
      write: false,
    };
    const approval = {} as Args[0];
    const participant = {} as Args[1];
    const admitExecution = vi.fn(async () => {
      input.command = "synthetic\0command";
      return {
        approval,
        participant,
        deadlineAt: 16000,
        current: async () => true,
      };
    });
    const shell = new SandboxedWorkspaceShell(
      approval,
      participant,
      {} as Args[2],
      "/unused/private",
      () => 1000,
      "/unused/home",
      { admitExecution },
    );
    expect(await shell.start(input)).toEqual({
      ok: false,
      error: { code: "SHELL_INPUT_INVALID", retry: "never" },
    });
    expect(admitExecution).toHaveBeenCalledTimes(1);
  });
});
