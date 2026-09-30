import type { ReleaseManifest } from "../domain/github-release-contract";

export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1_000;

export type ReadyUpdate = Readonly<{
  handle: string;
  manifest: ReleaseManifest;
}>;
export type { InstalledUpdateView as UpdateView } from "../domain/installed-update";
import type { InstalledUpdateView as UpdateView } from "../domain/installed-update";

type KnownFailure = Readonly<{
  ok: false;
  code: string;
  recoveryRequired?: boolean;
}>;
export type InstalledUpdaterPorts = Readonly<{
  now(): number;
  // Recovery must reverify the retained archive/package and reconcile any helper receipt.
  recover(): Promise<
    Readonly<{ ok: true; update: ReadyUpdate | null }> | KnownFailure
  >;
  discover(): Promise<
    Readonly<{ ok: true; available: boolean }> | KnownFailure
  >;
  download(): Promise<
    Readonly<{ ok: true; update: ReadyUpdate }> | KnownFailure
  >;
  retain(update: ReadyUpdate): Promise<void>;
  // The composition holds existing admission fences, checks real obligations,
  // and hands off to the helper before it requests the application's normal quit.
  restart(
    update: ReadyUpdate,
  ): Promise<
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "blocked"; code: string }>
    | Readonly<{ status: "unknown"; code: string }>
  >;
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

  constructor(private readonly ports: InstalledUpdaterPorts) {}

  snapshot(): UpdateView {
    return this.view;
  }

  private publish(view: UpdateView): void {
    this.view = view;
    if (!this.closed) this.ports.publish(view);
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.busy || this.closed) return;
    this.busy = true;
    try {
      const restored = await this.ports.recover();
      if (!restored.ok) {
        this.publish({
          phase: "failed",
          code: restored.code,
          recoveryRequired: true,
        });
      } else if (restored.update) {
        this.ready = restored.update;
        this.publish({
          phase: "ready",
          version: restored.update.manifest.version,
          deferred: true,
          blockedBy: null,
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
      this.busy = false;
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
      this.view.blockedBy !== null
    ) {
      this.publish({ ...this.view, blockedBy: null });
      return;
    }
    if (
      !this.initialized ||
      this.busy ||
      this.closed ||
      this.ready ||
      this.view.phase === "applying" ||
      (this.view.phase === "failed" && this.view.recoveryRequired)
    )
      return;
    const now = this.ports.now();
    if (
      !manual &&
      this.lastCheck !== null &&
      now - this.lastCheck < UPDATE_RECHECK_MS
    )
      return;
    this.lastCheck = now;
    this.busy = true;
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
        });
        return;
      }
      if (!found.available) {
        this.publish({ phase: "idle", checkedAt: now });
        return;
      }
      this.publish({ phase: "downloading" });
      stagingStarted = true;
      const downloaded = await this.ports.download();
      if (this.closed) return;
      if (!downloaded.ok) {
        this.publish({
          phase: "failed",
          code: downloaded.code,
          recoveryRequired: downloaded.recoveryRequired ?? false,
        });
        return;
      }
      // A visible ready state always has a durable, verifiable restart record.
      await this.ports.retain(downloaded.update);
      stagingStarted = false;
      if (this.closed) return;
      this.ready = downloaded.update;
      this.publish({
        phase: "ready",
        version: downloaded.update.manifest.version,
        deferred: false,
        blockedBy: null,
      });
    } catch {
      this.publish({
        phase: "failed",
        code: "UPDATE_CHECK_FAILED",
        recoveryRequired: stagingStarted,
      });
    } finally {
      this.busy = false;
    }
  }

  later(): void {
    if (this.view.phase !== "ready" || this.closed) return;
    this.publish({ ...this.view, deferred: true });
  }

  async restart(): Promise<void> {
    if (this.closed || this.busy || this.view.phase !== "ready" || !this.ready)
      return;
    this.busy = true;
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
      this.busy = false;
    }
  }

  close(): void {
    this.closed = true;
  }
}
