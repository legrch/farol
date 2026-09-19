import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

import type {
  MutableWorkspace,
  WorkspaceMutationErrorCode,
  WorkspaceMutationRequest,
  WorkspaceMutationResult,
  WorkspaceMutationReceipt,
} from "../../app/port/mutable-workspace";
import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceExecutionContext,
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
  WorkspaceEditSnapshotReader,
  WorkspaceEditSnapshotRequest,
  WorkspaceApprovedRoot,
  WorkspaceEditSnapshotResult,
  WorkspaceMatch,
  WorkspaceReadRange,
} from "../../app/port/readonly-workspace";
import { credentialStorePolicy } from "./home-secret-stores";
import {
  type ApprovedRootLauncher,
  executeNativeVerificationCommand,
} from "./native-verification-command";

export type SafeOpenHelperRecord = Readonly<{
  sha256: string;
  size: number;
  mode: number;
}>;

export const NEXT_SAFE_OPEN_HELPER: SafeOpenHelperRecord = Object.freeze({
  sha256: "e06b320af93e62f3040152e1a3a878307ad2d6b994d256fd05d027a3f5a9e056",
  size: 88_730,
  mode: 0o644,
});

const RESPONSE_MAGIC = Buffer.from("FAROLR1\0", "ascii");
const RESPONSE_HEADER_BYTES = 16;
const O_CLOEXEC =
  (Reflect.get(fsConstants, "O_CLOEXEC") as number | undefined) ?? 0;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
// A window returns no more than a whole read may and spans at least one whole
// UTF-8 character (at most four bytes), so each window's `nextOffset` lies
// past its own offset. Its offset is any exact integer: the helper accepts
// every offset up to 2^53 - 1, so a reported `nextOffset` is always a valid
// next request, however large the file.
const MIN_WINDOW_BYTES = 4;
const MAX_MUTATION_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export const DEFAULT_DENIED_PATHS = Object.freeze([
  ".env",
  ".ssh",
  ".aws",
  ".gnupg",
  ".codex",
  ".claude",
  ".git",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker/config.json",
  ".kube/config",
  "Library/Keychains",
]);

const DEFAULT_WRITE_DENIED_PATHS = Object.freeze([".git"]);

// The helper refuses more deny prefixes than this.  The adapter measures the
// union of mandatory and owner exclusions first, so an oversized policy is a
// specific refusal instead of a generic invalid request, and no exclusion is
// ever dropped to make a request fit.
const MAX_HELPER_DENIED_PATHS = 64;

const EXIT_TO_ERROR = new Map<number, NativeWorkspaceErrorCode>([
  [20, "WORKSPACE_INVALID_REQUEST"],
  [21, "WORKSPACE_NOT_FOUND"],
  [22, "WORKSPACE_PATH_REFUSED"],
  [23, "WORKSPACE_NOT_A_FILE"],
  [24, "WORKSPACE_FILE_TOO_LARGE"],
  [25, "WORKSPACE_RACE_DETECTED"],
  [26, "WORKSPACE_HELPER_FAILED"],
  [27, "WORKSPACE_SEARCH_TIMEOUT"],
  [28, "WORKSPACE_NOT_TEXT"],
  [29, "WORKSPACE_EDIT_NO_MATCH"],
  [30, "WORKSPACE_EDIT_NOT_UNIQUE"],
  [31, "WORKSPACE_EDIT_OVERLAP"],
  [32, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"],
  [33, "WORKSPACE_ROOT_CHANGED"],
]);

const REVIEWED_PYTHON = Object.freeze({
  selector: "/usr/bin/python3",
  selectorIdentifier: "com.apple.dt.xcode_select.tool-shim-public",
  xcrun: "/usr/bin/xcrun",
  xcodeSelect: "/usr/bin/xcode-select",
  codesign: "/usr/bin/codesign",
  developerRoots: Object.freeze([
    "/Applications/Xcode.app/Contents/Developer",
    "/Library/Developer/CommandLineTools",
  ]),
  frameworkVersions: "Library/Frameworks/Python3.framework/Versions",
  realIdentifier: "com.apple.python3",
  realTeamIdentifier: "59GAB85EFG",
  minimumSeries: Object.freeze([3, 9] as const),
});

const PYTHON_SERIES = /^3\.(?:[9]|[1-9][0-9])$/;
const PYTHON_VERSION_OUTPUT = /^Python (3\.(?:[9]|[1-9][0-9]))\.[0-9]+$/;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

type NativeRequest = Readonly<{
  operation:
    "edit" | "grep" | "list-directory" | "read" | "read-window" | "write";
  root: string;
  relative: string;
  denied: readonly string[];
  writeDenied?: readonly string[];
  maxBytes?: number;
  offset?: number;
  length?: number;
  pattern?: string;
  content?: string;
  edits?: readonly Readonly<{ oldText: string; newText: string }>[];
  expectedSha256?: string | null;
  fileOnly?: boolean;
  testHook?: TestHookRequest | readonly TestHookRequest[];
}>;

type TestHookRequest = Readonly<{ phase: string; index: number | null }>;

// A test may pause the helper at up to four named points in one run; the
// callback learns which barrier (its position in the request) was reached.
// Answering "helper-fault" makes the helper fail with an internal error at
// that exact point, with its cleanup still running, instead of continuing.
const MAX_TEST_BARRIERS = 4;

export type NativeReadonlyWorkspaceTestOptions =
  ReadonlyWorkspaceExecutionContext &
    Readonly<{
      testHookRequest?: TestHookRequest | readonly TestHookRequest[];
      testHook?: (barrier: number) => Promise<void | "helper-fault">;
    }>;

type NativeReadonlyWorkspaceOptions = Readonly<{
  helperPath: string;
  helper: SafeOpenHelperRecord;
  attestInterpreter?: () => Promise<string>;
  attestGit?: () => Promise<string>;
  // The owner's home, whose credential stores stay denied whichever root is
  // selected. Defaults to this process's home directory.
  homeDirectory?: string;
}>;

type SystemFileMeasurement = Readonly<{
  path: string;
  symlink: boolean;
  regularFile: boolean;
  uid: number;
  mode: number;
}>;

type NativeWorkspaceErrorCode =
  | ReadonlyWorkspaceErrorCode
  | WorkspaceMutationErrorCode
  // Internal: the caller aborted after the helper process had started.
  | "WORKSPACE_REQUEST_INTERRUPTED";

class WorkspaceRefusal extends Error {
  constructor(readonly code: NativeWorkspaceErrorCode) {
    super(code);
  }
}

function success(
  value: Extract<ReadonlyWorkspaceResult, { ok: true }>["value"],
): ReadonlyWorkspaceResult {
  return { ok: true, value };
}

function failure(code: ReadonlyWorkspaceErrorCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

function mutationFailure(
  code: WorkspaceMutationErrorCode,
): WorkspaceMutationResult {
  return { ok: false, error: { code, retry: "never" } };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(
            (value as Readonly<Record<string, JsonValue>>)[key] as JsonValue,
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function plainString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    [...value].every((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && code >= 32 && code !== 127;
    })
  );
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !plainString(value, 4_096)
  ) {
    return false;
  }
  return value
    .split("/")
    .slice(1)
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part, "utf8") <= 255,
    );
}

