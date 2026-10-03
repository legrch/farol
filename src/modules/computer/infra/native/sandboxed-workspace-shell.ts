import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  authorizeComputerAction,
  type ComputerApproval,
  type ParticipantAuthority,
} from "../../domain/execution-authority";
import { DEFAULT_DENIED_PATHS } from "./native-readonly-workspace";
import { credentialStorePolicy } from "./home-secret-stores";
import { matchesApprovedGitMetadata } from "./native-verification-command";
import {
  SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE,
  SHELL_WATCHDOG_SOURCE,
} from "./shell-watchdog-source";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const OUTPUT_WINDOW_BYTES = 64 * 1024;
const MAX_RUNNING = 4;
const MAX_COMPLETED = 8;
const MAX_COMPUTER_OPERATIONS = 10_000;

export type ShellStart = Readonly<{
  operationId: string;
  workspaceId: string;
  relativeCwd: string;
  command: string;
  stdin?: string | undefined;
  timeoutMs: number;
  write: boolean;
}>;

export type ShellRead = Readonly<{
  handle: string;
  stdoutOffset: number;
  stderrOffset: number;
}>;

export type ShellOutcome = Readonly<{
  handle: string;
  state: "running" | "exited";
  groupCleanup: "pending" | "confirmed" | "unverified";
  detachedCleanup: "unverified";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBase64: string;
  stderrBase64: string;
  stdoutNextOffset: number;
  stderrNextOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  outputLimitReached: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  authorityExpired: boolean;
  errorCode:
    | "SHELL_SPAWN_FAILED"
    | "SHELL_SANDBOX_UNAVAILABLE"
    | "SHELL_WATCHDOG_LOST"
    | "SHELL_GROUP_CLEANUP_UNVERIFIED"
    | null;
}>;

type RunningCommand = {
  operationId: string;
  fingerprint: string;
  handle: string;
  child: ChildProcess;
  productPid: number | null;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  state: "running" | "exited";
  rootExitReported: boolean;
  signalRefused: boolean;
  groupCleanup: "pending" | "confirmed" | "unverified";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  outputLimitReached: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  authorityExpired: boolean;
  errorCode:
    | "SHELL_SPAWN_FAILED"
    | "SHELL_SANDBOX_UNAVAILABLE"
    | "SHELL_WATCHDOG_LOST"
    | "SHELL_GROUP_CLEANUP_UNVERIFIED"
    | null;
  scratch: string;
  terminal: Promise<"confirmed" | "unverified">;
  settleTerminal: (cleanup: "confirmed" | "unverified") => void;
};

type Binding = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
}>;

type Workspace = ComputerApproval["workspaces"][number];
type EffectiveWorkspace = Readonly<{
  root: string;
  access: "read" | "write";
  gitMetadata: Workspace["gitMetadata"];
  gitHistoryApproved: boolean;
}>;

export type ShellResponse =
  | Readonly<{ ok: true; value: ShellOutcome }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; retry: "never" }> }>;

