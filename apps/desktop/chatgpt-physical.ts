import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { PublicTurnFrameSchema } from "../../src/apps/desktop/chatgpt-public-turn";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
  PhysicalCorrelation,
  PhysicalFailure,
  PhysicalGuard,
  PhysicalSelection,
  PhysicalSelectionEvidence,
  PhysicalWitness,
} from "./chatgpt-physical-api";
import type {
  ChatGptPhysicalHostPort,
  PhysicalPageObservation,
  PhysicalSubmission,
  PhysicalSurface,
} from "./chatgpt-physical-host-port";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const viewFields = {
  viewId: z.string().regex(/^[1-9][0-9]*$/),
  viewGeneration: z.number().int().positive(),
  documentGeneration: z.number().int().nonnegative(),
  partition: z.enum([
    "persist:farol-next-chatgpt",
    "persist:farol-dev-chatgpt",
  ]),
};
const bindingSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...viewFields,
    phase: z.literal("home"),
    url: z.url(),
    conversationId: z.null(),
  }),
  z.strictObject({
    ...viewFields,
    phase: z.literal("conversation"),
    url: z.url(),
    conversationId: id,
  }),
]);
const previousSchema = z
  .strictObject({ userTurnId: id, replyId: id })
  .nullable();
const declarationSchema = z.strictObject({
  provider: id,
  alias: id,
  accountId: id,
  modelId: id,
  effort: z.string().max(256),
  mode: z.string().max(256),
  connectorId: z.string().max(256),
  connectorGrantId: z.string().max(256),
  toolsEnabled: z.boolean(),
});
const selectionSchema = z.strictObject({
  requested: declarationSchema,
  admitted: declarationSchema,
  resolved: z.strictObject({
    selection: declarationSchema,
    configSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    translationId: id,
  }),
  controls: z.strictObject({
    modelLabel: id,
    effortLabel: id.nullable(),
    modeLabel: id.nullable(),
    connector: z.strictObject({ id, label: id }).nullable(),
  }),
  requiredControls: z.strictObject({
    model: z.literal(true),
    effort: z.boolean(),
    mode: z.boolean(),
    connector: z.boolean(),
  }),
});
const factSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("observed"),
    source: z.literal("public-dom"),
    value: id,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    code: z.enum(["not-exposed", "unqualified"]),
  }),
]);
const observedSchema = z.strictObject({
  modelLabel: factSchema,
  effortLabel: factSchema,
  modeLabel: factSchema,
  connectorLabel: factSchema,
});
const evidenceSchema = z.strictObject({
  declared: selectionSchema,
  observed: observedSchema,
  observedAtMillis: z.number().int().positive(),
  sourceProfile: z.literal("message-anchors-v1"),
});
const boundFields = {
  operationId: id,
  binding: bindingSchema,
  deadlineMillis: z.number().int().positive(),
};
const boundSchema = z.strictObject(boundFields);
const witnessSchema = z.strictObject({
  ...boundFields,
  evidenceId: id,
  intentDigest: id,
  previous: previousSchema,
  selection: evidenceSchema,
});
const verifySchema = z.strictObject({
  ...boundFields,
  previous: previousSchema,
  intentDigest: id,
  selection: selectionSchema,
});
const sendSchema = z.strictObject({
  ...boundFields,
  witness: witnessSchema,
  intentDigest: id,
  prompt: z
    .string()
    .min(1)
    .max(256 * 1024),
});
const prepareSchema = z.strictObject({
  operationId: id,
  target: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("new-saved") }),
    z.strictObject({ kind: z.literal("owned-saved"), conversationId: id }),
  ]),
  deadlineMillis: z.number().int().positive(),
});
const failureSchema = z.strictObject({
  state: z.enum(["refused", "awaiting-owner", "unknown"]),
  code,
});
const rawWitnessSchema = z.strictObject({
  state: z.literal("witnessed"),
  binding: bindingSchema,
  operationId: id,
  evidenceId: id,
  intentDigest: id,
  previous: previousSchema,
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
  baselineUserIds: z.array(id).max(512),
});
const correlationSchema = z.strictObject({
  userTurnId: id.nullable(),
  replyId: id.nullable(),
});
const rawObserveSchema = z.strictObject({
  state: z.literal("observed"),
  originBinding: bindingSchema,
  binding: bindingSchema,
  correlation: correlationSchema,
  frame: PublicTurnFrameSchema.nullable(),
  observed: observedSchema,
  sourceProfile: z.literal("message-anchors-v1"),
});
const sendResultSchema = z.strictObject({
  state: z.enum(["submitted", "not-sent", "unknown"]),
  binding: bindingSchema,
  operationId: id,
  evidenceId: id,
  code,
});
const cancelSchema = z.union([
  failureSchema,
  z.strictObject({
    state: z.enum(["requested", "unknown"]),
    binding: bindingSchema,
    code,
  }),
  z.strictObject({
    state: z.enum(["confirmed-terminal", "already-terminal"]),
    proof: z.strictObject({
      binding: bindingSchema,
      correlation: z.strictObject({ userTurnId: id, replyId: id }),
      frame: PublicTurnFrameSchema,
    }),
  }),
]);
const same = isDeepStrictEqual;
const refuse = (reason: string): PhysicalFailure => ({
  state: "refused",
  code: reason,
});
const unknown = (reason: string): PhysicalFailure => ({
  state: "unknown",
  code: reason,
});
const safeGuard = (guard: PhysicalGuard, binding: PhysicalBinding): boolean => {
  try {
    return guard(structuredClone(binding)) === true;
  } catch {
    return false;
  }
};
const sameView = (a: PhysicalBinding, b: PhysicalBinding): boolean =>
  a.viewId === b.viewId &&
  a.viewGeneration === b.viewGeneration &&
  a.documentGeneration === b.documentGeneration &&
  a.partition === b.partition;

