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
  /^\.(?:(?:prepared|completed)\.json|revoked-[a-f0-9]{64})\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/u;
const QuitReconciliationIdentity = z.strictObject({
  schema: z.literal(1),
  operationId: z.string().uuid(),
  failedQuitSha256: z.string().regex(DIGEST),
});
const CrashReconciliationIdentity = z.strictObject({
  schema: z.literal(2),
  operationId: z.string().uuid(),
  basis: z.literal("failed-run"),
  failedRunSha256: z.string().regex(DIGEST),
  configSha256: z.string().regex(DIGEST),
});
const ReconciliationIdentity = z.discriminatedUnion("schema", [
  QuitReconciliationIdentity,
  CrashReconciliationIdentity,
]);
const reconciliationInstances = z.array(z.string().regex(INSTANCE)).max(64);
const Reconciliation = z.discriminatedUnion("schema", [
  QuitReconciliationIdentity.extend({ instances: reconciliationInstances }),
  CrashReconciliationIdentity.extend({ instances: reconciliationInstances }),
]);

/** One launch root, shared by Desktop and every Computer MCP it authorizes. */
export class PrivateMcpLifecycle {
  private readonly directory: string;
  private activeHandlers = 0;
  private handlerAdmissionClosed = false;
  private stopRevision = 0;
  private preparationRevision = 0;
  private confirmedStopRevision: number | null = null;

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
          throw new Error("COMPUTER_MCP_LIFECYCLE_UNVERIFIED", {
            cause: error,
          });
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
    if (name === "stopping" && info.isDirectory()) {
      if (
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.geteuid?.() ||
        (await fs.realpath(target)) !== target ||
        (await fs.readdir(target)).length !== 0
      )
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
      return true;
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
    if (name === "stopping") {
      await this.existingMarker(name);
    } else if (info.isDirectory()) {
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

  // Call only while holding the exclusive lifetime lock. That lock excludes
  // every live MCP join; retained markers describe history, not process life.
  private async validateInactiveInstances(): Promise<void> {
    for (const entry of await fs.readdir(this.directory)) {
      if (
        entry.startsWith("active-") &&
        (!INSTANCE.test(entry) || !(await this.existingMarker(entry)))
      )
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    }
  }

  private async reconciliationComplete(): Promise<void> {
    if (
      (await fs.readdir(this.directory)).some((name) =>
        name.startsWith("reconciling-"),
      )
    )
      throw new Error("COMPUTER_MCP_RECONCILIATION_PENDING");
  }

  private async revokePrepared(recoveryArchive?: string): Promise<void> {
    for (const entry of await fs.readdir(this.directory)) {
      const match = PREPARED.exec(entry);
      if (match) {
        await this.existingMarker(entry);
        const name = `revoked-${match[1]}`;
        if (recoveryArchive) {
          // Closed reconciliation must resume after a process death without
          // leaving partial authoritative revocations. Retain uncommitted
          // bytes inside this exact operation's validated private archive.
          await this.writeRecoveryBytes(
            path.join(this.directory, name),
            "1\n",
            recoveryArchive,
          );
        } else await this.marker(name);
      } else if (entry.startsWith("prepared-"))
        throw new Error("COMPUTER_MCP_LIFECYCLE_MARKER_UNSAFE");
    }
  }

  /** Called by Desktop after writing the exact new launch contract, before starting its tunnel. */
  async prepare(digest: string): Promise<void> {
    if (!DIGEST.test(digest))
      throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_INVALID");
    this.preparationRevision += 1;
    this.confirmedStopRevision = null;
    // Desktop retains one lifecycle for its launch root. Capture before lock
    // acquisition: a concurrent Stop must not be cleared by this preparation.
    const admittedStopRevision = this.stopRevision;
    const lease = await this.lock(true, 5_000);
    try {
      if (admittedStopRevision !== this.stopRevision)
        throw new Error("COMPUTER_MCP_PREPARATION_STOPPED");
      await this.reconciliationComplete();
      await this.validateInactiveInstances();
      await this.shellGroupsGone();
      await this.revokePrepared();
      await this.marker(`prepared-${digest}`);
      if (await this.existingMarker(`revoked-${digest}`))
        throw new Error("COMPUTER_MCP_LIFECYCLE_DIGEST_REUSED");
      if (await this.existingMarker("stopping")) {
        const stopping = path.join(this.directory, "stopping");
        const info = await fs.lstat(stopping);
        if (info.isDirectory()) await fs.rmdir(stopping);
        else await fs.unlink(stopping);
      }
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
  async join(digest: string): Promise<
    Readonly<{
      release(
        receipt?: Readonly<{ effectsUnresolved: boolean }>,
      ): Promise<void>;
    }>
  > {
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
    let release: Promise<void> | undefined;
    return {
      release: (receipt = { effectsUnresolved: false }) => {
        if (release) return release;
        release = (async () => {
          if (!receipt.effectsUnresolved)
            await fs.unlink(path.join(this.directory, instance));
          await this.sync();
          await lease.close();
        })();
        return release;
      },
    };
  }

  /** Install before stopping the tunnel; new MCP joins then refuse. */
  async beginStop(): Promise<void> {
    // Synchronous admission also covers a preparation suspended in filesystem IO.
    this.stopRevision += 1;
    this.confirmedStopRevision = null;
    await this.ensure();
    await this.marker("stopping");
  }

  /** Closed maintenance only, after the caller retains evidence and proves idle. */
  async beginClosedRecoveryStop(): Promise<void> {
    // Exclude prepare and join before publishing any stop intent. A leased MCP
    // must refuse maintenance without receiving a shutdown signal from us.
    const lease = await this.lock(true, 0);
    try {
      await this.shellGroupsGone();
      this.stopRevision += 1;
      this.confirmedStopRevision = null;
      await this.reconciliationMarker("stopping");
    } finally {
      await lease.close();
    }
  }

  async isStopping(): Promise<boolean> {
    return this.existingMarker("stopping");
  }

  /** A marker alone is closed admission, not the original stop acknowledgement.
   * An inherited marker has no in-lifetime confirmation and remains refused.
   */
  async hasUnconfirmedStop(): Promise<boolean> {
    return (
      (await this.existingMarker("stopping")) &&
      this.confirmedStopRevision !== this.stopRevision
    );
  }

  /** Startup only, under the primary host's promotion exclusion, before IPC
   * admission. The host supplies the same clean predecessor proof used by Go
   * boot. Recheck native obligations without replaying Stop or opening admission.
   */
  async confirmCleanHostStop(
    previousHostDrainConfirmed: boolean,
  ): Promise<void> {
    const current = () =>
      previousHostDrainConfirmed === true &&
      this.stopRevision === 0 &&
      this.preparationRevision === 0;
    if (!current()) throw new Error("COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED");
    const stopping = await this.isStopping();
    if (!current()) throw new Error("COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED");
    if (!stopping) return;
    // confirmStop retains the marker and checks reconciliation, exclusive
    // lifetime ownership, MCP instances, shell groups and concurrent revisions.
    await this.confirmStop();
    if (!current()) throw new Error("COMPUTER_MCP_CLEAN_HOST_STOP_UNVERIFIED");
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
      await this.validateInactiveInstances();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
  }

  /** Final confirmation after the tunnel parent has stopped; revoke its launch. */
  async confirmStop(timeoutMs = 5_000): Promise<void> {
    const originalRevision = this.stopRevision;
    const originalPreparation = this.preparationRevision;
    const lease = await this.lock(true, timeoutMs);
    try {
      await this.reconciliationComplete();
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      await this.revokePrepared();
      await this.validateInactiveInstances();
      await this.shellGroupsGone();
    } finally {
      await lease.close();
    }
    if (
      originalRevision !== this.stopRevision ||
      originalPreparation !== this.preparationRevision
    )
      throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
    this.confirmedStopRevision = originalRevision;
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
    const selected = QuitReconciliationIdentity.safeParse({
      schema: 1,
      operationId: input.operationId,
      failedQuitSha256: input.failedQuitSha256,
    });
    if (!selected.success || typeof input.proveIdle !== "function")
      throw new Error("COMPUTER_MCP_RECONCILIATION_INVALID");
    await this.reconcileSelected(selected.data, input.proveIdle.bind(input));
  }

  /** Closed Dev crash-maintenance primitive. Enclosing trusted host code must
   * retain the same promotion/Computer exclusions and canonical work proof.
   * The run/config digests identify that observation, never a Quit or old ACK.
   * The preserved-history maintenance host selects this after canonical Go
   * observation. Startup UI and ordinary MCP ingress never select it.
   */
  async reconcileInactiveAfterCrash(
    input: Readonly<{
      operationId: string;
      failedRunSha256: string;
      configSha256: string;
      proveIdle(): Promise<void>;
    }>,
  ): Promise<void> {
    const selected = CrashReconciliationIdentity.safeParse({
      schema: 2,
      operationId: input.operationId,
      basis: "failed-run",
      failedRunSha256: input.failedRunSha256,
      configSha256: input.configSha256,
    });
    if (!selected.success || typeof input.proveIdle !== "function")
      throw new Error("COMPUTER_MCP_RECONCILIATION_INVALID");
    await this.reconcileSelected(selected.data, input.proveIdle.bind(input));
  }

  private async reconcileSelected(
    identity: z.infer<typeof ReconciliationIdentity>,
    proveIdle: () => Promise<void>,
  ): Promise<void> {
    const lease = await this.lock(true, 0);
    try {
      if (!(await this.existingMarker("stopping")))
        throw new Error("COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED");
      const pending = `reconciling-${identity.operationId}`;
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
      await proveIdle();
      const archive = path.join(
        this.directory,
        `retired-${identity.operationId}`,
      );
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
          ...identity,
          instances,
        });
      const sameIdentity =
        plan.operationId === identity.operationId &&
        (plan.schema === 1 && identity.schema === 1
          ? plan.failedQuitSha256 === identity.failedQuitSha256
          : plan.schema === 2 &&
            identity.schema === 2 &&
            plan.basis === identity.basis &&
            plan.failedRunSha256 === identity.failedRunSha256 &&
            plan.configSha256 === identity.configSha256);
      if (
        !sameIdentity ||
        instances.some((name) => !plan.instances.includes(name))
      )
        throw new Error("COMPUTER_MCP_RECONCILIATION_CHANGED");
      const completedFile = path.join(archive, "completed.json");
      const completion = { ...plan, phase: "retired_unconfirmed" };
      // Refuse retained conflicts before creating a pending claim, revoking
      // preparation or relocating markers. The final write still rechecks
      // exact private bytes to fence a change after this preflight.
      const retainedCompletion = await this.privateRecoveryBytes(completedFile);
      if (
        retainedCompletion !== null &&
        retainedCompletion !== `${JSON.stringify(completion)}\n`
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
      await this.revokePrepared(archive);
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
      await this.writeReconciliation(completedFile, completion);
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
    await this.writeRecoveryBytes(file, `${JSON.stringify(value)}\n`);
  }

  private async writeRecoveryBytes(
    file: string,
    bytes: string,
    stagingDirectory = path.dirname(file),
  ): Promise<void> {
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
      stagingDirectory,
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
    if (stagingDirectory !== path.dirname(file))
      await this.syncDirectory(stagingDirectory);
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
