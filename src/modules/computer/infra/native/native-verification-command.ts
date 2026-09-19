import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import type {
  ReadonlyWorkspaceRequest,
  ReadonlyWorkspaceResult,
  WorkspaceGitMetadataGrant,
} from "../../app/port/readonly-workspace";
import type {
  WorkspaceSnapshotErrorCode,
  WorkspaceSnapshotOutcome,
  WorkspaceSnapshotRequest,
} from "./workspace-snapshot";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const XCODE_SELECT = "/usr/bin/xcode-select";
const XCRUN = "/usr/bin/xcrun";
const CODESIGN = "/usr/bin/codesign";
const MAX_OUTPUT_BYTES = 64 * 1_024;
const MAX_STDERR_BYTES = 4 * 1_024;
const MAX_GIT_METADATA_BYTES = 4 * 1_024;
const COMMAND_TIMEOUT_MS = 10_000;
const O_CLOEXEC =
  (Reflect.get(fsConstants, "O_CLOEXEC") as number | undefined) ?? 0;
const O_DIRECTORY =
  (Reflect.get(fsConstants, "O_DIRECTORY") as number | undefined) ?? 0;
const O_NOFOLLOW =
  (Reflect.get(fsConstants, "O_NOFOLLOW") as number | undefined) ?? 0;

const REVIEWED_DEVELOPER_ROOTS = Object.freeze([
  "/Applications/Xcode.app/Contents/Developer",
  "/Library/Developer/CommandLineTools",
]);

// N02 -- Git never reads the owner's folder. It reads only the private
// snapshot `createSnapshot` (workspace-snapshot.ts) assembles from
// descriptors Farol already holds, and the sandbox grants read and write
// access to that snapshot directory alone -- never to the owner's workspace
// pathname. The snapshot mirrors both a primary checkout and a linked
// worktree (its own gitdir and the repository's common gitdir rebuilt inside
// the same destination), so Git needs no path outside it.
const COMMAND_PROFILE = `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-exec (literal (param "FAROL_GIT")))
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/private/etc")
  (literal "/dev/null")
  (literal "/dev/urandom")
  (subpath (param "FAROL_DEVELOPER"))
  (subpath (param "FAROL_EXECUTABLE_DIR"))
  (subpath (param "FAROL_SNAPSHOT")))
(allow file-write*
  (subpath (param "FAROL_SNAPSHOT"))
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/null")
  (regex #"^/dev/fd/[0-9]+$"))
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(deny network*)`;

type VerificationOperation = Extract<
  ReadonlyWorkspaceRequest["operation"],
  { kind: "verification.run" }
>;

// Builds the private snapshot for one Git verification and removes it once
// the caller is done with it -- production wires this to
// `createWorkspaceSnapshot` (workspace-snapshot.ts); a test may supply a
// fixed handle directly.
export type SnapshotFactory = (
  request: WorkspaceSnapshotRequest,
) => Promise<WorkspaceSnapshotOutcome>;

export type NativeVerificationCommandOptions = Readonly<{
  attestGit?: () => Promise<string>;
  createSnapshot: SnapshotFactory;
  // Test seam: runs after the last pathname check and before the snapshot is
  // built, the window a replacement of the root used to exploit (F1-8). The
  // snapshot's own descriptor-bound walk re-checks the approved identity, so
  // a replacement made here is never read.
  beforeSnapshot?: () => Promise<void>;
  signal?: AbortSignal;
}>;

type ExactResult = Readonly<{ stdout: string; stderr: string }>;
type WorkspaceGitMetadata = Readonly<{
  gitDirectory: string;
  commonDirectory: string;
}>;
type CommandFailureCode =
  | "WORKSPACE_COMMAND_UNSUPPORTED"
  | "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"
  | "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED"
  | "WORKSPACE_COMMAND_CANCELLED"
  | "WORKSPACE_COMMAND_TIMEOUT"
  | "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"
  | "WORKSPACE_COMMAND_FAILED"
  | "WORKSPACE_NOT_GIT_REPOSITORY"
  | "WORKSPACE_GIT_HEAD_UNBORN"
  | "WORKSPACE_GIT_METADATA_NOT_APPROVED"
  | "WORKSPACE_ROOT_CHANGED"
  | "WORKSPACE_HELPER_FAILED";

