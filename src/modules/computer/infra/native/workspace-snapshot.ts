import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";

// N02 -- Git never reads the owner's folder; it reads a private snapshot
// Farol assembles from descriptors it already holds. This module builds and
// removes that snapshot by calling one new safe_open.py verb
// ("workspace-snapshot"); it never runs Git and it is not wired into any
// product code path yet (that is a separate packet).

export type WorkspaceSnapshotHelperRecord = Readonly<{
  sha256: string;
  size: number;
  mode: number;
}>;

export type WorkspaceSnapshotGrant = Readonly<{
  path: string;
  device: string;
  inode: string;
}>;

export type WorkspaceSnapshotRequest = Readonly<{
  root: string;
  approvedRoot: WorkspaceSnapshotGrant;
  // Present only for a linked worktree, whose `.git` is a file: the identity
  // of its own gitdir and of the repository's common gitdir, exactly as the
  // owner-verified discovery flow already resolves them elsewhere. This
  // module re-checks the identity; it does not rediscover the relationship.
  externalGitDir?: WorkspaceSnapshotGrant;
  externalCommonDir?: WorkspaceSnapshotGrant;
  // Bounded path mode: link only `.git` plus these caller-named,
  // repository-relative paths, instead of the whole approved tree.
  // Undefined means the whole-tree mode; an empty array is valid and means
  // "only `.git`" -- the metadata-only step a caller takes before it knows
  // which paths it needs. A path under `denied` (or naming one) is refused,
  // never silently dropped.
  paths?: readonly string[];
  denied?: readonly string[];
  // Clamped by the helper to its own fixed ceiling; a caller may only ask for
  // less, never more.
  maxEntries?: number;
  maxBytes?: number;
}>;

export type WorkspaceSnapshotErrorCode =
  | "SNAPSHOT_INVALID_REQUEST"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_PATH_REFUSED"
  | "SNAPSHOT_RACE_DETECTED"
  | "SNAPSHOT_ROOT_CHANGED"
  | "SNAPSHOT_CROSS_VOLUME"
  | "SNAPSHOT_TOO_LARGE"
  | "SNAPSHOT_METADATA_UNAPPROVED"
  | "SNAPSHOT_DESTINATION_INVALID"
  | "SNAPSHOT_HELPER_FAILED"
  | "SNAPSHOT_HELPER_UNTRUSTED";

export type WorkspaceSnapshotFailure = Readonly<{
  ok: false;
  code: WorkspaceSnapshotErrorCode;
}>;

export type WorkspaceSnapshotHandle = Readonly<{
  ok: true;
  path: string;
  entries: number;
  bytes: number;
  // Idempotent: safe to call more than once, and safe to call after a
  // partial failure -- the destination is always removed, not left behind.
  remove: () => Promise<void>;
}>;

export type WorkspaceSnapshotOutcome =
  | WorkspaceSnapshotHandle
  | WorkspaceSnapshotFailure;

export type WorkspaceSnapshotOptions = Readonly<{
  helperPath: string;
  helper: WorkspaceSnapshotHelperRecord;
  // No default: this module is not wired into a product path yet, so the
  // reviewed Apple-signature attestation chain stays the caller's decision
  // rather than a silently weaker fallback living here.
  attestInterpreter: () => Promise<string>;
  // The directory the private destination is created under (mode 0700,
  // `mkdtemp`'s own guarantee). Farol's own runtime directory in production;
  // a test's own temporary directory in tests.
  runtimeDirectory: string;
}>;

// Test seam only: pauses the helper at one named barrier inside its own walk
// (see safe_open.py `_test_hook`) so a test can replace the source tree
// between the descriptor bind and the walk, or mid-walk, and observe that the
// snapshot is unaffected.
export type WorkspaceSnapshotTestOptions = Readonly<{
  testHookRequest?: Readonly<{ phase: string; index: number | null }>;
  testHook?: () => Promise<void>;
}>;

