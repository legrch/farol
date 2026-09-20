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
// descriptors Farol already holds, and the sandbox grants read access to
// that snapshot directory alone -- never to the owner's workspace pathname.
// (N02d narrows the matching write grant further still; see below.) The
// snapshot mirrors both a primary checkout and a linked worktree (its own
// gitdir and the repository's common gitdir rebuilt inside the same
// destination), so Git needs no path outside it.
//
// N02c -- one command may run over more than one such snapshot. `git.status`
// first snapshots `.git` alone, asks Git itself (inside that snapshot) which
// paths are tracked, and only then builds a second, bounded snapshot that
// links exactly those paths (minus any the workspace's own exclusions cover)
// before running the fixed status command over it. `git.head` never needs a
// second snapshot: `rev-parse` reads refs and objects, never a worktree
// file.
//
// N02d -- reads stay granted across the whole snapshot subtree, but writes do
// not: a working-tree file inside the snapshot is a hard link to the owner's
// own inode (workspace-snapshot.ts / safe_open.py), so a write grant wide
// enough to cover it would let the fixed Git command rewrite the owner's real
// file. `git status`/`git rev-parse` only ever need to write repository
// metadata Git itself may rewrite in place -- the index and its lock during
// an index refresh -- and that metadata is always a private copy inside the
// snapshot (`_snapshot_copy_handler`), never a link to the owner's tree. The
// write grant is therefore narrowed to exactly the two metadata subtrees a
// snapshot can contain: `.git` (a plain directory holding that metadata for a
// primary checkout) and `.gitmeta` (the `worktree`/`common` pair
// `_snapshot_linked_worktree` rebuilds for a linked worktree, whose top-level
// `.git` is instead a small fixed pointer file Git never rewrites). Whichever
// layout is in play, the other subtree simply does not exist in that
// snapshot, so granting both unconditionally costs nothing.
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
  (subpath (param "FAROL_GIT_DIR"))
  (subpath (param "FAROL_GIT_META_DIR"))
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

// Builds one private snapshot and removes it once the caller is done with
// it. One Git verification may call this more than once (N02c: a
// metadata-only snapshot, then a bounded one carrying exactly the tracked
// paths it found) -- production wires this to `createWorkspaceSnapshot`
// (workspace-snapshot.ts); a test may supply a fixed handle directly.
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

// The `-c` flags every fixed Git invocation over a snapshot uses, whatever
// command it runs: no config-driven execution path from the owner's
// repository survives the minimal `.git/config` this snapshot already
// carries, but these still remove anything a caller-supplied override on the
// command line could otherwise reintroduce.
const FIXED_GIT_CONFIG_ARGUMENTS = [
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
] as const;

type SandboxedGitOutcome =
  | Readonly<{ failure: CommandFailureCode }>
  | Readonly<{
      code: number | null;
      exitSignal: NodeJS.Signals | null;
      stdout: Buffer;
      stderr: string;
    }>;

