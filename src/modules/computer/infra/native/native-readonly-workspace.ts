import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Readable, Writable } from "node:stream";

import type {
  MutableWorkspace,
  WorkspaceMutationRequest,
  WorkspaceMutationResult,
} from "../../app/port/mutable-workspace";
import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceExecutionContext,
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
  WorkspaceApprovedRoot,
} from "../../app/port/readonly-workspace";
import { credentialStorePolicy } from "./home-secret-stores";
import { executeNativeVerificationCommand } from "./native-verification-command";
import { canonicalAbsolutePath, exactKeys, plainString } from "./paths";
import {
  DEFAULT_DENIED_PATHS,
  MAX_HELPER_DENIED_PATHS,
  deniedPaths,
  verificationDeniedPaths,
  writeDeniedPaths,
} from "./denied";
import {
  WorkspaceRefusal,
  mapExitCode,
  mutationErrorCode,
  readonlyErrorCode,
} from "./errors";
import { MAX_SOURCE_BYTES } from "./limits";
import {
  parseEntries,
  parseMatches,
  parseMutationReceipt,
  parseText,
  parseTextWindow,
} from "./replies";
import { failure, mutationFailure } from "./results";
import { validateMutationRequest, validateRequest } from "./requests";

export { DEFAULT_DENIED_PATHS };
import { createWorkspaceSnapshot } from "./workspace-snapshot";

export type SafeOpenHelperRecord = Readonly<{
  sha256: string;
  size: number;
  mode: number;
}>;

export const SAFE_OPEN_HELPER: SafeOpenHelperRecord = Object.freeze({
  sha256: "9a94b5947e8cea02f32a28b3488bf8bc8e8fcdb767c755840054710ba0ea207c",
  size: 133611,
  mode: 0o644,
});

const RESPONSE_MAGIC = Buffer.from("FAROLR1\0", "ascii");
const RESPONSE_HEADER_BYTES = 16;
const O_CLOEXEC =
  (Reflect.get(fsConstants, "O_CLOEXEC") as number | undefined) ?? 0;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

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
  // N02: where a Git verification's private snapshot is created (mode 0700,
  // `mkdtemp`'s own guarantee) before it is removed again. Farol's own
  // runtime directory in production; a test's own temporary directory in
  // tests. Defaults to the OS temporary directory.
  runtimeDirectory?: string;
}>;

type SystemFileMeasurement = Readonly<{
  path: string;
  symlink: boolean;
  regularFile: boolean;
  uid: number;
  mode: number;
}>;

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

function approvedRootRequest(
  workspace: Readonly<{ approvedRoot: WorkspaceApprovedRoot }>,
): Readonly<{ approvedRoot: WorkspaceApprovedRoot }> {
  return { approvedRoot: { ...workspace.approvedRoot } };
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
    let spawnError: Error | undefined;
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
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) =>
      finish(() => {
        if (spawnError) {
          reject(spawnError);
          return;
        }
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
      child.once("error", () => {});
      child.once("close", () =>
        reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED")),
      );
      child.kill("SIGKILL");
      return;
    }
    const requestInput = requestPipe;

    const response: Buffer[] = [];
    let responseBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let interrupted = false;
    let channelFailed = false;
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
    const failChannel = (): void => {
      channelFailed = true;
      child.kill("SIGKILL");
    };
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
    child.once("error", failChannel);
    child.once("close", (code, signal) =>
      finish(() => {
        if (channelFailed) {
          reject(new WorkspaceRefusal("WORKSPACE_HELPER_FAILED"));
          return;
        }
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

export class NativeReadonlyWorkspace
  implements ReadonlyWorkspace, MutableWorkspace
{
  private helperAttestation: Promise<Buffer> | undefined;
  private readonly attestInterpreter: () => Promise<string>;
  private readonly homeDirectory: string;
  private readonly runtimeDirectory: string;

  constructor(private readonly options: NativeReadonlyWorkspaceOptions) {
    this.attestInterpreter =
      options.attestInterpreter ?? defaultAttestInterpreter;
    this.homeDirectory = options.homeDirectory ?? os.homedir();
    this.runtimeDirectory = options.runtimeDirectory ?? os.tmpdir();
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
          createSnapshot: (snapshotRequest) =>
            createWorkspaceSnapshot(snapshotRequest, {
              helperPath: this.options.helperPath,
              helper: this.options.helper,
              attestInterpreter: () => this.attestInterpreter(),
              runtimeDirectory: this.runtimeDirectory,
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