const RESPONSE_MAGIC = Buffer.from("FAROLR1\0", "ascii");
const RESPONSE_HEADER_BYTES = 16;
const MAX_RESPONSE_BYTES = 4 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const TIMEOUT_MS = 15_000;
const O_CLOEXEC =
  (Reflect.get(fsConstants, "O_CLOEXEC") as number | undefined) ?? 0;
const O_NOFOLLOW =
  (Reflect.get(fsConstants, "O_NOFOLLOW") as number | undefined) ?? 0;

const EXIT_TO_CODE = new Map<number, WorkspaceSnapshotErrorCode>([
  [20, "SNAPSHOT_INVALID_REQUEST"],
  [21, "SNAPSHOT_NOT_FOUND"],
  [22, "SNAPSHOT_PATH_REFUSED"],
  [25, "SNAPSHOT_RACE_DETECTED"],
  [26, "SNAPSHOT_HELPER_FAILED"],
  [33, "SNAPSHOT_ROOT_CHANGED"],
  [34, "SNAPSHOT_CROSS_VOLUME"],
  [35, "SNAPSHOT_TOO_LARGE"],
  [36, "SNAPSHOT_METADATA_UNAPPROVED"],
  [37, "SNAPSHOT_DESTINATION_INVALID"],
]);

function plainAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "/" &&
    value.length <= 4_096 &&
    !/[\0\n\r]/u.test(value)
  );
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 4_096) {
    return false;
  }
  if (path.isAbsolute(value) || /[\0\\]/u.test(value)) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function isPathList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(validRelativePath);
}

function isGrant(value: unknown): value is WorkspaceSnapshotGrant {
  if (typeof value !== "object" || value === null) return false;
  const grant = value as Record<string, unknown>;
  return (
    plainAbsolutePath(grant.path) &&
    typeof grant.device === "string" &&
    /^[0-9]{1,20}$/.test(grant.device) &&
    typeof grant.inode === "string" &&
    /^[0-9]{1,20}$/.test(grant.inode)
  );
}

function failure(code: WorkspaceSnapshotErrorCode): WorkspaceSnapshotFailure {
  return { ok: false, code };
}

async function measuredHelperSource(
  helperPath: string,
  expected: WorkspaceSnapshotHelperRecord,
): Promise<Buffer> {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !plainAbsolutePath(helperPath) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > 512 * 1_024 ||
    expected.mode !== 0o644 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  ) {
    throw new Error("helper contract is invalid");
  }
  let handle;
  try {
    const listed = await lstat(helperPath, { bigint: true });
    handle = await open(helperPath, fsConstants.O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const payload = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const stable =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs;
    if (
      listed.isSymbolicLink() ||
      !before.isFile() ||
      listed.dev !== before.dev ||
      listed.ino !== before.ino ||
      !stable ||
      before.uid !== BigInt(uid) ||
      before.nlink !== 1n ||
      Number(before.mode & 0o777n) !== expected.mode ||
      payload.length !== expected.size ||
      createHash("sha256").update(payload).digest("hex") !== expected.sha256
    ) {
      throw new Error("helper identity drifted");
    }
    return payload;
  } finally {
    await handle?.close();
  }
}

class SnapshotHelperExit extends Error {
  constructor(readonly code: number | null) {
    super("workspace-snapshot helper exited with a refusal");
  }
}