function canonicalRelativePath(
  value: unknown,
  { root = false }: Readonly<{ root?: boolean }> = {},
): value is string {
  if (root && value === ".") return true;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !plainString(value, 4_096)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        Buffer.byteLength(part, "utf8") <= 255,
    );
}

function validWorkspaceId(value: unknown): value is string {
  return plainString(value, 120);
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function validReadRange(value: unknown): value is WorkspaceReadRange {
  if (!exactKeys(value, ["offset", "length"])) return false;
  const range = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(range.offset) &&
    (range.offset as number) >= 0 &&
    Number.isSafeInteger(range.length) &&
    (range.length as number) >= MIN_WINDOW_BYTES &&
    (range.length as number) <= MAX_SOURCE_BYTES
  );
}

function validGitMetadataGrant(value: unknown): boolean {
  if (!exactKeys(value, ["gitDirectory", "commonDirectory"])) return false;
  const grant = value as Readonly<Record<string, unknown>>;
  return (
    canonicalAbsolutePath(grant.gitDirectory) &&
    canonicalAbsolutePath(grant.commonDirectory)
  );
}

// The approved root is the folder the owner approved, bound to the device and
// inode it had then. It is the requested root or one of its ancestors, so a
// narrowed subtree is still checked against the folder that was approved.
function validApprovedRoot(value: unknown, root: unknown): boolean {
  if (!exactKeys(value, ["path", "device", "inode"])) return false;
  const approved = value as Readonly<Record<string, unknown>>;
  return (
    canonicalAbsolutePath(approved.path) &&
    typeof root === "string" &&
    (root === approved.path || root.startsWith(`${approved.path}/`)) &&
    typeof approved.device === "string" &&
    /^[0-9]{1,20}$/u.test(approved.device) &&
    typeof approved.inode === "string" &&
    /^[0-9]{1,20}$/u.test(approved.inode)
  );
}

function validateRequest(value: unknown): ReadonlyWorkspaceRequest | null {
  if (!exactKeys(value, ["workspace", "operation"])) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  const hasExactFilePaths = hasOwn(candidate.workspace, "exactFilePaths");
  const hasGitMetadata = hasOwn(candidate.workspace, "gitMetadata");
  // Every request names the identity the owner verified; a request without
  // one would let a folder that later took the same path pass as approved.
  if (
    !exactKeys(candidate.workspace, [
      "workspaceId",
      "root",
      "deniedPaths",
      "approvedRoot",
      ...(hasExactFilePaths ? ["exactFilePaths"] : []),
      ...(hasGitMetadata ? ["gitMetadata"] : []),
    ])
  ) {
    return null;
  }
  const workspace = candidate.workspace as Readonly<Record<string, unknown>>;
  if (
    !validWorkspaceId(workspace.workspaceId) ||
    !canonicalAbsolutePath(workspace.root) ||
    !validApprovedRoot(workspace.approvedRoot, workspace.root) ||
    (hasGitMetadata && !validGitMetadataGrant(workspace.gitMetadata)) ||
    !Array.isArray(workspace.deniedPaths) ||
    workspace.deniedPaths.length > 256 ||
    !workspace.deniedPaths.every((entry) => canonicalRelativePath(entry)) ||
    (hasExactFilePaths &&
      (!Array.isArray(workspace.exactFilePaths) ||
        workspace.exactFilePaths.length < 1 ||
        workspace.exactFilePaths.length > 32 ||
        !workspace.exactFilePaths.every((entry) =>
          canonicalRelativePath(entry, { root: true }),
        ) ||
        workspace.exactFilePaths.length !==
          new Set(workspace.exactFilePaths).size))
  ) {
    return null;
  }
  if (
    workspace.deniedPaths.length !== new Set(workspace.deniedPaths).size ||
    candidate.operation === null ||
    typeof candidate.operation !== "object" ||
    Array.isArray(candidate.operation)
  ) {
    return null;
  }
  const operation = candidate.operation as Readonly<Record<string, unknown>>;
  if (operation.kind === "workspace.read") {
    const hasRange = hasOwn(operation, "range");
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        ...(hasRange ? ["range"] : []),
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      (hasRange &&
        operation.range !== undefined &&
        !validReadRange(operation.range))
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.list") {
    if (
      !exactKeys(operation, ["kind", "relativePath"]) ||
      !canonicalRelativePath(operation.relativePath, { root: true })
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.search") {
    if (
      !exactKeys(operation, ["kind", "relativePath", "pattern"]) ||
      !canonicalRelativePath(operation.relativePath, { root: true }) ||
      !plainString(operation.pattern, 4_096)
    ) {
      return null;
    }
  } else if (operation.kind === "verification.run") {
    if (
      !exactKeys(operation, ["kind", "command", "relativePath"]) ||
      (operation.command !== "git.status" &&
        operation.command !== "git.head") ||
      operation.relativePath !== "."
    ) {
      return null;
    }
  } else {
    return null;
  }
  if (
    hasExactFilePaths &&
    (operation.kind === "workspace.list" ||
      operation.kind === "verification.run" ||
      !(workspace.exactFilePaths as readonly string[]).includes(
        operation.relativePath as string,
      ))
  ) {
    return null;
  }
  return value as ReadonlyWorkspaceRequest;
}

function deniedPaths(
  request: Readonly<{
    workspace: Readonly<{ deniedPaths: readonly string[] }>;
  }>,
): readonly string[] {
  return [
    ...new Set([...DEFAULT_DENIED_PATHS, ...request.workspace.deniedPaths]),
  ];
}

function verificationDeniedPaths(
  request: Readonly<{
    workspace: Readonly<{ deniedPaths: readonly string[] }>;
  }>,
): readonly string[] {
  return [
    ...new Set([
      ...DEFAULT_DENIED_PATHS.filter((relative) => relative !== ".git"),
      ...request.workspace.deniedPaths,
    ]),
  ];
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedMutationText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_MUTATION_BYTES
  );
}

