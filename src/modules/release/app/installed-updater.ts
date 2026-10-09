import type {
  AutomaticUpdatePreference,
  AutomaticUpdatePreferenceResult,
  InstallOnQuitPreference,
  InstallOnQuitPreferenceResult,
  NormalQuitApplyContext,
  NormalQuitUpdateReceipt,
  NormalQuitUpdateRequest,
  NormalQuitUpdateState,
  UpdateNotice,
} from "../domain/installed-update";
import { parseInstallOnQuitPreference } from "../domain/installed-update";
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
  // Missing ports mean OFF/unsupported. The host must load a separately scoped
  // durable choice; the existing auto-download record cannot supply this ACK.
  readInstallOnQuitPreference?(): Promise<unknown>;
  writeInstallOnQuitPreference?(
    enabled: boolean,
  ): Promise<InstallOnQuitPreferenceResult>;

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
  // Adapter into the SAME restart/apply engine, called before destructive Quit
  // drain. Acquire its original admission before stopping clients, use this
  // absolute deadline through preparation/rechecks/helper readiness, and refuse
  // late dispatch. Do not call quit(), relaunch, force work to stop, drop an
  // unknown admission/lock/journal, or substitute a helper. Accepted requires
  // the exact live helper's readiness ACK. The host's original Quit continues.
  applyOnQuit?(
    update: ReadyUpdate,
    context: NormalQuitApplyContext,
  ): Promise<UpdateHandoff>;
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
  private quitPreference: InstallOnQuitPreference = {
    status: "confirmed",
    scope: "install-on-normal-quit",
    enabled: false,
  };
  private normalQuitState: NormalQuitUpdateState = { status: "idle" };
  private normalQuitAttempt: Promise<NormalQuitUpdateReceipt> | null = null;
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
    if (ports.readInstallOnQuitPreference)
      this.quitPreference = {
        status: "blocked",
        enabled: false,
        code: "UPDATE_QUIT_PREFERENCE_NOT_LOADED",
      };
  }

  snapshot(): UpdateView {
    return {
      ...this.view,
      ...(this.ports.readAutomaticUpdatePreference
        ? { automaticUpdatePreference: this.automaticPreference }
        : {}),
      ...(this.ports.readInstallOnQuitPreference
        ? { installOnQuitPreference: this.quitPreference }
        : {}),
    };
  }

  private isClosing(): boolean {
    return this.closed || this.normalQuitState.status !== "idle";
  }

  installOnQuitPreference(): InstallOnQuitPreference {
    return this.quitPreference;
  }

  normalQuitUpdateState(): NormalQuitUpdateState {
    return this.normalQuitState;
  }

  async setInstallOnQuitPreference(
    enabled: boolean,
  ): Promise<InstallOnQuitPreferenceResult> {
    if (this.quitPreference.status === "unknown")
      return { status: "unknown", code: this.quitPreference.code };
    if (typeof enabled !== "boolean")
      return { status: "refused", code: "UPDATE_QUIT_PREFERENCE_INVALID" };
    if (this.isClosing() || !this.initialized || this.preferenceWriting)
      return { status: "refused", code: "UPDATE_QUIT_PREFERENCE_UNAVAILABLE" };
    if (!this.ports.writeInstallOnQuitPreference)
      return { status: "refused", code: "UPDATE_QUIT_PREFERENCE_UNSUPPORTED" };
    if (this.quitPreference.status === "blocked")
      return { status: "refused", code: this.quitPreference.code };
    this.preferenceWriting = true;
    let finishPreference!: () => void;
    this.preferenceDrained = new Promise((resolve) => {
      finishPreference = resolve;
    });
    this.quitPreference = {
      status: "blocked",
      enabled: false,
      code: "UPDATE_QUIT_PREFERENCE_WRITING",
    };
    let result: InstallOnQuitPreferenceResult;
    try {
      const ack = await this.ports.writeInstallOnQuitPreference(enabled);
      const confirmed = parseInstallOnQuitPreference(ack);
      if (confirmed?.status === "confirmed" && confirmed.enabled === enabled)
        result = confirmed;
      else if (
        ack &&
        (ack.status === "refused" || ack.status === "unknown") &&
        typeof ack.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,100}$/u.test(ack.code) &&
        Object.keys(ack).every((key) => ["status", "code"].includes(key))
      )
        result = { status: ack.status, code: ack.code };
      else
        result = {
          status: "unknown",
          code: "UPDATE_QUIT_PREFERENCE_ACK_MISMATCH",
        };
    } catch {
      result = {
        status: "unknown",
        code: "UPDATE_QUIT_PREFERENCE_OUTCOME_UNKNOWN",
      };
    }
    this.quitPreference =
      result.status === "confirmed"
        ? result
        : {
            status: result.status === "unknown" ? "unknown" : "blocked",
            enabled: false,
            code: result.code,
          };
    this.preferenceWriting = false;
    finishPreference();
    if (!this.isClosing()) {
      try {
        this.ports.publish(this.snapshot());
      } catch {
        /* The durable ACK remains authoritative. */
      }
    }
    return result;
  }

  /** One host-only attempt per lifetime, before collect()/close()/quit flags. */
  applyOnNormalQuit(
    request: NormalQuitUpdateRequest,
  ): Promise<NormalQuitUpdateReceipt> {
    if (
      !request ||
      request.kind !== "ordinary-quit" ||
      !Number.isSafeInteger(request.deadlineAt) ||
      request.deadlineAt < 0 ||
      !Object.keys(request).every((key) => ["kind", "deadlineAt"].includes(key))
    )
      return Promise.resolve({
        status: "blocked",
        code: "UPDATE_QUIT_REQUEST_INVALID",
      });
    if (this.normalQuitAttempt) return this.normalQuitAttempt;
    const wasClosing = this.isClosing();
    // Claim synchronously. Repeated before-quit events neither extend the
    // original deadline nor race another release command or preference write.
    const original = {
      kind: "ordinary-quit" as const,
      deadlineAt: request.deadlineAt,
    };
    this.normalQuitState = {
      status: "pending",
      deadlineAt: original.deadlineAt,
    };
    let settle!: (receipt: NormalQuitUpdateReceipt) => void;
    this.normalQuitAttempt = new Promise((resolve) => {
      settle = resolve;
    });
    // Publish the promise before invoking a host port: synchronous re-entry
    // observes the same attempt even before that port returns its promise.
    void this.applyForNormalQuit(original, wasClosing).then((receipt) => {
      this.normalQuitState = {
        status: "settled",
        deadlineAt: original.deadlineAt,
        receipt,
      };
      settle(receipt);
    });
    return this.normalQuitAttempt;
  }

  private async applyForNormalQuit(
    request: NormalQuitUpdateRequest,
    wasClosing: boolean,
  ): Promise<NormalQuitUpdateReceipt> {
    if (wasClosing || !this.initialized || this.busy || this.preferenceWriting)
      return { status: "skipped", code: "UPDATE_QUIT_OWNER_UNAVAILABLE" };
    const preference = this.quitPreference;
    if (preference.status !== "confirmed")
      return { status: preference.status, code: preference.code };
    if (!preference.enabled)
      return { status: "skipped", code: "UPDATE_QUIT_NOT_OPTED_IN" };
    if (this.view.phase === "failed" && this.view.recoveryRequired)
      return {
        status: this.view.code.includes("UNKNOWN") ? "unknown" : "blocked",
        code: this.view.code,
      };
    if (this.view.phase === "recovery")
      return { status: "blocked", code: "UPDATE_RECOVERY_REQUIRED" };
    if (this.view.phase !== "ready" || !this.ready)
      return { status: "skipped", code: "UPDATE_PACKAGE_NOT_READY" };
    if (this.view.blockedBy !== null)
      return {
        status: this.view.blockedBy.includes("UNKNOWN") ? "unknown" : "blocked",
        code: this.view.blockedBy,
      };
    if (!this.ports.applyOnQuit)
      return { status: "blocked", code: "UPDATE_QUIT_APPLY_UNSUPPORTED" };
    let dispatched = false;
    this.begin();
    try {
      const now = this.ports.now();
      if (!Number.isFinite(now) || now >= request.deadlineAt)
        return { status: "skipped", code: "UPDATE_QUIT_DEADLINE_EXPIRED" };
      // No download, retained-record rewrite or renderer ACK belongs here.
      // Later/restore's deferred flag postpones an explicit restart; the new
      // confirmed Quit consent still selects this retained, verified candidate.
      dispatched = true;
      const outcome = await this.ports.applyOnQuit(this.ready, {
        ...request,
        relaunch: false,
        requestQuit: false,
      });
      if (
        outcome &&
        outcome.status === "accepted" &&
        Object.keys(outcome).length === 1
      ) {
        this.view = { phase: "applying", version: this.ready.manifest.version };
        return { status: "accepted", relaunch: false };
      }
      if (
        outcome &&
        (outcome.status === "blocked" || outcome.status === "unknown") &&
        typeof outcome.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,100}$/u.test(outcome.code) &&
        Object.keys(outcome).every((key) => ["status", "code"].includes(key))
      ) {
        if (outcome.status === "unknown")
          this.view = {
            phase: "failed",
            code: outcome.code,
            recoveryRequired: true,
          };
        else
          this.view = {
            ...this.view,
            phase: "ready",
            version: this.ready.manifest.version,
            deferred: true,
            blockedBy: outcome.code,
          };
        return { status: outcome.status, code: outcome.code };
      }
      throw new Error("UPDATE_HANDOFF_UNKNOWN");
    } catch {
      const code = dispatched
        ? "UPDATE_HANDOFF_UNKNOWN"
        : "UPDATE_QUIT_CLOCK_UNREADABLE";
      if (dispatched)
        this.view = { phase: "failed", code, recoveryRequired: true };
      return { status: dispatched ? "unknown" : "blocked", code };
    } finally {
      this.finish();
    }
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
    if (this.isClosing() || !this.initialized || this.preferenceWriting)
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
    if (!this.isClosing()) {
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
    if (this.isClosing()) return;
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
    if (!this.isClosing()) this.ports.publish(this.snapshot());
  }

  async acknowledgeNotice(key: string): Promise<void> {
    const current = this.view;
    if (
      this.isClosing() ||
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
        if (!this.isClosing()) this.ports.publish(this.snapshot());
      }
      this.noticeWriting = false;
      finishNotice();
    }
  }

  private canPrepare(): boolean {
    return (
      this.initialized &&
      !this.busy &&
      !this.isClosing() &&
      !this.ready &&
      this.view.phase !== "applying" &&
      this.view.phase !== "recovery" &&
      !(this.view.phase === "failed" && this.view.recoveryRequired)
    );
  }

  private async retainPrepared(
    prepared: Awaited<ReturnType<InstalledUpdaterPorts["download"]>>,
    knownReady?: Extract<UpdateView, { phase: "ready" }>,
  ): Promise<void> {
    if (!prepared.ok) {
      // Only a known producer refusal before retention can preserve the
      // admitted original. Keep the refusal visible and do not replay it.
      if (
        knownReady &&
        !prepared.recoveryRequired &&
        !prepared.code.includes("UNKNOWN")
      ) {
        await this.publish({ ...knownReady, blockedBy: prepared.code });
        return;
      }
      await this.publish({
        phase: "failed",
        code: prepared.code,
        recoveryRequired: knownReady
          ? true
          : (prepared.recoveryRequired ?? false),
        ...(!knownReady && !prepared.recoveryRequired && this.rollbackVersion
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
        // A replacement retain was dispatched: even a known failure cannot
        // prove the original retained record is still authoritative.
        recoveryRequired: knownReady
          ? true
          : (retention.recoveryRequired ?? false),
        ...(!knownReady && !retention.recoveryRequired && this.rollbackVersion
          ? { rollbackVersion: this.rollbackVersion }
          : {}),
      });
      return;
    }
    this.ready = prepared.update;
    if (this.isClosing()) return;
    await this.publish({
      phase: "ready",
      version: prepared.update.manifest.version,
      deferred: false,
      blockedBy: null,
      ...(prepared.update.notes ? { notes: prepared.update.notes } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized || this.busy || this.isClosing()) return;
    this.begin();
    try {
      if (this.ports.readInstallOnQuitPreference) {
        try {
          this.quitPreference = parseInstallOnQuitPreference(
            await this.ports.readInstallOnQuitPreference(),
          ) ?? {
            status: "blocked",
            enabled: false,
            code: "UPDATE_QUIT_PREFERENCE_INVALID",
          };
        } catch {
          this.quitPreference = {
            status: "blocked",
            enabled: false,
            code: "UPDATE_QUIT_PREFERENCE_UNREADABLE",
          };
        }
      }
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
      if (
        !this.isClosing() &&
        (this.ports.readAutomaticUpdatePreference ||
          this.ports.readInstallOnQuitPreference)
      )
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
      !this.isClosing() &&
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
      if (this.isClosing()) return;
      const found = await this.ports.discover();
      if (this.isClosing()) return;
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
      this.isClosing() ||
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
      if (this.isClosing()) return;
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
      this.isClosing() ||
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

  /**
   * Host-only replacement requires the supervisor's exact admitted Ready build.
   * The caller owns disk validation, its existing lease and original backup;
   * this argument supplies no admission authority and is not a renderer command.
   * Without it, local preparation remains Idle-only.
   */
  async prepareLocal(expectedReadyBuildId?: string): Promise<void> {
    const previous = this.view;
    const original = this.ready;
    const replacing = expectedReadyBuildId !== undefined;
    if (replacing) {
      if (
        !this.initialized ||
        this.busy ||
        this.isClosing() ||
        previous.phase !== "ready" ||
        previous.blockedBy !== null ||
        !original ||
        original.manifest.buildId !== expectedReadyBuildId ||
        original.manifest.version !== previous.version
      )
        return;
    } else if (!this.canPrepare() || previous.phase !== "idle") return;
    const knownReady =
      replacing && previous.phase === "ready" ? previous : undefined;
    if (!this.ports.prepareLocal) {
      this.begin();
      try {
        await this.publish(
          knownReady
            ? {
                ...knownReady,
                blockedBy: "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
              }
            : {
                phase: "failed",
                code: "UPDATE_LOCAL_IMPORT_UNAVAILABLE",
                recoveryRequired: false,
                ...(this.rollbackVersion
                  ? { rollbackVersion: this.rollbackVersion }
                  : {}),
              },
        );
      } finally {
        this.finish();
      }
      return;
    }
    this.begin();
    let importStarted = false;
    try {
      await this.publish({ phase: "downloading" });
      if (this.isClosing()) return;
      importStarted = true;
      const prepared = await this.ports.prepareLocal();
      if (
        prepared.ok &&
        knownReady &&
        original &&
        (prepared.update.manifest.buildId === original.manifest.buildId ||
          prepared.update.handle === original.handle ||
          prepared.update.manifest.archiveSha256 ===
            original.manifest.archiveSha256 ||
          prepared.update.manifest.artifactSha256 ===
            original.manifest.artifactSha256)
      ) {
        // The producer may have staged an intent, but has not selected a new
        // package. Leave both archives to their owner for reconciliation.
        await this.publish({
          phase: "failed",
          code: "UPDATE_LOCAL_CANDIDATE_NOT_NEW",
          recoveryRequired: true,
        });
        return;
      }
      await this.retainPrepared(prepared, knownReady);
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
      this.isClosing() ||
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
      this.isClosing() ||
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
      if (this.isClosing()) return;
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
    if (this.isClosing() || this.busy || !version) return;
    this.begin();
    let restoreStarted = false;
    try {
      await this.publish({ phase: "applying", version });
      if (this.isClosing()) return;
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