type WitnessRecord = {
  witness: PhysicalWitness;
  surface: PhysicalSurface;
  baselineUserIds: readonly string[];
};
type SubmissionRecord = {
  submission: PhysicalSubmission;
  surface: PhysicalSurface;
  binding: PhysicalBinding;
  correlation: PhysicalCorrelation;
  cancelAttempted: boolean;
  terminal: boolean;
};

// One instance belongs to one dedicated route. Its fuses are physical dispatch
// safety, not a second task engine: Go owns authority, sequencing and results.
export class ChatGptPhysical implements ChatGptPhysicalApi {
  private readonly witnesses = new Map<string, WitnessRecord>();
  private readonly attempted = new Set<string>();
  private readonly prepared = new Set<string>();
  private readonly disposed = new Set<object>();
  private submission: SubmissionRecord | null = null;
  private mutating = false;

  constructor(
    private readonly port: ChatGptPhysicalHostPort,
    private readonly now: () => number = Date.now,
  ) {}

  private snapshot(): PhysicalSurface | null {
    try {
      if (!this.port.qualified()) return null;
      const surface = this.port.snapshot();
      if (
        !surface ||
        !surface.handle ||
        typeof surface.handle !== "object" ||
        surface.isDestroyed()
      )
        return null;
      const binding = bindingSchema.safeParse(surface.binding);
      return binding.success ? { ...surface, binding: binding.data } : null;
    } catch {
      return null;
    }
  }

  private validDeadline(deadline: number): boolean {
    const remaining = deadline - this.now();
    return (
      Number.isSafeInteger(deadline) && remaining > 0 && remaining <= 15_000
    );
  }

  private capture(
    binding: PhysicalBinding,
    guard: PhysicalGuard,
    deadline: number,
  ): PhysicalSurface | null {
    if (
      !this.port.qualified() ||
      !this.validDeadline(deadline) ||
      !safeGuard(guard, binding)
    )
      return null;
    const surface = this.snapshot();
    return surface && !surface.isDestroyed() && same(surface.binding, binding)
      ? surface
      : null;
  }

  private current(
    surface: PhysicalSurface,
    guard: PhysicalGuard,
    deadline: number,
  ): PhysicalSurface | null {
    if (!this.validDeadline(deadline)) return null;
    const current = this.snapshot();
    return current &&
      current.handle === surface.handle &&
      !surface.isDestroyed() &&
      safeGuard(guard, current.binding)
      ? current
      : null;
  }

  private selectionMatches(
    selection: PhysicalSelection,
    observed: z.infer<typeof observedSchema>,
  ): boolean {
    const expected = [
      selection.controls.modelLabel,
      selection.controls.effortLabel,
      selection.controls.modeLabel,
      selection.controls.connector?.label ?? null,
    ];
    const facts = [
      observed.modelLabel,
      observed.effortLabel,
      observed.modeLabel,
      observed.connectorLabel,
    ];
    const required = [
      true,
      selection.requiredControls.effort,
      selection.requiredControls.mode,
      selection.requiredControls.connector,
    ];
    return facts.every((fact, n) =>
      fact.state === "observed"
        ? expected[n] !== null && fact.value === expected[n]
        : !required[n],
    );
  }

