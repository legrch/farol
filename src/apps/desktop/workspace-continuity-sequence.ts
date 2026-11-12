/**
 * One trusted desktop invocation of the Go-owned continuity journal.
 *
 * This is NOT a journal or an approval writer. Go owns the original operation,
 * held descriptors, exact effect intents/ACKs and current activation. The
 * desktop supplies the original independently acknowledged MCP stop and the
 * sole Settings CAS. No callback can be replayed after an ambiguous effect.
 */
export type ContinuitySequencePhase =
  | "stop"
  | "record-stopped"
  | "admit"
  | "confirm"
  | "withdraw"
  | "settings"
  | "stage"
  | "close"
  | "current-qualification";

export type ContinuitySequenceResult = Readonly<
  | { state: "refused"; phase: ContinuitySequencePhase }
  | { state: "unknown"; phase: ContinuitySequencePhase }
  | { state: "committed-not-active"; operationId: string }
  | { state: "current-qualified"; operationId: string }
>;

export type KnownStop = Readonly<{
  state: "confirmed";
  // This must be an original reply from the separately owned Settings writer.
  revision: number;
  generation: number;
  operationId: string;
}>;
export type ContinuityEffectReceipt = Readonly<{
  effectId: string;
  digest: string;
}>;
export type ContinuityPhaseResult =
  | Readonly<{ state: "acknowledged"; receipt: ContinuityEffectReceipt }>
  | Readonly<{ state: "refused" }>
  | Readonly<{ state: "unknown" }>;
export type ContinuityAdmitted = Readonly<{
  state: "admitted";
  operationId: string;
}>;
export type ContinuityPrepared = Readonly<{
  state: "prepared";
  root: string;
  currentDevice: string;
  currentInode: string;
}>;

// All ports are trusted host composition. No renderer supplies a receipt,
// current() predicate, one-shot intent or native picker result to Go.
export type ContinuitySequencePorts = Readonly<{
  current(): boolean;
  // Trusted native/build compatibility is never inferred from version numbers,
  // a renderer toggle, or equal Settings bytes. No qualified implementation
  // means persistence must remain CLOSED before any stop/Go WAL effect.
  recoveryQualified(): Promise<true | "unavailable">;
  // Separately owned original connector/Settings stop custody, including
  // unresolved publication from a PREVIOUS request or runtime. Must be
  // backed by that owner's protected state; visible equal Settings bytes or
  // a fresh ContinuitySequence instance are not an acknowledgement. Missing
  // callback is a refusal before any new drain/WAL effect.
  priorStopSettled(): Promise<true | "unknown">;
  stop(): Promise<true | false | "unknown">;
  recordStopped(): Promise<
    KnownStop | { state: "refused" } | { state: "unknown" }
  >;
  // Go Admit confirms the first WAL intent before obtaining native handles.
  admit(
    stopped: KnownStop,
  ): Promise<ContinuityAdmitted | { state: "refused" } | { state: "unknown" }>;
  // The picker is called while Go retains the original candidate chain.
  picker(operationId: string): Promise<"confirmed" | "cancelled" | "invalid">;
  confirm(
    operationId: string,
    ownerPicked: boolean,
  ): Promise<ContinuityPrepared | { state: "refused" } | { state: "unknown" }>;
  // A known pre-withdraw refusal can close original native owners and certify.
  refuseBeforeWithdraw(operationId: string): Promise<true | "unknown">;
  // Go supplies a deterministic per-effect plan bound to the original UUID;
  // the desktop never fabricates a receipt/digest.
  plan(
    operationId: string,
    phase:
      "withdraw_intent" | "settings_intent" | "publish_intent" | "close_intent",
  ): Promise<ContinuityEffectReceipt | "unknown">;
  // Each effect intent is durable before dispatch; ACK has the same effect ID.
  intent(
    operationId: string,
    phase:
      "withdraw_intent" | "settings_intent" | "publish_intent" | "close_intent",
    receipt: ContinuityEffectReceipt,
  ): Promise<true | "unknown">;
  acknowledge(
    operationId: string,
    phase: "withdraw_ack" | "settings_ack" | "publish_ack",
    receipt: ContinuityEffectReceipt,
  ): Promise<true | "unknown">;
  withdraw(operationId: string): Promise<ContinuityPhaseResult>;
  settings(
    operationId: string,
    prepared: ContinuityPrepared,
  ): Promise<ContinuityPhaseResult>;
  stage(operationId: string): Promise<ContinuityPhaseResult>;
  // Go Close / Certify is one-shot and returns a qualified logical certificate.
  closeAndCertify(operationId: string): Promise<true | "unknown">;
  // Requires host-only compatible-reader/recovery/native qualification;
  // without it a committed certificate remains unavailable to Computer.
  qualifyCurrent(operationId: string): Promise<true | "unavailable">;
}>;

export class ContinuitySequence {
  private consumed = false;
  private unknownStop = false;
  private readonly ports: ContinuitySequencePorts;
  constructor(ports: ContinuitySequencePorts) {
    this.ports = ports;
  }
  // An unknown stopped-publication outcome must not be cleared by a later
  // ordinary request whose Settings bytes happen to equal the stopped bytes.
  get stoppedPublicationUnconfirmed(): boolean {
    return this.unknownStop;
  }

