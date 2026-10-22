import type { OperationsRecorder } from "./renderer/operations-contract";
import { observeOperation } from "./operations/observe";
import { isDeepStrictEqual } from "node:util";
import { ChatGptAccountObservationSchema } from "./chatgpt-account-probe.ts";
import { BridgeError } from "./bridge/client.ts";
import type { BrowserDriver } from "./bridge/browser.ts";
import {
  validate,
  type BrowserLease,
  type BrowserBinding,
  type BrowserPrepare,
  type BrowserPrepared,
  type BrowserVerifySend,
  type BrowserVerified,
  type BrowserVerification,
  type BrowserAccountObservation,
  type BrowserSend,
  type BrowserSent,
  type BrowserObserve,
  type BrowserObserved,
  type BrowserObservation,
  type BrowserCancel,
  type BrowserCancelled,
  type BrowserDispose,
  type BrowserDisposed,
  type BrowserRequiredControls,
  type BrowserSelectionFacts,
  type BrowserControlFact,
} from "./bridge/wire.ts";
import type {
  ChatGptPhysicalApi,
  PhysicalPartition,
  PhysicalBinding,
  PhysicalView,
  PhysicalSelection,
  PhysicalSelectionEvidence,
  PhysicalWitness,
  PhysicalGuard,
  PhysicalPrevious,
  PhysicalFrame,
} from "./chatgpt-physical-api.ts";
import {
  ChatGptPublicTurn,
  PublicTurnFrameSchema,
} from "../../src/apps/desktop/chatgpt-public-turn.ts";