  async prepare(
    input: Parameters<ChatGptPhysicalApi["prepare"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["prepare"]> {
    const parsed = prepareSchema.safeParse(input);
    if (
      !parsed.success ||
      !this.port.qualified() ||
      !this.validDeadline(input.deadlineMillis)
    )
      return refuse("PHYSICAL_PREPARE_INVALID");
    const request = parsed.data;
    if (
      this.mutating ||
      (this.submission && !this.submission.terminal) ||
      this.attempted.has(request.operationId) ||
      this.prepared.has(request.operationId) ||
      this.prepared.size >= 64
    )
      return refuse("PHYSICAL_OPERATION_ALREADY_USED");
    const before = this.snapshot();
    if (!before || before.isDestroyed() || !safeGuard(guard, before.binding))
      return refuse("PHYSICAL_BINDING_LOST");
    const url =
      request.target.kind === "new-saved"
        ? this.port.homeUrl
        : this.port.conversationUrl(request.target.conversationId);
    if (!url) return refuse("PHYSICAL_TARGET_INVALID");
    this.prepared.add(request.operationId);
    this.submission = null;
    this.witnesses.clear();
    this.mutating = true;
    try {
      if (before.binding.url !== url) await this.port.load(before, url);
      const after = this.current(before, guard, request.deadlineMillis);
      if (
        !after ||
        after.binding.url !== url ||
        after.binding.viewId !== before.binding.viewId ||
        after.binding.viewGeneration !== before.binding.viewGeneration ||
        after.binding.partition !== before.binding.partition
      )
        return unknown("PHYSICAL_PREPARE_BINDING_LOST");
      if (
        request.target.kind === "new-saved"
          ? after.binding.phase !== "home"
          : after.binding.conversationId !== request.target.conversationId
      )
        return refuse("PHYSICAL_TARGET_MISMATCH");
      const raw = await this.port.prepareProbe(after, after.binding);
      const receipt = z
        .strictObject({
          readiness: z.enum([
            "ready",
            "sign-in-required",
            "awaiting-owner",
            "unavailable",
          ]),
        })
        .safeParse(raw);
      const final = this.current(after, guard, request.deadlineMillis);
      if (!final || !same(final.binding, after.binding))
        return unknown("PHYSICAL_PREPARE_BINDING_LOST");
      const failed = failureSchema.safeParse(raw);
      if (failed.success) return failed.data;
      return receipt.success
        ? {
            state: "prepared",
            binding: final.binding,
            readiness: receipt.data.readiness,
          }
        : refuse("PHYSICAL_PREPARE_RECEIPT_INVALID");
    } catch {
      return unknown("PHYSICAL_PREPARE_UNCONFIRMED");
    } finally {
      this.mutating = false;
    }
  }

  async verifySend(
    input: Parameters<ChatGptPhysicalApi["verifySend"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["verifySend"]> {
    const parsed = verifySchema.safeParse(input);
    if (!parsed.success) return refuse("PHYSICAL_VERIFICATION_INVALID");
    const request = parsed.data;
    if (
      this.mutating ||
      this.attempted.has(request.operationId) ||
      this.witnesses.size >= 64
    )
      return refuse("PHYSICAL_OPERATION_ALREADY_USED");
    if (request.binding.phase === "home" && request.previous !== null)
      return refuse("PHYSICAL_PREVIOUS_MISMATCH");
    const surface = this.capture(
      request.binding,
      guard,
      request.deadlineMillis,
    );
    if (!surface) return refuse("PHYSICAL_BINDING_LOST");
    try {
      const raw = await this.port.verifySend(surface, request);
      const current = this.current(surface, guard, request.deadlineMillis);
      if (
        !current ||
        !same(current.binding, request.binding) ||
        this.attempted.has(request.operationId)
      )
        return refuse("PHYSICAL_BINDING_LOST");
      const failed = failureSchema.safeParse(raw);
      if (failed.success) return failed.data;
      const receipt = rawWitnessSchema.safeParse(raw);
      if (!receipt.success)
        return refuse("PHYSICAL_VERIFICATION_RECEIPT_INVALID");
      const proof = receipt.data;
      if (
        !same(proof.binding, request.binding) ||
        proof.operationId !== request.operationId ||
        proof.intentDigest !== request.intentDigest ||
        !same(proof.previous, request.previous) ||
        !this.selectionMatches(request.selection, proof.observed) ||
        this.witnesses.has(proof.evidenceId) ||
        new Set(proof.baselineUserIds).size !== proof.baselineUserIds.length ||
        (request.binding.phase === "home" && proof.baselineUserIds.length !== 0)
      )
        return refuse("PHYSICAL_VERIFICATION_MISMATCH");
      const witness: PhysicalWitness = {
        ...request,
        evidenceId: proof.evidenceId,
        selection: {
          declared: request.selection,
          observed: proof.observed,
          observedAtMillis: this.now(),
          sourceProfile: proof.sourceProfile,
        },
      };
      // Return a detached value; callers cannot mutate our dispatch witness.
      this.witnesses.set(proof.evidenceId, {
        witness: structuredClone(witness),
        surface,
        baselineUserIds: proof.baselineUserIds,
      });
      return { state: "witnessed", witness: structuredClone(witness) };
    } catch {
      return refuse("PHYSICAL_VERIFICATION_UNAVAILABLE");
    }
  }

  async send(
    input: Parameters<ChatGptPhysicalApi["send"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["send"]> {
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) return refuse("PHYSICAL_SEND_INVALID");
    const request = parsed.data;
    const reply = (state: "not-sent" | "unknown", reason: string) =>
      structuredClone({
        state,
        binding: request.binding,
        operationId: request.operationId,
        evidenceId: request.witness.evidenceId,
        code: reason,
      });
    const retained = this.witnesses.get(request.witness.evidenceId);
    const surface = this.capture(
      request.binding,
      guard,
      request.deadlineMillis,
    );
    if (
      !retained ||
      !surface ||
      retained.surface.handle !== surface.handle ||
      !same(retained.witness, request.witness) ||
      !same(request.witness.binding, request.binding) ||
      request.witness.operationId !== request.operationId ||
      request.witness.intentDigest !== request.intentDigest ||
      request.witness.deadlineMillis !== request.deadlineMillis
    )
      return reply("not-sent", "PHYSICAL_WITNESS_MISMATCH");
    if (
      this.mutating ||
      this.attempted.has(request.operationId) ||
      (this.submission && !this.submission.terminal)
    )
      return reply("not-sent", "PHYSICAL_OPERATION_ALREADY_USED");
    // Consume before dispatch. Exceptions, ACK loss, and owner loss retain it.
    this.attempted.add(request.operationId);
    this.witnesses.delete(request.witness.evidenceId);
    this.mutating = true;
    this.submission = {
      surface,
      binding: request.binding,
      correlation: { userTurnId: null, replyId: null },
      cancelAttempted: false,
      terminal: false,
      submission: {
        originBinding: request.binding,
        operationId: request.operationId,
        evidenceId: request.witness.evidenceId,
        intentDigest: request.intentDigest,
        promptDigest: createHash("sha256")
          .update(request.prompt.replace(/\r\n?/g, "\n"))
          .digest("hex"),
        baselineUserIds: retained.baselineUserIds,
        previous: request.witness.previous,
        selection: request.witness.selection.declared,
      },
    };
    try {
      const raw = await this.port.send(surface, request);
      const receipt = sendResultSchema.safeParse(raw);
      if (
        !receipt.success ||
        !same(receipt.data.binding, request.binding) ||
        receipt.data.operationId !== request.operationId ||
        receipt.data.evidenceId !== request.witness.evidenceId
      )
        return reply("unknown", "PHYSICAL_SEND_RECEIPT_INVALID");
      const current = this.current(surface, guard, request.deadlineMillis);
      const firstCID =
        current &&
        request.binding.phase === "home" &&
        current.binding.phase === "conversation" &&
        sameView(current.binding, request.binding) &&
        current.binding.url ===
          this.port.conversationUrl(current.binding.conversationId);
      if (
        !current ||
        (!same(current.binding, request.binding) &&
          !(receipt.data.state === "submitted" && firstCID))
      )
        return reply("unknown", "PHYSICAL_SEND_BINDING_LOST");
      // A one-click ACK may precede the correlated CID observation. Keep origin
      // Home here; only Observe can adopt actual provider identity once.
      return receipt.data;
    } catch {
      return reply("unknown", "PHYSICAL_SEND_UNCONFIRMED");
    } finally {
      this.mutating = false;
    }
  }

  private observationInput(
    input: Parameters<ChatGptPhysicalApi["observe"]>[0],
    guard: PhysicalGuard,
  ): {
    record: SubmissionRecord;
    surface: PhysicalSurface;
    page: PhysicalPageObservation;
  } | null {
    const parsed = boundSchema.safeParse(input);
    if (
      !parsed.success ||
      !this.submission ||
      parsed.data.operationId !== this.submission.submission.operationId ||
      !same(parsed.data.binding, this.submission.binding)
    )
      return null;
    const record = this.submission;
    const current = this.current(
      record.surface,
      guard,
      parsed.data.deadlineMillis,
    );
    if (!current || !sameView(current.binding, record.submission.originBinding))
      return null;
    const origin = record.submission.originBinding;
    if (
      !same(current.binding, record.binding) &&
      !(
        origin.phase === "home" &&
        record.binding.phase === "home" &&
        current.binding.phase === "conversation"
      )
    )
      return null;
    return {
      record,
      surface: current,
      page: {
        operationId: parsed.data.operationId,
        binding: current.binding,
        deadlineMillis: parsed.data.deadlineMillis,
        submission: record.submission,
        correlation: record.correlation,
      },
    };
  }

  async observe(
    input: Parameters<ChatGptPhysicalApi["observe"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["observe"]> {
    const owned = this.observationInput(input, guard);
    if (!owned) return refuse("PHYSICAL_OBSERVATION_UNBOUND");
    try {
      const raw = await this.port.observe(owned.surface, owned.page);
      if (this.submission !== owned.record)
        return refuse("PHYSICAL_OBSERVATION_STALE");
      const current = this.current(
        owned.surface,
        guard,
        owned.page.deadlineMillis,
      );
      if (!current || !same(current.binding, owned.surface.binding))
        return unknown("PHYSICAL_OBSERVATION_BINDING_LOST");
      const failed = failureSchema.safeParse(raw);
      if (failed.success) return failed.data;
      const receipt = rawObserveSchema.safeParse(raw);
      if (!receipt.success)
        return refuse("PHYSICAL_OBSERVATION_RECEIPT_INVALID");
      const result = receipt.data;
      if (
        !same(result.originBinding, owned.record.submission.originBinding) ||
        !same(result.binding, current.binding) ||
        !this.validCorrelation(owned.record, result.correlation, result.frame)
      )
        return refuse("PHYSICAL_CORRELATION_MISMATCH");
      if (
        result.binding.phase === "conversation" &&
        owned.record.binding.phase === "home" &&
        result.correlation.userTurnId === null
      )
        return refuse("PHYSICAL_PROVIDER_ID_UNPROVEN");
      owned.record.binding = structuredClone(result.binding);
      owned.record.correlation = structuredClone(result.correlation);
      if (owned.record.terminal && result.frame?.terminal !== true)
        return refuse("PHYSICAL_TERMINAL_MUTATED");
      owned.record.terminal = result.frame?.terminal === true;
      const selection: PhysicalSelectionEvidence = {
        declared: structuredClone(owned.record.submission.selection),
        observed: result.observed,
        observedAtMillis: this.now(),
        sourceProfile: result.sourceProfile,
      };
      return structuredClone({
        state: "observed" as const,
        originBinding: result.originBinding,
        binding: result.binding,
        correlation: result.correlation,
        frame: result.frame,
        selection,
      });
    } catch {
      return unknown("PHYSICAL_OBSERVATION_UNAVAILABLE");
    }
  }

  private validCorrelation(
    record: SubmissionRecord,
    correlation: PhysicalCorrelation,
    frame: z.infer<typeof PublicTurnFrameSchema> | null,
  ): boolean {
    if (
      record.correlation.userTurnId !== null &&
      correlation.userTurnId !== record.correlation.userTurnId
    )
      return false;
    if (
      record.correlation.replyId !== null &&
      correlation.replyId !== record.correlation.replyId
    )
      return false;
    if (
      correlation.userTurnId !== null &&
      (record.submission.baselineUserIds.includes(correlation.userTurnId) ||
        correlation.userTurnId === record.submission.previous?.userTurnId)
    )
      return false;
    if (
      correlation.replyId !== null &&
      (correlation.userTurnId === null ||
        correlation.replyId === record.submission.previous?.replyId)
    )
      return false;
    if (
      frame &&
      (frame.userId !== correlation.userTurnId ||
        frame.messages[0]?.id !== correlation.replyId ||
        correlation.userTurnId === null ||
        correlation.replyId === null)
    )
      return false;
    if (frame) {
      const parents = new Set([frame.userId]);
      for (const message of frame.messages) {
        if (
          parents.has(message.id) ||
          (message.parentId !== null &&
            message.parentId !== undefined &&
            !parents.has(message.parentId))
        )
          return false;
        parents.add(message.id);
      }
      if (frame.terminal && !this.fullTerminal(frame)) return false;
    }
    return frame !== null || correlation.replyId === null;
  }

  private fullTerminal(frame: z.infer<typeof PublicTurnFrameSchema>): boolean {
    return (
      frame.terminal &&
      frame.messages.length > 0 &&
      frame.messages.at(-1)?.channel === "answer" &&
      frame.messages.every(
        (message) =>
          message.complete &&
          message.text !== null &&
          (message.segments === undefined ||
            message.segments.every(
              (segment) => segment.complete && segment.text !== null,
            )),
      )
    );
  }

  async cancel(
    input: Parameters<ChatGptPhysicalApi["cancel"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["cancel"]> {
    const owned = this.observationInput(input, guard);
    if (!owned) return refuse("PHYSICAL_CANCEL_UNBOUND");
    if (this.mutating || owned.record.cancelAttempted)
      return unknown("PHYSICAL_CANCEL_ALREADY_ATTEMPTED");
    owned.record.cancelAttempted = true;
    this.mutating = true;
    try {
      const raw = await this.port.cancel(owned.surface, owned.page);
      if (this.submission !== owned.record)
        return unknown("PHYSICAL_CANCEL_STALE");
      const current = this.current(
        owned.surface,
        guard,
        owned.page.deadlineMillis,
      );
      if (!current || !same(current.binding, owned.surface.binding))
        return unknown("PHYSICAL_CANCEL_BINDING_LOST");
      const receipt = cancelSchema.safeParse(raw);
      if (!receipt.success) return unknown("PHYSICAL_CANCEL_RECEIPT_INVALID");
      const result = receipt.data;
      if (
        result.state === "confirmed-terminal" ||
        result.state === "already-terminal"
      ) {
        if (
          !same(result.proof.binding, current.binding) ||
          !this.fullTerminal(result.proof.frame) ||
          !this.validCorrelation(
            owned.record,
            result.proof.correlation,
            result.proof.frame,
          )
        )
          return unknown("PHYSICAL_CANCEL_TERMINAL_UNPROVEN");
        owned.record.correlation = structuredClone(result.proof.correlation);
        owned.record.binding = structuredClone(current.binding);
        owned.record.terminal = true;
      } else if ("binding" in result && !same(result.binding, current.binding))
        return unknown("PHYSICAL_CANCEL_BINDING_LOST");
      return structuredClone(result);
    } catch {
      return unknown("PHYSICAL_CANCEL_UNCONFIRMED");
    } finally {
      this.mutating = false;
    }
  }

  async dispose(
    input: Parameters<ChatGptPhysicalApi["dispose"]>[0],
    guard: PhysicalGuard,
  ): ReturnType<ChatGptPhysicalApi["dispose"]> {
    const parsed = boundSchema.safeParse(input);
    if (!parsed.success || this.mutating)
      return refuse("PHYSICAL_DISPOSE_INVALID");
    const request = parsed.data;
    const surface = this.capture(
      request.binding,
      guard,
      request.deadlineMillis,
    );
    if (!surface || this.disposed.has(surface.handle))
      return refuse("PHYSICAL_DISPOSE_UNBOUND");
    const view = {
      viewId: surface.binding.viewId,
      viewGeneration: surface.binding.viewGeneration,
      documentGeneration: surface.binding.documentGeneration,
      partition: surface.binding.partition,
    };
    this.disposed.add(surface.handle);
    this.mutating = true;
    try {
      await this.port.destroy(surface, request.deadlineMillis);
    } catch {
      /* Read back the same captured native object even after a throw. */
    } finally {
      this.mutating = false;
    }
    // Null route/snapshot is deliberately irrelevant to destruction proof.
    if (!safeGuard(guard, request.binding))
      return {
        state: "unconfirmed",
        view,
        code: "PHYSICAL_DISPOSE_AUTHORITY_LOST",
      };
    return surface.isDestroyed()
      ? { state: "destroyed", view, destroyedWebContentsId: view.viewId }
      : {
          state: "unconfirmed",
          view,
          code: "PHYSICAL_DESTRUCTION_UNCONFIRMED",
        };
  }
}