function validRelativePaths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((entry) => canonicalRelativePath(entry)) &&
    value.length === new Set(value).size
  );
}

function validateMutationRequest(
  value: unknown,
): WorkspaceMutationRequest | null {
  if (!exactKeys(value, ["workspace", "operation"])) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(candidate.workspace, [
      "workspaceId",
      "root",
      "deniedPaths",
      "writeDeniedPaths",
      "approvedRoot",
    ])
  ) {
    return null;
  }
  const workspace = candidate.workspace as Readonly<Record<string, unknown>>;
  if (
    !validWorkspaceId(workspace.workspaceId) ||
    !canonicalAbsolutePath(workspace.root) ||
    !validApprovedRoot(workspace.approvedRoot, workspace.root) ||
    !validRelativePaths(workspace.deniedPaths) ||
    !validRelativePaths(workspace.writeDeniedPaths) ||
    candidate.operation === null ||
    typeof candidate.operation !== "object" ||
    Array.isArray(candidate.operation)
  ) {
    return null;
  }
  const operation = candidate.operation as Readonly<Record<string, unknown>>;
  if (operation.kind === "workspace.write") {
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        "content",
        "expectedSha256",
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      !boundedMutationText(operation.content) ||
      !(
        operation.expectedSha256 === null ||
        validSha256(operation.expectedSha256)
      )
    ) {
      return null;
    }
  } else if (operation.kind === "workspace.edit") {
    if (
      !exactKeys(operation, [
        "kind",
        "relativePath",
        "edits",
        "expectedSha256",
      ]) ||
      !canonicalRelativePath(operation.relativePath) ||
      !validSha256(operation.expectedSha256) ||
      !Array.isArray(operation.edits) ||
      operation.edits.length === 0 ||
      operation.edits.length > 256
    ) {
      return null;
    }
    let aggregate = 0;
    for (const edit of operation.edits) {
      if (!exactKeys(edit, ["oldText", "newText"])) return null;
      const record = edit as Readonly<Record<string, unknown>>;
      if (
        !boundedMutationText(record.oldText) ||
        !boundedMutationText(record.newText) ||
        record.oldText.length === 0 ||
        record.oldText === record.newText
      ) {
        return null;
      }
      aggregate +=
        Buffer.byteLength(record.oldText, "utf8") +
        Buffer.byteLength(record.newText, "utf8");
      if (aggregate > MAX_MUTATION_BYTES) return null;
    }
  } else {
    return null;
  }
  return value as WorkspaceMutationRequest;
}

function approvedRootRequest(
  workspace: Readonly<{ approvedRoot: WorkspaceApprovedRoot }>,
): Readonly<{ approvedRoot: WorkspaceApprovedRoot }> {
  return { approvedRoot: { ...workspace.approvedRoot } };
}

function writeDeniedPaths(
  request: WorkspaceMutationRequest,
): readonly string[] {
  return [
    ...new Set([
      ...DEFAULT_WRITE_DENIED_PATHS,
      ...request.workspace.writeDeniedPaths,
    ]),
  ];
}

function nativeMutationRequest(
  request: WorkspaceMutationRequest,
  options: NativeReadonlyWorkspaceTestOptions,
): NativeRequest {
  const common = {
    root: request.workspace.root,
    ...approvedRootRequest(request.workspace),
    relative: request.operation.relativePath,
    denied: deniedPaths(request),
    writeDenied: writeDeniedPaths(request),
    expectedSha256: request.operation.expectedSha256,
    ...(options.testHookRequest ? { testHook: options.testHookRequest } : {}),
  };
  return request.operation.kind === "workspace.write"
    ? {
        ...common,
        operation: "write",
        content: request.operation.content,
      }
    : {
        ...common,
        operation: "edit",
        edits: request.operation.edits.map((edit) => ({ ...edit })),
      };
}

function nativeRequest(
  request: ReadonlyWorkspaceRequest,
  options: NativeReadonlyWorkspaceTestOptions,
): NativeRequest {
  const common = {
    root: request.workspace.root,
    ...approvedRootRequest(request.workspace),
    relative: request.operation.relativePath,
    denied: deniedPaths(request),
    ...(options.testHookRequest ? { testHook: options.testHookRequest } : {}),
  };
  switch (request.operation.kind) {
    case "workspace.read":
      return request.operation.range
        ? {
            ...common,
            operation: "read-window",
            offset: request.operation.range.offset,
            length: request.operation.range.length,
          }
        : { ...common, operation: "read", maxBytes: MAX_SOURCE_BYTES };
    case "workspace.list":
      return { ...common, operation: "list-directory" };
    case "workspace.search":
      return {
        ...common,
        operation: "grep",
        pattern: request.operation.pattern,
        ...(request.workspace.exactFilePaths ? { fileOnly: true } : {}),
      };
    case "verification.run":
      throw new WorkspaceRefusal("WORKSPACE_INVALID_REQUEST");
  }
}

