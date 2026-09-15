import { spawn } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;

function terminateOwnedProcessGroup(child) {
  const pid = child.pid;
  if (process.platform !== "win32" && Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export function runBoundedProcess(command, arguments_, options) {
  const timeoutMs = options.timeoutMs;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const terminationGraceMs =
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 1 ||
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs < 1
  ) {
    throw new Error("E2E_CHILD_BOUND_INVALID");
  }

  const child = spawn(command, arguments_, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let failure = null;
    let terminationFailure = null;
    let terminationTimer = null;

    const timeout = setTimeout(() => {
      terminate("E2E_CHILD_TIMEOUT");
    }, timeoutMs);

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      callback(value);
    };

    const failureError = () => {
      const error = new Error(failure ?? "E2E_CHILD_FAILED");
      if (terminationFailure) error.cause = terminationFailure;
      return error;
    };

    function terminate(code) {
      if (settled || failure) return;
      failure = code;
      try {
        terminateOwnedProcessGroup(child);
      } catch (error) {
        terminationFailure = error;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      terminationTimer = setTimeout(() => {
        settle(reject, failureError());
      }, terminationGraceMs);
    }

    const append = (current, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = outputLimit - current.length;
      if (bytes.length > remaining) {
        terminate("E2E_CHILD_OUTPUT_LIMIT");
        return Buffer.concat([
          current,
          bytes.subarray(0, Math.max(0, remaining)),
        ]);
      }
      return Buffer.concat([current, bytes]);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (failure) {
        terminationFailure ??= error;
        settle(reject, failureError());
        return;
      }
      settle(reject, error);
    });
    child.on("close", (status, signal) => {
      if (failure) {
        settle(reject, failureError());
        return;
      }
      settle(resolve, {
        status,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}
