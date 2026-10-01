import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const SHARED_LOCK = 0x10;
const EXCLUSIVE_LOCK = 0x20;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;
const DIGEST = /^[a-f0-9]{64}$/u;
const PREPARED = /^prepared-([a-f0-9]{64})$/u;
const INSTANCE = /^active-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const JOURNAL_TEMPORARY =
  /^\.(?:prepared|completed)\.json\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u;
const Reconciliation = z.strictObject({
  schema: z.literal(1),
  operationId: z.string().uuid(),
  failedQuitSha256: z.string().regex(DIGEST),
  instances: z.array(z.string().regex(INSTANCE)).max(64),
});

/** One launch root, shared by Desktop and every Computer MCP it authorizes. */
export class PrivateMcpLifecycle {
  private readonly directory: string;
  private activeHandlers = 0;
  private handlerAdmissionClosed = false;
  private stopRevision = 0;

  constructor(private readonly root: string) {
    if (!path.isAbsolute(root) || root.includes("\0"))
      throw new Error("COMPUTER_MCP_LIFECYCLE_ROOT_INVALID");
    this.directory = path.join(root, "mcp-lifecycle");
  }

  private async ensure(): Promise<void> {
    if (process.platform !== "darwin")
      throw new Error("COMPUTER_MCP_LIFECYCLE_UNSUPPORTED");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of [this.root, this.directory]) {
      const info = await fs.lstat(name);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (info.mode & 0o077) !== 0 ||
        (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
        (await fs.realpath(name)) !== name
      )
        throw new Error("COMPUTER_MCP_LIFECYCLE_ROOT_UNSAFE");
    }
  }

  private async lock(exclusive: boolean, timeoutMs: number) {
    await this.ensure();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(
          path.join(this.directory, "lifetime.lock"),
          fsConstants.O_RDWR |
            fsConstants.O_CREAT |
            fsConstants.O_NONBLOCK |
            NO_FOLLOW |
            CLOSE_ON_EXEC |
            (exclusive ? EXCLUSIVE_LOCK : SHARED_LOCK),
          0o600,
        );
        try {
          const info = await handle.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            (info.mode & 0o077) !== 0 ||
            (process.geteuid?.() !== undefined &&
              info.uid !== process.geteuid())
          )
            throw new Error("COMPUTER_MCP_LIFECYCLE_LOCK_UNSAFE");
        } catch (error) {
          await handle.close();
          throw error;
        }
        return handle;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          (code !== "EAGAIN" && code !== "EWOULDBLOCK") ||
          Date.now() >= deadline
        )
          throw new Error("COMPUTER_MCP_LIFECYCLE_UNVERIFIED");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async marker(name: string): Promise<boolean> {
    const target = path.join(this.directory, name);
    try {
      const handle = await fs.open(
        target,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
        0o600,
      );
      try {
        await handle.writeFile("1\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.sync();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await this.existingMarker(name)))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
      return false;
    }
  }

  private async existingMarker(name: string): Promise<boolean> {
    const target = path.join(this.directory, name);
    let info;
    try {
      info = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.geteuid?.() !== undefined && info.uid !== process.geteuid()) ||
      (await fs.readFile(target, "utf8")) !== "1\n"
    )
      throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    return true;
  }

  private async reconciliationMarker(name: string) {
    const target = path.join(this.directory, name);
    // Atomic directory creation has no partially written authoritative bytes.
    // Preserve compatibility with an already complete old file marker; partial
    // or foreign old markers still refuse rather than being repaired by guess.
    await fs
      .mkdir(target, { mode: 0o700 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await fs.lstat(target);
    if (info.isDirectory()) {
      await this.safeRecoveryDirectory(target);
      if ((await fs.readdir(target)).length !== 0)
        throw new Error("COMPUTER_MCP_RECONCILIATION_UNSAFE");
    } else if (!(await this.existingMarker(name))) {
      throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    }
    await this.sync();
    return { device: info.dev, inode: info.ino, directory: info.isDirectory() };
  }

  private async sync(): Promise<void> {
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

  private async shellGroupsGone(): Promise<void> {
    const directory = path.join(this.root, "execution-fence");
    const entries = await fs
      .readdir(directory)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    if (entries.some((entry) => entry.startsWith("shell-")))
      throw new Error("COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED");
  }

  private async instancesGone(): Promise<void> {
    if (
      (await fs.readdir(this.directory)).some((entry) =>
        entry.startsWith("active-"),
      )
    )
      throw new Error("COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED");
  }

  private async reconciliationComplete(): Promise<void> {
    if (
      (await fs.readdir(this.directory)).some((name) =>
        name.startsWith("reconciling-"),
      )
    )
      throw new Error("COMPUTER_MCP_RECONCILIATION_PENDING");
  }

  private async revokePrepared(): Promise<void> {
    for (const entry of await fs.readdir(this.directory)) {
      const match = PREPARED.exec(entry);
      if (match) {
        await this.existingMarker(entry);
        await this.marker(`revoked-${match[1]}`);
      } else if (entry.startsWith("prepared-"))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    }
  }

  /** Called by Desktop after writing the exact new launch contract, before starting its tunnel. */
  async prepare(digest: string): Promise<void> {
    if (!DIGEST.test(digest))
      throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID");
    // Desktop retains one lifecycle for its launch root. Capture before lock
    // acquisition: a concurrent Stop must not be cleared by this preparation.
    const admittedStopRevision = this.stopRevision;
    const lease = await this.lock(true, 5_000);
    try {
      if (admittedStopRevision !== this.stopRevision)
        throw new Error("COMPUTER_MCP_PREPARATION_STOPPED");
      await this.reconciliationComplete();
      await this.instancesGone();
      await this.shellGroupsGone();
      await this.revokePrepared();
      await this.marker(`prepared-${digest}`);
      if (await this.existingMarker(`revoked-${digest}`))
        throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_REUSED");
      await fs
        .unlink(path.join(this.directory, "stopping"))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      await this.sync();
    } finally {
      try {
        if (admittedStopRevision !== this.stopRevision) {
          // Keep the exclusive lifetime lease until stop admission and all
          // prepared digests are revoked, including one published above.
          await this.marker("stopping");
          await this.revokePrepared();
          throw new Error("COMPUTER_MCP_PREPARATION_STOPPED");
        }
      } finally {
        await lease.close();
      }
    }
  }

  /** Held by the MCP process from before serveStdio until its verified shutdown. */
  async join(digest: string): Promise<Readonly<{ release(): Promise<void> }>> {
    if (!DIGEST.test(digest))
      throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID");
    const lease = await this.lock(false, 0);
    const instance = `active-${randomUUID()}`;
    try {
      if (!(await this.existingMarker(`prepared-${digest}`)))
        throw new Error("COMPUTER_MCP_LIFECYCLE_UNPREPARED");
      for (const name of ["stopping", `revoked-${digest}`]) {
        if (await this.existingMarker(name))
          throw new Error("COMPUTER_MCP_LIFECYCLE_REVOKED");
      }
      await this.marker(instance);
    } catch (error) {
      await lease.close();
      throw error;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        await fs.unlink(path.join(this.directory, instance));
        await this.sync();
        await lease.close();
        released = true;
      },
    };
  }

  /** Install before stopping the tunnel; new MCP joins then refuse. */
  async beginStop(): Promise<void> {
    // Synchronous admission also covers a preparation suspended in filesystem IO.
    this.stopRevision += 1;
    await this.ensure();
    await this.marker("stopping");
  }

  async isStopping(): Promise<boolean> {
    return this.existingMarker("stopping");
  }

  enterHandler(): (() => void) | null {
    if (this.handlerAdmissionClosed) return null;
    this.activeHandlers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeHandlers -= 1;
    };
  }

  closeHandlers(): void {
    this.handlerAdmissionClosed = true;
  }

  async waitForHandlers(timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeHandlers > 0) {
      if (Date.now() >= deadline)
        throw new Error("COMPUTER_MCP_HANDLERS_UNVERIFIED");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** No MCP lifetime lease or unresolved shell group may remain. */
  async waitForStop(timeoutMs = 5_000): Promise<void> {
    const lease = await this.lock(true, timeoutMs);
    try {
      await this.reconciliationComplete();
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      await this.instancesGone();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
  }

  /** Final confirmation after the tunnel parent has stopped; revoke its launch. */
  async confirmStop(timeoutMs = 5_000): Promise<void> {
    const lease = await this.lock(true, timeoutMs);
    try {
      await this.reconciliationComplete();
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      await this.revokePrepared();
      await this.instancesGone();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
  }

  /** Explicit closed-app maintenance only. The caller must hold the Desktop
   * promotion lease and exclusive Computer fence, and prove all durable work
   * settled. A free lifetime lease alone never calls this path. Old instances
   * and the failed Quit identity are retained; this is NOT a stop acknowledgement.
   */
  async reconcileInactive(
    input: Readonly<{
      operationId: string;
      failedQuitSha256: string;
      proveIdle(): Promise<void>;
    }>,
  ): Promise<void> {
    if (
      !z.string().uuid().safeParse(input.operationId).success ||
      !DIGEST.test(input.failedQuitSha256)
    )
      throw new Error("COMPUTER_MCP_RECONCILIATION_INVALID");
    const lease = await this.lock(true, 0);
    try {
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      const pending = `reconciling-${input.operationId}`;
      const entries = await fs.readdir(this.directory);
      if (
        entries.length > 4096 ||
        entries.some(
          (name) => name.startsWith("reconciling-") && name !== pending,
        )
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_PENDING");
      const instances = entries
        .filter((name) => name.startsWith("active-"))
        .sort();
      if (instances.some((name) => !INSTANCE.test(name)))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
      for (const name of instances) await this.existingMarker(name);
      await this.shellGroupsGone();
      // All effect/state checks run while no MCP can join. No process, proxy,
      // status probe or effect is launched by this lifecycle primitive.
      await input.proveIdle();
      const archive = path.join(this.directory, `retired-${input.operationId}`);
      try {
        await this.safeRecoveryDirectory(archive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const planFile = path.join(archive, "prepared.json");
      const previous = await this.readReconciliation(planFile);
      const plan =
        previous ??
        Reconciliation.parse({
          schema: 1,
          operationId: input.operationId,
          failedQuitSha256: input.failedQuitSha256,
          instances,
        });
      if (
        plan.operationId !== input.operationId ||
        plan.failedQuitSha256 !== input.failedQuitSha256 ||
        instances.some((name) => !plan.instances.includes(name))
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      const pendingIdentity = await this.reconciliationMarker(pending);
      await fs
        .mkdir(archive, { mode: 0o700 })
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await this.safeRecoveryDirectory(archive);
      await this.sync();
      for (const name of await fs.readdir(archive)) {
        if (JOURNAL_TEMPORARY.test(name)) {
          await this.privateRecoveryBytes(path.join(archive, name));
          continue;
        }
        if (
          !plan.instances.includes(name) &&
          name !== "prepared.json" &&
          name !== "completed.json"
        )
          throw new Error("COMPUTER_MCP_RECONCILIATION_UNSAFE");
      }
      await this.writeReconciliation(planFile, plan);
      await this.revokePrepared();
      for (const name of plan.instances) {
        const source = path.join(this.directory, name);
        const target = path.join(archive, name);
        const sourcePresent = await this.existingMarker(name);
        const targetPresent = await this.archivedMarker(target);
        if (sourcePresent === targetPresent)
          throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
        if (sourcePresent) await fs.rename(source, target);
        await this.syncDirectory(archive);
        await this.sync();
      }
      await this.writeReconciliation(path.join(archive, "completed.json"), {
        ...plan,
        phase: "retired_unconfirmed",
      });
      const pendingPath = path.join(this.directory, pending);
      const pendingNow = await fs.lstat(pendingPath);
      if (
        pendingNow.dev !== pendingIdentity.device ||
        pendingNow.ino !== pendingIdentity.inode ||
        pendingNow.isDirectory() !== pendingIdentity.directory
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      if (pendingIdentity.directory) await fs.rmdir(pendingPath);
      else await fs.unlink(pendingPath);
      await this.sync();
    } finally {
      await lease.close();
    }
  }

  private async readReconciliation(
    file: string,
  ): Promise<z.infer<typeof Reconciliation> | null> {
    const text = await this.privateRecoveryBytes(file);
    return text === null ? null : Reconciliation.parse(JSON.parse(text));
  }

  private async archivedMarker(file: string): Promise<boolean> {
    const bytes = await this.privateRecoveryBytes(file);
    if (bytes !== null && bytes !== "1\n")
      throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    return bytes !== null;
  }

  private async safeRecoveryDirectory(directory: string): Promise<void> {
    const info = await fs.lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.geteuid?.() ||
      (await fs.realpath(directory)) !== directory
    )
      throw new Error("COMPUTER_MCP_RECONCILIATION_UNSAFE");
  }

  private async privateRecoveryBytes(file: string): Promise<string | null> {
    let handle;
    try {
      handle = await fs.open(
        file,
        fsConstants.O_RDONLY |
          fsConstants.O_NONBLOCK |
          NO_FOLLOW |
          CLOSE_ON_EXEC,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 8192 ||
        (before.mode & 0o077) !== 0 ||
        before.uid !== process.geteuid?.()
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_UNSAFE");
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      const current = await fs.lstat(file);
      if (
        bytesRead !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private async writeReconciliation(
    file: string,
    value: unknown,
  ): Promise<void> {
    const bytes = `${JSON.stringify(value)}\n`;
    const previous = await this.privateRecoveryBytes(file);
    if (previous !== null) {
      if (previous !== bytes)
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      await this.syncDirectory(path.dirname(file));
      return;
    }
    // A crash must leave an uncommitted private remnant, never a partial
    // authoritative record. The same operation retains these bytes on resume.
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
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
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await this.privateRecoveryBytes(temporary)) !== bytes)
      throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
    const concurrent = await this.privateRecoveryBytes(file);
    if (concurrent !== null) {
      if (concurrent !== bytes)
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      await this.syncDirectory(path.dirname(file));
      return;
    }
    await fs.rename(temporary, file);
    await this.syncDirectory(path.dirname(file));
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await fs.open(
      directory,
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
