// Cooperative single-writer lock for one checkout's Dev outputs. It covers
// stop -> proof -> replacement -> cleanup -> spawn of the new Dev. A kernel
// flock is held by a tiny child that exits when this process's pipe closes, so
// a crashed or killed launcher never leaves a stale lock to be reclaimed. The
// lock file itself is permanent; its pid/start text is diagnostics only.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const HOLDER = `import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.stdout.write("busy\\n")
    sys.stdout.flush()
    sys.exit(3)
os.ftruncate(fd, 0)
os.write(fd, (sys.argv[2] + "\\n").encode())
sys.stdout.write("locked\\n")
sys.stdout.flush()
sys.stdin.buffer.read()
`;

let held = null;

export function devLifecycleLockPath(root) {
  return path.join(root, "_output/.dev-lifecycle.lock");
}

export async function acquireDevLifecycleLock(
  root,
  { python = "/usr/bin/python3" } = {},
) {
  if (held) throw Error("DEV_LIFECYCLE_LOCK_ALREADY_HELD");
  const output = path.join(root, "_output");
  fs.mkdirSync(output, { recursive: true, mode: 0o755 });
  const info = fs.lstatSync(output);
  if (!info.isDirectory() || info.uid !== process.getuid())
    throw Error("DEV_LIFECYCLE_LOCK_UNAVAILABLE: _output is not owned");
  const child = spawn(
    python,
    [
      "-I",
      "-c",
      HOLDER,
      devLifecycleLockPath(root),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    ],
    { stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" } },
  );
  const answer = await new Promise((resolve) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(text.trim());
    });
    child.on("error", () => resolve("failed"));
    child.on("exit", () => resolve(text.trim() || "failed"));
  });
  if (answer !== "locked") {
    child.kill();
    throw Error(
      answer === "busy"
        ? "DEV_LIFECYCLE_BUSY: another task dev in this checkout is preparing or launching Dev. Wait until it has launched, then run task dev again."
        : "DEV_LIFECYCLE_LOCK_UNAVAILABLE",
    );
  }
  child.stdout.removeAllListeners("data");
  // Never keep this process alive for the lock alone.
  child.unref();
  child.stdin.unref();
  child.stdout.unref();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  held = {
    release: async () => {
      child.ref();
      child.stdin.end();
      await exited;
    },
  };
  return held;
}

// Idempotent; a no-op when this process holds no lock.
export async function releaseDevLifecycleLock() {
  const current = held;
  held = null;
  if (current) await current.release();
}
