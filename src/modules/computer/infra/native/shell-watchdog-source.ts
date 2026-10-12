// A separate, bounded controller owns one sandboxed command. Its IPC channel
// closes when the Computer MCP process disappears, including an abrupt crash;
// then it terminates its own process group. It is not a task App Server.
// Reserved watchdog exit status preserves refusal if its IPC report is lost.
export const SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE = 84;

export const SHELL_WATCHDOG_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
// Explicit Go selection reuses this watchdog and Node's private JSON IPC.
// Legacy launches have no mode variable and retain the existing path below.
if (process.env?.FAROL_SHELL_WATCHDOG_MODE === "go-prepared-v1" &&
    process.argv?.[1] === "--farol-go-prepared-v1") {
  const { constants } = require("node:os");
  // Private, closed diagnostics only. Never forward exception/code/path text.
  const errorReason = Object.freeze({
    invalidPrepare: "invalid-prepare", invalidControl: "invalid-control",
    invalidStart: "invalid-start", invalidExit: "invalid-exit",
    invalidClose: "invalid-close", commandError: "command-error",
    stdinEpipe: "stdin-epipe", stdinError: "stdin-error",
    dispatchException: "dispatch-exception",
  });
  let selected = null;
  let command = null;
  let timer = null;
  let id = null;
  let started = false;
  let ready = false;
  let closed = false;
  let closeDelivered = false;
  let rootExited = false;
  let rootStopAttempted = false;
  let groupStopAttempted = false;
  let stopRefused = false;
  let stopped = false;
  let signalAttempted = false;
  let stopRequested = false;
  let channelFailed = false;
  let outputBytes = 0;
  const pending = [];
  let pendingBytes = 0;
  let sending = false;
  let pumping = false;
  const exact = (value, keys) => value && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  function stopNow() {
    if (stopped) return;
    stopped = true;
    pending.length = 0;
    pendingBytes = 0;
    if (timer) clearTimeout(timer);
    if (stopRefused) {
      // Retire only this observer. A refused signal remains unknown and
      // never authorizes another signal; helper exit is not root completion.
      process.exit(84); // SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE
      return;
    }
    if (!command) { process.exit(0); return; }
    if (signalAttempted) return;
    signalAttempted = true;
    try { process.kill(-process.pid, "SIGKILL"); }
    catch {
      // One failed signal freezes this resource. No escalation or PID probe.
      if (process.connected && !channelFailed) {
        try { process.send({ type: "signal-refused", id }); } catch {}
      }
    }
  }
  function refuseStop() {
    if (stopRefused) return;
    stopRefused = true;
    // ChildProcess.kill may synchronously emit an error before returning false.
    // Fence before callbacks can select any alternate shutdown signal.
    emit("signal-refused", {}, stopNow);
  }
  function stopCommand() {
    if (stopped || channelFailed || groupStopAttempted || stopRefused) return;
    if (!command) { stopNow(); return; }
    if (closed) return;
    // The retained root and this still-live group leader are the only signal
    // identities. A known root exit does not mean inherited pipes have closed.
    if (!rootExited) {
      if (rootStopAttempted) return;
      rootStopAttempted = true;
      try {
        if (!command.kill("SIGKILL")) { refuseStop(); return; }
      } catch { refuseStop(); return; }
      if (stopped || channelFailed || stopRefused) return;
    }
    // Keep the observer alive while ordinary same-group descendants receive
    // TERM and close inherited output. The original deadline still bounds this
    // drain; signal acceptance proves neither process-tree nor group cleanup.
    groupStopAttempted = true;
    try { process.kill(-process.pid, "SIGTERM"); }
    catch { refuseStop(); }
  }
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (!sending && pending.length && !stopped && !channelFailed) {
        if (!process.connected) { channelFailed = true; stopNow(); break; }
        const item = pending.shift();
        sending = true;
        let settled = false;
        try {
          // false can mean queued backpressure, not a failed send. Retain this
          // one attempt until its callback; never resend or send ahead of it.
          process.send(item.message, (error) => {
            if (settled) return;
            settled = true;
            sending = false;
            if (stopped || channelFailed) return;
            pendingBytes -= item.bytes;
            if (error || !process.connected) { channelFailed = true; stopNow(); return; }
            item.delivered?.();
            pump();
          });
        } catch { channelFailed = true; stopNow(); }
      }
    } finally {
      pumping = false;
      // A stop already queued behind close must receive its original ACK before
      // the observer exits. Neither message is resent or reordered.
      if (closeDelivered && !sending && !pending.length && !stopped && !channelFailed) {
        stopNow();
      }
      if (!sending && !pending.length && !stopped && !closed && !channelFailed) {
        command?.stdout.resume();
        command?.stderr.resume();
      }
    }
  }
  function emit(type, fields = {}, delivered) {
    if (stopped || channelFailed || !process.connected) { stopNow(); return false; }
    const message = { type, id, ...fields };
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    // Includes the one in-flight message. Paused pipes normally leave only one
    // read chunk buffered; cap both bytes and frames even for tiny chunks.
    if (bytes > 96 * 1024 || pendingBytes + bytes > 256 * 1024 ||
        pending.length + Number(sending) >= 16) {
      channelFailed = true; stopNow(); return false;
    }
    pending.push({ message, bytes, delivered });
    pendingBytes += bytes;
    command?.stdout.pause();
    command?.stderr.pause();
    pump();
    return !stopped && !channelFailed;
  }
  function refuse(reason) { emit("error", { reason }); stopNow(); }
  function output(type, chunk) {
    if (!ready || closed || stopped || channelFailed) return;
    outputBytes += chunk.length;
    if (outputBytes > 4 * 1024 * 1024) { emit("output-limit"); stopNow(); return; }
    // Keep every private output frame below Go's 96 KiB bound.
    for (let offset = 0; offset < chunk.length; offset += 48 * 1024) {
      if (!emit(type, { data: chunk.subarray(offset, offset + 48 * 1024).toString("base64") })) return;
    }
  }
  process.on("disconnect", stopNow);
  process.on("error", () => { channelFailed = true; stopNow(); });
  process.on("SIGTERM", () => {
    // Our own anchored-group TERM also reaches the observer. Remain alive to
    // receive the retained child exit/EOF; the original timer is still armed.
    if (!groupStopAttempted) stopNow();
  });
  process.on("SIGINT", stopNow);
  process.on("message", (message) => {
    if (stopped || channelFailed) return;
    if (message?.type === "prepare") {
      if (selected || started || !exact(message, ["type", "id", "executable", "args", "cwd", "environment", "stdinBase64", "deadlineAt"]) ||
          typeof message.id !== "string" || !/^[a-f0-9]{64}$/.test(message.id) ||
          typeof message.executable !== "string" || !message.executable.startsWith("/") || message.executable.includes("\0") ||
          typeof message.cwd !== "string" || !message.cwd.startsWith("/") || message.cwd.includes("\0") ||
          !Array.isArray(message.args) || message.args.length > 256 ||
          message.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
          message.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 64 * 1024 ||
          !message.environment || typeof message.environment !== "object" || Array.isArray(message.environment) ||
          Object.keys(message.environment).length > 64 ||
          Object.entries(message.environment).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) ||
          Object.entries(message.environment).reduce((total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value) + 1, 0) > 64 * 1024 ||
          typeof message.stdinBase64 !== "string" || message.stdinBase64.length > 1398104 ||
          !Number.isSafeInteger(message.deadlineAt) || message.deadlineAt <= Date.now() || message.deadlineAt > Date.now() + 15000) {
        refuse(errorReason.invalidPrepare); return;
      }
      const input = Buffer.from(message.stdinBase64, "base64");
      if (input.length > 1024 * 1024 || input.toString("base64") !== message.stdinBase64) { refuse(errorReason.invalidPrepare); return; }
      id = message.id;
      selected = { ...message, args: [...message.args], environment: { ...message.environment }, input };
      timer = setTimeout(() => { emit("deadline"); stopNow(); }, message.deadlineAt - Date.now());
      emit("prepared");
      return;
    }
    if (!exact(message, ["type", "id"]) || !selected || message.id !== id) { refuse(errorReason.invalidControl); return; }
    if (message.type === "stop") {
      if (stopRequested) return;
      stopRequested = true;
      // ACK remains intent only. Observe the original root stop through exit
      // and pipe EOF before the supervisor performs its own final shutdown.
      emit("stop-requested", {}, stopCommand);
      return;
    }
    if (message.type !== "start" || started || stopRequested || Date.now() >= selected.deadlineAt) { refuse(errorReason.invalidStart); return; }
    started = true; // Consumed before the one spawn, including unknown failure.
    try {
      command = spawn(selected.executable, selected.args, {
        cwd: selected.cwd, env: selected.environment, detached: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      command.once("spawn", () => {
        if (stopped || channelFailed || Date.now() >= selected.deadlineAt) { stopNow(); return; }
        ready = true;
        emit("ready");
      });
      command.stdout.on("data", (chunk) => output("stdout", chunk));
      command.stderr.on("data", (chunk) => output("stderr", chunk));
      command.on("error", () => {
        if (rootStopAttempted) refuseStop();
        else refuse(errorReason.commandError);
      });
      command.once("exit", (code, signal) => {
        if (stopped) return;
        const number = signal === null ? null : constants.signals[signal];
        if (!ready || (signal !== null && !Number.isInteger(number))) { refuse(errorReason.invalidExit); return; }
        // Root exit is useful even while a descendant keeps a stdio pipe open.
        rootExited = true;
        emit("exit", { code, signal: number });
      });
      command.on("close", (code, signal) => {
        if (closed || stopped) return;
        closed = true;
        const number = signal === null ? null : constants.signals[signal];
        if (!ready || (signal !== null && !Number.isInteger(number))) { refuse(errorReason.invalidClose); return; }
        // Node close follows root exit AND its stdio closure. This supplies root
        // facts only, never descendant/group settlement. Flush before self-stop.
        emit("close", { code, signal: number }, () => { closeDelivered = true; });
      });
      command.stdin.on("error", (error) => {
        // A command may deliberately close stdin early (head, an argument error,
        // or a fast exit). EPIPE says nothing about root exit or output drain.
        // Keep observing that SAME child instead of killing away its diagnostics.
        // This is not an input-consumption ACK and does not extend the deadline.
        if (error?.code === "EPIPE") return;
        refuse(errorReason.stdinError);
      });
      command.stdin.end(selected.input);
    } catch { refuse(errorReason.dispatchException); }
  });
} else {
let command = null;
let deadline = null;
let escalation = null;
let stopped = false;
let outputStopped = false;
let stopReason = null;
let signalRefused = false;
let killSent = false;
const outputBytes = { stdout: 0, stderr: 0 };
function report(value) {
  if (process.connected) {
    try {
      if (!process.send(value)) stop("backpressure");
    } catch { stop("backpressure"); }
  }
}
function signalGroup(signal) {
  // The watchdog is the detached group leader. Its child joins that group,
  // so the parent can stop the whole owned group even before the ready IPC.
  if (signalRefused || killSent) return false;
  if (signal === "SIGKILL") killSent = true;
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch {
    // A refusal is not evidence of exit and never permits another signal.
    signalRefused = true;
    report({ type: "signal-refused" });
    return false;
  }
}
function stop(reason) {
  if (["backpressure", "output-limit", "disconnect", "ipc-error"].includes(reason)) {
    outputStopped = true;
    if (stopped && (reason === "backpressure" || reason === "output-limit"))
      stopReason = reason;
  }
  if (stopped) return;
  stopped = true;
  stopReason = reason;
  if (!command) {
    if (process.connected) {
      process.send({ type: "close", code: null, signal: null, reason }, () => process.exit(0));
    } else {
      process.exit(0);
    }
    return;
  }
  if (!signalGroup("SIGTERM")) return;
  escalation = setTimeout(() => signalGroup("SIGKILL"), 1000);
}
function output(stream, chunk) {
  // Cancellation still drains final diagnostics, within the original byte ceiling.
  if (outputStopped) return;
  outputBytes[stream] += chunk.length;
  if (outputBytes.stdout + outputBytes.stderr > 4 * 1024 * 1024) {
    report({ type: "output-limit" });
    stop("output-limit");
    return;
  }
  report({ type: stream, data: chunk.toString("base64") });
}
process.on("disconnect", () => stop("disconnect"));
// IPC send failures can arrive asynchronously on the process emitter.
process.on("error", () => stop("ipc-error"));
process.on("SIGTERM", () => stop("signal"));
process.on("SIGINT", () => stop("signal"));
process.on("message", (message) => {
  if (message?.type === "stop") { stop("cancel"); return; }
  if (message?.type !== "start" || command || stopped) return;
  const authorityDeadlineAt = message.authorityDeadlineAt;
  const commandDeadlineAt = message.commandDeadlineAt;
  if (!Number.isSafeInteger(authorityDeadlineAt) ||
      !Number.isSafeInteger(commandDeadlineAt)) {
    report({ type: "error" });
    stop("invalid-deadline");
    return;
  }
  const firstDeadline = Math.min(authorityDeadlineAt, commandDeadlineAt);
  const deadlineReason = authorityDeadlineAt <= commandDeadlineAt
    ? "authority" : "timeout";
  if (Date.now() >= firstDeadline) {
    report({ type: "deadline", reason: deadlineReason });
    stop("deadline-before-spawn");
    return;
  }
  try {
    command = spawn(message.executable, message.args, {
      cwd: message.cwd,
      env: message.environment,
      detached: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // No command handle was returned; only this controller has a known close.
    // Flush its generic error before exit, bounded by the original deadline.
    // Never invent a command-close receipt or retry a synchronous rejection.
    stopped = true;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (deadline) clearTimeout(deadline);
      process.removeListener("disconnect", finish);
      process.removeListener("error", finish);
      process.removeListener("message", onStop);
      process.removeListener("SIGTERM", finish);
      process.removeListener("SIGINT", finish);
      process.exit(1);
    };
    // Cancellation can abandon an unacknowledged diagnostic frame; it still
    // closes only this controller, with command outcome/cleanup unproved.
    const onStop = (message) => {
      if (message?.type === "stop") finish();
    };
    const remaining = firstDeadline - Date.now();
    if (remaining <= 0 || !process.connected) {
      finish();
      return;
    }
    deadline = setTimeout(finish, remaining);
    process.once("disconnect", finish);
    process.once("error", finish);
    process.on("message", onStop);
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
    try { process.send({ type: "error" }, finish); }
    catch { finish(); }
    return;
  }
  command.stdout.on("data", (chunk) => output("stdout", chunk));
  command.stderr.on("data", (chunk) => output("stderr", chunk));
  command.on("error", () => report({ type: "error" }));
  command.on("close", (code, signal) => {
    if (deadline) clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    // A shell can exit while a background child in the same group survives.
    const finish = () => {
      if (!signalRefused) signalGroup("SIGKILL");
      if (signalRefused) process.exit(${SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE});
    };
    if (process.connected) {
      try {
        process.send({ type: "close", code, signal, reason: stopReason }, finish);
      } catch { finish(); }
    } else {
      finish();
    }
  });
  deadline = setTimeout(() => {
    report({ type: "deadline", reason: deadlineReason });
    stop("deadline");
  }, Math.max(1, firstDeadline - Date.now()));
  command.stdin.on("error", () => {});
  command.stdin.end(message.stdin);
  report({ type: "ready", pid: command.pid });
});
}
`;
