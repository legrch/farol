import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";

const HELPER_SHA256 =
  "43dfcb9004e21fbe1eab4b5e5afe972f7ff24a679fb36a3f19018ad5c33e645b";
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
    value.version.length <= 128 &&
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
    input.processStart.length > 128 ||
    !Number.isSafeInteger(input.waitSeconds) ||
    input.waitSeconds < 1 ||
    input.waitSeconds > 120 ||
    typeof input.relaunch !== "boolean"
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
  const expected = await fs.lstat(helperPath, { bigint: true });
  if (
    !expected.isFile() ||
    expected.nlink !== 1n ||
    expected.size < 1n ||
    expected.size > BigInt(MAX_HELPER_BYTES) ||
    expected.uid !== BigInt(process.geteuid?.() ?? -1) ||
    (expected.mode & 0o022n) !== 0n
  ) {
    throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
  }
  const matches = (value: typeof expected): boolean =>
    value.isFile() &&
    value.dev === expected.dev &&
    value.ino === expected.ino &&
    value.mode === expected.mode &&
    value.nlink === expected.nlink &&
    value.uid === expected.uid &&
    value.gid === expected.gid &&
    value.size === expected.size &&
    value.mtimeNs === expected.mtimeNs &&
    value.ctimeNs === expected.ctimeNs;
  const handle = await fs.open(
    helperPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!matches(await handle.stat({ bigint: true }))) {
      throw new Error("INSTALLED_UPDATE_HELPER_INVALID");
    }
    // The extra byte detects growth without reading beyond the checked bound.
    const buffer = Buffer.alloc(Number(expected.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    if (
      size !== Number(expected.size) ||
      !matches(await handle.stat({ bigint: true })) ||
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

export type InstalledUpdateHandoff =
  | Readonly<{ phase: "waiting_for_exit" }>
  | Readonly<{ phase: "refused"; error: string }>;

export interface InstalledUpdateCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly terminal: Readonly<{ phase: string; error: string | null }> | null;
  readonly protocolError: string | null;
}

export interface InstalledUpdateOperation {
  readonly operationId: string;
  readonly pid: number | null;
  readonly completion: Promise<InstalledUpdateCompletion>;
  observe(): Readonly<{
    handoff: InstalledUpdateHandoff | null;
    exit: InstalledUpdateCompletion | null;
    protocolError: string | null;
  }>;
}

export type InstalledUpdateLaunch =
  | Readonly<{
      status: "not_started";
      reason:
        | "helper_spawn_failed"
        | "helper_preflight_failed"
        | "owner_home_invalid";
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{ status: "ready"; operation: InstalledUpdateOperation }>
  | Readonly<{
      status: "refused";
      reason: string;
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{
      status: "outcome_unknown";
      reason: string;
      operation: InstalledUpdateOperation;
    }>
  | Readonly<{
      status: "terminal";
      operation: InstalledUpdateOperation;
      result: InstalledUpdateCompletion;
    }>;

const MAX_CHANNEL_BYTES = 4096;
const HANDOFF_SCHEMA = "farol.installed-update-handoff/1";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sameBuild(value: unknown, expected: AcceptedInstalledBuild): boolean {
  const record = object(value);
  return (
    record !== null &&
    Object.keys(record).length === 3 &&
    record["digest"] === expected.digest &&
    record["version"] === expected.version &&
    record["buildId"] === expected.buildId
  );
}

function parseHandoff(
  bytes: Buffer,
  expected: InstalledUpdateRequest,
): InstalledUpdateHandoff | null {
  try {
    const event = object(JSON.parse(bytes.toString("utf8")));
    if (
      !event ||
      event["schema"] !== HANDOFF_SCHEMA ||
      event["operationId"] !== expected.operationId ||
      event["action"] !== expected.action ||
      event["pid"] !== expected.pid ||
      event["processStart"] !== expected.processStart ||
      !sameBuild(event["source"], expected.source) ||
      !sameBuild(event["target"], expected.target)
    )
      return null;
    if (
      event["phase"] === "waiting_for_exit" &&
      (expected.action !== "recover" || expected.relaunch) &&
      Object.keys(event).length === 8
    ) {
      return { phase: "waiting_for_exit" };
    }
    if (
      event["phase"] === "refused" &&
      Object.keys(event).length === 9 &&
      typeof event["error"] === "string" &&
      /^[a-z][a-z0-9_]{0,79}$/u.test(event["error"])
    ) {
      return { phase: "refused", error: event["error"] };
    }
  } catch {
    /* Invalid or multiple frames never authorize Quit. */
  }
  return null;
}

function parseTerminal(
  bytes: Buffer,
  operationId: string,
): InstalledUpdateCompletion["terminal"] {
  try {
    const record = object(JSON.parse(bytes.toString("utf8")));
    if (
      !record ||
      record["operationId"] !== operationId ||
      typeof record["phase"] !== "string" ||
      !/^[a-z_]{1,40}$/u.test(record["phase"])
    )
      return null;
    if (Object.keys(record).length === 2)
      return { phase: record["phase"], error: null };
    if (
      Object.keys(record).length === 3 &&
      typeof record["error"] === "string" &&
      /^[a-z][a-z0-9_]{0,79}$/u.test(record["error"])
    ) {
      return { phase: record["phase"], error: record["error"] };
    }
  } catch {
    /* The journal remains authoritative when terminal output is unknown. */
  }
  return null;
}

/**
 * Only `ready` authorizes normal Quit for apply/rollback or live recover. Every post-spawn
 * outcome retains the same child via its observation/completion handle.
 * Offline `recover` has no live-app handoff and returns a terminal result instead.
 */
export async function startInstalledUpdateHelper(
  helperPath: string,
  input: InstalledUpdateRequest,
  options: Readonly<{ readinessTimeoutMs?: number }> = {},
): Promise<InstalledUpdateLaunch> {
  assertInput(input);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 180_000;
  if (
    !Number.isSafeInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 1 ||
    readinessTimeoutMs > 300_000
  ) {
    throw new Error("INSTALLED_UPDATE_READINESS_DEADLINE_INVALID");
  }
  // Pin the request before asynchronous preflight; later caller mutation cannot
  // change either the bytes sent or the identity expected in the acknowledgment.
  const pinned: InstalledUpdateRequest = {
    action: input.action,
    operationId: input.operationId,
    source: { ...input.source },
    target: { ...input.target },
    drain: { ...input.drain },
    pid: input.pid,
    processStart: input.processStart,
    waitSeconds: input.waitSeconds,
    relaunch: input.relaunch,
  };
  const beforeSpawn = (
    reason: "helper_preflight_failed" | "owner_home_invalid",
  ): InstalledUpdateLaunch => {
    // This receipt explicitly has no process and no process exit code. It is
    // created only on the preflight side of the spawn boundary.
    const result: InstalledUpdateCompletion = {
      code: null,
      signal: null,
      terminal: null,
      protocolError: reason,
    };
    return {
      status: "not_started",
      reason,
      operation: {
        operationId: pinned.operationId,
        pid: null,
        completion: Promise.resolve(result),
        observe: () => ({ handoff: null, exit: result, protocolError: reason }),
      },
    };
  };
  let bytes: Buffer;
  try {
    bytes = await helperBytes(helperPath);
  } catch {
    return beforeSpawn("helper_preflight_failed");
  }
  let user: os.UserInfo<string>;
  try {
    user = os.userInfo();
    if (
      user.uid !== process.geteuid?.() ||
      !path.isAbsolute(user.homedir) ||
      path.normalize(user.homedir) !== user.homedir
    )
      return beforeSpawn("owner_home_invalid");
  } catch {
    return beforeSpawn("owner_home_invalid");
  }
  const request = {
    schema: "farol.installed-update/1",
    ...pinned,
    home: user.homedir,
  };
  const child = spawn("/usr/bin/python3", ["-I", "-S", "-B", "-"], {
    cwd: "/",
    env: { LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
    detached: true,
    stdio: ["pipe", "pipe", "ignore", "pipe", "pipe"],
  });
  let handoff: InstalledUpdateHandoff | null = null;
  let exit: InstalledUpdateCompletion | null = null;
  let protocolError: string | null = null;
  let resolveCompletion!: (result: InstalledUpdateCompletion) => void;
  const completion = new Promise<InstalledUpdateCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  const operation: InstalledUpdateOperation = {
    operationId: pinned.operationId,
    get pid() {
      return child.pid ?? null;
    },
    completion,
    observe: () => ({ handoff, exit, protocolError }),
  };
  let resolveLaunch!: (result: InstalledUpdateLaunch) => void;
  const launched = new Promise<InstalledUpdateLaunch>((resolve) => {
    resolveLaunch = resolve;
  });
  let settled = false;
  let spawned = false;
  let spawnFailed = false;
  const detach = (): void => {
    child.unref();
    for (const pipe of child.stdio)
      (pipe as { unref?: () => void } | null)?.unref?.();
  };
  const finish = (result: InstalledUpdateLaunch): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    detach();
    resolveLaunch(result);
  };
  const unknown = (reason: string): void => {
    protocolError ??= reason;
    finish({ status: "outcome_unknown", reason, operation });
  };
  const timer = setTimeout(
    () => unknown("readiness_timeout"),
    readinessTimeoutMs,
  );
  const ack = child.stdio[4] as Readable | null;
  const ackChunks: Buffer[] = [];
  const outputChunks: Buffer[] = [];
  let ackBytes = 0;
  let outputBytes = 0;
  let ackEnded = false;
  let ackInvalid = false;
  child.stdout?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_CHANNEL_BYTES) {
      unknown("terminal_output_oversized");
      return;
    }
    outputChunks.push(chunk);
  });
  child.stdout?.on("error", () => unknown("terminal_channel_error"));
  ack?.on("data", (chunk: Buffer) => {
    ackBytes += chunk.length;
    if (ackBytes > MAX_CHANNEL_BYTES) {
      ackInvalid = true;
      unknown("readiness_oversized");
      return;
    }
    ackChunks.push(chunk);
  });
  ack?.on("error", () => {
    ackInvalid = true;
    unknown("readiness_channel_error");
  });
  ack?.on("end", () => {
    ackEnded = true;
    if (ackInvalid || ackBytes === 0) return;
    handoff = parseHandoff(Buffer.concat(ackChunks), pinned);
    if (!handoff) {
      unknown("readiness_malformed");
      return;
    }
    if (handoff.phase === "refused")
      finish({ status: "refused", reason: handoff.error, operation });
    else finish({ status: "ready", operation });
  });
  ack?.on("close", () => {
    if (!ackEnded && !spawnFailed) unknown("readiness_channel_closed");
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    if (
      !spawned &&
      child.pid === undefined &&
      error.syscall === "spawn /usr/bin/python3" &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "ENOEXEC",
        "ENOMEM",
        "EAGAIN",
        "EMFILE",
        "ENFILE",
      ].includes(error.code ?? "")
    ) {
      // Node emitted an exec failure before the spawn event. No program or
      // request bytes have been written. Still require terminal channel closure.
      spawnFailed = true;
    } else unknown("helper_process_error");
  });
  child.once("close", (code, signal) => {
    if (
      spawnFailed &&
      !spawned &&
      child.pid === undefined &&
      code !== null &&
      code < 0 &&
      signal === null &&
      ackBytes === 0 &&
      outputBytes === 0 &&
      !handoff &&
      !protocolError
    ) {
      exit = {
        code,
        signal,
        terminal: null,
        protocolError: "helper_spawn_failed",
      };
      resolveCompletion(exit);
      finish({
        status: "not_started",
        reason: "helper_spawn_failed",
        operation,
      });
      return;
    }
    const terminal =
      outputBytes <= MAX_CHANNEL_BYTES
        ? parseTerminal(Buffer.concat(outputChunks), pinned.operationId)
        : null;
    exit = {
      code,
      signal,
      terminal,
      protocolError:
        protocolError ?? (terminal ? null : "terminal_output_invalid"),
    };
    resolveCompletion(exit);
    if (
      pinned.action === "recover" &&
      !pinned.relaunch &&
      code === 0 &&
      !signal &&
      terminal &&
      terminal.error === null &&
      !protocolError
    ) {
      finish({ status: "terminal", operation, result: exit });
    } else if (!settled) unknown("helper_exited_before_readiness");
  });
  const write = (stream: Writable | null, data: Buffer | string): void => {
    if (!stream) {
      unknown("request_channel_missing");
      return;
    }
    stream.once("error", () => unknown("request_channel_error"));
    stream.end(data);
  };
  child.once("spawn", () => {
    spawned = true;
    write(child.stdin, bytes);
    write(child.stdio[3] as Writable | null, JSON.stringify(request));
  });
  if (!ack || !child.stdout) unknown("readiness_channel_missing");
  return launched;
}

/** Fixed path for the caller's installed-slot readback; never take it from a workspace. */
export function installedFarolSlot(): string {
  return path.join(os.userInfo().homedir, "Applications", APP_NAME);
}