export type AssignedChatBrowser = Readonly<{
  lease: BrowserLease;
  api: ChatGptPhysicalApi;
  partition: PhysicalPartition;
}>;
type ControlTranslation = Readonly<{ value: string; literal: string }>;
// Host configuration, never inferred from a requested model or a DOM label.
export type QualifiedControlTranslation = Readonly<{
  version: "public-controls-v1";
  configSHA256: string;
  translationId: string;
  model: readonly ControlTranslation[];
  effort: readonly ControlTranslation[];
  mode: readonly ControlTranslation[];
  connector: readonly ControlTranslation[];
}>;
export type GoChatBrowserDependencies = Readonly<{
  operations?: OperationsRecorder;
  lookup: (lease: BrowserLease) => AssignedChatBrowser | undefined;
  translations: readonly QualifiedControlTranslation[];
  // Explicit trusted harness input; never read from a wire request or environment.
  // Selection pins one loopback origin and excludes the production destination.
  e2eOrigin?: string | null;
  nowMillis?: () => number;
}>;
type Session = {
  lease: BrowserLease;
  assigned: AssignedChatBrowser;
  target: BrowserPrepare["target"];
  translation: QualifiedControlTranslation;
  selection: PhysicalSelection;
  origin?: PhysicalBinding;
  physical?: PhysicalBinding;
  binding?: BrowserBinding;
  cid?: string;
  witness?: PhysicalWitness;
  witnessSnapshot?: PhysicalWitness;
  verification?: BrowserVerification;
  verifyAttempted: boolean;
  sendAttempted: boolean;
  sentAt?: number;
  turnObservation?:
    ReturnType<NonNullable<OperationsRecorder["begin"]>> | undefined;
  sendOutcome?: "submitted" | "not-sent" | "unknown";
  cancelAttempted: boolean;
  disposeAttempted: boolean;
  busy: boolean;
  failed: boolean;
  userId?: string;
  replyId?: string;
  semantic?: ChatGptPublicTurn;
  terminal: boolean;
  settled: boolean;
  answerSegments: number;
  readiness?: BrowserPrepared["readiness"];
  lastSignal?: string;
  sequence: bigint;
  delivered: bigint;
  floor: bigint;
  events: BrowserObservation[];
};
const controls = ["model", "effort", "mode", "connector"] as const;
const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
function validId(value: unknown): value is string {
  return typeof value === "string" && id.test(value);
}
function validControlLiteral(value: unknown): value is string {
  // Match Go ControlFact.Valid without trimming or normalizing the literal.
  // Go TrimSpace includes NEL but excludes BOM; JavaScript trim differs.
  // In Unicode mode the surrogate range matches only unpaired surrogates.
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(
      value,
    ) &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
  );
}
function validCode(value: unknown): value is string {
  return typeof value === "string" && codePattern.test(value);
}
function fail(code: string, state: "refused" | "unknown" = "refused"): never {
  throw new BridgeError(state, code);
}
function shape(name: string, input: unknown): void {
  if (!validate(name, input)) fail("chat_browser_invalid_boundary");
}
function copy<T>(input: T): T {
  return structuredClone(input);
}
function key(lease: BrowserLease): string {
  const i = lease.identity;
  return JSON.stringify([
    i.profileId,
    i.ownerId,
    i.sessionId,
    i.taskId,
    i.turnId,
    i.operationId,
    i.turnGeneration,
    lease.backendGeneration,
    lease.slotOrdinal,
    lease.slotGeneration,
  ]);
}
function previous(userTurnId: string, replyId: string): PhysicalPrevious {
  if (Boolean(userTurnId) !== Boolean(replyId))
    fail("chat_browser_previous_pair");
  return userTurnId ? { userTurnId, replyId } : null;
}
function validView(view: PhysicalView, partition: PhysicalPartition): boolean {
  return (
    !!view &&
    validId(view.viewId) &&
    view.partition === partition &&
    Number.isSafeInteger(view.viewGeneration) &&
    view.viewGeneration > 0 &&
    Number.isSafeInteger(view.documentGeneration) &&
    view.documentGeneration > 0
  );
}
function fixtureOrigin(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  try {
    const url = new URL(value);
    if (
      typeof value === "string" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      Number(url.port) > 0 &&
      url.origin === value
    )
      return value;
  } catch {
    /* Invalid trusted configuration stays unavailable. */
  }
  return fail("chat_browser_fixture_origin_invalid");
}
function validBinding(
  b: PhysicalBinding,
  partition: PhysicalPartition,
  e2eOrigin: string | null,
): boolean {
  if (!validView(b, partition)) return false;
  try {
    const url = new URL(b.url);
    if (
      url.origin !== (e2eOrigin ?? "https://chatgpt.com") ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    return b.phase === "home"
      ? b.conversationId === null &&
          url.pathname === (e2eOrigin ? "/chatgpt" : "/")
      : b.phase === "conversation" &&
          validId(b.conversationId) &&
          url.pathname ===
            `${e2eOrigin ? "/chatgpt" : ""}/c/${b.conversationId}`;
  } catch {
    return false;
  }
}
function sameView(a: PhysicalView, b: PhysicalView): boolean {
  return (
    a.viewId === b.viewId &&
    a.viewGeneration === b.viewGeneration &&
    a.documentGeneration === b.documentGeneration &&
    a.partition === b.partition
  );
}
function sameOwnedView(a: PhysicalView, b: PhysicalView): boolean {
  return (
    a.viewId === b.viewId &&
    a.viewGeneration === b.viewGeneration &&
    a.partition === b.partition
  );
}
function wireBinding(s: Session, b: PhysicalBinding): BrowserBinding {
  return {
    lease: copy(s.lease),
    viewId: b.viewId,
    viewGeneration: String(b.viewGeneration),
    documentGeneration: String(b.documentGeneration),
    conversationId: b.conversationId ?? "",
    providerState: b.phase === "home" ? "home" : "bound",
  };
}
function unknownFact(): BrowserControlFact {
  return { source: "unknown", value: "", literal: "" };
}

/** Mechanical physical adapter only. The host assigns routes; Go owns all
 * allocation, intent, journals, results and ACK. This map is bounded transient
 * observation paging and witness correlation, never an executor or result store.
 */
export class GoChatBrowserDriver implements BrowserDriver {
  private readonly operations: OperationsRecorder | undefined;
  private readonly lookup: GoChatBrowserDependencies["lookup"];
  private readonly translations: readonly QualifiedControlTranslation[];
  private readonly now: () => number;
  private readonly e2eOrigin: string | null;
  private readonly sessions = new Map<string, Session>();
  private readonly attempted = new Set<string>();
  private readonly evidenceIds = new Set<string>();
  constructor(deps: GoChatBrowserDependencies) {
    if (
      !deps ||
      typeof deps.lookup !== "function" ||
      !Array.isArray(deps.translations) ||
      (deps.nowMillis !== undefined && typeof deps.nowMillis !== "function")
    )
      fail("chat_browser_dependencies_missing");
    this.operations = deps.operations;
    this.e2eOrigin = fixtureOrigin(deps.e2eOrigin);
    this.lookup = deps.lookup;
    this.translations = copy(deps.translations);
    this.now = deps.nowMillis ?? Date.now;
    const keys = new Set<string>();
    for (const t of this.translations) {
      const k = `${t.configSHA256}/${t.translationId}`;
      if (
        t.version !== "public-controls-v1" ||
        !/^[a-f0-9]{64}$/.test(t.configSHA256) ||
        !validId(t.translationId) ||
        keys.has(k)
      )
        fail("chat_browser_translation_unqualified");
      keys.add(k);
      for (const field of controls) {
        const rows = t[field];
        if (!Array.isArray(rows) || rows.length > 128)
          fail("chat_browser_translation_unqualified");
        const values = new Set<string>(),
          literals = new Set<string>();
        for (const row of rows) {
          if (
            !row ||
            !validId(row.value) ||
            row.value.length > 120 ||
            !validControlLiteral(row.literal) ||
            values.has(row.value) ||
            literals.has(row.literal)
          )
            fail("chat_browser_translation_unqualified");
          values.add(row.value);
          literals.add(row.literal);
        }
      }
    }
  }
  private time(): number {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0) fail("chat_browser_clock_invalid");
    return n;
  }
  private deadline(value: string): number {
    const n = Number(value),
      now = this.time();
    if (!Number.isSafeInteger(n) || n <= now || n - now > 15000)
      fail("chat_browser_deadline");
    return n;
  }
  private assignment(lease: BrowserLease): AssignedChatBrowser {
    const a = this.lookup(copy(lease));
    if (
      !a ||
      !isDeepStrictEqual(a.lease, lease) ||
      ![
        "persist:farol-app-chatgpt",
        "persist:farol-dev-chatgpt",
        "persist:farol-owner-preview-chatgpt",
      ].includes(a.partition) ||
      !a.api ||
      ["prepare", "verifySend", "send", "observe", "cancel", "dispose"].some(
        (name) => typeof a.api[name as keyof ChatGptPhysicalApi] !== "function",
      )
    )
      fail("chat_browser_assignment_mismatch");
    return { lease: copy(lease), api: a.api, partition: a.partition };
  }
  private current(s: Session, deadline: number): boolean {
    if (this.time() >= deadline) return false;
    try {
      const a = this.assignment(s.lease);
      return a.api === s.assigned.api && a.partition === s.assigned.partition;
    } catch {
      return false;
    }
  }
  private guard(
    s: Session,
    deadline: number,
    transition = false,
  ): PhysicalGuard {
    return (b) => {
      if (
        !this.current(s, deadline) ||
        !validBinding(b, s.assigned.partition, this.e2eOrigin)
      )
        return false;
      if (!s.origin) return false;
      if (!sameView(s.origin, b)) return false;
      if (s.cid) return isDeepStrictEqual(s.physical, b);
      if (s.origin.phase === "conversation")
        return isDeepStrictEqual(s.origin, b);
      return (
        isDeepStrictEqual(s.origin, b) ||
        (transition && b.phase === "conversation")
      );
    };
  }
  private prepareGuard(
    s: Session,
    deadline: number,
    prior?: PhysicalBinding,
  ): PhysicalGuard {
    let initial: PhysicalBinding | undefined = prior ? copy(prior) : undefined;
    let rejected = false;
    let targetEpoch: number | undefined;
    return (b) => {
      if (
        rejected ||
        s.failed ||
        !this.current(s, deadline) ||
        !validBinding(b, s.assigned.partition, this.e2eOrigin)
      ) {
        rejected = true;
        return false;
      }
      if (s.origin) return isDeepStrictEqual(s.origin, b);
      if (!initial) initial = copy(b);
      const target =
        s.target.mode === "new-saved"
          ? b.phase === "home"
          : b.phase === "conversation" &&
            b.conversationId === s.target.conversationId;
      // One navigation of the existing dedicated view, including its exact
      // before-navigation binding. A URL change requires a new document epoch.
      // No other destination/view or regressing document is permitted.
      const unchanged = isDeepStrictEqual(b, initial);
      const allowed =
        sameOwnedView(initial, b) &&
        b.documentGeneration >= initial.documentGeneration &&
        (targetEpoch === undefined ||
          (target && b.documentGeneration === targetEpoch)) &&
        (unchanged ||
          (target &&
            (b.url === initial.url ||
              b.documentGeneration > initial.documentGeneration)));
      if (!allowed) rejected = true;
      if (
        allowed &&
        target &&
        b.documentGeneration !== initial.documentGeneration
      )
        targetEpoch = b.documentGeneration;
      return allowed;
    };
  }
  private session(lease: BrowserLease): Session {
    const s = this.sessions.get(key(lease));
    if (!s || !s.binding || !s.origin) fail("chat_browser_not_prepared");
    return s;
  }
  private bound(s: Session, b: BrowserBinding): void {
    if (!s.binding || !isDeepStrictEqual(b, s.binding))
      fail("chat_browser_binding_mismatch");
  }
  private async exclusive<T>(
    s: Session,
    run: () => Promise<T>,
    cleanup = false,
  ): Promise<T> {
    if (s.busy) fail("chat_browser_call_in_flight");
    if (s.failed && !cleanup)
      fail("chat_browser_observation_fenced", "unknown");
    s.busy = true;
    try {
      return await run();
    } catch (error) {
      s.failed = true;
      if (error instanceof BridgeError) throw error;
      fail("chat_browser_physical_unknown", "unknown");
    } finally {
      s.busy = false;
    }
  }
  private label(
    t: QualifiedControlTranslation,
    field: (typeof controls)[number],
    value: string,
  ): string | null {
    return t[field].find((row) => row.value === value)?.literal ?? null;
  }
  private selection(
    input: BrowserPrepare,
    t: QualifiedControlTranslation,
  ): PhysicalSelection {
    const selection = input.target.selection,
      resolution = input.target.resolution;
    if (
      !isDeepStrictEqual(selection, resolution.resolved) ||
      !input.target.required.model
    )
      fail("chat_browser_pinned_scope_mismatch");
    const modelLabel = this.label(t, "model", selection.modelId);
    if (!modelLabel) fail("chat_browser_model_translation_missing");
    for (const field of controls) {
      const value =
        field === "model"
          ? selection.modelId
          : field === "connector"
            ? selection.connectorId
            : selection[field];
      if (input.target.required[field] && !this.label(t, field, value))
        fail("chat_browser_required_translation_missing");
    }
    const connectorLabel = this.label(t, "connector", selection.connectorId);
    return {
      requested: copy(selection),
      admitted: copy(selection),
      resolved: {
        selection: copy(resolution.resolved),
        configSHA256: resolution.configSHA256,
        translationId: resolution.translationId,
      },
      controls: {
        modelLabel,
        effortLabel: this.label(t, "effort", selection.effort),
        modeLabel: this.label(t, "mode", selection.mode),
        connector: connectorLabel
          ? { id: selection.connectorId, label: connectorLabel }
          : null,
      },
      requiredControls: { ...copy(input.target.required), model: true },
    };
  }
  private facts(
    s: Session,
    evidence: PhysicalSelectionEvidence,
    required: BrowserRequiredControls,
    startedAt: number,
  ): BrowserSelectionFacts {
    if (
      !evidence ||
      evidence.sourceProfile !== "message-anchors-v1" ||
      !isDeepStrictEqual(evidence.declared, s.selection) ||
      !evidence.observed ||
      !Number.isSafeInteger(evidence.observedAtMillis) ||
      evidence.observedAtMillis < startedAt ||
      evidence.observedAtMillis > this.time()
    )
      fail("chat_browser_selection_evidence_invalid");
    const observed = evidence.observed;
    const result = {
      model: unknownFact(),
      effort: unknownFact(),
      mode: unknownFact(),
      connector: unknownFact(),
      observedAtMillis: String(evidence.observedAtMillis),
    };
    for (const field of controls) {
      const f =
        field === "model"
          ? observed.modelLabel
          : field === "effort"
            ? observed.effortLabel
            : field === "connector"
              ? observed.connectorLabel
              : observed.modeLabel;
      if (!f) fail("chat_browser_selection_fact_invalid");
      if (f.state === "unknown") {
        if (!["not-exposed", "unqualified"].includes(f.code) || required[field])
          fail("chat_browser_required_control_unknown");
        continue;
      }
      if (
        f.state !== "observed" ||
        f.source !== "public-dom" ||
        typeof f.value !== "string"
      )
        fail("chat_browser_selection_fact_invalid");
      const row = s.translation[field].find((row) => row.literal === f.value);
      const expected =
        field === "model"
          ? s.selection.admitted.modelId
          : field === "connector"
            ? s.selection.admitted.connectorId
            : s.selection.admitted[field];
      if (!row || row.value !== expected)
        fail("chat_browser_control_translation_mismatch");
      result[field] = {
        source: "public-control",
        value: row.value,
        literal: f.value,
      };
    }
    return result;
  }
  async prepare(input: BrowserPrepare): Promise<BrowserPrepared> {
    shape("BrowserPrepare", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      k = key(input.lease);
    if (this.attempted.has(k) || this.attempted.size >= 4096)
      fail("chat_browser_prepare_consumed");
    const t = this.translations.find(
      (t) =>
        t.configSHA256 === input.target.resolution.configSHA256 &&
        t.translationId === input.target.resolution.translationId,
    );
    if (!t) fail("chat_browser_translation_unqualified");
    previous(input.target.previousUserTurnId, input.target.previousReplyId);
    if (
      input.target.mode === "new-saved"
        ? Boolean(
            input.target.conversationId || input.target.previousUserTurnId,
          )
        : !validId(input.target.conversationId)
    )
      fail("chat_browser_target_invalid");
    const selection = this.selection(input, t);
    const assigned = this.assignment(input.lease);
    let prior: PhysicalBinding | undefined;
    // The host has already assigned the validated Go Prepare. Retire only our
    // drained, physically settled transient correlation for that same route;
    // never allocate, queue, infer release from an ordinal or lift an unknown.
    for (const [oldKey, old] of this.sessions) {
      if (
        old.assigned.api !== assigned.api &&
        old.lease.slotOrdinal !== input.lease.slotOrdinal
      )
        continue;
      if (
        old.busy ||
        old.failed ||
        !old.settled ||
        old.assigned.api !== assigned.api ||
        old.assigned.partition !== assigned.partition ||
        old.lease.identity.profileId !== input.lease.identity.profileId ||
        old.lease.backendGeneration !== input.lease.backendGeneration ||
        old.lease.slotOrdinal !== input.lease.slotOrdinal ||
        BigInt(input.lease.slotGeneration) <= BigInt(old.lease.slotGeneration)
      )
        fail("chat_browser_slot_fenced");
      prior = copy(old.physical!);
      this.sessions.delete(oldKey);
    }
    if (this.sessions.size >= 5) fail("chat_browser_capacity");
    const s: Session = {
      lease: copy(input.lease),
      assigned,
      target: copy(input.target),
      translation: t,
      selection,
      verifyAttempted: false,
      sendAttempted: false,
      cancelAttempted: false,
      disposeAttempted: false,
      busy: false,
      failed: false,
      terminal: false,
      settled: false,
      answerSegments: 0,
      sequence: 0n,
      delivered: 0n,
      floor: 0n,
      events: [],
    };
    this.attempted.add(k);
    this.sessions.set(k, s);
    return this.exclusive(s, async () => {
      const guard = this.prepareGuard(s, deadline, prior);
      const reply = await s.assigned.api.prepare(
        {
          operationId: s.lease.identity.operationId,
          target:
            input.target.mode === "new-saved"
              ? { kind: "new-saved" }
              : {
                  kind: "owned-saved",
                  conversationId: input.target.conversationId,
                },
          deadlineMillis: deadline,
        },
        guard,
      );
      if (reply.state !== "prepared")
        fail(
          "chat_browser_prepare_unconfirmed",
          reply.state === "unknown" ? "unknown" : "refused",
        );
      if (
        !guard(reply.binding) ||
        (s.target.mode === "new-saved"
          ? reply.binding.phase !== "home"
          : reply.binding.phase !== "conversation" ||
            reply.binding.conversationId !== s.target.conversationId) ||
        ![
          "ready",
          "sign-in-required",
          "awaiting-owner",
          "unavailable",
        ].includes(reply.readiness)
      )
        fail("chat_browser_prepare_binding_unknown", "unknown");
      s.origin = copy(reply.binding);
      s.binding = wireBinding(s, reply.binding);
      s.physical = copy(reply.binding);
      s.readiness = reply.readiness;
      const result: BrowserPrepared = {
        saved: reply.binding.phase === "conversation",
        binding: copy(s.binding),
        readiness: reply.readiness,
        code: "PHYSICAL_PREPARED",
      };
      shape("BrowserPrepared", result);
      return result;
    });
  }
  async verifySend(input: BrowserVerifySend): Promise<BrowserVerified> {
    shape("BrowserVerifySend", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      s = this.session(input.binding.lease);
    this.bound(s, input.binding);
    if (
      s.verifyAttempted ||
      s.readiness !== "ready" ||
      !isDeepStrictEqual(input.requested, s.target.selection) ||
      !isDeepStrictEqual(input.required, s.target.required) ||
      input.previousUserTurnId !== s.target.previousUserTurnId ||
      input.previousReplyId !== s.target.previousReplyId
    )
      fail("chat_browser_verification_scope_mismatch");
    return this.exclusive(s, async () => {
      s.verifyAttempted = true;
      const guard = this.guard(s, deadline),
        origin = s.origin!;
      if (!guard(origin)) fail("chat_browser_assignment_mismatch");
      const prior = previous(input.previousUserTurnId, input.previousReplyId);
      const startedAt = this.time();
      const reply = await s.assigned.api.verifySend(
        {
          operationId: s.lease.identity.operationId,
          binding: copy(origin),
          deadlineMillis: deadline,
          previous: prior,
          intentDigest: input.intentDigest,
          selection: copy(s.selection),
        },
        guard,
      );
      if (reply.state !== "witnessed")
        fail(
          "chat_browser_verification_unconfirmed",
          reply.state === "unknown" ? "unknown" : "refused",
        );
      const w = reply.witness;
      if (
        !w ||
        !guard(w.binding) ||
        !isDeepStrictEqual(w.binding, origin) ||
        w.operationId !== s.lease.identity.operationId ||
        w.deadlineMillis !== deadline ||
        w.intentDigest !== input.intentDigest ||
        !isDeepStrictEqual(w.previous, prior) ||
        !validId(w.evidenceId) ||
        this.evidenceIds.has(w.evidenceId) ||
        this.evidenceIds.size >= 4096
      )
        fail("chat_browser_witness_mismatch");
      let account: BrowserAccountObservation | undefined;
      if (w.account !== undefined) {
        const parsed = ChatGptAccountObservationSchema.safeParse(w.account);
        if (!parsed.success || parsed.data.state !== "observed")
          fail("chat_browser_account_unavailable");
        const fact = parsed.data,
          now = this.time();
        if (
          fact.documentUrl !== origin.url ||
          fact.observedAtMillis < startedAt ||
          fact.observedAtMillis > now ||
          now - fact.observedAtMillis >= 5000 ||
          fact.expiresAtMillis <= now
        )
          fail("chat_browser_account_unavailable");
        account = {
          state: "observed",
          source: fact.source,
          principalKey: fact.accountKey,
          observedAtMillis: String(fact.observedAtMillis),
          expiresAtMillis: String(fact.expiresAtMillis),
        };
      }
      const verification: BrowserVerification = {
        ...(account ? { account } : {}),
        binding: copy(input.binding),
        observed: this.facts(s, w.selection, input.required, startedAt),
        pinned: copy(s.target.selection),
        required: copy(input.required),
        previousUserTurnId: input.previousUserTurnId,
        previousReplyId: input.previousReplyId,
        intentDigest: input.intentDigest,
        evidenceId: w.evidenceId,
      };
      shape("BrowserVerification", verification);
      this.evidenceIds.add(w.evidenceId);
      // Keep the exact physical witness object: the dedicated API owns its mint.
      s.witness = w;
      s.witnessSnapshot = copy(w);
      s.verification = copy(verification);
      return { verification };
    });
  }
  async send(input: BrowserSend): Promise<BrowserSent> {
    if (!this.operations) return this.sendObserved(input);
    return observeOperation(
      this.operations,
      { source: "ChatGPT", kind: "chatgpt.consult.send", target: {} },
      () => this.sendObserved(input),
    );
  }
  private async sendObserved(input: BrowserSend): Promise<BrowserSent> {
    shape("BrowserSend", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      s = this.session(input.binding.lease);
    this.bound(s, input.binding);
    if (
      s.sendAttempted ||
      !s.witness ||
      !s.verification ||
      !isDeepStrictEqual(input.verification, s.verification) ||
      input.intentDigest !== s.witness.intentDigest ||
      !isDeepStrictEqual(s.witness, s.witnessSnapshot) ||
      this.time() >= s.witness.deadlineMillis
    )
      fail("chat_browser_send_witness_mismatch");
    return this.exclusive(s, async () => {
      s.sendAttempted = true;
      s.sentAt = this.time();
      const guard = this.guard(
          s,
          Math.min(deadline, s.witness!.deadlineMillis),
          true,
        ),
        origin = s.origin!;
      if (!guard(origin)) fail("chat_browser_assignment_mismatch");
      // Once dispatched, any exception, invalid reply or lost binding is an
      // unknown effect. The original operation remains available for read-only
      // observation, while the consumed Send can never be issued again.
      let result: BrowserSent;
      try {
        const reply = await s.assigned.api.send(
          {
            operationId: s.lease.identity.operationId,
            binding: copy(origin),
            deadlineMillis: deadline,
            witness: s.witness!,
            intentDigest: input.intentDigest,
            prompt: input.prompt,
          },
          guard,
        );
        if (
          !reply ||
          !("binding" in reply) ||
          !guard(reply.binding) ||
          reply.operationId !== s.lease.identity.operationId ||
          reply.evidenceId !== s.verification!.evidenceId ||
          !["submitted", "not-sent", "unknown"].includes(reply.state) ||
          !validCode(reply.code)
        )
          fail("chat_browser_send_reply_unknown", "unknown");
        result = {
          binding: copy(input.binding),
          verificationId: s.verification!.evidenceId,
          status: reply.state,
          code: reply.code,
        };
      } catch {
        result = {
          binding: copy(input.binding),
          verificationId: s.verification!.evidenceId,
          status: "unknown",
          code: "PHYSICAL_SEND_UNKNOWN",
        };
      }
      s.sendOutcome = result.status;
      return result;
    });
  }
  private append(
    s: Session,
    binding: BrowserBinding,
    kind: BrowserObservation["kind"],
    fields: Partial<
      Pick<
        BrowserObservation,
        "text" | "code" | "segmentId" | "providerConversationId"
      >
    > = {},
  ): void {
    const metadata = {
      source: "ChatGPT",
      kind: "chatgpt.consult.turn",
      target: {},
    } as const;
    if (kind === "accepted")
      s.turnObservation = this.operations?.begin?.(metadata);
    if (["completed", "refused", "unknown", "awaiting-owner"].includes(kind)) {
      const outcome =
        kind === "completed"
          ? "done"
          : kind === "refused"
            ? "refused"
            : kind === "awaiting-owner"
              ? "pending"
              : "unknown";
      const duration = Math.max(0, this.time() - (s.sentAt ?? this.time()));
      if (s.turnObservation) {
        const finish = s.turnObservation;
        s.turnObservation = undefined;
        finish(outcome, fields.code || null, duration);
      } else
        this.operations?.record(
          metadata,
          outcome,
          fields.code || null,
          duration,
        );
    }
    if (s.events.length >= 1024) fail("chat_browser_page_overflow", "unknown");
    const event: BrowserObservation = {
      binding: copy(binding),
      sequence: String(++s.sequence),
      observedAtMillis: String(this.time()),
      kind,
      text: "",
      code: "",
      userTurnId: s.userId ?? "",
      replyId: s.replyId ?? "",
      segmentId: "",
      providerConversationId: "",
      ...fields,
    };
    shape("BrowserObservation", event);
    s.events.push(event);
  }
  private accept(
    s: Session,
    binding: PhysicalBinding,
    correlation: { userTurnId: string | null; replyId: string | null },
  ): void {
    if (
      !correlation ||
      (correlation.userTurnId !== null && !validId(correlation.userTurnId)) ||
      (correlation.replyId !== null && !validId(correlation.replyId)) ||
      (correlation.userTurnId === null && correlation.replyId !== null)
    )
      fail("chat_browser_frame_correlation_unknown", "unknown");
    if (correlation.userTurnId === null) return;
    if (
      binding.phase !== "conversation" ||
      correlation.userTurnId === s.target.previousUserTurnId ||
      correlation.replyId === s.target.previousReplyId ||
      (s.userId && s.userId !== correlation.userTurnId) ||
      (s.replyId && s.replyId !== correlation.replyId)
    )
      fail("chat_browser_frame_correlation_unknown", "unknown");
    if (correlation.replyId !== null) s.replyId = correlation.replyId;
    if (!s.userId) {
      s.userId = correlation.userTurnId;
      const prepared = copy(s.binding!);
      s.cid = binding.conversationId;
      s.physical = copy(binding);
      this.append(s, prepared, "accepted", { providerConversationId: s.cid });
      s.binding = wireBinding(s, binding);
    }
  }
  private frame(
    s: Session,
    frame: PhysicalFrame,
    observedAtMillis: number,
  ): void {
    const parsed = PublicTurnFrameSchema.safeParse(frame);
    if (
      !parsed.success ||
      !s.userId ||
      !s.replyId ||
      parsed.data.userId !== s.userId ||
      (!s.semantic && parsed.data.messages[0]?.id !== s.replyId)
    )
      fail("chat_browser_frame_correlation_unknown", "unknown");
    const f = parsed.data;
    if (!s.semantic) s.semantic = new ChatGptPublicTurn(s.userId!, s.replyId!);
    const semantic = s.semantic.observe(f, observedAtMillis);
    for (const item of semantic.items) {
      const text =
        item.channel === "answer" && s.answerSegments++ > 0
          ? `\n\n${item.text}`
          : item.text;
      // One immutable provider message is one segment. Split only to obey wire
      // byte limits; each piece has a stable segment key, never a DOM index.
      let part = "",
        partIndex = 0;
      const flush = (): void => {
        if (!part) return;
        const segmentId =
          Buffer.byteLength(text) <= 65536
            ? item.id
            : `${item.id}/part/${partIndex++}`;
        if (!validId(segmentId))
          fail("chat_browser_segment_id_limit", "unknown");
        this.append(
          s,
          s.binding!,
          item.channel === "answer" ? "answer-delta" : item.channel,
          { text: part, segmentId },
        );
        part = "";
      };
      let bytes = 0;
      for (const character of text) {
        const width = Buffer.byteLength(character);
        if (bytes + width > 65536) {
          flush();
          bytes = 0;
        }
        part += character;
        bytes += width;
      }
      flush();
    }
    if (semantic.completed) {
      s.terminal = true;
      s.settled = true;
      this.append(s, s.binding!, "completed");
      this.append(s, s.binding!, "quiescent");
    }
  }
  async observe(input: BrowserObserve): Promise<BrowserObserved> {
    shape("BrowserObserve", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      s = this.session(input.binding.lease);
    const after = BigInt(input.afterSequence);
    // An undelivered accepted event can still be read with the origin Home
    // binding; all later cursor reads must use the adopted provider binding.
    if (
      !isDeepStrictEqual(input.binding, s.binding) &&
      !(
        s.origin &&
        after === 0n &&
        isDeepStrictEqual(input.binding, wireBinding(s, s.origin))
      )
    )
      fail("chat_browser_binding_mismatch");
    if (!this.current(s, deadline)) fail("chat_browser_assignment_mismatch");
    if (after < s.floor) return { events: [], gap: true };
    if (after > s.delivered || !s.sendOutcome || s.sendOutcome === "not-sent")
      fail("chat_browser_cursor_invalid");
    return this.exclusive(s, async () => {
      if (!this.current(s, deadline)) fail("chat_browser_assignment_mismatch");
      // The Go cursor authorizes dropping only the delivered prefix.
      s.events = s.events.filter((event) => BigInt(event.sequence) > after);
      s.floor = after;
      if (!s.events.length && !s.terminal) {
        const guard = this.guard(s, deadline, true),
          origin = s.origin!;
        const binding = s.physical!;
        const startedAt = this.time();
        const reply = await s.assigned.api.observe(
          {
            operationId: s.lease.identity.operationId,
            binding: copy(binding),
            deadlineMillis: deadline,
          },
          guard,
        );
        if (!this.current(s, deadline))
          fail("chat_browser_observe_assignment_unknown", "unknown");
        if (reply.state !== "observed") {
          if (
            !["refused", "awaiting-owner", "unknown"].includes(reply.state) ||
            !validCode(reply.code)
          )
            fail("chat_browser_observe_reply_unknown", "unknown");
          const signal = `${reply.state}/${reply.code}`;
          if (s.lastSignal !== signal)
            this.append(s, s.binding!, reply.state, { code: reply.code });
          s.lastSignal = signal;
          if (reply.state !== "awaiting-owner") s.terminal = true;
        } else {
          if (
            !isDeepStrictEqual(reply.originBinding, origin) ||
            !guard(reply.binding)
          )
            fail("chat_browser_observe_binding_unknown", "unknown");
          this.facts(s, reply.selection, s.target.required, startedAt);
          delete s.lastSignal;
          this.accept(s, reply.binding, reply.correlation);
          if (
            reply.frame !== null &&
            (reply.correlation.userTurnId === null ||
              reply.correlation.replyId === null)
          )
            fail("chat_browser_frame_correlation_unknown", "unknown");
          if (reply.frame !== null)
            this.frame(s, reply.frame, reply.selection.observedAtMillis);
        }
      }
      const page: BrowserObservation[] = [];
      for (const event of s.events) {
        // Home adoption is an explicit Go journal transition. Do not put
        // bound events in the page that still echoes the Home request binding.
        if (!isDeepStrictEqual(event.binding, input.binding)) break;
        if (page.length >= input.limit) break;
        page.push(event);
      }
      if (s.events.length && !page.length)
        fail("chat_browser_page_binding_mismatch");
      const result = { events: copy(page), gap: false };
      if (!this.current(s, deadline))
        fail("chat_browser_observe_assignment_unknown", "unknown");
      shape("BrowserObserved", result);
      if (page.length)
        s.delivered =
          BigInt(page.at(-1)!.sequence) > s.delivered
            ? BigInt(page.at(-1)!.sequence)
            : s.delivered;
      return result;
    });
  }
  async cancel(input: BrowserCancel): Promise<BrowserCancelled> {
    shape("BrowserCancel", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      s = this.session(input.binding.lease);
    this.bound(s, input.binding);
    if (s.cancelAttempted || !s.sendOutcome)
      fail("chat_browser_cancel_consumed");
    return this.exclusive(
      s,
      async () => {
        s.cancelAttempted = true;
        const guard = this.guard(s, deadline, true),
          binding = s.physical!;
        if (!this.current(s, deadline))
          fail("chat_browser_assignment_mismatch");
        const reply = await s.assigned.api.cancel(
          {
            operationId: s.lease.identity.operationId,
            binding: copy(binding),
            deadlineMillis: deadline,
          },
          guard,
        );
        if (!this.current(s, deadline))
          fail("chat_browser_cancel_unknown", "unknown");
        if (
          reply.state === "confirmed-terminal" ||
          reply.state === "already-terminal"
        ) {
          const proof = reply.proof,
            parsed = PublicTurnFrameSchema.safeParse(proof?.frame);
          // Cancellation cannot invent/adopt the first provider conversation.
          if (
            !proof ||
            !s.cid ||
            !guard(proof.binding) ||
            !parsed.success ||
            !parsed.data.terminal ||
            proof.correlation.userTurnId !== s.userId ||
            proof.correlation.replyId !== s.replyId
          )
            fail("chat_browser_cancel_terminal_unqualified", "unknown");
          const check = new ChatGptPublicTurn(s.userId!, s.replyId!);
          check.observe(parsed.data, this.time());
          if (!this.current(s, deadline))
            fail("chat_browser_cancel_unknown", "unknown");
          s.settled = true;
          return {
            binding: copy(input.binding),
            status: reply.state,
            code: "PHYSICAL_TERMINAL_CONFIRMED",
          };
        }
        if (
          (reply.state === "requested" || reply.state === "unknown") &&
          (("binding" in reply && !guard(reply.binding)) ||
            !validCode(reply.code))
        )
          fail("chat_browser_cancel_unknown", "unknown");
        return {
          binding: copy(input.binding),
          status: reply.state === "requested" ? "requested" : "unknown",
          code:
            reply.state === "requested"
              ? "PHYSICAL_STOP_REQUESTED"
              : "PHYSICAL_STOP_UNCONFIRMED",
        };
      },
      true,
    );
  }
  async dispose(input: BrowserDispose): Promise<BrowserDisposed> {
    shape("BrowserDispose", input);
    input = copy(input);
    const deadline = this.deadline(input.deadlineMillis),
      s = this.session(input.lease);
    if (s.disposeAttempted) fail("chat_browser_dispose_consumed");
    return this.exclusive(
      s,
      async () => {
        s.disposeAttempted = true;
        s.failed = true;
        const origin = s.origin!,
          guard = this.guard(s, deadline, true);
        if (!this.current(s, deadline))
          fail("chat_browser_assignment_mismatch");
        const binding = s.physical!;
        const reply = await s.assigned.api.dispose(
          {
            operationId: s.lease.identity.operationId,
            binding: copy(binding),
            deadlineMillis: deadline,
          },
          guard,
        );
        const confirmed =
          this.current(s, deadline) &&
          reply.state === "destroyed" &&
          validView(reply.view, s.assigned.partition) &&
          sameView(origin, reply.view) &&
          validId(reply.destroyedWebContentsId);
        if (confirmed) this.sessions.delete(key(s.lease));
        return {
          lease: copy(input.lease),
          confirmed,
          code: confirmed
            ? "PHYSICAL_DESTROYED"
            : "PHYSICAL_DESTRUCTION_UNCONFIRMED",
        };
      },
      true,
    );
  }
}
