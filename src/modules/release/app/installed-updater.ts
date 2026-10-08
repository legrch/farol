import type { RetainedReleaseManifest } from "../domain/github-release-contract";

// Keep in sync with the release contract's presentation eligibility. The
// application guard remains authoritative even for callers bypassing the UI.
const recheckableAdmissionBlocks = new Set([
  "UPDATE_CONNECTOR_ACTIVE",
  "UPDATE_TASK_ROUTE_NEEDS_DRAIN",
  "UPDATE_BROWSER_OPEN",
  "UPDATE_BROWSER_BUSY",
  "UPDATE_BROWSER_DRAFT",
  "UPDATE_WORK_PENDING",
]);

export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1_000;

export type ReadyUpdate = Readonly<{
  handle: string;
  manifest: RetainedReleaseManifest;
}>;
export type { InstalledUpdateView as UpdateView } from "../domain/installed-update";
import type { InstalledUpdateView as UpdateView } from "../domain/installed-update";

type KnownFailure = Readonly<{
  ok: false;
  code: string;
  recoveryRequired?: boolean;
}>;
export type UpdateHandoff =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "unknown"; code: string }>;
export type InstalledUpdaterPorts = Readonly<{
  now(): number;
  // Stop only this updater lifetime's network requests; filesystem cleanup still drains.
  cancelPending(): void;
  // Recovery must reverify the retained archive/package and reconcile any helper receipt.
  recover(): Promise<
    | Readonly<{
        ok: true;
        update: ReadyUpdate | null;
        rollbackVersion?: string;
        recoveryVersion?: string;
      }>
    | KnownFailure
  >;
  discover(): Promise<
    Readonly<{ ok: true; available: boolean }> | KnownFailure
  >;
  download(): Promise<
    Readonly<{ ok: true; update: ReadyUpdate }> | KnownFailure
  >;
  // A supervised transition may select one local archive in composition. This
  // port must stage and verify it through the same archive/package owner. It is
  // not a caller-supplied ReadyUpdate or an alternate persistence mechanism.
  prepareLocal?(): Promise<
    Readonly<{ ok: true; update: ReadyUpdate }> | KnownFailure
  >;
  retain(update: ReadyUpdate): Promise<void | KnownFailure>;
  // The composition holds existing admission fences, checks real obligations,
  // and hands off to the helper before it requests the application's normal quit.
  restart(update: ReadyUpdate): Promise<UpdateHandoff>;
  restore(action: "recover" | "rollback"): Promise<UpdateHandoff>;
  publish(view: UpdateView): void;
}>;

/** One installed updater lifetime. It owns update progress, never task truth. */
export class InstalledUpdater {
  private view: UpdateView = { phase: "idle", checkedAt: null };
  private ready: ReadyUpdate | null = null;
  private initialized = false;
  private busy = false;
  private lastCheck: number | null = null;
  private closed = false;
  private rollbackVersion: string | undefined;
  private drained: Promise<void> = Promise.resolve();
  private finishDrain: () => void = () => undefined;
  private closing: Promise<void> | null = null;

  private begin(): void {
    this.busy = true;
    this.drained = new Promise((resolve) => {
      this.finishDrain = resolve;
    });
  }

  private finish(): void {
    this.busy = false;
    this.finishDrain();
  }

  constructor(private readonly ports: InstalledUpdaterPorts) {}

  snapshot(): UpdateView {
    return this.view;
  }

  private publish(view: UpdateView): void {
    this.view = view;
    if (!this.closed) this.ports.publish(view);
  }

  private canPrepare(): boolean {
    return (
      this.initialized &&
      !this.busy &&
      !this.closed &&
      !this.ready &&
      this.view.phase !== "applying" &&
      this.view.phase !== "recovery" &&
      !(this.view.phase === "failed" && this.view.recoveryRequired)
    );
  }

