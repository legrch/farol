import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import type { Writable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";

const HELPER_SHA256 =
  "13eae79f4600e7e5ebe679582a8eafaf96b49ae550fefff2785b8af40c7eed1a";
const MAX_HELPER_BYTES = 64 * 1024;
const APP_NAME = "Farol Next Preview.app";
const execFileAsync = promisify(execFile);
const sha = /^[0-9a-f]{64}$/u;

export interface AcceptedInstalledBuild {
  readonly digest: string;
  readonly version: string;
  readonly buildId: string;
}

export interface InstalledUpdateRequest {
  readonly action: "apply" | "recover" | "rollback";
  readonly operationId: string;
  readonly source: AcceptedInstalledBuild;
  readonly target: AcceptedInstalledBuild;
  /** Lead has reconciled all active work and the existing promotion obligations. */
  readonly drain: {
    readonly status: "reconciled";
    readonly acceptedSource: string;
    readonly acceptedTarget: string;
  };
  readonly pid: number;
  readonly processStart: string;
  readonly waitSeconds: number;
  readonly relaunch: boolean;
}

function assertInput(input: InstalledUpdateRequest): void {
  const validBuild = (value: AcceptedInstalledBuild): boolean =>
    !!value &&
    sha.test(value.digest) &&
    sha.test(value.buildId) &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version);
  if (
    !["apply", "recover", "rollback"].includes(input.action) ||
    !/^[0-9a-f]{32}$/u.test(input.operationId) ||
    !validBuild(input.source) ||
    !validBuild(input.target) ||
    input.source.digest === input.target.digest ||
    input.drain?.status !== "reconciled" ||
    input.drain.acceptedSource !== input.source.buildId ||
    input.drain.acceptedTarget !== input.target.buildId ||
    !Number.isSafeInteger(input.pid) ||
    input.pid <= 1 ||
    typeof input.processStart !== "string" ||
    !input.processStart.trim() ||
    !Number.isSafeInteger(input.waitSeconds) ||
    input.waitSeconds < 1 ||
    input.waitSeconds > 120 ||
    typeof input.relaunch !== "boolean" ||
    (input.action !== "apply" && input.relaunch)
  ) {
    throw new Error("INSTALLED_UPDATE_INPUT_INVALID");
  }
}

async function helperBytes(helperPath: string): Promise<Buffer> {
  if (
    !path.isAbsolute(helperPath) ||
    path.normalize(helperPath) !== helperPath
  ) {
    throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
  }
  const handle = await fs.open(
    helperPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_HELPER_BYTES ||
      before.uid !== process.geteuid?.() ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(bytes).digest("hex") !== HELPER_SHA256
    ) {
      throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Capture once while the exact installed app process is still alive. */
export async function captureInstalledProcessStart(
  pid: number,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("INSTALLED_UPDATE_PID_INVALID");
  const { stdout, stderr } = await execFileAsync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart="],
    { timeout: 3000, maxBuffer: 4096 },
  );
  if (stderr || !stdout.trim()) throw new Error("INSTALLED_UPDATE_PID_UNKNOWN");
  return stdout.trim();
}

/**
 * Start the external helper before normal app Quit. Its durable journal is the
 * result; a returned child PID only proves dispatch, not installation.
 */
export async function startInstalledUpdateHelper(
  helperPath: string,
  input: InstalledUpdateRequest,
): Promise<number> {
  assertInput(input);
  const bytes = await helperBytes(helperPath);
  const user = os.userInfo();
  if (
    user.uid !== process.geteuid?.() ||
    !path.isAbsolute(user.homedir) ||
    path.normalize(user.homedir) !== user.homedir
  ) {
    throw new Error("INSTALLED_UPDATE_HOME_INVALID");
  }
  const request = {
    schema: "farol.installed-update/1",
    ...input,
    home: user.homedir,
  };
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    detached: true,
    stdio: ["pipe", "ignore", "ignore", "pipe"],
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const write = (
    stream: Writable | null,
    data: Buffer | string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!stream) {
        reject(new Error("INSTALLED_UPDATE_PIPE_INVALID"));
        return;
      }
      stream.once("error", reject);
      stream.end(data, resolve);
    });
  await spawned;
  await Promise.all([
    write(child.stdin, bytes),
    write(child.stdio[3] as Writable | null, JSON.stringify(request)),
  ]);
  if (!child.pid) throw new Error("INSTALLED_UPDATE_SPAWN_UNKNOWN");
  child.unref();
  return child.pid;
}

/** Fixed path for the caller's installed-slot readback; never take it from a workspace. */
export function installedFarolSlot(): string {
  return path.join(os.userInfo().homedir, "Applications", APP_NAME);
}
