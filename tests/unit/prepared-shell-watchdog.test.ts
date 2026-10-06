import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
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
  it.each([
    "invalid-prepare",
    "invalid-control",
    "invalid-start",
    "invalid-exit",
    "invalid-close",
    "command-error",
    "stdin-epipe",
    "stdin-error",
    "dispatch-exception",
  ])(
    "emits only the closed %s reason and permanently consumes failure",
    (reason) => {
      const f = fixture();
      const privateText =
        "SYNTHETIC_PRIVATE_PATH_ENV_CODE_EXCEPTION_NEVER_SEND";
      const error = Object.assign(Error(privateText), {
        code: reason === "stdin-epipe" ? "EPIPE" : privateText,
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
        code: "EPIPE",
        message: "PRIVATE_EXCEPTION",
      });
      const sent = f.messages.length;
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
      expect(f.messages.filter((message) => message.type === "error")).toEqual(
        kind === "behind-output"
          ? []
          : [{ type: "error", id: f.id, reason: "stdin-epipe" }],
      );
      f.deliver();
      f.deliver(Error("PRIVATE_CALLBACK"));
      f.child.stdin.emit("error", { code: "EPIPE" });
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
      expect(f.signals).toEqual([[-4242, "SIGKILL"]]);
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
