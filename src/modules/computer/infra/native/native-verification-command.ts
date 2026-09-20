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
// The tracked-path listing (`git ls-files -z --stage`) is not a product
// result: it only decides which paths the bounded snapshot carries, so it has
// its own budget, sized for a large ordinary repository (about 90 bytes per
// entry, so well over 300,000 tracked files) rather than the 64 KiB result
// bound a status or HEAD output must fit.
const MAX_TRACKED_LIST_BYTES = 32 * 1_024 * 1_024;
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
// The snapshot mirrors both a primary checkout and a linked worktree (its own
// gitdir and the repository's common gitdir rebuilt inside the same
// destination), so Git needs no path outside it.
//
// N02c -- one command may run over more than one such snapshot. `git.status`
// first snapshots `.git` alone, asks Git itself (inside that snapshot) which
// paths are tracked, and only then builds a second, bounded snapshot that
// carries exactly those paths (minus any the workspace's own exclusions
// cover) before running the fixed status command over it. The second
// snapshot is pinned to the first's index (`expectedIndexSha256`): the two
// describe one instant, or the command refuses. `git.head` never needs a
// second snapshot: `rev-parse` reads refs and objects, never a worktree
// file.
//
// N02d -- reads stay granted across the whole snapshot subtree, but writes
// are granted to exactly the files a plain `git status` may rewrite: the
// index and its lock, in whichever metadata directory the snapshot's layout
// puts them (`.git` for a primary checkout, `.gitmeta/worktree` for a linked
// worktree; the other pair simply does not exist in that snapshot, so naming
// both unconditionally costs nothing). Every working-tree file inside the
// snapshot is an APFS clone on an inode of its own (workspace-snapshot.ts /
// safe_open.py), so no write through the snapshot could reach the owner's
// bytes in any case; the literal grant additionally keeps the fixed command
// from altering its own evidence -- HEAD, refs, objects and config inside
// the snapshot are read-only to it.
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
  (literal (param "FAROL_GIT_INDEX"))
  (literal (param "FAROL_GIT_INDEX_LOCK"))
  (literal (param "FAROL_GIT_META_INDEX"))
  (literal (param "FAROL_GIT_META_INDEX_LOCK"))
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
  | "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED"
  | "WORKSPACE_ROOT_CHANGED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_PATH_REFUSED"
  | "WORKSPACE_RACE_DETECTED"
  | "WORKSPACE_TRACKED_LIST_TOO_LARGE"
  | "WORKSPACE_TRACKED_PATH_UNSUPPORTED"
  | "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT"
  | "WORKSPACE_SNAPSHOT_TOO_LARGE"
  | "WORKSPACE_SNAPSHOT_CROSS_VOLUME"
  | "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED"
  | "WORKSPACE_HELPER_FAILED";

// The HEAD profile exits 1 without output when HEAD does not resolve; the
// caller decides from the repository metadata whether that is an unborn
// branch or a failure.
const HEAD_UNRESOLVED = Symbol("head-unresolved");

function failure(code: CommandFailureCode): ReadonlyWorkspaceResult {
  return { ok: false, error: { code, retry: "never" } };
}

