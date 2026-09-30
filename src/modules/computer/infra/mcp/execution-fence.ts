import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const EXECUTION_FENCE_DIRECTORY = "execution-fence";
const ADMISSION_LOCK = "admission.lock";
const SHELL_MARKER = /^shell-[a-f0-9]{64}\.json$/u;
// BSD open(2) locks. The inode is never removed: unlinking a held lock would
// allow another process to acquire a different inode at the same path.
const SHARED_LOCK = 0x10;
const EXCLUSIVE_LOCK = 0x20;

const MAXIMUM_RECORD_BYTES = 4 * 1_024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

// A phase during which no Computer tool may execute. The desktop raises one
// per summary-only operation and the connector's MCP process reads them
// through the launch root both share. Records carry identities only.
const fenceRecordSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal("summary_only_phase"),
  operationId: z.string().min(1).max(160),
  taskId: z.string().min(1).max(160),
  raisedAt: z.string().min(1).max(64),
});

export type ExecutionFenceRecord = z.infer<typeof fenceRecordSchema>;

export type ExecutionFenceAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      code:
        "COMPUTER_SUMMARY_PHASE_ACTIVE" | "COMPUTER_EXECUTION_FENCE_UNREADABLE";
    }>;

export type ExecutionFenceReader = Readonly<{
  admits(): Promise<ExecutionFenceAdmission>;
  acquireAdmission(): Promise<ExecutionFenceAdmissionLease>;
  reserveShell(operationId: string): Promise<void>;
  clearShell(operationId: string): Promise<void>;
  quarantineShell(operationId: string): void;
}>;

export type ExecutionFenceAdmissionLease =
  | Readonly<{
      admitted: false;
      code: Exclude<ExecutionFenceAdmission, { admitted: true }>["code"];
    }>
  | Readonly<{ admitted: true; fd?: number; release(): Promise<void> }>;

function fileName(operationId: string): string {
  return `${createHash("sha256").update(operationId).digest("hex")}.json`;
}

function shellFileName(operationId: string): string {
  return `shell-${fileName(operationId)}`;
}

/**
 * The fence as files under the launch root: one record per raised
 * operation. Any record, readable or not, fences execution; the directory
 * being absent or empty admits it. The connector creates only the shared
 * lock inode; summary records remain desktop-owned.
 */
export class PrivateExecutionFence implements ExecutionFenceReader {
  private readonly directory: string;
  private readonly ownedShellMarkers = new Set<string>();
  private readonly mutationLock: string;

  constructor(options: Readonly<{ root: string }>) {
    if (!path.isAbsolute(options.root) || options.root.includes("\0")) {
      throw new Error("EXECUTION_FENCE_ROOT_NOT_ABSOLUTE");
    }
    this.directory = path.join(options.root, EXECUTION_FENCE_DIRECTORY);
    this.mutationLock = path.join(
      options.root,
      "execution-fence-mutation.lock",
    );
  }