function refusal(code: string): ShellResponse {
  return { ok: false, error: { code, retry: "never" } };
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function exactRelative(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      value.length <= 4_096 &&
      !path.isAbsolute(value) &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

function profile(
  workspaces: readonly EffectiveWorkspace[],
  exclusions: readonly Readonly<{ path: string }>[],
  scratch: string,
  write: boolean,
  gitSettings: readonly string[],
): Readonly<{ source: string; parameters: string[] }> {
  const parameters: string[] = [];
  const reads: string[] = [];
  const writes: string[] = [];
  const denies: string[] = [];
  const parents = new Set<string>();
  const add = (label: string, value: string, collection: string[]) => {
    const key = `${label}_${collection.length}`;
    parameters.push("-D", `${key}=${value}`);
    collection.push(`(subpath (param "${key}"))`);
    for (
      let ancestor = path.dirname(value);
      ancestor !== "/";
      ancestor = path.dirname(ancestor)
    ) {
      parents.add(ancestor);
    }
  };
  for (const effective of workspaces) {
    add("ROOT", effective.root, reads);
    if (write && effective.access === "write")
      add("WRITE", effective.root, writes);
    if (effective.gitMetadata) {
      add("GIT_READ", effective.gitMetadata.gitDirectory, reads);
      add("GIT_READ", effective.gitMetadata.commonDirectory, reads);
      if (write && effective.access === "write") {
        add("GIT_WRITE", effective.gitMetadata.gitDirectory, writes);
        add("GIT_WRITE", effective.gitMetadata.commonDirectory, writes);
      }
    }
  }
  for (const setting of gitSettings) add("GIT_SETTINGS", setting, reads);
  for (const exclusion of exclusions ?? []) {
    // A command may cross effective task roots, but never an excluded path.
    add("DENY", exclusion.path, denies);
  }
  for (const workspace of workspaces) {
    for (const relative of DEFAULT_DENIED_PATHS) {
      if (relative === ".git" && workspace.gitHistoryApproved) continue;
      add("DENY", path.join(workspace.root, relative), denies);
    }
  }
  add("SCRATCH", scratch, reads);
  add("SCRATCH", scratch, writes);
  const parentRules = [...parents]
    .map((parent, index) => {
      const key = `PARENT_${index}`;
      parameters.push("-D", `${key}=${parent}`);
      return `(allow file-read-metadata (literal (param "${key}")))`;
    })
    .join("\n");
  const source = `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/usr/sbin")
  (subpath "/sbin")
  (subpath "/private/etc")
  (subpath "/opt/homebrew/bin")
  (subpath "/opt/homebrew/Cellar")
  (subpath "/opt/homebrew/lib")
  (subpath "/opt/homebrew/opt")
  (subpath "/usr/local/bin")
  (subpath "/usr/local/Cellar")
  (subpath "/usr/local/lib")
  (subpath "/usr/local/opt")
  (subpath "/Library/Developer/CommandLineTools")
  (subpath "/Applications/Xcode.app/Contents/Developer")
  (literal "/dev/null")
  (literal "/dev/urandom")
  ${reads.join("\n  ")})
(allow file-read-metadata (subpath "/dev"))
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (regex #"^/dev/fd/[0-9]+$")
  ${writes.join("\n  ")})
${denies.length ? `(deny file-read* file-write* ${denies.join(" ")})` : ""}
(deny file-read* file-write*
  (regex #"/(\\.env|\\.ssh|\\.aws|\\.gnupg|\\.codex|\\.claude|\\.git-credentials|\\.netrc|\\.npmrc|\\.pypirc)(/|$)"))
${workspaces.some((workspace) => !workspace.gitHistoryApproved) ? '(deny file-read* file-write* (regex #"/\\.git(/|$)"))' : ""}
${parentRules}
(deny network*)`;
  return { source, parameters };
}

function stopWatchdog(child: ChildProcess): void {
  if (child.connected) child.send({ type: "stop" });
}

function window(bytes: readonly Buffer[], offset: number): Buffer {
  return Buffer.concat(bytes).subarray(offset, offset + OUTPUT_WINDOW_BYTES);
}

type ShellExecutionAuthority = Readonly<{
  approval: ComputerApproval;
  participant: ParticipantAuthority;
  deadlineAt: number;
  current(): Promise<boolean>;
}>;

export class SandboxedWorkspaceShell {
  private readonly execution = new AsyncLocalStorage<ShellExecutionAuthority>();
  private readonly byOperation = new Map<string, RunningCommand>();
  private readonly byHandle = new Map<string, RunningCommand>();
  private readonly pendingOperations = new Set<string>();
  private readonly pendingTerminalCleanup = new Set<Promise<void>>();
  private readonly completedOrder: string[] = [];
  private closing = false;
  private groupCleanupUnverified = false;
  private scratchCleanupUnverified = false;
  private terminalCleanupUnverified = false;

  constructor(
    private readonly launchApproval: ComputerApproval,
    private readonly launchParticipant: ParticipantAuthority,
    private readonly binding: Binding,
    private readonly privateRoot: string,
    private readonly now: () => number = () => Date.now(),
    private readonly homeDirectory: string = os.homedir(),
    private readonly authority?: Readonly<{
      admitExecution(lifetimeMs: number): Promise<ShellExecutionAuthority>;
    }>,
  ) {}

  private get approval(): ComputerApproval {
    return this.execution.getStore()?.approval ?? this.launchApproval;
  }
  private get participant(): ParticipantAuthority {
    return this.execution.getStore()?.participant ?? this.launchParticipant;
  }

  private async currentExecution(): Promise<boolean> {
    const execution = this.execution.getStore();
    return execution ? execution.current().catch(() => false) : true;
  }

  private authorize(
    workspaceId: string,
    candidate: string,
    write: boolean,
  ): string | null {
    const decision = authorizeComputerAction(
      this.participant,
      this.approval,
      {
        ...this.binding,
        operation: {
          kind: "workspace.shell",
          workspaceId,
          path: candidate,
          write,
        },
      },
      this.now(),
    );
    return decision.ok ? null : decision.error.code;
  }

  private async verifiedWorkspace(input: ShellStart): Promise<
    | Readonly<{
        cwd: string;
        effective: readonly EffectiveWorkspace[];
        credentialDenials: readonly string[];
        gitSettings: readonly string[];
      }>
    | Readonly<{ error: string }>
  > {
    const workspace = this.approval.workspaces.find(
      (item) => item.workspaceId === input.workspaceId,
    );
    if (!workspace) return { error: "SHELL_WORKSPACE_NOT_APPROVED" };
    if (workspace.shellVerified !== true) {
      return { error: "SHELL_WORKSPACE_VERIFICATION_REQUIRED" };
    }
    const scope = this.participant.grant.workspaces.find(
      (item) => item.workspaceId === input.workspaceId,
    );
    if (!scope || scope.mode !== "subtree") {
      return { error: "SHELL_SCOPE_UNSUPPORTED" };
    }
    const cwd = path.resolve(scope.root, input.relativeCwd);
    if (!inside(scope.root, cwd)) return { error: "SHELL_CWD_DENIED" };
    const stores = credentialStorePolicy(scope.root, this.homeDirectory);
    if (stores.kind === "inside-store") {
      return { error: "SHELL_CREDENTIAL_STORE_DENIED" };
    }
    const auth = this.authorize(input.workspaceId, cwd, input.write);
    if (auth) return { error: auth };
    try {
      const root = await fs.lstat(workspace.root, { bigint: true });
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        String(root.dev) !== workspace.rootIdentity.device ||
        String(root.ino) !== workspace.rootIdentity.inode ||
        (await fs.realpath(workspace.root)) !== workspace.root
      ) {
        return { error: "SHELL_ROOT_CHANGED" };
      }
      if ((await fs.realpath(scope.root)) !== scope.root) {
        return { error: "SHELL_ROOT_CHANGED" };
      }
      const scopedRoot = await fs.lstat(scope.root);
      if (!scopedRoot.isDirectory() || scopedRoot.isSymbolicLink()) {
        return { error: "SHELL_ROOT_CHANGED" };
      }
      const gitMetadata =
        scope.root === workspace.root && workspace.gitHistoryApproved === true
          ? workspace.gitMetadata
          : undefined;
      if (
        scope.root === workspace.root &&
        workspace.gitHistoryApproved === true &&
        !(await matchesApprovedGitMetadata(
          workspace.root,
          workspace.gitMetadata,
        ))
      ) {
        return { error: "SHELL_GIT_METADATA_CHANGED" };
      }
      for (const metadata of [
        gitMetadata?.gitDirectory,
        gitMetadata?.commonDirectory,
      ]) {
        if (
          metadata !== undefined &&
          (await fs.realpath(metadata)) !== metadata
        ) {
          return { error: "SHELL_GIT_METADATA_CHANGED" };
        }
      }
      if ((await fs.realpath(cwd)) !== cwd)
        return { error: "SHELL_CWD_DENIED" };
      const cwdInfo = await fs.lstat(cwd);
      if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) {
        return { error: "SHELL_CWD_DENIED" };
      }
      const gitSettings: string[] = [];
      if (
        scope.root === workspace.root &&
        workspace.gitHistoryApproved === true
      ) {
        const home = this.homeDirectory;
        if (!path.isAbsolute(home) || (await fs.realpath(home)) !== home) {
          return { error: "SHELL_GIT_SETTINGS_UNSAFE" };
        }
        for (const [candidate, kind] of [
          [home, "directory"],
          [path.join(home, ".config"), "directory"],
          [path.join(home, ".gitconfig"), "file"],
          [path.join(home, ".config", "git"), "directory"],
        ] as const) {
          let entry;
          try {
            entry = await fs.lstat(candidate);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code === "ENOENT" &&
              candidate !== home
            )
              continue;
            return { error: "SHELL_GIT_SETTINGS_UNSAFE" };
          }
          if (
            candidate === path.join(home, ".gitconfig") &&
            entry.isSymbolicLink()
          ) {
            const target = await fs.realpath(candidate);
            const targetInfo = await fs.lstat(target);
            if (
              !inside(home, target) ||
              credentialStorePolicy(target, home).kind === "inside-store" ||
              !targetInfo.isFile() ||
              (process.getuid?.() !== undefined &&
                targetInfo.uid !== process.getuid()) ||
              (await fs.realpath(target)) !== target
            ) {
              return { error: "SHELL_GIT_SETTINGS_UNSAFE" };
            }
            // Only the link and its exact owner-owned target are visible, not
            // the containing dotfiles repository or any credential store.
            gitSettings.push(candidate, target);
            continue;
          }
          if (
            entry.isSymbolicLink() ||
            (kind === "directory" ? !entry.isDirectory() : !entry.isFile()) ||
            (process.getuid?.() !== undefined &&
              entry.uid !== process.getuid()) ||
            (await fs.realpath(candidate)) !== candidate
          ) {
            return { error: "SHELL_GIT_SETTINGS_UNSAFE" };
          }
          if (
            candidate.endsWith("/.gitconfig") ||
            candidate.endsWith("/.config/git")
          )
            gitSettings.push(candidate);
        }
      }
      return {
        cwd,
        gitSettings,
        credentialDenials: stores.deniedPaths.map((relative) =>
          path.join(scope.root, relative),
        ),
        effective: [
          {
            root: scope.root,
            access: scope.access,
            gitMetadata,
            gitHistoryApproved:
              scope.root === workspace.root &&
              workspace.gitHistoryApproved === true,
          },
        ],
      };
    } catch {
      return { error: "SHELL_ROOT_UNAVAILABLE" };
    }
  }

  private snapshot(record: RunningCommand, read: ShellRead): ShellOutcome {
    const stdout = window(record.stdout, read.stdoutOffset);
    const stderr = window(record.stderr, read.stderrOffset);
    return {
      handle: record.handle,
      state: record.state,
      groupCleanup: record.groupCleanup,
      // A child can call setsid(), leave the watchdog's process group and
      // close its inherited pipes. Group disappearance cannot prove that such
      // a descendant has exited.
      detachedCleanup: "unverified",
      exitCode: record.state === "exited" ? record.exitCode : null,
      exitSignal: record.state === "exited" ? record.exitSignal : null,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      stdoutBase64: stdout.toString("base64"),
      stderrBase64: stderr.toString("base64"),
      stdoutNextOffset: read.stdoutOffset + stdout.length,
      stderrNextOffset: read.stderrOffset + stderr.length,
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      outputLimitReached: record.outputLimitReached,
      cancelRequested: record.cancelRequested,
      timedOut: record.timedOut,
      authorityExpired: record.authorityExpired,
      errorCode: record.errorCode,
    };
  }

  private completed(record: RunningCommand): void {
    if (record.groupCleanup !== "confirmed") {
      this.groupCleanupUnverified = true;
    }
    this.completedOrder.push(record.handle);
    while (this.completedOrder.length > MAX_COMPLETED) {
      const handle = this.completedOrder.shift();
      if (!handle) break;
      const old = this.byHandle.get(handle);
      if (!old || old.state === "running") continue;
      this.byHandle.delete(handle);
      this.byOperation.delete(old.operationId);
      // The fsynced intent remains: reuse of this operation ID is unknown,
      // not a fresh command, even after output retention expires.
    }
  }

  private computerRoot(): string {
    const identity = createHash("sha256")
      .update(JSON.stringify([this.approval.ownerId, this.approval.computerId]))
      .digest("hex");
    return path.join(this.privateRoot, "shell-v2", identity);
  }

  private async removeScratch(scratch: string): Promise<void> {
    try {
      await fs.rm(scratch, { recursive: true, force: true });
    } catch {
      this.scratchCleanupUnverified = true;
    }
  }

  async start(
    input: ShellStart,
    signal?: AbortSignal,
    dispatchAllowed?: () => Promise<boolean>,
    admissionFd?: number,
    reserveBeforeDispatch?: () => Promise<void>,
    absoluteDeadlineAt?: number,
  ): Promise<ShellResponse> {
    if (!this.authority)
      return this.startAdmitted(
        input,
        signal,
        dispatchAllowed,
        admissionFd,
        reserveBeforeDispatch,
        absoluteDeadlineAt,
      );
    let execution;
    try {
      execution = await this.authority.admitExecution(600_000);
    } catch {
      return refusal("SHELL_AUTHORITY_REVOKED");
    }
    return this.execution.run(execution, () =>
      this.startAdmitted(
        input,
        signal,
        dispatchAllowed,
        admissionFd,
        reserveBeforeDispatch,
        absoluteDeadlineAt,
      ),
    );
  }

  private async startAdmitted(
    input: ShellStart,
    signal?: AbortSignal,
    dispatchAllowed?: () => Promise<boolean>,
    admissionFd?: number,
    reserveBeforeDispatch?: () => Promise<void>,
    absoluteDeadlineAt?: number,
  ): Promise<ShellResponse> {
    if (this.closing) return refusal("SHELL_CLOSED");
    if (signal?.aborted) return refusal("SHELL_CALL_ABORTED");
    if (
      !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.operationId) ||
      !exactRelative(input.relativeCwd) ||
      input.command.length === 0 ||
      Buffer.byteLength(input.command) > 16 * 1024 ||
      Buffer.byteLength(input.stdin ?? "") > 1024 * 1024 ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 600_000 ||
      (absoluteDeadlineAt !== undefined &&
        (!Number.isSafeInteger(absoluteDeadlineAt) || absoluteDeadlineAt <= 0))
    ) {
      return refusal("SHELL_INPUT_INVALID");
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          absoluteDeadlineAt === undefined
            ? input
            : { input, absoluteDeadlineAt },
        ),
      )
      .digest("hex");
    const previous = this.byOperation.get(input.operationId);
    if (previous) {
      return previous.fingerprint === fingerprint
        ? {
            ok: true,
            value: this.snapshot(previous, {
              handle: previous.handle,
              stdoutOffset: 0,
              stderrOffset: 0,
            }),
          }
        : refusal("SHELL_OPERATION_CONFLICT");
    }
    if (this.pendingOperations.has(input.operationId)) {
      return refusal("SHELL_START_PENDING");
    }
    if (
      [...this.byHandle.values()].filter((entry) => entry.state === "running")
        .length +
        this.pendingOperations.size >=
      MAX_RUNNING
    ) {
      return refusal("SHELL_BUSY");
    }
    this.pendingOperations.add(input.operationId);
    const verified = await this.verifiedWorkspace(input);
    if (this.closing) {
      this.pendingOperations.delete(input.operationId);
      return refusal("SHELL_CLOSED");
    }
    if (signal?.aborted) {
      this.pendingOperations.delete(input.operationId);
      return refusal("SHELL_CALL_ABORTED");
    }
    if ("error" in verified) {
      this.pendingOperations.delete(input.operationId);
      return refusal(verified.error);
    }
    if (
      this.approval.network !== "none" ||
      this.participant.grant.network !== "none"
    ) {
      this.pendingOperations.delete(input.operationId);
      return refusal("SHELL_NETWORK_POLICY_UNSUPPORTED");
    }
    if (!(await this.currentExecution())) {
      this.pendingOperations.delete(input.operationId);
      return refusal("SHELL_AUTHORITY_REVOKED");
    }
    const renewed = this.authorize(
      input.workspaceId,
      verified.cwd,
      input.write,
    );
    if (renewed) {
      this.pendingOperations.delete(input.operationId);
      return refusal(renewed);
    }
    const taskRoot = this.computerRoot();
    const intentPath = path.join(
      taskRoot,
      `shell-${createHash("sha256").update(input.operationId).digest("hex")}.json`,
    );
    const handle = randomUUID();
    let scratch: string;
    try {
      await fs.mkdir(taskRoot, { recursive: true, mode: 0o700 });
      for (const directoryPath of [
        this.privateRoot,
        path.dirname(taskRoot),
        taskRoot,
      ]) {
        const root = await fs.lstat(directoryPath);
        if (
          !root.isDirectory() ||
          root.isSymbolicLink() ||
          (root.mode & 0o077) !== 0 ||
          (process.getuid?.() !== undefined && root.uid !== process.getuid()) ||
          (await fs.realpath(directoryPath)) !== directoryPath
        ) {
          this.pendingOperations.delete(input.operationId);
          return refusal("SHELL_PRIVATE_ROOT_UNSAFE");
        }
      }
      const entries = await fs.readdir(taskRoot);
      if (
        entries.filter((name) => name.startsWith("shell-")).length >=
          MAX_COMPUTER_OPERATIONS &&
        !entries.includes(path.basename(intentPath))
      ) {
        this.pendingOperations.delete(input.operationId);
        return refusal("SHELL_OPERATION_LIMIT");
      }
      // A durable pre-effect reservation turns lost start acknowledgement
      // into an explicit unknown, never a second execution after restart.
      const intent = await fs.open(intentPath, "wx", 0o600);
      try {
        await intent.writeFile(JSON.stringify({ handle, fingerprint }));
        await intent.sync();
      } finally {
        await intent.close();
      }
      for (const directoryPath of [
        this.privateRoot,
        path.dirname(taskRoot),
        taskRoot,
      ]) {
        const directory = await fs.open(directoryPath, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      scratch = await fs.mkdtemp(path.join(taskRoot, "shell-tmp-"));
    } catch (error) {
      this.pendingOperations.delete(input.operationId);
      return refusal(
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "SHELL_OUTCOME_UNKNOWN"
          : "SHELL_PRIVATE_STORE_UNAVAILABLE",
      );
    }
    // The fsynced reservation already exists. Never reissue it after a lost
    // acknowledgement, even when no command was dispatched.
    const abandonReserved = async (code: string): Promise<ShellResponse> => {
      await this.removeScratch(scratch);
      this.pendingOperations.delete(input.operationId);
      return refusal(code);
    };
    if (this.closing) {
      return abandonReserved("SHELL_OUTCOME_UNKNOWN");
    }
    if (signal?.aborted) {
      return abandonReserved("SHELL_OUTCOME_UNKNOWN");
    }
    if (dispatchAllowed && !(await dispatchAllowed().catch(() => false))) {
      return abandonReserved("SHELL_DISPATCH_FENCED");
    }
    if (this.closing) {
      return abandonReserved("SHELL_OUTCOME_UNKNOWN");
    }
    const dispatchAuthority = this.authorize(
      input.workspaceId,
      verified.cwd,
      input.write,
    );
    if (dispatchAuthority) {
      return abandonReserved(dispatchAuthority);
    }
    const authorityRemaining =
      Math.min(
        this.approval.expiresAt,
        this.participant.grant.expiresAt,
        absoluteDeadlineAt ?? Infinity,
      ) - this.now();
    if (authorityRemaining <= 0) {
      return abandonReserved("SHELL_AUTHORITY_EXPIRED");
    }
    if (signal?.aborted) {
      return abandonReserved("SHELL_OUTCOME_UNKNOWN");
    }
    const sandbox = profile(
      verified.effective,
      [
        ...this.participant.grant.excludedPaths.filter(
          (excluded) => excluded.workspaceId === input.workspaceId,
        ),
        ...verified.credentialDenials.map((denied) => ({ path: denied })),
      ],
      scratch,
      input.write,
      verified.gitSettings,
    );
    const environment: NodeJS.ProcessEnv = {
      HOME: verified.gitSettings.length > 0 ? this.homeDirectory : scratch,
      TMPDIR: scratch,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: input.write ? "1" : "0",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    if (verified.gitSettings.length > 0) {
      environment.XDG_CONFIG_HOME = path.join(this.homeDirectory, ".config");
    } else {
      environment.GIT_CONFIG_GLOBAL = "/dev/null";
    }
    if (reserveBeforeDispatch) {
      try {
        await reserveBeforeDispatch();
      } catch {
        return abandonReserved("SHELL_DISPATCH_FENCED");
      }
    }
    if (!(await this.currentExecution()))
      return abandonReserved("SHELL_AUTHORITY_REVOKED");
    // Reservation and policy reads can wait while the caller aborts, the
    // connector closes or authority expires. No await may separate this check
    // from spawn.
    if (this.closing || signal?.aborted) {
      return abandonReserved("SHELL_OUTCOME_UNKNOWN");
    }
    const finalAuthority = this.authorize(
      input.workspaceId,
      verified.cwd,
      input.write,
    );
    if (finalAuthority) return abandonReserved(finalAuthority);
    if (
      Math.min(
        this.approval.expiresAt,
        this.participant.grant.expiresAt,
        absoluteDeadlineAt ?? Infinity,
      ) <= this.now()
    ) {
      return abandonReserved("SHELL_AUTHORITY_EXPIRED");
    }
    const child = spawn(process.execPath, ["-e", SHELL_WATCHDOG_SOURCE], {
      cwd: verified.cwd,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      // The watchdog inherits the same locked inode. If the MCP parent
      // crashes, summary raise still waits for disconnect cleanup and the
      // watchdog's actual exit, rather than racing the parent FD close.
      stdio: ["ignore", "ignore", "ignore", "ipc", admissionFd ?? "ignore"],
    });
    let settleTerminal: (cleanup: "confirmed" | "unverified") => void = () =>
      undefined;
    const terminal = new Promise<"confirmed" | "unverified">((resolve) => {
      settleTerminal = resolve;
    });
    const record: RunningCommand = {
      operationId: input.operationId,
      fingerprint,
      handle,
      child,
      productPid: null,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      state: "running",
      rootExitReported: false,
      signalRefused: false,
      groupCleanup: "pending",
      exitCode: null,
      exitSignal: null,
      outputLimitReached: false,
      cancelRequested: false,
      timedOut: false,
      authorityExpired: false,
      errorCode: null,
      scratch,
      terminal,
      settleTerminal,
    };
    this.byOperation.set(input.operationId, record);
    this.byHandle.set(handle, record);
    this.pendingOperations.delete(input.operationId);
    const onAbort = () => {
      record.cancelRequested = true;
      stopWatchdog(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const total = record.stdoutBytes + record.stderrBytes;
      if (total + chunk.length > MAX_OUTPUT_BYTES) {
        record.outputLimitReached = true;
        stopWatchdog(child);
        return;
      }
      record[stream].push(chunk);
      record[`${stream}Bytes`] += chunk.length;
    };
    const markSignalRefused = () => {
      record.signalRefused = true;
      record.groupCleanup = "unverified";
      record.errorCode = "SHELL_GROUP_CLEANUP_UNVERIFIED";
      this.groupCleanupUnverified = true;
    };
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const event = message as {
        type?: string;
        data?: string;
        code?: number | null;
        signal?: NodeJS.Signals | null;
        pid?: number;
        reason?: string | null;
      };
      if (
        (event.type === "stdout" || event.type === "stderr") &&
        typeof event.data === "string"
      ) {
        collect(event.type, Buffer.from(event.data, "base64"));
      } else if (
        event.type === "ready" &&
        Number.isSafeInteger(event.pid) &&
        (event.pid ?? 0) > 0
      ) {
        record.productPid = event.pid!;
      } else if (event.type === "deadline") {
        record.authorityExpired = event.reason === "authority";
        record.timedOut = !record.authorityExpired;
      } else if (event.type === "signal-refused") {
        markSignalRefused();
      } else if (event.type === "error") {
        record.errorCode = "SHELL_SPAWN_FAILED";
      } else if (event.type === "output-limit") {
        record.outputLimitReached = true;
      } else if (event.type === "close") {
        record.rootExitReported = true;
        record.exitCode = event.code ?? null;
        record.exitSignal = event.signal ?? null;
        if (event.reason === "backpressure" || event.reason === "output-limit")
          record.outputLimitReached = true;
        if (
          Buffer.concat(record.stderr)
            .toString("utf8")
            .startsWith("sandbox-exec: sandbox_apply:")
        ) {
          record.errorCode = "SHELL_SANDBOX_UNAVAILABLE";
        }
      }
    });
    child.on("error", () => {
      // An IPC error does not prove controller exit. Keep cancellation and the
      // terminal lease active until close has drained the owned controller.
      record.groupCleanup = "unverified";
      this.groupCleanupUnverified = true;
      record.errorCode ??= child.pid
        ? "SHELL_WATCHDOG_LOST"
        : "SHELL_SPAWN_FAILED";
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === SHELL_WATCHDOG_SIGNAL_REFUSED_EXIT_CODE) markSignalRefused();
      void (async () => {
        // Exit alone does not drain controller IPC. Keep the lease until
        // final close and disconnect before acting on missing receipts.
        if (child.connected)
          await new Promise<void>((resolve) =>
            child.once("disconnect", resolve),
          );
        if (!record.rootExitReported && record.state === "running") {
          if (child.pid && !record.signalRefused) {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH")
                record.groupCleanup = "confirmed";
              else markSignalRefused();
            }
          }
          record.errorCode ??= "SHELL_WATCHDOG_LOST";
        }
        // A close notification for the watchdog proves only that the leader
        // exited. Do not report a terminal handle until the owned group is
        // gone, or its cleanup has been classified as unverified.
        if (
          child.pid &&
          !record.signalRefused &&
          record.groupCleanup === "pending"
        ) {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (record.signalRefused) break;
            try {
              process.kill(-child.pid, 0);
            } catch (error) {
              if (
                !record.signalRefused &&
                (error as NodeJS.ErrnoException).code === "ESRCH"
              ) {
                record.groupCleanup = "confirmed";
              }
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        if (record.signalRefused || record.groupCleanup === "pending") {
          record.groupCleanup = "unverified";
        }
        if (record.groupCleanup === "unverified") {
          record.errorCode ??= "SHELL_GROUP_CLEANUP_UNVERIFIED";
          this.groupCleanupUnverified = true;
        }
        if (record.groupCleanup === "confirmed") {
          await this.removeScratch(scratch);
        }
        record.state = "exited";
        this.completed(record);
        record.settleTerminal(record.groupCleanup);
      })();
    });
    const execution = this.execution.getStore();
    if (execution) {
      let checking = false;
      const policyPoll = setInterval(() => {
        if (checking || record.state !== "running") return;
        checking = true;
        void execution
          .current()
          .catch(() => false)
          .then((current) => {
            if (!current && record.state === "running") {
              record.authorityExpired = true;
              stopWatchdog(child);
            }
          })
          .finally(() => {
            checking = false;
          });
      }, 100);
      policyPoll.unref();
      child.once("close", () => clearInterval(policyPoll));
    }
    // The watchdog checks absolute host deadlines before spawning the command.
    const authorityDeadlineAt = Math.min(
      this.approval.expiresAt,
      this.participant.grant.expiresAt,
      absoluteDeadlineAt ?? Infinity,
    );
    const commandDeadlineAt = Math.min(
      Date.now() + input.timeoutMs,
      absoluteDeadlineAt ?? Infinity,
    );
    child.send({
      type: "start",
      executable: SANDBOX_EXEC,
      args: [
        ...sandbox.parameters,
        "-p",
        sandbox.source,
        "/bin/zsh",
        "-c",
        input.command,
      ],
      cwd: verified.cwd,
      environment,
      authorityDeadlineAt,
      commandDeadlineAt,
      stdin: input.stdin ?? "",
    });
    return {
      ok: true,
      value: this.snapshot(record, {
        handle,
        stdoutOffset: 0,
        stderrOffset: 0,
      }),
    };
  }

  async readAdmitted(input: ShellRead): Promise<ShellResponse> {
    if (this.authority) {
      try {
        const execution = await this.authority.admitExecution(1_000);
        if (!(await execution.current()))
          return refusal("SHELL_AUTHORITY_REVOKED");
      } catch {
        return refusal("SHELL_AUTHORITY_REVOKED");
      }
    }
    return this.read(input);
  }

  read(input: ShellRead): ShellResponse {
    const record = this.byHandle.get(input.handle);
    if (!record) return refusal("SHELL_HANDLE_UNKNOWN");
    if (
      !Number.isSafeInteger(input.stdoutOffset) ||
      !Number.isSafeInteger(input.stderrOffset) ||
      input.stdoutOffset < 0 ||
      input.stderrOffset < 0 ||
      input.stdoutOffset > record.stdoutBytes ||
      input.stderrOffset > record.stderrBytes
    ) {
      return refusal("SHELL_OFFSET_INVALID");
    }
    return { ok: true, value: this.snapshot(record, input) };
  }

  // The MCP admission lease stays held until the watchdog group is really
  // gone. A failed proof is returned explicitly so the caller can retain a
  // fail-closed lease for the lifetime of this connector process.
  waitForTerminal(handle: string): Promise<"confirmed" | "unverified"> {
    const record = this.byHandle.get(handle);
    if (!record) return Promise.resolve("unverified");
    return record.terminal;
  }

  trackTerminalCleanup(work: Promise<void>): void {
    const tracked = work
      .catch(() => {
        this.terminalCleanupUnverified = true;
      })
      .finally(() => {
        this.pendingTerminalCleanup.delete(tracked);
      });
    this.pendingTerminalCleanup.add(tracked);
  }

  cancel(handle: string): ShellResponse {
    const record = this.byHandle.get(handle);
    if (!record) return refusal("SHELL_HANDLE_UNKNOWN");
    if (record.state === "running" && !record.cancelRequested) {
      record.cancelRequested = true;
      stopWatchdog(record.child);
    }
    const snapshot = this.snapshot(record, {
      handle,
      stdoutOffset: 0,
      stderrOffset: 0,
    });
    // Cancellation must stay available while a summary fence is raised.
    // Its response is status-only so it cannot bypass a fenced read.
    return {
      ok: true,
      value: {
        ...snapshot,
        stdout: "",
        stderr: "",
        stdoutBase64: "",
        stderrBase64: "",
        stdoutNextOffset: 0,
        stderrNextOffset: 0,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    };
  }

  close(): void {
    this.closing = true;
    for (const record of this.byHandle.values()) {
      if (record.state === "running") stopWatchdog(record.child);
    }
  }

  // A graceful connector shutdown must wait for its owned groups to leave.
  // This cannot prove a process that deliberately detached from a group;
  // callers must continue to report that limit separately.
  async closeAndWait(): Promise<"confirmed" | "unverified"> {
    this.close();
    const deadline = Date.now() + 4_000;
    while (
      (this.pendingOperations.size > 0 ||
        this.pendingTerminalCleanup.size > 0 ||
        [...this.byHandle.values()].some(
          (record) => record.state === "running",
        )) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.pendingOperations.size === 0 &&
      this.pendingTerminalCleanup.size === 0 &&
      !this.groupCleanupUnverified &&
      !this.scratchCleanupUnverified &&
      !this.terminalCleanupUnverified &&
      [...this.byHandle.values()].every(
        (record) =>
          record.state === "exited" && record.groupCleanup === "confirmed",
      )
      ? "confirmed"
      : "unverified";
  }
}