function testBarriers(
  options: NativeReadonlyWorkspaceTestOptions,
): readonly TestHookRequest[] {
  const requested = options.testHookRequest;
  if (requested === undefined) return [];
  return Array.isArray(requested)
    ? (requested as readonly TestHookRequest[])
    : [requested as TestHookRequest];
}

function validTestOptions(
  options: NativeReadonlyWorkspaceTestOptions,
): boolean {
  if (options.testHookRequest === undefined && options.testHook === undefined) {
    return true;
  }
  const barriers = testBarriers(options);
  return (
    options.testHookRequest !== undefined &&
    options.testHook !== undefined &&
    barriers.length >= 1 &&
    barriers.length <= MAX_TEST_BARRIERS &&
    barriers.every(
      (barrier) =>
        exactKeys(barrier, ["phase", "index"]) &&
        plainString(barrier.phase, 80) &&
        (barrier.index === null ||
          (Number.isSafeInteger(barrier.index) && barrier.index >= 0)),
    ) &&
    new Set(barriers.map((barrier) => `${barrier.phase}:${barrier.index}`))
      .size === barriers.length
  );
}

async function measuredHelper(
  helperPath: string,
  expected: SafeOpenHelperRecord,
): Promise<Buffer> {
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !canonicalAbsolutePath(helperPath) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1 ||
    expected.size > 512 * 1024 ||
    expected.mode !== 0o644 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  ) {
    throw new Error("helper contract is invalid");
  }

  let handle;
  try {
    const listed = await lstat(helperPath, { bigint: true });
    handle = await open(
      helperPath,
      fsConstants.O_RDONLY | O_CLOEXEC | (fsConstants.O_NOFOLLOW ?? 0),
    );
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
      sha256(payload) !== expected.sha256
    ) {
      throw new Error("helper identity drifted");
    }
    return payload;
  } finally {
    await handle?.close();
  }
}

function runExact(
  executable: string,
  args: readonly string[],
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let complete = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), DEFAULT_TIMEOUT_MS);
    const finish = (action: () => void): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      action();
    };
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) child.kill("SIGKILL");
        else chunks.push(chunk);
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) =>
      finish(() => {
        if (code !== 0 || signal !== null || bytes > 16 * 1024) {
          reject(new Error("reviewed dependency command failed"));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }),
    );
  });
}

async function systemFileMeasurement(
  filePath: string,
): Promise<SystemFileMeasurement> {
  const listed = await lstat(filePath, { bigint: true });
  if (listed.isSymbolicLink()) {
    return {
      path: filePath,
      symlink: true,
      regularFile: false,
      uid: -1,
      mode: 0,
    };
  }
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | O_CLOEXEC | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (listed.dev !== opened.dev || listed.ino !== opened.ino) {
      throw new Error("system executable identity drifted");
    }
    return {
      path: filePath,
      symlink: false,
      regularFile: opened.isFile(),
      uid: Number(opened.uid),
      mode: Number(opened.mode & 0o7777n),
    };
  } finally {
    await handle?.close();
  }
}

function codeSignature(output: string): Readonly<{
  identifier?: string;
  teamIdentifier?: string;
}> {
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1];
  const teamIdentifier = output.match(/^TeamIdentifier=(.+)$/m)?.[1];
  return {
    ...(identifier === undefined ? {} : { identifier }),
    ...(teamIdentifier === undefined ? {} : { teamIdentifier }),
  };
}

function assertSystemOwned(measurement: SystemFileMeasurement): void {
  if (
    measurement.symlink ||
    !measurement.regularFile ||
    measurement.uid !== 0 ||
    (measurement.mode & 0o022) !== 0 ||
    (measurement.mode & 0o111) === 0
  ) {
    throw new Error("system executable is not trusted");
  }
}

async function attestReviewedPython(): Promise<string> {
  const selected = await runExact(REVIEWED_PYTHON.xcodeSelect, ["-p"]);
  const found = await runExact(REVIEWED_PYTHON.xcrun, ["--find", "python3"]);
  if (selected.stderr !== "" || found.stderr !== "") {
    throw new Error("Apple developer tools reported an error");
  }
  const developerDir = selected.stdout.trim();
  const xcrunFound = found.stdout.trim();
  if (
    !REVIEWED_PYTHON.developerRoots.includes(developerDir) ||
    xcrunFound !== `${developerDir}/usr/bin/python3`
  ) {
    throw new Error("Python is outside the reviewed developer root");
  }

  const selector = await systemFileMeasurement(REVIEWED_PYTHON.selector);
  assertSystemOwned(selector);
  const selectorSignature = codeSignature(
    (
      await runExact(REVIEWED_PYTHON.codesign, [
        "-dv",
        "--verbose=4",
        REVIEWED_PYTHON.selector,
      ])
    ).stderr,
  );
  if (selectorSignature.identifier !== REVIEWED_PYTHON.selectorIdentifier) {
    throw new Error("Python selector signature is not reviewed");
  }

  const xcrunEntry = await lstat(xcrunFound);
  if (!xcrunEntry.isSymbolicLink()) {
    throw new Error("xcrun Python entry is not a link");
  }
  const xcrunLink = await readlink(xcrunFound);
  const match = new RegExp(
    `^\\.\\./\\.\\./${REVIEWED_PYTHON.frameworkVersions.replace(
      /[.]/g,
      "\\.",
    )}/(3\\.[0-9]{1,2})/bin/python3$`,
  ).exec(xcrunLink);
  const series = match?.[1];
  if (series === undefined || !PYTHON_SERIES.test(series)) {
    throw new Error("Python framework series is not reviewed");
  }
  const [major, minor] = series.split(".").map(Number);
  if (
    major !== REVIEWED_PYTHON.minimumSeries[0] ||
    minor === undefined ||
    minor < REVIEWED_PYTHON.minimumSeries[1]
  ) {
    throw new Error("Python framework is too old");
  }

  const frameworkEntry = path.resolve(path.dirname(xcrunFound), xcrunLink);
  const frameworkEntryInfo = await lstat(frameworkEntry);
  if (!frameworkEntryInfo.isSymbolicLink()) {
    throw new Error("Python framework entry is not a link");
  }
  const frameworkLink = await readlink(frameworkEntry);
  if (frameworkLink !== `python${series}`) {
    throw new Error("Python framework entry names another series");
  }
  const resolved = await realpath(frameworkEntry);
  const expected = `${developerDir}/${REVIEWED_PYTHON.frameworkVersions}/${series}/bin/python${series}`;
  if (resolved !== expected) {
    throw new Error("Python framework resolved outside its reviewed path");
  }
  const interpreter = await systemFileMeasurement(resolved);
  assertSystemOwned(interpreter);
  const signature = codeSignature(
    (await runExact(REVIEWED_PYTHON.codesign, ["-dv", "--verbose=4", resolved]))
      .stderr,
  );
  if (
    signature.identifier !== REVIEWED_PYTHON.realIdentifier ||
    signature.teamIdentifier !== REVIEWED_PYTHON.realTeamIdentifier
  ) {
    throw new Error("Python interpreter signature is not reviewed");
  }
  const version = await runExact(resolved, ["--version"]);
  const reported = PYTHON_VERSION_OUTPUT.exec(
    `${version.stdout}${version.stderr}`.trim(),
  )?.[1];
  if (reported !== series) {
    throw new Error("Python interpreter version contradicts its path");
  }
  return resolved;
}