// Spawns the attested interpreter with the helper's own bytes on stdin and
// the JSON request on fd 3, exactly the protocol every other safe_open.py
// caller in this product already uses. Resolves with the response payload
// (the bytes after the FAROLR1 header) or rejects with SnapshotHelperExit
// (carrying the helper's exit status) or a generic failure.
function spawnSnapshotHelper(
  interpreter: string,
  source: Buffer,
  requestBytes: Buffer,
  hook: WorkspaceSnapshotTestOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const withHook = hook.testHookRequest !== undefined;
    const child = spawn(interpreter, ["-I", "-S", "-B", "-"], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: withHook
        ? ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", "pipe"],
    });
    const pipes = child.stdio as unknown as readonly (
      Readable | Writable | null
    )[];
    const sourcePipe = child.stdin;
    const responsePipe = child.stdout;
    const errorPipe = child.stderr;
    const requestPipe = pipes[3] as Writable | null | undefined;
    const hookSignal = withHook ? (pipes[4] as Readable | null | undefined) : null;
    const hookContinue = withHook
      ? (pipes[5] as Writable | null | undefined)
      : null;
    if (
      sourcePipe == null ||
      responsePipe == null ||
      errorPipe == null ||
      requestPipe == null ||
      (withHook && (hookSignal == null || hookContinue == null))
    ) {
      child.kill("SIGKILL");
      reject(new Error("SNAPSHOT_HELPER_FAILED"));
      return;
    }

    const response: Buffer[] = [];
    let responseBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let complete = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    const finish = (action: () => void): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      action();
    };
    const failChannel = (): void =>
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("SNAPSHOT_HELPER_FAILED"));
      });
    for (const pipe of pipes) pipe?.on("error", failChannel);

    responsePipe.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > RESPONSE_HEADER_BYTES + MAX_RESPONSE_BYTES) {
        child.kill("SIGKILL");
      } else {
        response.push(chunk);
      }
    });
    errorPipe.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) child.kill("SIGKILL");
    });
    child.once("error", () =>
      finish(() => reject(new Error("SNAPSHOT_HELPER_FAILED"))),
    );
    child.once("close", (code, signal) =>
      finish(() => {
        if (
          timedOut ||
          signal !== null ||
          stderrBytes !== 0 ||
          responseBytes > RESPONSE_HEADER_BYTES + MAX_RESPONSE_BYTES
        ) {
          reject(new Error("SNAPSHOT_HELPER_FAILED"));
          return;
        }
        if (code !== 0) {
          reject(new SnapshotHelperExit(code));
          return;
        }
        const bytes = Buffer.concat(response);
        if (
          bytes.length < RESPONSE_HEADER_BYTES ||
          !bytes.subarray(0, 8).equals(RESPONSE_MAGIC)
        ) {
          reject(new Error("SNAPSHOT_HELPER_FAILED"));
          return;
        }
        const length = bytes.readBigUInt64BE(8);
        if (
          length > BigInt(MAX_RESPONSE_BYTES) ||
          length !== BigInt(bytes.length - RESPONSE_HEADER_BYTES)
        ) {
          reject(new Error("SNAPSHOT_HELPER_FAILED"));
          return;
        }
        resolve(bytes.subarray(RESPONSE_HEADER_BYTES));
      }),
    );

    try {
      sourcePipe.end(source);
      requestPipe.end(requestBytes);
    } catch {
      failChannel();
      return;
    }

    if (withHook && hookSignal != null && hookContinue != null) {
      const signalPipe = hookSignal;
      const continuePipe = hookContinue;
      let pending = Buffer.alloc(0);
      let handled = Promise.resolve();
      signalPipe.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
          const marker = pending[0];
          pending = pending.subarray(2);
          if (marker !== 0x52) {
            failChannel();
            return;
          }
          handled = handled.then(async () => {
            try {
              await hook.testHook?.();
              continuePipe.write(Buffer.from("C"));
            } catch {
              failChannel();
            }
          });
        }
      });
    }
  });
}

function parseResponse(raw: Buffer): Readonly<{
  entries: number;
  bytes: number;
}> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { entries, bytes } = parsed as Record<string, unknown>;
  if (
    typeof entries !== "number" ||
    !Number.isInteger(entries) ||
    entries < 0 ||
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes < 0
  ) {
    return null;
  }
  return { entries, bytes };
}

/**
 * Builds the private snapshot N02 describes: a fresh, owner-only directory
 * under `options.runtimeDirectory` that recreates directories and symlinks,
 * replaces `.git/config` with its minimal safe equivalent, copies (never
 * links) the files Git may rewrite in place, and -- for a linked worktree --
 * rebuilds its gitdir/commondir pair inside the destination from
 * caller-approved identities. Every regular file it attaches -- whole-tree,
 * or the caller's own bounded `paths` list -- is hard-linked by descriptor,
 * resolving to the source's inode: a rename, replacement or deletion of the
 * source afterwards cannot change what the link resolves to, but an in-place
 * write through a descriptor opened before this call is still visible
 * through it, because it is the same inode, not a point-in-time copy of its
 * bytes. This function only builds and removes that snapshot; it never runs
 * Git against it.
 */