// Maps a snapshot-layer refusal (EXIT_TO_CODE in workspace-snapshot.ts) onto
// this command's own closed product codes, one for one wherever the refusal
// has a product meaning: the owner's root or a named path moved or was
// refused, the snapshot would be too large or cannot be cloned on this
// volume, the live index moved between the two phases, or the repository's
// layout (unapproved external metadata, an alternates file) is one this
// route does not run over. `SNAPSHOT_HELPER_UNTRUSTED` (the attested
// interpreter or helper bytes failed their own check) is the existing
// executable-untrusted code, which already covers a failed attestation for
// the command itself. Only a malformed request of our own, an invalid
// destination or an internal helper fault -- none of which says anything
// about the owner's repository -- stay on the generic `WORKSPACE_HELPER_FAILED`.
function snapshotFailureCode(
  code: WorkspaceSnapshotErrorCode,
): CommandFailureCode {
  switch (code) {
    case "SNAPSHOT_ROOT_CHANGED":
      return "WORKSPACE_ROOT_CHANGED";
    case "SNAPSHOT_METADATA_UNAPPROVED":
      return "WORKSPACE_GIT_METADATA_NOT_APPROVED";
    case "SNAPSHOT_ALTERNATES_UNSUPPORTED":
      return "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED";
    case "SNAPSHOT_HELPER_UNTRUSTED":
      return "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED";
    case "SNAPSHOT_NOT_FOUND":
      return "WORKSPACE_NOT_FOUND";
    case "SNAPSHOT_PATH_REFUSED":
      return "WORKSPACE_PATH_REFUSED";
    case "SNAPSHOT_RACE_DETECTED":
      return "WORKSPACE_RACE_DETECTED";
    case "SNAPSHOT_TOO_LARGE":
      return "WORKSPACE_SNAPSHOT_TOO_LARGE";
    case "SNAPSHOT_CROSS_VOLUME":
      return "WORKSPACE_SNAPSHOT_CROSS_VOLUME";
    case "SNAPSHOT_CLONE_UNSUPPORTED":
      return "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED";
    case "SNAPSHOT_INDEX_CHANGED":
      return "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT";
    case "SNAPSHOT_INVALID_REQUEST":
    case "SNAPSHOT_DESTINATION_INVALID":
    case "SNAPSHOT_HELPER_FAILED":
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

const HEAD_ARGUMENTS = [
  "rev-parse",
  "--verify",
  "--quiet",
  "HEAD",
] as const satisfies readonly string[];

// The fixed status invocation: porcelain v1, NUL-terminated (`-z`), so every
// path arrives raw -- no C-quoting Git would otherwise apply to a space, a
// non-ASCII character or an arrow -- and is parsed structurally
// (`parsePorcelainStatus`) rather than by line. One `:(exclude,top,literal)`
// pathspec per denied prefix keeps Git from even considering a tracked path
// the workspace's own exclusions cover (such a path is never in the snapshot
// either, so without the exclusion Git would report it deleted);
// `literal` disables glob interpretation of the prefix and `top` anchors it
// at the snapshot root whatever the working directory. The rendered result
// is filtered against the same prefixes again (`isUnderAnyPrefix`, folded
// the way the helper folds), so nothing rests on Git's own matching alone.
function statusArguments(deniedPrefixes: readonly string[]): readonly string[] {
  return [
    "status",
    "--porcelain",
    "--branch",
    "-z",
    "--untracked-files=no",
    "--ignore-submodules=all",
    ...(deniedPrefixes.length > 0
      ? [
          "--",
          ...deniedPrefixes.map((prefix) => `:(exclude,top,literal)${prefix}`),
        ]
      : []),
  ];
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

// The `-c` flags every fixed Git invocation over a snapshot uses, whatever
// command it runs: no config-driven execution path from the owner's
// repository survives the minimal `.git/config` this snapshot already
// carries, but these still remove anything a caller-supplied override on the
// command line could otherwise reintroduce. (`core.quotepath` is moot for the
// `-z` listings this route reads, and is pinned so no other output shape can
// ever appear.)
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

type CompletedGit = Readonly<{
  code: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}>;

type SandboxedGitOutcome =
  Readonly<{ failure: CommandFailureCode }> | CompletedGit;

// How much stdout one fixed invocation may produce before it is killed, and
// the code that kill is reported as. The tracked-path listing has its own,
// larger budget and its own code, so a large but ordinary repository is told
// apart from a status or HEAD output that overran the product's result bound.
type SandboxedGitBudget = Readonly<{
  maxStdoutBytes: number;
  overflow: CommandFailureCode;
}>;

const COMMAND_OUTPUT_BUDGET: SandboxedGitBudget = {
  maxStdoutBytes: MAX_OUTPUT_BYTES,
  overflow: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
};

const TRACKED_LIST_BUDGET: SandboxedGitBudget = {
  maxStdoutBytes: MAX_TRACKED_LIST_BYTES,
  overflow: "WORKSPACE_TRACKED_LIST_TOO_LARGE",
};

// Runs one fixed, no-network Git invocation entirely inside `snapshotPath`
// (the private snapshot N02 built): the Seatbelt profile grants read across
// that whole directory, plus the reviewed Git binary and the system
// libraries it needs, but write only to the snapshot's own index and index
// lock (N02d). Git sees no pathname belonging to the owner's real workspace
// at all -- primary and linked-worktree layouts alike are self-contained
// inside the snapshot (workspace-snapshot.ts / safe_open.py
// `_snapshot_linked_worktree`), so no extra grant is needed for either. This
// is the one place a sandboxed Git process is spawned; `runGitStatus`,
// `runGitHead` and `runGitLsFiles` (tracked-path discovery) are all thin
// callers through `completedGit`, so a sandbox failure, a timeout or a
// cancellation is classified identically whichever one is running.
function runSandboxedGit(
  git: string,
  snapshotPath: string,
  trailingArguments: readonly string[],
  budget: SandboxedGitBudget,
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
    // N02d -- the four literal files Git may actually rewrite: the index and
    // its lock, in a primary checkout's `.git` or in the `.gitmeta/worktree`
    // directory a linked worktree's snapshot rebuilds. Each is a plain join
    // of an already-validated `snapshotPath` with fixed literal segments, so
    // no extra path check is needed here.
    "-D",
    `FAROL_GIT_INDEX=${path.join(snapshotPath, ".git", "index")}`,
    "-D",
    `FAROL_GIT_INDEX_LOCK=${path.join(snapshotPath, ".git", "index.lock")}`,
    "-D",
    `FAROL_GIT_META_INDEX=${path.join(snapshotPath, ".gitmeta", "worktree", "index")}`,
    "-D",
    `FAROL_GIT_META_INDEX_LOCK=${path.join(snapshotPath, ".gitmeta", "worktree", "index.lock")}`,
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
    let stdoutTooLarge = false;
    let stderrTooLarge = false;
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
      if (stdoutBytes > budget.maxStdoutBytes) {
        stdoutTooLarge = true;
        killProcessGroup(child);
      } else {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stderrTooLarge = true;
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
      if (stdoutTooLarge) {
        finish({ failure: budget.overflow });
        return;
      }
      if (stderrTooLarge) {
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

// One fixed invocation's outcome, with the sandbox's own refusal to apply
// its profile classified before anything else is read from it.
async function completedGit(
  git: string,
  snapshotPath: string,
  trailingArguments: readonly string[],
  budget: SandboxedGitBudget,
  signal?: AbortSignal,
): Promise<SandboxedGitOutcome> {
  const outcome = await runSandboxedGit(
    git,
    snapshotPath,
    trailingArguments,
    budget,
    signal,
  );
  if ("failure" in outcome) return outcome;
  if (/^sandbox-exec: sandbox_apply:/mu.test(outcome.stderr)) {
    return { failure: "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE" };
  }
  return outcome;
}

function commandResult(
  command: VerificationOperation["command"],
  stdout: string,
): ReadonlyWorkspaceResult {
  return {
    ok: true,
    value: {
      kind: "workspace.command",
      command,
      relativePath: ".",
      exitCode: 0,
      stdout,
      stderr: "",
      outputBytes: Buffer.byteLength(stdout),
      network: "none",
      coverage: commandCoverage(command),
      layout: "primary",
    },
  };
}

async function runGitHead(
  git: string,
  snapshotPath: string,
  signal?: AbortSignal,
): Promise<ReadonlyWorkspaceResult | typeof HEAD_UNRESOLVED> {
  const completed = await completedGit(
    git,
    snapshotPath,
    HEAD_ARGUMENTS,
    COMMAND_OUTPUT_BUDGET,
    signal,
  );
  if ("failure" in completed) return failure(completed.failure);
  const { code, exitSignal, stdout, stderr } = completed;
  if (
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
  let output: string;
  try {
    output = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return failure("WORKSPACE_COMMAND_FAILED");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n$/u.test(output)) {
    return failure("WORKSPACE_COMMAND_FAILED");
  }
  return commandResult("git.head", output);
}

// A repository-relative path this route is willing to name in a request or
// render in a result: no NUL, CR, LF or backslash, no absolute or traversal
// shape. Git itself admits more into an index (a backslash, a newline); such
// a path is refused as `WORKSPACE_TRACKED_PATH_UNSUPPORTED` rather than
// smuggled through a snapshot request or a rendered line.
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

// One `git ls-files -z --stage` record: `<mode> <object> <stage>\t<path>`.
const TRACKED_RECORD =
  /^([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t([\s\S]+)$/u;
const GITLINK_MODE = "160000";

type TrackedListing =
  | Readonly<{ kind: "ok"; paths: readonly string[] }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "unsupported-path" }>;

// Splits `git ls-files -z --stage` output into validated,
// repository-relative tracked paths. `-z` NUL-terminates every record
// including the last, so a well-formed payload's final split segment is
// always empty. A gitlink (mode 160000, a submodule's commit) is dropped: it
// is not a file in this tree and the fixed status ignores submodules anyway.
// An unmerged path appears once per stage and is kept once. Output that is
// not a well-formed listing is `malformed`; a well-formed record naming a
// path this route will not carry is `unsupported-path`; neither is ever
// reinterpreted as "nothing tracked".
function parseTrackedListing(stdout: Buffer): TrackedListing {
  if (stdout.length === 0) return { kind: "ok", paths: [] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return { kind: "malformed" };
  }
  const fields = text.split("\0");
  if (fields.length < 2 || fields[fields.length - 1] !== "") {
    return { kind: "malformed" };
  }
  const paths = new Set<string>();
  for (const field of fields.slice(0, -1)) {
    const match = TRACKED_RECORD.exec(field);
    const mode = match?.[1];
    const trackedPath = match?.[2];
    if (mode === undefined || trackedPath === undefined) {
      return { kind: "malformed" };
    }
    if (mode === GITLINK_MODE) continue;
    if (!validTrackedPath(trackedPath)) return { kind: "unsupported-path" };
    paths.add(trackedPath);
  }
  return { kind: "ok", paths: [...paths] };
}

type TrackedPathsResult =
  | Readonly<{ ok: true; paths: readonly string[] }>
  | Readonly<{ ok: false; result: ReadonlyWorkspaceResult }>;

// Asks Git which paths are tracked, inside the metadata-only snapshot: `git
// ls-files` reads only the index that snapshot already copied, so it never
// needs a single working-tree file to be present. Its output decides the
// bounded set of paths the *next* snapshot carries -- this function never
// touches the owner's workspace itself.
async function runGitLsFiles(
  git: string,
  snapshotPath: string,
  signal?: AbortSignal,
): Promise<TrackedPathsResult> {
  const completed = await completedGit(
    git,
    snapshotPath,
    ["ls-files", "-z", "--stage"],
    TRACKED_LIST_BUDGET,
    signal,
  );
  if ("failure" in completed) {
    return { ok: false, result: failure(completed.failure) };
  }
  const { code, exitSignal, stdout, stderr } = completed;
  if (code !== 0 || exitSignal !== null || stderr !== "") {
    return { ok: false, result: failure("WORKSPACE_COMMAND_FAILED") };
  }
  const listing = parseTrackedListing(stdout);
  if (listing.kind === "malformed") {
    return { ok: false, result: failure("WORKSPACE_COMMAND_FAILED") };
  }
  if (listing.kind === "unsupported-path") {
    return {
      ok: false,
      result: failure("WORKSPACE_TRACKED_PATH_UNSUPPORTED"),
    };
  }
  return { ok: true, paths: listing.paths };
}

// One path component, folded the way the helper's `_comparable` folds it
// (NFC, then a case fold): macOS volumes compare names case- and
// normalisation-insensitively, so `Private/x` and a decomposed `privé/x`
// name the same objects as `private/x` and `privé/x`. Folding here means a
// tracked path that is a case or normalisation variant of a denied prefix is
// excluded on this side before it is ever named to the helper, which would
// refuse it (`SNAPSHOT_PATH_REFUSED` -> `WORKSPACE_PATH_REFUSED`) -- the
// same decision, reached first where it is cheapest. `toUpperCase` then
// `toLowerCase` is the closest full case fold JavaScript offers (it maps `ß`
// to `ss` and a final sigma to `σ` as Python's `casefold` does).
function comparableSegment(segment: string): string {
  return segment.normalize("NFC").toUpperCase().toLowerCase();
}

function isUnderAnyPrefix(
  relativePath: string,
  prefixes: readonly string[],
): boolean {
  const segments = relativePath.split("/").map(comparableSegment);
  return prefixes.some((prefix) => {
    const prefixSegments = prefix.split("/").map(comparableSegment);
    return (
      prefixSegments.length <= segments.length &&
      prefixSegments.every((segment, index) => segments[index] === segment)
    );
  });
}

// The two-character status field of a porcelain v1 record, per column.
const STATUS_CODE_CHARACTERS = new Set([
  " ",
  "M",
  "T",
  "A",
  "D",
  "R",
  "C",
  "U",
]);

type StatusRecord = Readonly<{
  code: string;
  path: string;
  // Renames and copies carry the path the content came from as a second
  // NUL-terminated field.
  original?: string;
}>;

type ParsedStatus =
  | Readonly<{
      kind: "ok";
      header: string | null;
      records: readonly StatusRecord[];
    }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "unsupported-path" }>;

// Parses `git status --porcelain --branch -z` structurally: an optional
// `## <branch>` header, then `XY <path>` records, each NUL-terminated, a
// rename or copy followed by one more NUL-terminated field holding the
// original path. Paths arrive raw (no quoting under `-z`), so a denied
// prefix can be matched against the exact bytes Git saw, and the rendered
// result never has to undo an escape. Anything outside this shape is
// `malformed`; a path this route will not render is `unsupported-path`.
function parsePorcelainStatus(stdout: Buffer): ParsedStatus {
  if (stdout.length === 0) return { kind: "ok", header: null, records: [] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return { kind: "malformed" };
  }
  const fields = text.split("\0");
  if (fields.length < 2 || fields[fields.length - 1] !== "") {
    return { kind: "malformed" };
  }
  fields.pop();
  let header: string | null = null;
  let position = 0;
  const first = fields[0];
  if (first !== undefined && first.startsWith("## ")) {
    header = first.slice(3);
    if (header.length === 0 || /[\r\n]/u.test(header)) {
      return { kind: "malformed" };
    }
    position = 1;
  }
  const records: StatusRecord[] = [];
  while (position < fields.length) {
    const field = fields[position] ?? "";
    position += 1;
    const code = field.slice(0, 2);
    if (
      field.length < 4 ||
      field.charAt(2) !== " " ||
      code === "  " ||
      !STATUS_CODE_CHARACTERS.has(field.charAt(0)) ||
      !STATUS_CODE_CHARACTERS.has(field.charAt(1))
    ) {
      return { kind: "malformed" };
    }
    const target = field.slice(3);
    if (!validTrackedPath(target)) return { kind: "unsupported-path" };
    if (code.includes("R") || code.includes("C")) {
      const original = fields[position];
      position += 1;
      if (original === undefined) return { kind: "malformed" };
      if (!validTrackedPath(original)) return { kind: "unsupported-path" };
      records.push({ code, path: target, original });
    } else {
      records.push({ code, path: target });
    }
  }
  return { kind: "ok", header, records };
}

// Renders the parsed status the way `git status --short --branch` would,
// minus the C-quoting: `## <branch>`, then `XY <path>` or
// `XY <original> -> <path>`, one per line, paths as raw UTF-8.
function renderStatus(
  header: string | null,
  records: readonly StatusRecord[],
): string {
  const lines: string[] = [];
  if (header !== null) lines.push(`## ${header}`);
  for (const record of records) {
    lines.push(
      record.original === undefined
        ? `${record.code} ${record.path}`
        : `${record.code} ${record.original} -> ${record.path}`,
    );
  }
  return lines.map((line) => `${line}\n`).join("");
}

// Runs the fixed status over one snapshot and renders it. A record naming a
// path under a denied prefix -- as its own path or as the original of a
// rename or copy -- is dropped whatever Git's own exclusion pathspec did with
// it, so a denied path is absent from the result exactly as it is absent
// from the snapshot, whatever characters it carries.
async function runGitStatus(
  git: string,
  snapshotPath: string,
  deniedPrefixes: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyWorkspaceResult> {
  const completed = await completedGit(
    git,
    snapshotPath,
    statusArguments(deniedPrefixes),
    COMMAND_OUTPUT_BUDGET,
    signal,
  );
  if ("failure" in completed) return failure(completed.failure);
  const { code, exitSignal, stdout, stderr } = completed;
  if (code !== 0 || exitSignal !== null || stderr !== "") {
    return failure("WORKSPACE_COMMAND_FAILED");
  }
  const parsed = parsePorcelainStatus(stdout);
  if (parsed.kind === "malformed") return failure("WORKSPACE_COMMAND_FAILED");
  if (parsed.kind === "unsupported-path") {
    return failure("WORKSPACE_TRACKED_PATH_UNSUPPORTED");
  }
  const kept = parsed.records.filter(
    (record) =>
      !isUnderAnyPrefix(record.path, deniedPrefixes) &&
      (record.original === undefined ||
        !isUnderAnyPrefix(record.original, deniedPrefixes)),
  );
  const output = renderStatus(parsed.header, kept);
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    return failure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE");
  }
  return commandResult("git.status", output);
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
    Readonly<{ path: string; device: string; inode: string }> | undefined;
  let externalCommonDir:
    Readonly<{ path: string; device: string; inode: string }> | undefined;
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
  const withLayout = (
    result: ReadonlyWorkspaceResult,
  ): ReadonlyWorkspaceResult =>
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
  // carries exactly those paths: the snapshot only ever carries what the
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
      const result = await runGitHead(
        git,
        metadataSnapshot.path,
        options.signal,
      );
      if (result === HEAD_UNRESOLVED) {
        return (await headIsUnbornBranch(metadata))
          ? failure("WORKSPACE_GIT_HEAD_UNBORN")
          : failure("WORKSPACE_COMMAND_FAILED");
      }
      return withLayout(result);
    }

    const listed = await runGitLsFiles(
      git,
      metadataSnapshot.path,
      options.signal,
    );
    if (!listed.ok) return listed.result;
    // A tracked path under one of the workspace's own exclusions is never
    // carried -- absent from the snapshot exactly as an untracked path in
    // the same subtree already is -- and `runGitStatus` excludes and filters
    // it from the reported result, so it is absent from the Git result too,
    // not merely reported as missing. The match is folded like the helper's,
    // so a case or normalisation variant is excluded here rather than named
    // to the helper and refused there.
    const allowedPaths = listed.paths.filter(
      (trackedPath) => !isUnderAnyPrefix(trackedPath, deniedPaths),
    );

    const runStatus = async (
      snapshotPath: string,
    ): Promise<ReadonlyWorkspaceResult> =>
      withLayout(
        await runGitStatus(git, snapshotPath, deniedPaths, options.signal),
      );

    if (allowedPaths.length === 0) {
      // Nothing beyond `.git` needs carrying: either the repository tracks
      // nothing yet, or everything tracked falls under an exclusion. The
      // metadata-only snapshot already built is the whole answer.
      return await runStatus(metadataSnapshot.path);
    }
    // Phase 2 is pinned to phase 1's index: the tracked list above came from
    // the index bytes phase 1 copied, and the helper refuses this snapshot
    // unless the index it copies now is byte-identical, so the list and the
    // status computed over it describe one instant rather than two.
    const trackedSnapshot = await options.createSnapshot({
      ...baseSnapshotRequest,
      paths: allowedPaths,
      expectedIndexSha256: metadataSnapshot.indexSha256,
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