let reviewedPython: Promise<string> | undefined;

async function defaultAttestInterpreter(): Promise<string> {
  reviewedPython ??= attestReviewedPython();
  try {
    return await reviewedPython;
  } catch (error) {
    reviewedPython = undefined;
    throw error;
  }
}

// Starts a reviewed verification command bound to the approved root object:
// the attested helper opens the root by descriptor, checks the approved
// identity, makes it its working directory and replaces itself with the
// command (see safe_open.py `_exec_verification`).
export function approvedRootLauncher(
  dependencies: Readonly<{
    helperSource: () => Promise<Buffer>;
    attestInterpreter: () => Promise<string>;
  }>,
): ApprovedRootLauncher {
  return async (input) => {
    let source: Buffer;
    let interpreter: string;
    try {
      source = await dependencies.helperSource();
      interpreter = await dependencies.attestInterpreter();
      if (!canonicalAbsolutePath(interpreter)) {
        return "WORKSPACE_HELPER_UNTRUSTED";
      }
    } catch {
      return "WORKSPACE_HELPER_UNTRUSTED";
    }
    const request = Buffer.from(
      canonical({
        operation: "exec-verification",
        root: input.root,
        approvedRoot: { ...input.approvedRoot },
        launch: {
          arguments: [...input.arguments],
          environment: { ...input.environment },
        },
      } as unknown as JsonValue),
      "utf8",
    );
    const child = spawn(interpreter, ["-I", "-S", "-B", "-"], {
      env: { LANG: "C", LC_ALL: "C" },
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const pipes = child.stdio as unknown as readonly (Writable | null)[];
    child.stdin?.on("error", () => undefined);
    pipes[3]?.on("error", () => undefined);
    child.stdin?.end(source);
    pipes[3]?.end(request);
    return child;
  };
}

function mapExitCode(code: number | null): NativeWorkspaceErrorCode {
  if (code === null) return "WORKSPACE_HELPER_FAILED";
  return EXIT_TO_ERROR.get(code) ?? "WORKSPACE_HELPER_FAILED";
}

function runHelper(
  interpreter: string,
  source: Buffer,
  request: NativeRequest,
  options: NativeReadonlyWorkspaceTestOptions,
): Promise<Buffer> {
  const requestBytes = Buffer.from(
    canonical(request as unknown as JsonValue),
    "utf8",
  );
  if (requestBytes.length === 0 || requestBytes.length > MAX_REQUEST_BYTES) {
    throw new WorkspaceRefusal("WORKSPACE_INVALID_REQUEST");
  }

  // A cancellation before the helper starts has no effect at all; after it
  // started, the process is killed and awaited, and the caller learns only
  // that it was interrupted.
  if (options.signal?.aborted) {
    throw new WorkspaceRefusal("WORKSPACE_REQUEST_CANCELLED");
  }
  return new Promise((resolve, reject) => {
    const withHook = options.testHook !== undefined;
    const child = spawn(interpreter, ["-I", "-S", "-B", "-"], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: withHook
        ? ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe", "pipe"],
    });
    const sourcePipe = child.stdin;
    const responsePipe = child.stdout;
    const errorPipe = child.stderr;
    const pipes = child.stdio as unknown as readonly (
      Readable | Writable | null
    )[];
    const requestPipe = pipes[3] as Writable | null | undefined;
    const hookSignal = withHook
      ? (pipes[4] as Readable | null | undefined)
      : null;
    const hookContinue = withHook
      ? (pipes[5] as Writable | null | undefined)
      : null;
    if (
      sourcePipe === null ||
      responsePipe === null ||
      errorPipe === null ||
      requestPipe == null ||
      (withHook && (hookSignal == null || hookContinue == null))
    ) {
      child.kill("SIGKILL");
      reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
      return;
    }
    const requestInput = requestPipe;

    const response: Buffer[] = [];
    let responseBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let interrupted = false;
    let complete = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DEFAULT_TIMEOUT_MS);
    const interrupt = (): void => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", interrupt, { once: true });
    const finish = (action: () => void): void => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", interrupt);
      action();
    };
    const failChannel = (): void =>
      finish(() => {
        child.kill("SIGKILL");
        reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
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
      finish(() => reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"))),
    );
    child.once("close", (code, signal) =>
      finish(() => {
        if (interrupted) {
          // The process has exited and its pipes are closed.
          reject(new WorkspaceRefusal("WORKSPACE_REQUEST_INTERRUPTED"));
          return;
        }
        if (
          timedOut ||
          signal !== null ||
          stderrBytes !== 0 ||
          responseBytes > RESPONSE_HEADER_BYTES + MAX_RESPONSE_BYTES
        ) {
          reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
          return;
        }
        if (code !== 0) {
          reject(new WorkspaceRefusal(mapExitCode(code)));
          return;
        }
        const bytes = Buffer.concat(response);
        if (
          bytes.length < RESPONSE_HEADER_BYTES ||
          !bytes.subarray(0, 8).equals(RESPONSE_MAGIC)
        ) {
          reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
          return;
        }
        const length = bytes.readBigUInt64BE(8);
        if (
          length > BigInt(MAX_RESPONSE_BYTES) ||
          length !== BigInt(bytes.length - RESPONSE_HEADER_BYTES)
        ) {
          reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
          return;
        }
        resolve(bytes.subarray(RESPONSE_HEADER_BYTES));
      }),
    );

    try {
      sourcePipe.end(source);
      requestInput.end(requestBytes);
    } catch {
      failChannel();
      return;
    }
    if (withHook && hookSignal != null && hookContinue != null) {
      const signalPipe = hookSignal;
      const continuePipe = hookContinue;
      const barriers = testBarriers(options).length;
      // Each barrier is two bytes, "R" and its position; the helper waits
      // for one "C" before it goes on, so barriers are handled in order.
      let pending = Buffer.alloc(0);
      let handled = Promise.resolve();
      signalPipe.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
          const marker = pending[0];
          const barrier = pending[1] ?? barriers;
          pending = pending.subarray(2);
          if (marker !== 0x52 || barrier >= barriers) {
            failChannel();
            return;
          }
          handled = handled.then(async () => {
            try {
              const answer = await options.testHook?.(barrier);
              // Any byte but "C" is an internal error inside the helper.
              continuePipe.write(
                Buffer.from(answer === "helper-fault" ? "F" : "C"),
              );
            } catch {
              failChannel();
            }
          });
        }
      });
    }
  });
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("ascii"));
  } catch {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
}