export async function createWorkspaceSnapshot(
  request: WorkspaceSnapshotRequest,
  options: WorkspaceSnapshotOptions,
  testOptions: WorkspaceSnapshotTestOptions = {},
): Promise<WorkspaceSnapshotOutcome> {
  if (
    !plainAbsolutePath(request.root) ||
    !isGrant(request.approvedRoot) ||
    (request.externalGitDir !== undefined && !isGrant(request.externalGitDir)) ||
    (request.externalCommonDir !== undefined &&
      !isGrant(request.externalCommonDir)) ||
    (request.paths !== undefined && !isPathList(request.paths)) ||
    (request.denied !== undefined && !isPathList(request.denied)) ||
    (request.maxEntries !== undefined &&
      (!Number.isInteger(request.maxEntries) || request.maxEntries < 1)) ||
    (request.maxBytes !== undefined &&
      (!Number.isInteger(request.maxBytes) || request.maxBytes < 1)) ||
    !plainAbsolutePath(options.runtimeDirectory)
  ) {
    return failure("SNAPSHOT_INVALID_REQUEST");
  }

  let destination: string;
  try {
    const created = await mkdtemp(
      path.join(options.runtimeDirectory, "farol-git-snapshot-"),
    );
    destination = await realpath(created);
  } catch {
    return failure("SNAPSHOT_DESTINATION_INVALID");
  }

  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const destinationStat = await lstat(destination, { bigint: true });
    const destinationRoot: WorkspaceSnapshotGrant = {
      path: destination,
      device: String(destinationStat.dev),
      inode: String(destinationStat.ino),
    };

    let interpreter: string;
    let source: Buffer;
    try {
      interpreter = await options.attestInterpreter();
      if (!plainAbsolutePath(interpreter)) throw new Error("invalid interpreter");
      source = await measuredHelperSource(options.helperPath, options.helper);
    } catch {
      await remove();
      return failure("SNAPSHOT_HELPER_UNTRUSTED");
    }

    const requestBody: Record<string, unknown> = {
      operation: "workspace-snapshot",
      root: request.root,
      approvedRoot: { ...request.approvedRoot },
      destination,
      destinationRoot,
    };
    if (request.externalGitDir) {
      requestBody.externalGitDir = { ...request.externalGitDir };
    }
    if (request.externalCommonDir) {
      requestBody.externalCommonDir = { ...request.externalCommonDir };
    }
    if (request.paths !== undefined) requestBody.paths = [...request.paths];
    if (request.denied !== undefined && request.denied.length > 0) {
      requestBody.denied = [...request.denied];
    }
    if (request.maxEntries !== undefined) requestBody.maxEntries = request.maxEntries;
    if (request.maxBytes !== undefined) requestBody.maxBytes = request.maxBytes;
    if (testOptions.testHookRequest) {
      requestBody.testHook = testOptions.testHookRequest;
    }
    const requestBytes = Buffer.from(JSON.stringify(requestBody), "utf8");

    let raw: Buffer;
    try {
      raw = await spawnSnapshotHelper(interpreter, source, requestBytes, testOptions);
    } catch (error) {
      await remove();
      if (error instanceof SnapshotHelperExit) {
        return failure(EXIT_TO_CODE.get(error.code ?? -1) ?? "SNAPSHOT_HELPER_FAILED");
      }
      return failure("SNAPSHOT_HELPER_FAILED");
    }

    const parsed = parseResponse(raw);
    if (parsed === null) {
      await remove();
      return failure("SNAPSHOT_HELPER_FAILED");
    }
    return {
      ok: true,
      path: destination,
      entries: parsed.entries,
      bytes: parsed.bytes,
      remove,
    };
  } catch {
    await remove();
    return failure("SNAPSHOT_HELPER_FAILED");
  }
}
