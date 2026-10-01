// A separate, bounded controller owns one sandboxed command. Its IPC channel
// closes when the Computer MCP process disappears, including an abrupt crash;
// then it terminates its own process group. It is not a task App Server.
// Reserved watchdog exit status preserves refusal if its IPC report is lost.
export const SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE = 84;

export const SHELL_WATCHDOG_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
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
    report({ type: "error" });
    process.exitCode = 1;
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
`;