// Runs one fixed, no-network Git invocation entirely inside `snapshotPath`
// (the private snapshot N02 built): the Seatbelt profile grants read across
// that whole directory, plus the reviewed Git binary and the system
// libraries it needs, but write only under its `.git` and `.gitmeta`
// metadata subtrees (N02d) -- never under a working-tree path a snapshot may
// have hard-linked to the owner's own inode. Git sees no pathname belonging
// to the owner's real workspace at all -- primary and linked-worktree
// layouts alike are self-contained inside the snapshot
// (workspace-snapshot.ts / safe_open.py `_snapshot_linked_worktree`), so no
// extra grant is needed for either. This is the one place a sandboxed Git
// process is spawned; `runGitOverSnapshot` (status/head) and `runGitLsFiles`
// (tracked-path discovery) are both thin callers, so a sandbox failure, a
// timeout or a cancellation is classified identically whichever one is
// running.
function runSandboxedGit(
  git: string,
  snapshotPath: string,
  trailingArguments: readonly string[],
  signal?: AbortSignal,
): Promise<SandboxedGitOutcome> {
  if (signal?.aborted) {
    return Promise.resolve({ failure: "WORKSPACE_COMMAND_CANCELLED" });
  }
  if (!plainPath(snapshotPath)) {
    return Promise.resolve({ failure: "WORKSPACE_COMMAND_UNSUPPORTED" });
  }
  let ancestors: readonly string[];
  try {
    ancestors = snapshotAncestors(snapshotPath);
    if (ancestors.length > MAX_SNAPSHOT_ANCESTORS) {
      throw new Error("snapshot path is too deep");
    }
  } catch {
    return Promise.resolve({ failure: "WORKSPACE_COMMAND_UNSUPPORTED" });
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
    // N02d -- the two metadata subtrees Git may actually rewrite: `.git`
    // (a primary checkout's own directory, or a linked worktree's small
    // fixed pointer file, which is never rewritten but costs nothing to
    // name) and `.gitmeta` (the worktree/common pair a linked worktree's
    // snapshot rebuilds). Both are plain joins of an already-validated
    // `snapshotPath` with a fixed literal segment, so no extra path check is
    // needed here.
    "-D",
    `FAROL_GIT_DIR=${path.join(snapshotPath, ".git")}`,
    "-D",
    `FAROL_GIT_META_DIR=${path.join(snapshotPath, ".gitmeta")}`,
  ];
  ancestors.forEach((directory, index) => {
    parameters.push("-D", `FAROL_SNAPSHOT_PARENT_${index}=${directory}`);
  });
  const launchArguments = [
    ...parameters,
    "-p",
    profile,
    git,
    ...FIXED_GIT_CONFIG_ARGUMENTS,
    ...trailingArguments,
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
      resolve({ failure: "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE" });
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
    const finish = (result: SandboxedGitOutcome): void => {
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
      finish({
        failure: cancelled
          ? "WORKSPACE_COMMAND_CANCELLED"
          : "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE",
      }),
    );
    child.once("close", (code, exitSignal) => {
      if (cancelled) {
        finish({ failure: "WORKSPACE_COMMAND_CANCELLED" });
        return;
      }
      if (timedOut) {
        finish({ failure: "WORKSPACE_COMMAND_TIMEOUT" });
        return;
      }
      if (outputTooLarge) {
        finish({ failure: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE" });
        return;
      }
      finish({
        code,
        exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function runGitOverSnapshot(
  git: string,
  snapshotPath: string,
  command: VerificationOperation["command"],
  signal?: AbortSignal,
): Promise<ReadonlyWorkspaceResult | typeof HEAD_UNRESOLVED> {
  const outcome = await runSandboxedGit(
    git,
    snapshotPath,
    gitArguments(command),
    signal,
  );
  if ("failure" in outcome) return failure(outcome.failure);
  const { code, exitSignal, stdout, stderr } = outcome;
  if (/^sandbox-exec: sandbox_apply:/mu.test(stderr)) {
    return failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE");
  }
  if (
    command === "git.head" &&
    code === 1 &&
    exitSignal === null &&
    stderr === "" &&
    stdout.length === 0
  ) {
    return HEAD_UNRESOLVED;
  }
  if (code !== 0 || exitSignal !== null || stderr !== "") {
    return failure("WORKSPACE_COMMAND_FAILED");
  }
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    if (!validGitOutput(command, output)) {
      return failure("WORKSPACE_COMMAND_FAILED");
    }
    return {
      ok: true,
      value: {
        kind: "workspace.command",
        command,
        relativePath: ".",
        exitCode: 0,
        stdout: output,
        stderr: "",
        outputBytes: stdout.length,
        network: "none",
        coverage: commandCoverage(command),
        layout: "primary",
      },
    };
  } catch {
    return failure("WORKSPACE_COMMAND_FAILED");
  }
}

// Splits `git ls-files -z` output into validated, repository-relative
// tracked paths.  `-z` NUL-terminates every entry including the last, so a
// well-formed payload's final split segment is always empty; anything else
// (a stray NUL-free line, an absolute or traversal-shaped entry) is treated
// as output this helper will not trust rather than guessed at.
function validTrackedPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.startsWith("/") &&
    !/[\0\r\n\\]/u.test(value) &&
    path.normalize(value) === value &&
    value
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parseTrackedPaths(stdout: Buffer): readonly string[] | null {
  if (stdout.length === 0) return [];
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return null;
  }
  const parts = text.split("\0");
  if (parts.length === 0 || parts[parts.length - 1] !== "") return null;
  const entries = parts.slice(0, -1);
  return entries.every(validTrackedPath) ? entries : null;
}

type TrackedPathsResult =
  | Readonly<{ ok: true; paths: readonly string[] }>
  | Readonly<{ ok: false; result: ReadonlyWorkspaceResult }>;

// Asks Git which paths are tracked, inside the metadata-only snapshot: `git
// ls-files` reads only the index that snapshot already copied, so it never
// needs a single working-tree file to be present. Its output decides the
// bounded set of paths the *next* snapshot links -- this function never
// touches the owner's workspace itself.
async function runGitLsFiles(
  git: string,
  snapshotPath: string,
  signal?: AbortSignal,
): Promise<TrackedPathsResult> {
  const outcome = await runSandboxedGit(
    git,
    snapshotPath,
    ["ls-files", "-z"],
    signal,
  );
  if ("failure" in outcome) return { ok: false, result: failure(outcome.failure) };
  const { code, exitSignal, stdout, stderr } = outcome;
  if (/^sandbox-exec: sandbox_apply:/mu.test(stderr)) {
    return { ok: false, result: failure("WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE") };
  }
  if (code !== 0 || exitSignal !== null || stderr !== "") {
    return { ok: false, result: failure("WORKSPACE_COMMAND_FAILED") };
  }
  // A clean exit with output that is not a well-formed `-z` listing is
  // treated as "nothing tracked" rather than a hard failure: this can only
  // shrink the set of paths the next snapshot links, never widen it, so it
  // never grants more than the empty-list case already would. Real `git
  // ls-files` never produces such output; this exists for whatever else may
  // be attested as "git" in a degraded or hostile configuration.
  return { ok: true, paths: parseTrackedPaths(stdout) ?? [] };
}

function isUnderAnyPrefix(
  relativePath: string,
  prefixes: readonly string[],
): boolean {
  const segments = relativePath.split("/");
  return prefixes.some((prefix) => {
    const prefixSegments = prefix.split("/");
    return (
      prefixSegments.length <= segments.length &&
      prefixSegments.every((segment, index) => segments[index] === segment)
    );
  });
}

// Best-effort unquote of one `git status --short` path field. With
// `core.quotepath=true` Git C-quotes a path that carries a special
// character; a plain ASCII path (the overwhelming case) is never quoted and
// round-trips through this unchanged.
function unquoteStatusPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}

// Removes any `git status --short` line naming a tracked-but-denied path, so
// a path the workspace's own exclusions cover is absent from the reported
// result exactly as it is absent from the snapshot -- not merely shown as a
// deletion. The branch header line (`## ...`) is never a path line and is
// always kept.
function stripDeniedStatusLines(
  output: string,
  deniedTracked: ReadonlySet<string>,
): string {
  if (deniedTracked.size === 0) return output;
  const lines = output.split("\n");
  const kept = lines.filter((line, index) => {
    if (line === "" && index === lines.length - 1) return true;
    if (line.startsWith("##")) return true;
    if (line.length < 3) return true;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const candidates =
      arrow >= 0 ? [rest.slice(0, arrow), rest.slice(arrow + 4)] : [rest];
    return !candidates.some((candidate) =>
      deniedTracked.has(unquoteStatusPath(candidate)),
    );
  });
  return kept.join("\n");
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
  const deniedPaths = request.workspace.deniedPaths;
  const baseSnapshotRequest = {
    root: request.workspace.root,
    approvedRoot: request.workspace.approvedRoot,
    ...(externalGitDir ? { externalGitDir } : {}),
    ...(externalCommonDir ? { externalCommonDir } : {}),
    ...(deniedPaths.length > 0 ? { denied: deniedPaths } : {}),
  };
  const withLayout = (result: ReadonlyWorkspaceResult): ReadonlyWorkspaceResult =>
    result.ok && result.value.kind === "workspace.command"
      ? {
          ok: true,
          value: {
            ...result.value,
            layout: linkedWorktree ? "linked-worktree" : "primary",
          },
        }
      : result;

  // Phase 1: `.git` alone, no working-tree paths at all. `git.head` needs
  // nothing else -- `rev-parse` reads refs and objects, never a worktree
  // file. `git.status` uses this same snapshot to ask Git itself which
  // paths are tracked (`runGitLsFiles`), before a second, bounded snapshot
  // links exactly those paths: the snapshot only ever carries what the
  // command in front of it actually needs.
  const metadataSnapshot = await options.createSnapshot({
    ...baseSnapshotRequest,
    paths: [],
  });
  if (!metadataSnapshot.ok) {
    return failure(snapshotFailureCode(metadataSnapshot.code));
  }
  try {
    if (operation.command === "git.head") {
      const result = await runGitOverSnapshot(
        git,
        metadataSnapshot.path,
        "git.head",
        options.signal,
      );
      if (result === HEAD_UNRESOLVED) {
        return (await headIsUnbornBranch(metadata))
          ? failure("WORKSPACE_GIT_HEAD_UNBORN")
          : failure("WORKSPACE_COMMAND_FAILED");
      }
      return withLayout(result);
    }

    const listed = await runGitLsFiles(git, metadataSnapshot.path, options.signal);
    if (!listed.ok) return listed.result;
    // A tracked path under one of the workspace's own exclusions is never
    // linked -- absent from the snapshot exactly as an untracked path in the
    // same subtree already is -- and any status line naming it is stripped
    // from the reported result below, so it is absent from the Git result
    // too, not merely reported as missing.
    const deniedTracked = new Set(
      listed.paths.filter((trackedPath) => isUnderAnyPrefix(trackedPath, deniedPaths)),
    );
    const allowedPaths = listed.paths.filter(
      (trackedPath) => !deniedTracked.has(trackedPath),
    );

    const runStatus = async (
      snapshotPath: string,
    ): Promise<ReadonlyWorkspaceResult> => {
      const result = await runGitOverSnapshot(
        git,
        snapshotPath,
        "git.status",
        options.signal,
      );
      if (result === HEAD_UNRESOLVED) return failure("WORKSPACE_COMMAND_FAILED");
      if (
        result.ok &&
        result.value.kind === "workspace.command" &&
        deniedTracked.size > 0
      ) {
        const stdout = stripDeniedStatusLines(result.value.stdout, deniedTracked);
        return withLayout({
          ok: true,
          value: {
            ...result.value,
            stdout,
            outputBytes: Buffer.byteLength(stdout),
          },
        });
      }
      return withLayout(result);
    };

    if (allowedPaths.length === 0) {
      // Nothing beyond `.git` needs linking: either the repository tracks
      // nothing yet, or everything tracked falls under an exclusion. The
      // metadata-only snapshot already built is the whole answer.
      return await runStatus(metadataSnapshot.path);
    }
    const trackedSnapshot = await options.createSnapshot({
      ...baseSnapshotRequest,
      paths: allowedPaths,
    });
    if (!trackedSnapshot.ok) {
      return failure(snapshotFailureCode(trackedSnapshot.code));
    }
    try {
      return await runStatus(trackedSnapshot.path);
    } finally {
      await trackedSnapshot.remove();
    }
  } finally {
    await metadataSnapshot.remove();
  }
}
