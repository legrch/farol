// A separate, bounded controller owns one sandboxed command. Its IPC channel
// closes when the Computer MCP process disappears, including an abrupt crash;
// then it terminates its own process group. It is not a task App Server.
export const SHELL_WATCHDOG_SOURCE = String.raw`
"use strict";
const { spawn } = require("node:child_process");
let command = null;
let deadline = null;
let escalation = null;
let stopped = false;
let stopReason = null;
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
  try { process.kill(-process.pid, signal); } catch { /* already exited */ }
}
function stop(reason) {
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
  signalGroup("SIGTERM");
  escalation = setTimeout(() => signalGroup("SIGKILL"), 1000);
}
function output(stream, chunk) {
  if (stopped) return;
  outputBytes[stream] += chunk.length;
  if (outputBytes.stdout + outputBytes.stderr > 4 * 1024 * 1024) {
    report({ type: "output-limit" });
    stop("output-limit");
    return;
  }
  report({ type: stream, data: chunk.toString("base64") });
}
process.on("disconnect", () => stop("disconnect"));
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
    if (process.connected) {
      process.send({ type: "close", code, signal, reason: stopReason }, () => {
        signalGroup("SIGKILL");
      });
    } else {
      signalGroup("SIGKILL");
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