  async run(legacy: boolean): Promise<ContinuitySequenceResult> {
    if (this.consumed || this.unknownStop || !this.isCurrent())
      return { state: "refused", phase: "stop" };
    this.consumed = true; // synchronous admission, including reentrant callers
    const invoke = async <T>(
      work: () => Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await work();
      } catch {
        return undefined;
      }
    };
    const fail = (
      phase: ContinuitySequencePhase,
    ): ContinuitySequenceResult => ({ state: "unknown", phase });
    const refusal = (
      phase: ContinuitySequencePhase,
    ): ContinuitySequenceResult => ({ state: "refused", phase });

    if (
      (await invoke(() => this.ports.recoveryQualified())) !== true ||
      !this.isCurrent()
    )
      return refusal("stop");
    if (
      (await invoke(() => this.ports.priorStopSettled())) !== true ||
      !this.isCurrent()
    )
      return refusal("stop");
    const stopped = await invoke(() => this.ports.stop());
    if (stopped === false && this.isCurrent()) return refusal("stop");
    if (stopped !== true || !this.isCurrent()) {
      this.unknownStop = true;
      return fail("stop");
    }
    const recorded = await invoke(() => this.ports.recordStopped());
    if (recorded?.state === "refused" && this.isCurrent())
      return refusal("record-stopped");
    if (
      recorded?.state !== "confirmed" ||
      !this.validStop(recorded) ||
      !this.isCurrent()
    ) {
      this.unknownStop = true;
      return fail("record-stopped");
    }
    // Do not consult visible Settings to prove this ACK. Only the original
    // returned stop/publication receipt may cross the WAL admission barrier.
    const admitted = await invoke(() => this.ports.admit(recorded));
    if (admitted?.state === "refused" && this.isCurrent())
      return refusal("admit");
    if (
      admitted?.state !== "admitted" ||
      !this.validUUID(admitted.operationId) ||
      !this.isCurrent()
    )
      return fail("admit");
    const id = admitted.operationId;
    if (legacy) {
      const picked = await invoke(() => this.ports.picker(id));
      if (picked !== "confirmed") {
        if (
          picked === "cancelled" &&
          this.isCurrent() &&
          (await invoke(() => this.ports.refuseBeforeWithdraw(id))) === true &&
          this.isCurrent()
        )
          return refusal("confirm");
        return fail("confirm");
      }
    }
    const prepared = await invoke(() => this.ports.confirm(id, legacy));
    if (prepared?.state !== "prepared" || !this.isCurrent())
      return fail("confirm");

    const steps = [
      {
        phase: "withdraw" as const,
        intent: "withdraw_intent" as const,
        ack: "withdraw_ack" as const,
        effect: () => this.ports.withdraw(id),
      },
      {
        phase: "settings" as const,
        intent: "settings_intent" as const,
        ack: "settings_ack" as const,
        effect: () => this.ports.settings(id, prepared),
      },
      {
        phase: "stage" as const,
        intent: "publish_intent" as const,
        ack: "publish_ack" as const,
        effect: () => this.ports.stage(id),
      },
    ];
    for (const step of steps) {
      const pending = await invoke(() => this.ports.plan(id, step.intent));
      if (
        !pending ||
        pending === "unknown" ||
        !this.validPlannedReceipt(pending) ||
        !this.isCurrent() ||
        (await invoke(() => this.ports.intent(id, step.intent, pending))) !==
          true ||
        !this.isCurrent()
      )
        return fail(step.phase);
      const result = await invoke(step.effect);
      if (
        result?.state !== "acknowledged" ||
        !this.validReceipt(result.receipt, pending.effectId)
      )
        return fail(step.phase);
      if (
        !this.isCurrent() ||
        (await invoke(() =>
          this.ports.acknowledge(id, step.ack, result.receipt),
        )) !== true
      )
        return fail(step.phase);
    }
    const closeIntent = await invoke(() => this.ports.plan(id, "close_intent"));
    if (
      !closeIntent ||
      closeIntent === "unknown" ||
      !this.validPlannedReceipt(closeIntent) ||
      !this.isCurrent() ||
      (await invoke(() =>
        this.ports.intent(id, "close_intent", closeIntent),
      )) !== true ||
      !this.isCurrent()
    )
      return fail("close");
    if ((await invoke(() => this.ports.closeAndCertify(id))) !== true)
      return fail("close");
    if (!this.isCurrent()) return fail("current-qualification");
    const qualified = await invoke(() => this.ports.qualifyCurrent(id));
    return qualified === true && this.isCurrent()
      ? { state: "current-qualified", operationId: id }
      : { state: "committed-not-active", operationId: id };
  }

  private isCurrent(): boolean {
    try {
      return this.ports.current() === true;
    } catch {
      return false;
    }
  }
  private validUUID(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    );
  }
  private validStop(value: KnownStop): boolean {
    return (
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      Number.isSafeInteger(value.generation) &&
      value.generation > 0 &&
      this.validUUID(value.operationId)
    );
  }
  private validPlannedReceipt(value: ContinuityEffectReceipt): boolean {
    return (
      typeof value?.effectId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value.effectId) &&
      typeof value?.digest === "string" &&
      /^[0-9a-f]{64}$/u.test(value.digest)
    );
  }
  private validReceipt(
    value: ContinuityEffectReceipt,
    effectId: string,
  ): boolean {
    return this.validPlannedReceipt(value) && value.effectId === effectId;
  }
}
