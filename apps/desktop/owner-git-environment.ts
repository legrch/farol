import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import path from "node:path";

const OUTPUT_LIMIT = 64 * 1024;
const TOTAL_TIMEOUT_MS = 10_000;

export type OwnerGitEnvironment = Readonly<{
  path: string;
  source: "desktop-login-shell" | "owner-override";
  capturedAt: string;
  generation: number;
}>;

export class OwnerGitEnvironmentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function validOwnerSearchPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value
      .split(":")
      .every((entry) => path.isAbsolute(entry) && path.resolve(entry) === entry)
  );
}

// This process owner is intentionally outside Computer/MCP admission. A user
// action in Farol opts in to executing the account's trusted startup files.
export async function ownedProcess(
  executable: string,
  args: readonly string[],
  home: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
): Promise<Buffer> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new OwnerGitEnvironmentError("SHELL_ENV_TIMEOUT");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd: home,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let outputSize = 0;
    let stderrSize = 0;
    let stopped = false;
    let timedOut = false;
    let settled = false;
    let waitDeadline: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (waitDeadline) clearTimeout(waitDeadline);
      reject(new OwnerGitEnvironmentError(code));
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      waitDeadline = setTimeout(() => fail("SHELL_ENV_OUTCOME_UNKNOWN"), 2_000);
    }, remaining);
    child.stdout.on("data", (part: Buffer) => {
      outputSize += part.length;
      if (outputSize > OUTPUT_LIMIT) stop();
      else stdout.push(Buffer.from(part));
    });
    child.stderr.on("data", (part: Buffer) => {
      stderrSize += part.length;
      if (stderrSize > OUTPUT_LIMIT) stop();
    });
    child.on("error", () => stop());
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (waitDeadline) clearTimeout(waitDeadline);
      if (settled) return;
      // A shell may have left children in its process group after closing its
      // own pipes. A signal alone is not evidence that those children exited.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* no descendants */
        }
      }
      const groupGone = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      const finish = () => {
        if (timedOut) return fail("SHELL_ENV_TIMEOUT");
        if (
          stopped ||
          code !== 0 ||
          signal ||
          outputSize > OUTPUT_LIMIT ||
          stderrSize > OUTPUT_LIMIT
        )
          return fail("SHELL_ENV_OUTCOME_UNKNOWN");
        settled = true;
        resolve(Buffer.concat(stdout));
      };
      if (groupGone()) return finish();
      const groupDeadline = Date.now() + 2_000;
      const checkGroup = () => {
        if (groupGone()) return finish();
        if (Date.now() >= groupDeadline)
          return fail("SHELL_ENV_OUTCOME_UNKNOWN");
        waitDeadline = setTimeout(checkGroup, 25);
      };
      waitDeadline = setTimeout(checkGroup, 25);
    });
  });
}

function accountFields(
  raw: Buffer,
  username: string,
  uid: number,
): { home: string; shell: string } {
  const fields = raw.toString("utf8").trimEnd().split(":");
  if (
    fields.length !== 10 ||
    fields[0] !== username ||
    fields[2] !== String(uid)
  )
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  const home = fields[8]!,
    shell = fields[9]!;
  if (
    !path.isAbsolute(home) ||
    path.normalize(home) !== home ||
    !path.isAbsolute(shell) ||
    path.normalize(shell) !== shell
  )
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  return { home, shell };
}

export function parseOwnerPathFrame(raw: Buffer, nonce: string): string {
  const begin = Buffer.from(`\0FAROL_ENV_BEGIN_${nonce}\0`);
  const end = Buffer.from(`\0FAROL_ENV_END_${nonce}\0`);
  const start = raw.indexOf(begin);
  const finish = raw.indexOf(end);
  if (
    start < 0 ||
    finish <= start + begin.length ||
    raw.indexOf(begin, start + 1) !== -1 ||
    raw.indexOf(end, finish + 1) !== -1
  )
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  const framed = raw.subarray(start + begin.length, finish);
  if (framed.includes(0))
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(framed);
  } catch {
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  }
  if (!validOwnerSearchPath(value))
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  return value;
}

export async function captureOwnerGitEnvironment(
  generation: number,
  run: typeof ownedProcess = ownedProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<OwnerGitEnvironment> {
  const account = userInfo();
  if (
    platform !== "darwin" ||
    process.getuid?.() !== account.uid ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  const seed = {
    HOME: account.homedir,
    USER: account.username,
    LOGNAME: account.username,
    SHELL: "",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TERM: "dumb",
    ...(process.env.ZDOTDIR ? { ZDOTDIR: process.env.ZDOTDIR } : {}),
  };
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const identity = await run(
    "/usr/bin/id",
    ["-P", account.username],
    account.homedir,
    seed,
    deadline,
  );
  const { home, shell } = accountFields(
    identity,
    account.username,
    account.uid,
  );
  // Unsupported account shells leave Git unavailable. Base Shell/File/Computer
  // continue to use their existing, independently qualified paths.
  if (shell !== "/bin/zsh" && shell !== "/bin/bash")
    throw new OwnerGitEnvironmentError("GIT_SHIM_UNSUPPORTED");
  const nonce = randomBytes(16).toString("hex");
  const script = `printf '\\000FAROL_ENV_BEGIN_${nonce}\\000%s\\000FAROL_ENV_END_${nonce}\\000' "$PATH"`;
  const raw = await run(
    shell,
    ["-l", "-i", "-c", script],
    home,
    {
      ...seed,
      HOME: home,
      SHELL: shell,
    },
    deadline,
  );
  return {
    path: parseOwnerPathFrame(raw, nonce),
    source: "desktop-login-shell",
    capturedAt: new Date().toISOString(),
    generation,
  };
}