function validEntry(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    return false;
  }
  const directory = value.endsWith("/");
  const name = directory ? value.slice(0, -1) : value;
  return (
    plainString(name, 255) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

function parseEntries(raw: Buffer): ReadonlyWorkspaceResult {
  const parsed = parseJson(raw);
  if (!exactKeys(parsed, ["entries", "truncated"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(value.entries) ||
    value.entries.length > 500 ||
    !value.entries.every(validEntry) ||
    typeof value.truncated !== "boolean"
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  return success({
    kind: "workspace.entries",
    entries: [...value.entries] as string[],
    truncated: value.truncated,
  });
}

function validMatch(value: unknown): value is WorkspaceMatch {
  if (!exactKeys(value, ["line", "path", "text", "truncated"])) {
    return false;
  }
  const match = value as Readonly<Record<string, unknown>>;
  return (
    Number.isSafeInteger(match.line) &&
    (match.line as number) > 0 &&
    canonicalRelativePath(match.path) &&
    typeof match.text === "string" &&
    !match.text.includes("\n") &&
    !match.text.includes("\r") &&
    [...match.text].length <= 500 &&
    [...match.text].every((character) => {
      const code = character.codePointAt(0);
      return (
        character === "\t" || (code !== undefined && code >= 32 && code !== 127)
      );
    }) &&
    typeof match.truncated === "boolean"
  );
}

function parseMatches(raw: Buffer): ReadonlyWorkspaceResult {
  const parsed = parseJson(raw);
  if (!exactKeys(parsed, ["matches", "resultLimited", "scanLimited"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !Array.isArray(value.matches) ||
    value.matches.length > 100 ||
    !value.matches.every(validMatch) ||
    typeof value.resultLimited !== "boolean" ||
    typeof value.scanLimited !== "boolean"
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  return success({
    kind: "workspace.matches",
    matches: value.matches.map((match) => ({ ...match })) as WorkspaceMatch[],
    resultLimited: value.resultLimited,
    scanLimited: value.scanLimited,
  });
}

function parseText(raw: Buffer): ReadonlyWorkspaceResult {
  if (raw.includes(0)) return failure("WORKSPACE_NOT_TEXT");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return success({ kind: "workspace.text", text, bytes: raw.length });
  } catch {
    return failure("WORKSPACE_NOT_TEXT");
  }
}

function continuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

// How many bytes the UTF-8 sequence that `lead` begins should span. An
// invalid lead counts as one byte and is left for the decoder to refuse.
function sequenceWidth(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

// The end of the last whole character in `payload`: an incomplete trailing
// sequence is left for the next window rather than decoded as broken text.
function wholeCharacterEnd(payload: Buffer, start: number): number {
  for (
    let index = payload.length - 1;
    index >= Math.max(start, payload.length - 4);
    index -= 1
  ) {
    const byte = payload[index];
    if (byte === undefined || continuationByte(byte)) continue;
    return index + sequenceWidth(byte) > payload.length
      ? index
      : payload.length;
  }
  return payload.length;
}

/**
 * The helper answers a window with one JSON header line, then the bytes it
 * read. A window may begin or end inside a multi-byte character, so it is
 * narrowed to whole characters: each window decodes on its own and the next
 * one begins exactly where this one's text ended. Only a window stopping short
 * of the file's end may end inside a character; one that reaches the end must
 * be complete text there, as a whole read must.
 */
function parseTextWindow(
  raw: Buffer,
  range: WorkspaceReadRange,
): ReadonlyWorkspaceResult {
  const newline = raw.indexOf(0x0a);
  if (newline < 0) throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  const header = parseJson(raw.subarray(0, newline));
  if (!exactKeys(header, ["offset", "returned", "size"])) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const { offset, returned, size } = header as Readonly<
    Record<string, unknown>
  >;
  const payload = raw.subarray(newline + 1);
  if (
    offset !== range.offset ||
    returned !== payload.length ||
    payload.length > range.length ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    (payload.length > 0 && range.offset + payload.length > (size as number))
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const fileSize = size as number;
  if (payload.includes(0)) return failure("WORKSPACE_NOT_TEXT");
  let start = 0;
  while (
    range.offset > 0 &&
    start < Math.min(3, payload.length) &&
    continuationByte(payload[start])
  ) {
    start += 1;
  }
  const end =
    range.offset + payload.length < fileSize
      ? wholeCharacterEnd(payload, start)
      : payload.length;
  const bytes = payload.subarray(start, end);
  let text: string;
  try {
    // A byte-order mark is dropped only where a whole read drops it: at the
    // very start of the file.
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: range.offset + start > 0,
    }).decode(bytes);
  } catch {
    return failure("WORKSPACE_NOT_TEXT");
  }
  const windowEnd = range.offset + end;
  return success({
    kind: "workspace.text",
    text,
    bytes: bytes.length,
    page: {
      offset: range.offset + start,
      size: fileSize,
      nextOffset: windowEnd < fileSize ? windowEnd : null,
    },
  });
}

function parseEditSnapshot(raw: Buffer): WorkspaceEditSnapshotResult {
  const text = parseText(raw);
  if (!text.ok) return text;
  // The digest covers the bytes this read returned, BOM included, which are
  // the bytes the edit helper compares before it replaces the file.
  return {
    ok: true,
    value: {
      kind: "workspace.edit-snapshot",
      bytes: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    },
  };
}

function parseMutationReceipt(
  raw: Buffer,
  operation: WorkspaceMutationRequest["operation"],
): WorkspaceMutationResult {
  const parsed = parseJson(raw);
  if (
    !exactKeys(parsed, ["afterSha256", "beforeSha256", "bytes", "replacements"])
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const value = parsed as Readonly<Record<string, unknown>>;
  if (
    !validSha256(value.afterSha256) ||
    !(value.beforeSha256 === null || validSha256(value.beforeSha256)) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAX_MUTATION_BYTES ||
    !Number.isSafeInteger(value.replacements) ||
    (value.replacements as number) < 0 ||
    (value.replacements as number) > 256 ||
    (operation.kind === "workspace.write" && value.replacements !== 0) ||
    (operation.kind === "workspace.edit" && (value.replacements as number) < 1)
  ) {
    throw new WorkspaceRefusal("WORKSPACE_HELPER_FAILED");
  }
  const receipt: WorkspaceMutationReceipt = {
    kind: "workspace.mutation",
    operation: operation.kind === "workspace.write" ? "write" : "edit",
    relativePath: operation.relativePath,
    bytes: value.bytes as number,
    replacements: value.replacements as number,
    beforeSha256: value.beforeSha256 as string | null,
    afterSha256: value.afterSha256,
  };
  return { ok: true, value: receipt };
}

function readonlyErrorCode(
  code: NativeWorkspaceErrorCode,
): ReadonlyWorkspaceErrorCode {
  switch (code) {
    case "WORKSPACE_REQUEST_INTERRUPTED":
    case "WORKSPACE_MUTATION_CANCELLED":
      return "WORKSPACE_REQUEST_CANCELLED";
    case "WORKSPACE_EDIT_NO_MATCH":
    case "WORKSPACE_EDIT_NOT_UNIQUE":
    case "WORKSPACE_EDIT_OVERLAP":
    case "WORKSPACE_MUTATION_CONFLICT":
    case "WORKSPACE_MUTATION_OUTCOME_UNKNOWN":
      return "WORKSPACE_HELPER_FAILED";
    default:
      return code;
  }
}

function mutationErrorCode(
  code: NativeWorkspaceErrorCode,
): WorkspaceMutationErrorCode {
  switch (code) {
    case "WORKSPACE_RACE_DETECTED":
      return "WORKSPACE_MUTATION_CONFLICT";
    case "WORKSPACE_SEARCH_TIMEOUT":
    case "WORKSPACE_HELPER_FAILED":
    case "WORKSPACE_COMMAND_UNSUPPORTED":
    case "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE":
    case "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED":
    case "WORKSPACE_COMMAND_CANCELLED":
    case "WORKSPACE_COMMAND_TIMEOUT":
    case "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE":
    case "WORKSPACE_COMMAND_FAILED":
    case "WORKSPACE_NOT_GIT_REPOSITORY":
    case "WORKSPACE_GIT_HEAD_UNBORN":
    case "WORKSPACE_GIT_METADATA_NOT_APPROVED":
    case "WORKSPACE_REQUEST_INTERRUPTED":
      return "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";
    case "WORKSPACE_REQUEST_CANCELLED":
      return "WORKSPACE_MUTATION_CANCELLED";
    default:
      return code;
  }
}

export class NativeReadonlyWorkspace
  implements ReadonlyWorkspace, MutableWorkspace, WorkspaceEditSnapshotReader
{
  private helperAttestation: Promise<Buffer> | undefined;
  private readonly attestInterpreter: () => Promise<string>;
  private readonly homeDirectory: string;

  constructor(private readonly options: NativeReadonlyWorkspaceOptions) {
    this.attestInterpreter =
      options.attestInterpreter ?? defaultAttestInterpreter;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
  }

  // Null when the root is a home credential store or lies inside one;
  // otherwise the request with every store its root encloses added to its
  // own exclusions, before any policy bound is measured.
  private withCredentialStores<
    T extends Readonly<{
      workspace: Readonly<{ root: string; deniedPaths: readonly string[] }>;
    }>,
  >(request: T): T | null {
    const policy = credentialStorePolicy(
      request.workspace.root,
      this.homeDirectory,
    );
    if (policy.kind === "inside-store") return null;
    if (policy.deniedPaths.length === 0) return request;
    return {
      ...request,
      workspace: {
        ...request.workspace,
        deniedPaths: [
          ...new Set([...policy.deniedPaths, ...request.workspace.deniedPaths]),
        ],
      },
    };
  }

  private async helperSource(): Promise<Buffer> {
    this.helperAttestation ??= measuredHelper(
      this.options.helperPath,
      this.options.helper,
    );
    try {
      return await this.helperAttestation;
    } catch (error) {
      this.helperAttestation = undefined;
      throw error;
    }
  }

  async execute(
    request: ReadonlyWorkspaceRequest,
    options: NativeReadonlyWorkspaceTestOptions = {},
  ): Promise<ReadonlyWorkspaceResult> {
    const requested = validateRequest(request);
    if (requested === null || !validTestOptions(options)) {
      return failure("WORKSPACE_INVALID_REQUEST");
    }
    const validated = this.withCredentialStores(requested);
    if (validated === null) return failure("WORKSPACE_PATH_REFUSED");
    if (
      options.signal?.aborted &&
      validated.operation.kind !== "verification.run"
    ) {
      return failure("WORKSPACE_REQUEST_CANCELLED");
    }
    if (
      (validated.operation.kind === "verification.run"
        ? verificationDeniedPaths(validated)
        : deniedPaths(validated)
      ).length > MAX_HELPER_DENIED_PATHS
    ) {
      return failure("WORKSPACE_POLICY_TOO_LARGE");
    }

    if (validated.operation.kind === "verification.run") {
      return executeNativeVerificationCommand(
        {
          ...validated,
          workspace: {
            ...validated.workspace,
            deniedPaths: verificationDeniedPaths(validated),
          },
        },
        validated.operation,
        {
          launchInApprovedRoot: approvedRootLauncher({
            helperSource: () => this.helperSource(),
            attestInterpreter: () => this.attestInterpreter(),
          }),
          ...(this.options.attestGit
            ? { attestGit: this.options.attestGit }
            : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    }

    const raw = await this.readonlyHelper(validated, options);
    if (!Buffer.isBuffer(raw)) return failure(raw);
    switch (validated.operation.kind) {
      case "workspace.read":
        return validated.operation.range
          ? parseTextWindow(raw, validated.operation.range)
          : parseText(raw);
      case "workspace.list":
        return parseEntries(raw);
      case "workspace.search":
        return parseMatches(raw);
    }
  }

  async readEditSnapshot(
    request: WorkspaceEditSnapshotRequest,
    options: NativeReadonlyWorkspaceTestOptions = {},
  ): Promise<WorkspaceEditSnapshotResult> {
    const requested = validateRequest({
      workspace: request.workspace,
      operation: { kind: "workspace.read", relativePath: request.relativePath },
    });
    if (
      requested === null ||
      requested.operation.kind !== "workspace.read" ||
      !validTestOptions(options)
    ) {
      return {
        ok: false,
        error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
      };
    }
    const validated = this.withCredentialStores(requested);
    if (validated === null) {
      return {
        ok: false,
        error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
      };
    }
    if (deniedPaths(validated).length > MAX_HELPER_DENIED_PATHS) {
      return {
        ok: false,
        error: { code: "WORKSPACE_POLICY_TOO_LARGE", retry: "never" },
      };
    }
    // One helper read supplies both the text check and the identity; a second
    // read for the digest could observe a different file.
    const raw = await this.readonlyHelper(validated, options);
    if (!Buffer.isBuffer(raw)) {
      return { ok: false, error: { code: raw, retry: "never" } };
    }
    return parseEditSnapshot(raw);
  }

  private async readonlyHelper(
    validated: ReadonlyWorkspaceRequest,
    options: NativeReadonlyWorkspaceTestOptions,
  ): Promise<Buffer | ReadonlyWorkspaceErrorCode> {
    let source: Buffer;
    try {
      source = await this.helperSource();
    } catch {
      return "WORKSPACE_HELPER_UNTRUSTED";
    }
    let interpreter: string;
    try {
      interpreter = await this.attestInterpreter();
      if (!canonicalAbsolutePath(interpreter)) {
        return "WORKSPACE_INTERPRETER_UNTRUSTED";
      }
    } catch {
      return "WORKSPACE_INTERPRETER_UNTRUSTED";
    }

    try {
      return await runHelper(
        interpreter,
        source,
        nativeRequest(validated, options),
        options,
      );
    } catch (error) {
      return error instanceof WorkspaceRefusal
        ? readonlyErrorCode(error.code)
        : "WORKSPACE_HELPER_FAILED";
    }
  }

  async mutate(
    request: WorkspaceMutationRequest,
    options: NativeReadonlyWorkspaceTestOptions = {},
  ): Promise<WorkspaceMutationResult> {
    const requested = validateMutationRequest(request);
    if (requested === null || !validTestOptions(options)) {
      return mutationFailure("WORKSPACE_INVALID_REQUEST");
    }
    const validated = this.withCredentialStores(requested);
    if (validated === null) return mutationFailure("WORKSPACE_PATH_REFUSED");
    if (options.signal?.aborted) {
      return mutationFailure("WORKSPACE_MUTATION_CANCELLED");
    }
    if (
      deniedPaths(validated).length > MAX_HELPER_DENIED_PATHS ||
      writeDeniedPaths(validated).length > MAX_HELPER_DENIED_PATHS
    ) {
      return mutationFailure("WORKSPACE_POLICY_TOO_LARGE");
    }

    let source: Buffer;
    try {
      source = await this.helperSource();
    } catch {
      return mutationFailure("WORKSPACE_HELPER_UNTRUSTED");
    }
    let interpreter: string;
    try {
      interpreter = await this.attestInterpreter();
      if (!canonicalAbsolutePath(interpreter)) {
        return mutationFailure("WORKSPACE_INTERPRETER_UNTRUSTED");
      }
    } catch {
      return mutationFailure("WORKSPACE_INTERPRETER_UNTRUSTED");
    }

    try {
      const raw = await runHelper(
        interpreter,
        source,
        nativeMutationRequest(validated, options),
        options,
      );
      return parseMutationReceipt(raw, validated.operation);
    } catch (error) {
      return mutationFailure(
        error instanceof WorkspaceRefusal
          ? mutationErrorCode(error.code)
          : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      );
    }
  }
}