// The HEAD profile exits 1 without output when HEAD does not resolve; the
// caller decides from the repository metadata whether that is an unborn
// branch or a failure.
const HEAD_UNRESOLVED = Symbol("head-unresolved");

function failure(code: CommandFailureCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

// Maps a snapshot-layer refusal (cbcf0924, EXIT_TO_CODE in workspace-snapshot.ts)
// onto this command's own product codes. `SNAPSHOT_ROOT_CHANGED` and
// `SNAPSHOT_METADATA_UNAPPROVED` already name an existing product refusal
// exactly, so they are surfaced as that code; every other snapshot failure is
// an internal-mechanism refusal without a more specific product meaning, so
// it is surfaced as the existing generic `WORKSPACE_HELPER_FAILED`, and
// `SNAPSHOT_HELPER_UNTRUSTED` (the attested interpreter or helper bytes
// failed their own check) as the existing executable-untrusted code, which
// already covers a failed attestation for the command itself.
function snapshotFailureCode(code: WorkspaceSnapshotErrorCode): CommandFailureCode {
  switch (code) {
    case "SNAPSHOT_ROOT_CHANGED":
      return "WORKSPACE_ROOT_CHANGED";
    case "SNAPSHOT_METADATA_UNAPPROVED":
      return "WORKSPACE_GIT_METADATA_NOT_APPROVED";
    case "SNAPSHOT_HELPER_UNTRUSTED":
      return "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED";
    default:
      return "WORKSPACE_HELPER_FAILED";
  }
}

function plainPath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value !== "/" &&
    value.length <= 4_096 &&
    !/[\0\n\r"\\]/u.test(value)
  );
}

function runExact(
  executable: string,
  arguments_: readonly string[],
): Promise<ExactResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...arguments_], {
      env: { LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    const finish = (action: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      action();
    };
    const collect =
      (chunks: Buffer[]) =>
      (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > 16 * 1_024) child.kill("SIGKILL");
        else chunks.push(chunk);
      };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code, signal) =>
      finish(() => {
        if (code !== 0 || signal !== null || bytes > 16 * 1_024) {
          reject(new Error("reviewed executable failed"));
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

async function systemExecutable(filePath: string): Promise<void> {
  if (!plainPath(filePath)) throw new Error("invalid executable path");
  const listed = await lstat(filePath, { bigint: true });
  let handle;
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      listed.isSymbolicLink() ||
      !opened.isFile() ||
      listed.dev !== opened.dev ||
      listed.ino !== opened.ino ||
      opened.uid !== 0n ||
      (opened.mode & 0o022n) !== 0n ||
      (opened.mode & 0o111n) === 0n
    ) {
      throw new Error("untrusted executable");
    }
  } finally {
    await handle?.close();
  }
}

function signatureField(output: string, name: string): string | null {
  return output.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1] ?? null;
}

async function attestReviewedGit(): Promise<string> {
  await systemExecutable(XCODE_SELECT);
  await systemExecutable(XCRUN);
  await systemExecutable(CODESIGN);
  await systemExecutable(SANDBOX_EXEC);
  const selected = await runExact(XCODE_SELECT, ["-p"]);
  const found = await runExact(XCRUN, ["--find", "git"]);
  if (selected.stderr !== "" || found.stderr !== "") {
    throw new Error("developer tools reported an error");
  }
  const developerRoot = selected.stdout.trim();
  const git = found.stdout.trim();
  if (
    !REVIEWED_DEVELOPER_ROOTS.includes(developerRoot) ||
    git !== `${developerRoot}/usr/bin/git`
  ) {
    throw new Error("git is outside the reviewed developer root");
  }
  await systemExecutable(git);
  const signature = await runExact(CODESIGN, ["-dv", "--verbose=4", git]);
  if (
    signatureField(signature.stderr, "Identifier") !== "com.apple.git" ||
    signatureField(signature.stderr, "TeamIdentifier") !== "59GAB85EFG"
  ) {
    throw new Error("git signature is not reviewed");
  }
  const version = await runExact(git, ["--version"]);
  if (
    version.stderr !== "" ||
    !/^git version [0-9]+\.[0-9]+\.[0-9]+ \(Apple Git-[0-9]+\)\n$/u.test(
      version.stdout,
    )
  ) {
    throw new Error("git version is not reviewed");
  }
  return git;
}

