import type {
  AutomaticUpdatePreference,
  AutomaticUpdatePreferenceResult,
  UpdateNotice,
} from "../domain/installed-update";
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
  notes?: string;
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
  // Optional for transitional callers. Production uses the installed release owner.
  readAutomaticUpdatePreference?(): Promise<AutomaticUpdatePreference>;
  writeAutomaticUpdatePreference?(
    enabled: boolean,
  ): Promise<AutomaticUpdatePreferenceResult>;

  // Optional only for transitional callers without a notice projection. The
  // installed runtime supplies both ports through its existing preferences owner.
  notice?(
    view: UpdateView,
    version: string | null,
    restored: boolean,
  ): Promise<UpdateNotice>;
  noticeSeen?(key: string): Promise<Readonly<{ ok: true }> | KnownFailure>;
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
    | Readonly<{ ok: true; available: false }>
    | Readonly<{
        ok: true;
        available: true;
        version: string;
        buildId: string;
        deferred: boolean;
        notes?: string;
      }>
    | KnownFailure
  >;
  download(): Promise<
    Readonly<{ ok: true; update: ReadyUpdate }> | KnownFailure
  >;
  skip(buildId: string): Promise<Readonly<{ ok: true }> | KnownFailure>;
  defer(buildId: string): Promise<Readonly<{ ok: true }> | KnownFailure>;
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
  private noticeVersion: string | null = null;
  private noticeBlocked: string | null = null;
  private noticeWriting = false;
  private noticeDrained: Promise<void> = Promise.resolve();
  private automaticPreference: AutomaticUpdatePreference = {
    status: "confirmed",
    enabled: false,
  };
  private preferenceWriting = false;
  private preferenceDrained: Promise<void> = Promise.resolve();
  private ready: ReadyUpdate | null = null;
  private available: Readonly<{ version: string; buildId: string }> | null =
    null;
  private initialized = false;
  private busy = false;
  private scheduledChecking = false;
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

  constructor(private readonly ports: InstalledUpdaterPorts) {
    if (ports.readAutomaticUpdatePreference) {
      this.automaticPreference = {
        status: "blocked",
        enabled: false,
        code: "UPDATE_AUTOMATIC_PREFERENCE_NOT_LOADED",
      };
    }
  }

  snapshot(): UpdateView {
    return this.ports.readAutomaticUpdatePreference
      ? { ...this.view, automaticUpdatePreference: this.automaticPreference }
      : this.view;
  }

  automaticUpdatePreference(): AutomaticUpdatePreference {
    return this.automaticPreference;
  }

  // Only an explicit command changes the choice. No release effect is dispatched.
  async setAutomaticUpdatePreference(
    enabled: boolean,
  ): Promise<AutomaticUpdatePreferenceResult> {
    if (this.automaticPreference.status === "unknown")
      return { status: "unknown", code: this.automaticPreference.code };
    if (typeof enabled !== "boolean")
      return { status: "refused", code: "UPDATE_AUTOMATIC_PREFERENCE_INVALID" };
    if (this.closed || !this.initialized || this.preferenceWriting)
      return {
        status: "refused",
        code: "UPDATE_AUTOMATIC_PREFERENCE_UNAVAILABLE",
      };
    if (!this.ports.writeAutomaticUpdatePreference)
      return {
        status: "refused",
        code: "UPDATE_AUTOMATIC_PREFERENCE_UNSUPPORTED",
      };
    if (this.automaticPreference.status === "blocked")
      return { status: "refused", code: this.automaticPreference.code };
    this.preferenceWriting = true;
    let finishPreference!: () => void;
    this.preferenceDrained = new Promise((resolve) => {
      finishPreference = resolve;
    });
    this.automaticPreference = {
      status: "blocked",
      enabled: false,
      code: "UPDATE_AUTOMATIC_PREFERENCE_WRITING",
    };
    let result: AutomaticUpdatePreferenceResult;
    try {
      result = await this.ports.writeAutomaticUpdatePreference(enabled);
      if (result.status === "confirmed" && result.enabled !== enabled)
        result = {
          status: "unknown",
          code: "UPDATE_AUTOMATIC_PREFERENCE_ACK_MISMATCH",
        };
    } catch {
      result = {
        status: "unknown",
        code: "UPDATE_AUTOMATIC_PREFERENCE_OUTCOME_UNKNOWN",
      };
    }
    this.automaticPreference =
      result.status === "confirmed"
        ? result
        : {
            status: result.status === "unknown" ? "unknown" : "blocked",
            enabled: false,
            code: result.code,
          };
    this.preferenceWriting = false;
    finishPreference();
    // A destroyed renderer cannot change the already settled durable ACK.
    if (!this.closed) {
      try {
        this.ports.publish(this.snapshot());
      } catch {
        /* Status can be read again. */
      }
    }
    return result;
  }

  private async publish(view: UpdateView): Promise<void> {
    if ("version" in view) this.noticeVersion = view.version;
    this.view = view;
    if (this.closed) return;
    if (
      this.ports.notice &&
      (view.phase === "available" ||
        view.phase === "ready" ||
        view.phase === "failed")
    ) {
      let notice: UpdateNotice;
      if (this.noticeBlocked) {
        notice = {
          key: "unconfirmed",
          seen: false,
          blockedBy: this.noticeBlocked,
        };
      } else {
        try {
          notice = await this.ports.notice(
            view,
            this.noticeVersion,
            !this.initialized,
          );
          if (notice.blockedBy) this.noticeBlocked = notice.blockedBy;
        } catch {
          // A notice preference write may have reached disk. Preserve update
          // truth and fence the notice command for this lifetime; never retry.
          this.noticeBlocked = "UPDATE_NOTICE_OUTCOME_UNKNOWN";
          notice = {
            key: "unconfirmed",
            seen: false,
            blockedBy: this.noticeBlocked,
          };
        }
      }
      this.view = { ...view, notice };
    }
    if (!this.closed) this.ports.publish(this.snapshot());
  }

  async acknowledgeNotice(key: string): Promise<void> {
    const current = this.view;
    if (
      this.closed ||
      this.noticeWriting ||
      this.noticeBlocked ||
      !this.initialized ||
      !this.ports.noticeSeen ||
      !(
        current.phase === "available" ||
        current.phase === "ready" ||
        current.phase === "failed"
      ) ||
      !current.notice ||
      current.notice.key !== key ||
      current.notice.seen ||
      current.notice.blockedBy ||
      (current.phase === "failed" && current.code.includes("UNKNOWN")) ||
      (current.phase === "ready" && current.blockedBy?.includes("UNKNOWN"))
    )
      return;
    this.noticeWriting = true;
    let finishNotice!: () => void;
    this.noticeDrained = new Promise((resolve) => {
      finishNotice = resolve;
    });
    let seen = false;
    try {
      const result = await this.ports.noticeSeen(key);
      if (result.ok) seen = true;
      else this.noticeBlocked = result.code;
    } catch {
      this.noticeBlocked = "UPDATE_NOTICE_OUTCOME_UNKNOWN";
    } finally {
      // Update commands have their own lane and may have advanced this view.
      // Mark only the still-current notice, never restore the captured phase.
      const latest = this.view;
      if ("notice" in latest && latest.notice?.key === key) {
        this.view = {
          ...latest,
          notice: { ...latest.notice, seen, blockedBy: this.noticeBlocked },
        };
        if (!this.closed) this.ports.publish(this.snapshot());
      }
      this.noticeWriting = false;
      finishNotice();
    }
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
      await this.publish({
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
      await this.publish({
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
    await this.publish({
      phase: "ready",
      version: prepared.update.manifest.version,
      deferred: false,
      blockedBy: null,
      ...(prepared.update.notes ? { notes: prepared.update.notes } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.busy || this.closed) return;
    this.begin();
    try {
      if (this.ports.readAutomaticUpdatePreference) {
        try {
          this.automaticPreference =
            await this.ports.readAutomaticUpdatePreference();
        } catch {
          this.automaticPreference = {
            status: "blocked",
            enabled: false,
            code: "UPDATE_AUTOMATIC_PREFERENCE_UNREADABLE",
          };
        }
      }
      const restored = await this.ports.recover();
      if (!restored.ok) {
        await this.publish({
          phase: "failed",
          code: restored.code,
          recoveryRequired: restored.recoveryRequired ?? true,
        });
      } else if (restored.recoveryVersion) {
        await this.publish({
          phase: "recovery",
          version: restored.recoveryVersion,
          blockedBy: null,
        });
      } else if (restored.update) {
        this.ready = restored.update;
        await this.publish({
          phase: "ready",
          version: restored.update.manifest.version,
          deferred: true,
          blockedBy: null,
          ...(restored.update.notes ? { notes: restored.update.notes } : {}),
        });
      } else if (restored.rollbackVersion) {
        this.rollbackVersion = restored.rollbackVersion;
        await this.publish({
          phase: "idle",
          checkedAt: null,
          rollbackVersion: this.rollbackVersion,
        });
      }
    } catch {
      await this.publish({
        phase: "failed",
        code: "UPDATE_RECOVERY_UNAVAILABLE",
        recoveryRequired: true,
      });
    } finally {
      this.initialized = true;
      this.finish();
      if (!this.closed && this.ports.readAutomaticUpdatePreference)
        this.ports.publish(this.snapshot());
    }
  }

  /** Timer entry point: discover, then retain an eligible update when opted in. */
  async scheduledCheck(): Promise<void> {
    if (this.scheduledChecking || !this.canPrepare()) return;
    this.scheduledChecking = true;
    const preference = this.automaticPreference;
    const previousCandidate = this.available;
    try {
      await this.check();
      // A throttled/busy check must not download an earlier manual candidate.
      // Re-read the choice after discovery: OFF or an unsettled write fences
      // automatic effects even if this tick began with a confirmed opt-in.
      if (
        preference.status === "confirmed" &&
        preference.enabled &&
        this.automaticPreference.status === "confirmed" &&
        this.automaticPreference.enabled &&
        this.available !== previousCandidate &&
        this.view.phase === "available" &&
        !this.view.deferred
      )
        await this.download();
    } finally {
      this.scheduledChecking = false;
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
      this.begin();
      try {
        await this.publish({ ...this.view, blockedBy: null });
      } finally {
        this.finish();
      }
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
    try {
      await this.publish({ phase: "checking" });
      if (this.closed) return;
      const found = await this.ports.discover();
      if (this.closed) return;
      this.available = null;
      if (!found.ok) {
        await this.publish({
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
        await this.publish({
          phase: "idle",
          checkedAt: now,
          ...(this.rollbackVersion
            ? { rollbackVersion: this.rollbackVersion }
            : {}),
        });
        return;
      }
      this.available = { version: found.version, buildId: found.buildId };
      await this.publish({
        phase: "available",
        version: found.version,
        deferred: found.deferred,
        ...(found.notes ? { notes: found.notes } : {}),
      });
    } catch {
      await this.publish({
        phase: "failed",
        code: "UPDATE_CHECK_FAILED",
        recoveryRequired: false,
      });
    } finally {
      this.finish();
    }
  }

  async download(): Promise<void> {
    if (
      this.closed ||
      this.busy ||
      !this.initialized ||
      this.ready ||
      this.view.phase !== "available" ||
      !this.available ||
      this.view.version !== this.available.version
    )
      return;
    const previous = this.view;
    const expected = this.available;
    this.available = null;
    this.begin();
    let downloadStarted = false;
    try {
      await this.publish({ phase: "downloading" });
      if (this.closed) return;
      downloadStarted = true;
      const downloaded = await this.ports.download();
      if (
        downloaded.ok &&
        (downloaded.update.manifest.version !== expected.version ||
          downloaded.update.manifest.buildId !== expected.buildId)
      ) {
        // A staged archive with a mismatched candidate requires reconciliation.
        // Never offer it as Ready or silently download a replacement.
        await this.publish({
          phase: "failed",
          code: "UPDATE_CANDIDATE_CHANGED",
          recoveryRequired: true,
        });
        return;
      }
      await this.retainPrepared(downloaded);
    } catch {
      if (!downloadStarted) {
        this.available = expected;
        await this.publish(previous);
        return;
      }
      await this.publish({
        phase: "failed",
        code: "UPDATE_STAGING_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  async skip(): Promise<void> {
    if (
      this.closed ||
      this.busy ||
      !this.initialized ||
      this.view.phase !== "available" ||
      !this.available ||
      this.view.version !== this.available.version
    )
      return;
    const buildId = this.available.buildId;
    this.begin();
    try {
      const result = await this.ports.skip(buildId);
      if (!result.ok) {
        await this.publish({
          phase: "failed",
          code: result.code,
          recoveryRequired: result.recoveryRequired ?? true,
        });
        return;
      }
      this.available = null;
      await this.publish({ phase: "idle", checkedAt: this.ports.now() });
    } catch {
      // The preference may have reached disk even if acknowledgment failed.
      await this.publish({
        phase: "failed",
        code: "UPDATE_SKIP_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  async prepareLocal(): Promise<void> {
    if (!this.canPrepare()) return;
    if (!this.ports.prepareLocal) {
      this.begin();
      try {
        await this.publish({
          phase: "failed",
          code: "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
          recoveryRequired: false,
          ...(this.rollbackVersion
            ? { rollbackVersion: this.rollbackVersion }
            : {}),
        });
      } finally {
        this.finish();
      }
      return;
    }
    const previous = this.view;
    this.begin();
    let importStarted = false;
    try {
      await this.publish({ phase: "downloading" });
      if (this.closed) return;
      importStarted = true;
      await this.retainPrepared(await this.ports.prepareLocal());
    } catch {
      if (!importStarted) {
        await this.publish(previous);
        return;
      }
      // Import or retention may already have published durable bytes. The
      // original owner must reconcile them; another import is not recovery.
      await this.publish({
        phase: "failed",
        code: "UPDATE_LOCAL_IMPORT_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
  }

  async later(): Promise<void> {
    if (
      (this.view.phase !== "ready" && this.view.phase !== "available") ||
      this.closed ||
      this.busy
    )
      return;
    if (this.view.phase === "ready") {
      this.begin();
      try {
        await this.publish({ ...this.view, deferred: true });
      } finally {
        this.finish();
      }
      return;
    }
    if (this.busy || !this.available || this.view.deferred) return;
    const current = this.view;
    this.begin();
    try {
      const result = await this.ports.defer(this.available.buildId);
      if (!result.ok) {
        await this.publish({
          phase: "failed",
          code: result.code,
          recoveryRequired: result.recoveryRequired ?? true,
        });
        return;
      }
      await this.publish({ ...current, deferred: true });
    } catch {
      await this.publish({
        phase: "failed",
        code: "UPDATE_LATER_OUTCOME_UNKNOWN",
        recoveryRequired: true,
      });
    } finally {
      this.finish();
    }
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
    const previous = this.view;
    this.begin();
    const version = this.ready.manifest.version;
    let restartStarted = false;
    try {
      await this.publish({ phase: "applying", version });
      if (this.closed) return;
      restartStarted = true;
      const outcome = await this.ports.restart(this.ready);
      if (outcome.status === "blocked") {
        await this.publish({
          phase: "ready",
          version,
          deferred: true,
          blockedBy: outcome.code,
        });
      } else if (outcome.status === "unknown") {
        await this.publish({
          phase: "failed",
          code: outcome.code,
          recoveryRequired: true,
        });
      }
    } catch {
      if (!restartStarted) {
        await this.publish(previous);
        return;
      }
      // The helper may already have accepted its handoff. Never launch another.
      await this.publish({
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
    let restoreStarted = false;
    try {
      await this.publish({ phase: "applying", version });
      if (this.closed) return;
      restoreStarted = true;
      const outcome = await this.ports.restore(action);
      if (outcome.status === "blocked") {
        if (previous.phase === "recovery" || previous.phase === "idle")
          await this.publish({ ...previous, blockedBy: outcome.code });
        else if (previous.phase === "failed" && !previous.recoveryRequired)
          await this.publish({ ...previous, code: outcome.code });
      } else if (outcome.status === "unknown") {
        await this.publish({
          phase: "failed",
          code: outcome.code,
          recoveryRequired: true,
        });
      }
    } catch {
      if (!restoreStarted) {
        await this.publish(previous);
        return;
      }
      await this.publish({
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
      await Promise.all([
        this.drained,
        this.noticeDrained,
        this.preferenceDrained,
      ]);
    })();
    return this.closing;
  }
}