  private async retainPrepared(
    prepared: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
  ): Promise<void> {
    if (!prepared.ok) {
      this.publish({
        phase: "failed",
        code: prepared.code,
        recoveryRequired: prepared.recoveryRequired ?? false,
        ...(!prepared.recoveryRequired && this.rollbackVersion
          ? { rollbackVersion: this.rollbackVersion }
          : {}),
      });
      return;
    }
    // Quit still settles the durable staging intent. A completed, verified
    // archive must be retained even if its UI lifetime has already closed.
    const retention = await this.ports.retain(prepared.update);
    if (retention) {
      this.publish({
        phase: "failed",
        code: retention.code,
        recoveryRequired: retention.recoveryRequired ?? false,
        ...(!retention.recoveryRequired && this.rollbackVersion
          ? { rollbackVersion: this.rollbackVersion }
          : {}),
      });
      return;
    }
    if (this.closed) return;
    this.ready = prepared.update;
    this.publish({
      phase: "ready",
      version: prepared.update.manifest.version,
      deferred: false,
      blockedBy: null,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.busy || this.closed) return;
    this.begin();
    try {
      const restored = await this.ports.recover();
      if (!restored.ok) {
        this.publish({
          phase: "failed",
          code: restored.code,
          recoveryRequired: restored.recoveryRequired ?? true,
        });
      } else if (restored.recoveryVersion) {
        this.publish({
          phase: "recovery",
          version: restored.recoveryVersion,
          blockedBy: null,
        });
      } else if (restored.update) {
        this.ready = restored.update;
        this.publish({
          phase: "ready",
          version: restored.update.manifest.version,
          deferred: true,
          blockedBy: null,
        });
      } else if (restored.rollbackVersion) {
        this.rollbackVersion = restored.rollbackVersion;
        this.publish({
          phase: "idle",
          checkedAt: null,
          rollbackVersion: this.rollbackVersion,
        });
      }
    } catch {
      this.publish({
        phase: "failed",
        code: "UPDATE_RECOVERY_UNAVAILABLE",
        recoveryRequired: true,
      });
    } finally {
      this.initialized = true;
      this.finish();
    }
  }

  async check(manual = false): Promise<void> {
    // A known admission refusal launched no helper. Let an explicit check
    // restore the restart action; restart must still acquire every live fence.
    if (
      manual &&
      !this.closed &&
      !this.busy &&
      this.view.phase === "ready" &&
      this.view.blockedBy !== null &&
      recheckableAdmissionBlocks.has(this.view.blockedBy)
    ) {
      this.publish({ ...this.view, blockedBy: null });
      return;
    }
    if (!this.canPrepare()) return;
    const now = this.ports.now();
    if (
      !manual &&
      this.lastCheck !== null &&
      now - this.lastCheck < UPDATE_RECHECK_MS
    )
      return;
    this.lastCheck = now;
    this.begin();
    this.publish({ phase: "checking" });
    let stagingStarted = false;
    try {
      const found = await this.ports.discover();
      if (this.closed) return;
      if (!found.ok) {
        this.publish({
          phase: "failed",
          code: found.code,
          recoveryRequired: found.recoveryRequired ?? false,
          // Discovery has not staged or dispatched anything. Its known failure
          // cannot revoke the independently reconciled local predecessor.
          ...(!found.recoveryRequired && this.rollbackVersion
            ? { rollbackVersion: this.rollbackVersion }
            : {}),
        });
        return;
      }
      if (!found.available) {
        this.publish({
          phase: "idle",
          checkedAt: now,
          ...(this.rollbackVersion
            ? { rollbackVersion: this.rollbackVersion }
            : {}),
        });
        return;
      }
      this.publish({ phase: "downloading" });
      stagingStarted = true;
      const downloaded = await this.ports.download();
      await this.retainPrepared(downloaded);
      stagingStarted = false;
    } catch {
      this.publish({
        phase: "failed",
        code: "UPDATE_CHECK_FAILED",
        recoveryRequired: stagingStarted,
      });
    } finally {
      this.finish();
    }
  }

  async prepareLocal(): Promise<void> {
    if (!this.canPrepare()) return;
    if (!this.ports.prepareLocal) {
      this.publish({
        phase: "failed",
        code: "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
        recoveryRequired: false,
        ...(this.rollbackVersion
          ? { rollbackVersion: this.rollbackVersion }
          : {}),
      });
      return;
    }
    this.begin();
    this.publish({ phase: "downloading" });
    try {
      await this.retainPrepared(await this.ports.prepareLocal());
    } catch {
      // Import or retention may already have published durable bytes. The
      // original owner must reconcile them; another import is not recovery.
      this.publish({
        phase: "failed",
        code: "UPDATE_LOCAL_IMPORT_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  later(): void {
    if (this.view.phase !== "ready" || this.closed) return;
    this.publish({ ...this.view, deferred: true });
  }

  async restart(): Promise<void> {
    if (
      this.closed ||
      this.busy ||
      this.view.phase !== "ready" ||
      this.view.blockedBy !== null ||
      !this.ready
    )
      return;
    this.begin();
    const version = this.ready.manifest.version;
    this.publish({ phase: "applying", version });
    try {
      const outcome = await this.ports.restart(this.ready);
      if (outcome.status === "blocked") {
        this.publish({
          phase: "ready",
          version,
          deferred: true,
          blockedBy: outcome.code,
        });
      } else if (outcome.status === "unknown") {
        this.publish({
          phase: "failed",
          code: outcome.code,
          recoveryRequired: true,
        });
      }
    } catch {
      // The helper may already have accepted its handoff. Never launch another.
      this.publish({
        phase: "failed",
        code: "UPDATE_HANDOFF_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  async restore(action: "recover" | "rollback"): Promise<void> {
    const previous = this.view;
    const version =
      action === "recover" && previous.phase === "recovery"
        ? previous.version
        : action === "rollback" &&
            (previous.phase === "idle" ||
              (previous.phase === "failed" && !previous.recoveryRequired))
          ? previous.rollbackVersion
          : undefined;
    if (this.closed || this.busy || !version) return;
    this.begin();
    this.publish({ phase: "applying", version });
    try {
      const outcome = await this.ports.restore(action);
      if (outcome.status === "blocked") {
        if (previous.phase === "recovery" || previous.phase === "idle")
          this.publish({ ...previous, blockedBy: outcome.code });
        else if (previous.phase === "failed" && !previous.recoveryRequired)
          this.publish({ ...previous, code: outcome.code });
      } else if (outcome.status === "unknown") {
        this.publish({
          phase: "failed",
          code: outcome.code,
          recoveryRequired: true,
        });
      }
    } catch {
      this.publish({
        phase: "failed",
        code: "UPDATE_HANDOFF_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.ports.cancelPending();
      await this.drained;
    })();
    return this.closing;
  }
}