let reviewedGit: Promise<string> | undefined;

async function defaultAttestGit(): Promise<string> {
  reviewedGit ??= attestReviewedGit();
  try {
    return await reviewedGit;
  } catch (error) {
    reviewedGit = undefined;
    throw error;
  }
}

async function isOwnedDirectory(
  directory: string,
  uid: bigint,
): Promise<boolean> {
  if (!plainPath(directory)) return false;
  let handle;
  try {
    const listed = await lstat(directory, { bigint: true });
    handle = await open(
      directory,
      fsConstants.O_RDONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    const physical = await realpath(directory);
    return (
      physical === directory &&
      !listed.isSymbolicLink() &&
      listed.isDirectory() &&
      opened.isDirectory() &&
      listed.dev === opened.dev &&
      listed.ino === opened.ino &&
      opened.uid === uid &&
      (opened.mode & 0o022n) === 0n
    );
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function readOwnedMetadataFile(
  filePath: string,
  uid: bigint,
): Promise<string | null> {
  if (!plainPath(filePath)) return null;
  let handle;
  try {
    const listed = await lstat(filePath, { bigint: true });
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | O_CLOEXEC | O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (
      listed.isSymbolicLink() ||
      !listed.isFile() ||
      !opened.isFile() ||
      listed.dev !== opened.dev ||
      listed.ino !== opened.ino ||
      opened.uid !== uid ||
      (opened.mode & 0o022n) !== 0n
    ) {
      return null;
    }
    const bytes = Buffer.alloc(MAX_GIT_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead === bytes.length) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, bytesRead),
    );
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function onePathLine(value: string): string | null {
  const match = /^([^\0\r\n]+)\n?$/u.exec(value);
  const line = match?.[1];
  return line !== undefined && line.trim() === line ? line : null;
}

function resolveMetadataPath(base: string, value: string): string | null {
  const candidate = path.resolve(base, value);
  return plainPath(candidate) ? candidate : null;
}

// null means metadata this verifier will not follow; "not-repository" means
// the approved root simply has no .git entry.
// A linked worktree keeps its metadata outside the root. Its structure (the
// `.git` pointer, `commondir` and the backlink) proves a relationship, not a
// permission, so outside owner verification ("discover") the pointed-to
// directories must be exactly the ones the owner approved, and that is decided
// before any file inside them is opened.
async function resolveWorkspaceGitMetadata(
  root: string,
  grant: WorkspaceGitMetadataGrant | "discover" | undefined,
): Promise<WorkspaceGitMetadata | "not-repository" | "not-approved" | null> {
  if (!plainPath(root)) return null;
  const uid = process.getuid?.();
  if (uid === undefined || !(await isOwnedDirectory(root, BigInt(uid)))) {
    return null;
  }
  const gitEntry = path.join(root, ".git");
  try {
    const listed = await lstat(gitEntry, { bigint: true });
    if (listed.isDirectory()) {
      if (!(await isOwnedDirectory(gitEntry, BigInt(uid)))) return null;
      return { gitDirectory: gitEntry, commonDirectory: gitEntry };
    }
    if (listed.isSymbolicLink() || !listed.isFile()) return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "not-repository"
      : null;
  }

  const gitEntryText = await readOwnedMetadataFile(gitEntry, BigInt(uid));
  const gitDirectoryLine =
    gitEntryText === null
      ? null
      : (/^gitdir: ([^\0\r\n]+)\n?$/u.exec(gitEntryText)?.[1] ?? null);
  if (
    gitDirectoryLine === null ||
    gitDirectoryLine.trim() !== gitDirectoryLine
  ) {
    return null;
  }
  const gitDirectory = resolveMetadataPath(root, gitDirectoryLine);
  if (gitDirectory === null) return null;
  if (grant !== "discover" && grant?.gitDirectory !== gitDirectory) {
    return "not-approved";
  }
  if (!(await isOwnedDirectory(gitDirectory, BigInt(uid)))) return null;

  const commonLine = onePathLine(
    (await readOwnedMetadataFile(
      path.join(gitDirectory, "commondir"),
      BigInt(uid),
    )) ?? "",
  );
  if (commonLine === null) return null;
  const commonDirectory = resolveMetadataPath(gitDirectory, commonLine);
  if (
    grant !== "discover" &&
    commonDirectory !== null &&
    grant?.commonDirectory !== commonDirectory
  ) {
    return "not-approved";
  }
  if (
    commonDirectory === null ||
    !(await isOwnedDirectory(commonDirectory, BigInt(uid))) ||
    path.basename(path.dirname(gitDirectory)) !== "worktrees" ||
    path.dirname(path.dirname(gitDirectory)) !== commonDirectory
  ) {
    return null;
  }

  const backLinkLine = onePathLine(
    (await readOwnedMetadataFile(
      path.join(gitDirectory, "gitdir"),
      BigInt(uid),
    )) ?? "",
  );
  const backLink =
    backLinkLine === null
      ? null
      : resolveMetadataPath(gitDirectory, backLinkLine);
  if (backLink !== gitEntry) return null;
  return { gitDirectory, commonDirectory };
}

// The identity of a directory this command already proved is owned and
// exactly the one the owner approved (`resolveWorkspaceGitMetadata`): what
// the snapshot's own grant needs to re-check that identity itself, the same
// discipline every other grant in this product already follows.
async function directoryGrant(
  directory: string,
): Promise<Readonly<{ path: string; device: string; inode: string }> | null> {
  try {
    const measured = await lstat(directory, { bigint: true });
    return measured.isDirectory() && !measured.isSymbolicLink()
      ? {
          path: directory,
          device: String(measured.dev),
          inode: String(measured.ino),
        }
      : null;
  } catch {
    return null;
  }
}

function validDeniedPath(relative: string): boolean {
  return (
    relative.length > 0 &&
    !relative.startsWith("/") &&
    !relative.endsWith("/") &&
    !relative.includes("\\") &&
    relative
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

// `subpath` grants the snapshot's own subtree, never the chain of ordinary
// directories leading to it (the snapshot lives under Farol's runtime
// directory, itself under the OS temporary root). A linked worktree's `.git`
// file and its `commondir` name that chain by absolute path, and Git
// canonicalises them component by component, so each ancestor directory
// needs its metadata (never its contents) readable. A primary checkout never
// exercises this path -- `.git` is a plain directory at the snapshot's own
// top level -- but the grant costs nothing to always add.
const MAX_SNAPSHOT_ANCESTORS = 128;

function snapshotAncestors(snapshotPath: string): readonly string[] {
  const ancestors: string[] = [];
  let current = path.dirname(snapshotPath);
  while (current !== "/") {
    ancestors.push(current);
    current = path.dirname(current);
  }
  return ancestors;
}

function sandboxDeveloperRoot(git: string): string {
  return (
    REVIEWED_DEVELOPER_ROOTS.find((root) => git.startsWith(`${root}/`)) ??
    "/System"
  );
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The fixed child can exit between the bound check and group signal.
    }
  }
  child.kill("SIGKILL");
}

function gitArguments(
  command: VerificationOperation["command"],
): readonly string[] {
  return command === "git.status"
    ? [
        "status",
        "--short",
        "--branch",
        "--untracked-files=no",
        "--ignore-submodules=all",
      ]
    : ["rev-parse", "--verify", "--quiet", "HEAD"];
}

// Status excludes untracked files and submodules by construction; HEAD reads
// one commit.  The result says so rather than letting a short status read as
// a clean workspace.
function commandCoverage(
  command: VerificationOperation["command"],
): "tracked-files-only" | "head-commit" {
  return command === "git.status" ? "tracked-files-only" : "head-commit";
}

async function headIsUnbornBranch(
  metadata: WorkspaceGitMetadata,
): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const head = await readOwnedMetadataFile(
    path.join(metadata.gitDirectory, "HEAD"),
    BigInt(uid),
  );
  return head !== null && /^ref: refs\/heads\/[^\0\r\n]+\n?$/u.test(head);
}

function validGitOutput(
  command: VerificationOperation["command"],
  output: string,
): boolean {
  return (
    !output.includes("\0") &&
    (command === "git.status" ||
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/u.test(output))
  );
}

// Runs the fixed, no-network Git command entirely inside `snapshotPath` (the
// private snapshot N02 built): the Seatbelt profile grants read and write
// only under that one directory, plus the reviewed Git binary and the system
// libraries it needs. Git sees no pathname belonging to the owner's real
// workspace at all -- primary and linked-worktree layouts alike are self-
// contained inside the snapshot (workspace-snapshot.ts / safe_open.py
// `_snapshot_linked_worktree`), so no extra grant is needed for either.
function runGitOverSnapshot(
  git: string,
  snapshotPath: string,
  command: VerificationOperation["command"],
  signal?: AbortSignal,
): Promise<ReadonlyWorkspaceResult | typeof HEAD_UNRESOLVED> {
  if (signal?.aborted) {
    return Promise.resolve(failure("WORKSPACE_COMMAND_CANCELLED"));
  }
  if (!plainPath(snapshotPath)) {
    return Promise.resolve(failure("WORKSPACE_COMMAND_UNSUPPORTED"));
  }
  let ancestors: readonly string[];
  try {
    ancestors = snapshotAncestors(snapshotPath);
    if (ancestors.length > MAX_SNAPSHOT_ANCESTORS) {
      throw new Error("snapshot path is too deep");
    }
  } catch {
    return Promise.resolve(failure("WORKSPACE_COMMAND_UNSUPPORTED"));
  }
  const ancestorRules = ancestors
    .map(
      (_directory, index) =>
        `(allow file-read-metadata (literal (param "FAROL_SNAPSHOT_PARENT_${index}")))`,
    )
    .join("\n");
  const profile = `${COMMAND_PROFILE}\n${ancestorRules}\n`;
  const parameters = [
    "-D",
    `FAROL_GIT=${git}`,
    "-D",
    `FAROL_DEVELOPER=${sandboxDeveloperRoot(git)}`,
    // The reviewed executable's own directory: exec-ing it needs its bytes
    // (and, for an ad-hoc binary, its dynamic dependencies) to be readable,
    // not only permitted by `process-exec`. For the real reviewed Git this is
    // always inside FAROL_DEVELOPER already; it is listed separately so this
    // profile is provably correct for exactly the executable it was built
    // for, whatever that executable's own location is.
    "-D",
    `FAROL_EXECUTABLE_DIR=${path.dirname(git)}`,
    "-D",
    `FAROL_SNAPSHOT=${snapshotPath}`,
  ];
  ancestors.forEach((directory, index) => {
    parameters.push("-D", `FAROL_SNAPSHOT_PARENT_${index}=${directory}`);
  });
  const launchArguments = [
    ...parameters,
    "-p",
    profile,
    git,
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.quotepath=true",
    "-c",
    "submodule.recurse=false",
    ...gitArguments(command),
  ];
  const environment = {
    GIT_CEILING_DIRECTORIES: path.dirname(snapshotPath),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: snapshotPath,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/private/tmp",
  };

  return new Promise((resolve) => {
    const child = spawn(SANDBOX_EXEC, launchArguments, {
      cwd: snapshotPath,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.stdout === null || child.stderr === null) {
      killProcessGroup(child);
      resolve(failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTooLarge = false;
    let cancelled = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child);
    }, COMMAND_TIMEOUT_MS);
    const finish = (
      result: ReadonlyWorkspaceResult | typeof HEAD_UNRESOLVED,
    ): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = (): void => {
      if (finished || cancelled) return;
      cancelled = true;
      killProcessGroup(child);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        killProcessGroup(child);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        outputTooLarge = true;
        killProcessGroup(child);
      } else {
        stderr.push(chunk);
      }
    });
    child.once("error", () =>
      finish(
        failure(
          cancelled
            ? "WORKSPACE_COMMAND_CANCELLED"
            : "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE",
        ),
      ),
    );
    child.once("close", (code, exitSignal) => {
      if (cancelled) {
        finish(failure("WORKSPACE_COMMAND_CANCELLED"));
        return;
      }
      if (timedOut) {
        finish(failure("WORKSPACE_COMMAND_TIMEOUT"));
        return;
      }
      if (outputTooLarge) {
        finish(failure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"));
        return;
      }
      const body = Buffer.concat(stdout);
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (/^sandbox-exec: sandbox_apply:/mu.test(errorText)) {
        finish(failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"));
        return;
      }
      if (
        command === "git.head" &&
        code === 1 &&
        exitSignal === null &&
        errorText === "" &&
        body.length === 0
      ) {
        finish(HEAD_UNRESOLVED);
        return;
      }
      if (code !== 0 || exitSignal !== null || errorText !== "") {
        finish(failure("WORKSPACE_COMMAND_FAILED"));
        return;
      }
      try {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(body);
        if (!validGitOutput(command, output)) {
          finish(failure("WORKSPACE_COMMAND_FAILED"));
          return;
        }
        finish({
          ok: true,
          value: {
            kind: "workspace.command",
            command,
            relativePath: ".",
            exitCode: 0,
            stdout: output,
            stderr: "",
            outputBytes: body.length,
            network: "none",
            coverage: commandCoverage(command),
            layout: "primary",
          },
        });
      } catch {
        finish(failure("WORKSPACE_COMMAND_FAILED"));
      }
    });
  });
}

// An early, cheap refusal. The binding itself happens again inside the
// snapshot's own descriptor-bound walk, which opens the root by descriptor
// and checks this identity before any file is read.
async function approvedRootUnchanged(
  approved: ReadonlyWorkspaceRequest["workspace"]["approvedRoot"],
): Promise<boolean> {
  try {
    const measured = await lstat(approved.path, { bigint: true });
    return (
      measured.isDirectory() &&
      String(measured.dev) === approved.device &&
      String(measured.ino) === approved.inode
    );
  } catch {
    return false;
  }
}

/**
 * Owner verification is when linked-worktree metadata is approved: this reads
 * the current layout and returns the grant the owner is approving, or null for
 * a root whose metadata lives inside it, or that is not a repository.
 */
export async function discoverLinkedGitMetadata(
  root: string,
): Promise<WorkspaceGitMetadataGrant | null> {
  const metadata = await resolveWorkspaceGitMetadata(root, "discover");
  if (
    metadata === null ||
    metadata === "not-repository" ||
    metadata === "not-approved" ||
    metadata.gitDirectory === path.join(root, ".git")
  ) {
    return null;
  }
  return {
    gitDirectory: metadata.gitDirectory,
    commonDirectory: metadata.commonDirectory,
  };
}

export async function executeNativeVerificationCommand(
  request: ReadonlyWorkspaceRequest,
  operation: VerificationOperation,
  options: NativeVerificationCommandOptions,
): Promise<ReadonlyWorkspaceResult> {
  if (options.signal?.aborted) {
    return failure("WORKSPACE_COMMAND_CANCELLED");
  }
  if (
    (operation.command !== "git.status" && operation.command !== "git.head") ||
    operation.relativePath !== "."
  ) {
    return failure("WORKSPACE_COMMAND_UNSUPPORTED");
  }
  if (
    request.workspace.deniedPaths.some(
      (relative) =>
        !validDeniedPath(relative) ||
        !plainPath(path.join(request.workspace.root, ...relative.split("/"))),
    )
  ) {
    return failure("WORKSPACE_COMMAND_UNSUPPORTED");
  }
  if (!(await approvedRootUnchanged(request.workspace.approvedRoot))) {
    return failure("WORKSPACE_ROOT_CHANGED");
  }
  const initialMetadata = await resolveWorkspaceGitMetadata(
    request.workspace.root,
    request.workspace.gitMetadata,
  );
  if (options.signal?.aborted) {
    return failure("WORKSPACE_COMMAND_CANCELLED");
  }
  if (initialMetadata === "not-repository") {
    return failure("WORKSPACE_NOT_GIT_REPOSITORY");
  }
  if (initialMetadata === "not-approved") {
    return failure("WORKSPACE_GIT_METADATA_NOT_APPROVED");
  }
  if (initialMetadata === null) {
    return failure("WORKSPACE_COMMAND_UNSUPPORTED");
  }
  let git: string;
  try {
    git = await (options.attestGit ?? defaultAttestGit)();
    if (!plainPath(git)) throw new Error("invalid git path");
  } catch {
    return failure("WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED");
  }
  if (options.signal?.aborted) {
    return failure("WORKSPACE_COMMAND_CANCELLED");
  }
  const metadata = await resolveWorkspaceGitMetadata(
    request.workspace.root,
    request.workspace.gitMetadata,
  );
  if (options.signal?.aborted) {
    return failure("WORKSPACE_COMMAND_CANCELLED");
  }
  if (
    metadata === null ||
    metadata === "not-repository" ||
    metadata === "not-approved" ||
    metadata.gitDirectory !== initialMetadata.gitDirectory ||
    metadata.commonDirectory !== initialMetadata.commonDirectory
  ) {
    return failure("WORKSPACE_COMMAND_UNSUPPORTED");
  }
  const primaryMetadata = path.join(request.workspace.root, ".git");
  const linkedWorktree = metadata.gitDirectory !== primaryMetadata;
  let externalGitDir:
    | Readonly<{ path: string; device: string; inode: string }>
    | undefined;
  let externalCommonDir:
    | Readonly<{ path: string; device: string; inode: string }>
    | undefined;
  if (linkedWorktree) {
    const gitDirGrant = await directoryGrant(metadata.gitDirectory);
    const commonDirGrant = await directoryGrant(metadata.commonDirectory);
    if (gitDirGrant === null || commonDirGrant === null) {
      return failure("WORKSPACE_COMMAND_FAILED");
    }
    externalGitDir = gitDirGrant;
    externalCommonDir = commonDirGrant;
  }
  if (!(await approvedRootUnchanged(request.workspace.approvedRoot))) {
    return failure("WORKSPACE_ROOT_CHANGED");
  }
  await options.beforeSnapshot?.();
  const snapshot = await options.createSnapshot({
    root: request.workspace.root,
    approvedRoot: request.workspace.approvedRoot,
    ...(externalGitDir ? { externalGitDir } : {}),
    ...(externalCommonDir ? { externalCommonDir } : {}),
  });
  if (!snapshot.ok) {
    return failure(snapshotFailureCode(snapshot.code));
  }
  try {
    const result = await runGitOverSnapshot(
      git,
      snapshot.path,
      operation.command,
      options.signal,
    );
    if (result === HEAD_UNRESOLVED) {
      return (await headIsUnbornBranch(metadata))
        ? failure("WORKSPACE_GIT_HEAD_UNBORN")
        : failure("WORKSPACE_COMMAND_FAILED");
    }
    if (result.ok && result.value.kind === "workspace.command") {
      return {
        ok: true,
        value: {
          ...result.value,
          layout: linkedWorktree ? "linked-worktree" : "primary",
        },
      };
    }
    return result;
  } finally {
    await snapshot.remove();
  }
}