  // Both desktop fence raises and task-host mutations use this atomic
  // cross-process lock. A crash leaves the lock in place and fails closed;
  // it is never stolen by age or PID guessing.
  private async withLock<T>(
    work: () => Promise<T>,
    retainIfWorkFails: (error: unknown) => boolean = () => false,
    timeoutMs = 30_000,
  ): Promise<T> {
    const root = path.dirname(this.mutationLock);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const rootInfo = await fs.lstat(root);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (rootInfo.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined &&
        rootInfo.uid !== process.geteuid()) ||
      (await fs.realpath(root)) !== root
    )
      throw new Error("COMPUTER_EXECUTION_FENCE_ROOT_UNSAFE");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await fs.mkdir(this.mutationLock, { mode: 0o700 });
        break;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    let retained = false;
    try {
      await this.syncLockParent();
      return await work();
    } catch (error) {
      retained = retainIfWorkFails(error);
      throw error;
    } finally {
      if (!retained) {
        await fs.rmdir(this.mutationLock);
        await this.syncLockParent();
      }
    }
  }

  async run<T>(
    preflight: () => Promise<void>,
    effect: () => Promise<T>,
    safeToReleaseError: (error: unknown) => boolean,
  ): Promise<T> {
    let effectStarted = false;
    return this.withLock(
      async () => {
        const admission = await this.admits();
        if (!admission.admitted) throw new Error(admission.code);
        await preflight();
        effectStarted = true;
        return effect();
      },
      (error) => effectStarted && !safeToReleaseError(error),
    );
  }

  /** Fence both Computer handlers and Codex dispatch while checking/draining
   * NEW-owned clients. Busy/unknown work is refused, never cancelled for update. */
  async withUpdateDrain<T>(work: () => Promise<T>): Promise<T> {
    return this.withLock(
      async () => {
        const lease = await this.lock(true);
        if (!lease) throw new Error("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
        try {
          const admission = await this.admits();
          if (!admission.admitted) throw new Error(admission.code);
          return await work();
        } finally {
          await lease.close();
        }
      },
      () => false,
      0,
    );
  }

  private async lock(exclusive: boolean): Promise<fs.FileHandle | null> {
    if (process.platform !== "darwin") {
      throw new Error("EXECUTION_FENCE_LOCK_UNSUPPORTED");
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && directory.uid !== process.getuid())
    ) {
      throw new Error("EXECUTION_FENCE_LOCK_UNSAFE");
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(
          path.join(this.directory, ADMISSION_LOCK),
          fsConstants.O_RDWR |
            fsConstants.O_CREAT |
            NO_FOLLOW |
            CLOSE_ON_EXEC |
            fsConstants.O_NONBLOCK |
            (exclusive ? EXCLUSIVE_LOCK : SHARED_LOCK),
          0o600,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
        if (attempt === 3) return null;
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid?.() !== undefined && info.uid !== process.getuid())
        ) {
          throw new Error("EXECUTION_FENCE_LOCK_UNSAFE");
        }
      } catch (error) {
        await handle.close();
        throw error;
      }
      return handle;
    }
    return null;
  }

  // Hold a shared kernel lock through the whole Computer effect. A summary
  // cannot raise its record until all such effects release their leases.
  async acquireAdmission(): Promise<ExecutionFenceAdmissionLease> {
    let handle: fs.FileHandle | null;
    try {
      handle = await this.lock(false);
    } catch {
      return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
    }
    if (!handle) {
      return { admitted: false, code: "COMPUTER_SUMMARY_PHASE_ACTIVE" };
    }
    const admission = await this.admits().catch(() => ({
      admitted: false as const,
      code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" as const,
    }));
    if (!admission.admitted) {
      await handle.close();
      return admission;
    }
    let released = false;
    return {
      admitted: true,
      fd: handle.fd,
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
      },
    };
  }

  // Called under an admission lease immediately before dispatch. A crash at
  // any point after the durable marker leaves the command outcome unknown;
  // a new connector cannot infer group cleanup from an unlocked inode.
  async reserveShell(operationId: string): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) {
      throw new Error("EXECUTION_FENCE_SHELL_ID_INVALID");
    }
    const name = shellFileName(operationId);
    const handle = await fs.open(
      path.join(this.directory, name),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({ schema: 1, operationId }),
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.syncDirectory();
    this.ownedShellMarkers.add(name);
  }

  async clearShell(operationId: string): Promise<void> {
    const name = shellFileName(operationId);
    if (!this.ownedShellMarkers.has(name)) {
      throw new Error("EXECUTION_FENCE_SHELL_NOT_OWNED");
    }
    await fs.unlink(path.join(this.directory, name));
    await this.syncDirectory();
    this.ownedShellMarkers.delete(name);
  }

  quarantineShell(operationId: string): void {
    // A failed group proof is no longer an active, known-cleanup reservation.
    // Its durable marker remains and every later admission fails closed.
    this.ownedShellMarkers.delete(shellFileName(operationId));
  }

  async raise(
    input: Readonly<{ operationId: string; taskId: string; now?: number }>,
  ): Promise<void> {
    return this.withLock(() => this.raiseLocked(input));
  }

  private async raiseLocked(
    input: Readonly<{ operationId: string; taskId: string; now?: number }>,
  ): Promise<void> {
    const record = fenceRecordSchema.parse({
      schema: 1,
      kind: "summary_only_phase",
      operationId: input.operationId,
      taskId: input.taskId,
      raisedAt: new Date(input.now ?? Date.now()).toISOString(),
    });
    const lease = await this.lock(true);
    if (!lease) throw new Error("EXECUTION_FENCE_ACTIVE_COMPUTER_WORK");
    try {
      if (
        (await fs.readdir(this.directory)).some((entry) =>
          SHELL_MARKER.test(entry),
        )
      ) {
        throw new Error("EXECUTION_FENCE_UNVERIFIED_SHELL");
      }
      const target = path.join(this.directory, fileName(input.operationId));
      const temporary = `${target}.${process.pid}.tmp`;
      const handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await this.syncDirectory();
    } finally {
      await lease.close();
    }
  }

  async lower(operationId: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.directory, fileName(operationId)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.syncDirectory();
  }

  // At a start, the fence is brought in line with what the private context
  // store still holds as possibly running: a record for an operation the
  // store settled is removed, and an unresolved operation whose record is
  // missing or unreadable is raised again. A crash leaves neither side
  // trusted alone; nothing here takes a record's age, a new process, or an
  // empty store as proof that a summary is over.
  async reconcile(
    unresolved: ReadonlyArray<
      Readonly<{ operationId: string; taskId: string }>
    >,
  ): Promise<void> {
    const keep = new Map(
      unresolved.map((operation) => [
        fileName(operation.operationId),
        operation,
      ]),
    );
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Required records are raised before anything stale is removed: a raise
    // that fails then leaves every record that was up still up, and never a
    // directory emptier than the one the crash left.
    for (const [entry, operation] of keep) {
      if (
        entries.includes(entry) &&
        (await this.holds(path.join(this.directory, entry), operation))
      ) {
        continue;
      }
      await this.raise(operation);
    }
    let removed = false;
    for (const entry of entries) {
      if (
        keep.has(entry) ||
        entry === ADMISSION_LOCK ||
        SHELL_MARKER.test(entry)
      )
        continue;
      await fs.rm(path.join(this.directory, entry), { force: true });
      removed = true;
    }
    if (removed) await this.syncDirectory();
  }

  // Every record a task raised: for the owner ending that task, whose
  // summaries then have no owner left to observe them.
  async release(taskId: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let removed = false;
    for (const entry of entries.filter((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    )) {
      const file = path.join(this.directory, entry);
      let record: ExecutionFenceRecord;
      try {
        record = fenceRecordSchema.parse(
          JSON.parse(await fs.readFile(file, "utf8")),
        );
      } catch {
        continue;
      }
      if (record.taskId !== taskId) continue;
      await fs.rm(file, { force: true });
      removed = true;
    }
    if (removed) await this.syncDirectory();
  }

  private async holds(
    file: string,
    operation: Readonly<{ operationId: string; taskId: string }>,
  ): Promise<boolean> {
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > MAXIMUM_RECORD_BYTES) return false;
      const parsed = fenceRecordSchema.safeParse(
        JSON.parse(await fs.readFile(file, "utf8")),
      );
      return (
        parsed.success &&
        parsed.data.operationId === operation.operationId &&
        parsed.data.taskId === operation.taskId
      );
    } catch {
      return false;
    }
  }

  async admits(): Promise<ExecutionFenceAdmission> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { admitted: true };
      }
      return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
    }
    const records = entries.filter((entry) =>
      /^[a-f0-9]{64}\.json$/u.test(entry),
    );
    if (
      entries.some(
        (entry) =>
          SHELL_MARKER.test(entry) && !this.ownedShellMarkers.has(entry),
      )
    ) {
      return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
    }
    if (records.length === 0) return { admitted: true };
    for (const entry of records) {
      const file = path.join(this.directory, entry);
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.size > MAXIMUM_RECORD_BYTES) {
          return {
            admitted: false,
            code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
          };
        }
        const parsed = fenceRecordSchema.safeParse(
          JSON.parse(await fs.readFile(file, "utf8")),
        );
        if (!parsed.success) {
          return {
            admitted: false,
            code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
          };
        }
      } catch (error) {
        // A record removed between listing and reading is a lowered fence.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" };
      }
      return { admitted: false, code: "COMPUTER_SUMMARY_PHASE_ACTIVE" };
    }
    return { admitted: true };
  }

  private async syncDirectory(): Promise<void> {
    const directory = await fs.open(
      this.directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async syncLockParent(): Promise<void> {
    const handle = await fs.open(
      path.dirname(this.mutationLock),
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
