import { createHash } from "node:crypto";
import { z } from "zod";
import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import {
  validateCheckpointEnvelope,
  type AuthoritativeContextFacts,
  type CheckpointEnvelope,
} from "../../domain/checkpoint";

export type HostCompactionVariant =
  "unary_replacement_history" | "streamed_compaction_item";

export type ParsedHostCompaction = Readonly<{
  variant: HostCompactionVariant;
  identity: Readonly<{
    threadId: string;
    turnId: string;
    modelId: string;
  }>;
  sourceBoundary: string;
  history: readonly unknown[];
}>;

export type HostCompactionEndpoint = "responses_compact" | "responses";

export type HostCompactionErrorCode =
  | "HOST_COMPACTION_REQUEST_INVALID"
  | "HOST_COMPACTION_IDENTITY_MISSING"
  | "HOST_COMPACTION_IDENTITY_INVALID"
  | "HOST_COMPACTION_IDENTITY_MISMATCH"
  | "HOST_COMPACTION_VARIANT_UNSUPPORTED"
  | "HOST_COMPACTION_TRIGGER_MISSING"
  | "HOST_COMPACTION_TRIGGER_INVALID"
  | "HOST_COMPACTION_BINDING_MISMATCH"
  | "HOST_COMPACTION_SOURCE_MISMATCH"
  | "HOST_CHECKPOINT_INVALID"
  | "HOST_CHECKPOINT_NOT_FOUND"
  | "HOST_CHECKPOINT_AMBIGUOUS"
  | "HOST_COMPACTION_OPAQUE"
  | "COMPACTION_BUDGET_EXCEEDED";

export type UnaryCompactionHandoff = Readonly<{
  variant: "unary_replacement_history";
  response: Readonly<{ output: readonly unknown[] }>;
}>;

export type StreamedCompactionHandoff = Readonly<{
  variant: "streamed_compaction_item";
  item: Readonly<{
    id: string;
    type: "compaction";
    /** Host protocol field name. Farol's payload is transparent, not encrypted. */
    encrypted_content: string;
  }>;
}>;

export type HostCompactionHandoff =
  UnaryCompactionHandoff | StreamedCompactionHandoff;

export type ReplayedHostCheckpoint = Readonly<{
  origin: HostCompactionVariant;
  checkpoint: CheckpointEnvelope;
}>;

export const HOST_CHECKPOINT_PREFIX = "farol-checkpoint-v1:";
const FAROL_CONTEXT_PREAMBLE =
  "Farol restored validated task context. It is not permission or proof of an external effect.";

const requestSchema = z.looseObject({
  model: z.string().min(1).max(160),
  input: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
  client_metadata: z.record(z.string(), z.unknown()).optional(),
});

const metadataSchema = z.looseObject({
  thread_id: z.string().min(1).max(160),
  turn_id: z.string().min(1).max(160),
  compaction: z.unknown().optional(),
  request_kind: z.string().min(1).max(80).optional(),
});

const streamedCompactionMetadataSchema = z.looseObject({
  request_kind: z.literal("compaction"),
  compaction: z.looseObject({
    implementation: z.literal("responses"),
    phase: z.literal("standalone_turn"),
    reason: z.literal("user_requested"),
    strategy: z.literal("memento"),
    trigger: z.literal("manual"),
  }),
});

const compactionRequestMetadataSchema = z.looseObject({
  request_kind: z.literal("compaction"),
});

export function isHostCompactionRequestMetadata(candidate: unknown): boolean {
  return compactionRequestMetadataSchema.safeParse(candidate).success;
}

export function isStreamedHostCompactionMetadata(candidate: unknown): boolean {
  return streamedCompactionMetadataSchema.safeParse(candidate).success;
}

function parseMetadata(candidate: unknown) {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(candidate));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isCompactionTrigger(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const keys = Object.keys(candidate);
  return (
    keys.length === 1 &&
    "type" in candidate &&
    candidate.type === "compaction_trigger"
  );
}

// Only the public summary emitted by the semantic stream is portable. Do
// not accept hidden reasoning, an opaque payload, or extra effect fields.
const publicStatusSchema = z.strictObject({
  type: z.literal("reasoning"),
  id: z.string().min(1).max(256).optional(),
  summary: z
    .array(
      z.strictObject({
        type: z.literal("summary_text"),
        text: z.string().max(256 * 1_024),
      }),
    )
    .max(512),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
});

const customToolHistorySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("custom_tool_call"),
    id: z.string().min(1).max(256).optional(),
    call_id: z.string().min(1).max(160),
    name: z.string().min(1).max(160),
    input: z.string(),
    status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  }),
  z.strictObject({
    type: z.literal("custom_tool_call_output"),
    id: z.string().min(1).max(256).optional(),
    call_id: z.string().min(1).max(160),
    output: z.string(),
  }),
]);

function isTransparentHistoryItem(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const item = candidate as Record<string, unknown>;
  if (item.type === "reasoning")
    return publicStatusSchema.safeParse(item).success;
  if (
    item.type === "custom_tool_call" ||
    item.type === "custom_tool_call_output"
  ) {
    return customToolHistorySchema.safeParse(item).success;
  }
  if (item.type === undefined) {
    return (
      (item.role === "user" || item.role === "assistant") && "content" in item
    );
  }
  if (
    item.type === "message" ||
    item.type === "function_call" ||
    item.type === "function_call_output"
  ) {
    return true;
  }
  return (
    item.type === "compaction" &&
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.startsWith(HOST_CHECKPOINT_PREFIX)
  );
}

function sourceBoundary(
  variant: HostCompactionVariant,
  threadId: string,
  turnId: string,
  modelId: string,
  history: readonly unknown[],
): string {
  const value = JSON.stringify({
    variant,
    threadId,
    turnId,
    modelId,
    history,
  });
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function parseHostCompactionRequest(
  endpoint: HostCompactionEndpoint,
  candidate: unknown,
  metadataHeader: string | undefined,
): Result<ParsedHostCompaction, HostCompactionErrorCode> {
  const parsed = requestSchema.safeParse(candidate);
  if (!parsed.success) return failure("HOST_COMPACTION_REQUEST_INVALID");
  const embeddedMetadata =
    parsed.data.client_metadata?.["x-codex-turn-metadata"];
  const headerIdentity = parseMetadata(metadataHeader);
  const embeddedIdentity = parseMetadata(embeddedMetadata);
  if (!metadataHeader && embeddedMetadata === undefined) {
    return failure("HOST_COMPACTION_IDENTITY_MISSING");
  }
  if (
    (metadataHeader && !headerIdentity) ||
    (embeddedMetadata !== undefined && !embeddedIdentity)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_INVALID");
  }
  if (
    headerIdentity &&
    embeddedIdentity &&
    (headerIdentity.thread_id !== embeddedIdentity.thread_id ||
      headerIdentity.turn_id !== embeddedIdentity.turn_id)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_MISMATCH");
  }
  const identity = headerIdentity ?? embeddedIdentity;
  if (!identity) return failure("HOST_COMPACTION_IDENTITY_MISSING");
  const outerThreadId = parsed.data.client_metadata?.thread_id;
  const outerTurnId = parsed.data.client_metadata?.turn_id;
  if (
    (typeof outerThreadId === "string" &&
      outerThreadId !== identity.thread_id) ||
    (typeof outerTurnId === "string" && outerTurnId !== identity.turn_id)
  ) {
    return failure("HOST_COMPACTION_IDENTITY_MISMATCH");
  }

  let variant: HostCompactionVariant;
  let history: readonly unknown[];
  if (endpoint === "responses_compact") {
    if (parsed.data.stream === true) {
      return failure("HOST_COMPACTION_VARIANT_UNSUPPORTED");
    }
    if (parsed.data.input.some(isCompactionTrigger)) {
      return failure("HOST_COMPACTION_TRIGGER_INVALID");
    }
    variant = "unary_replacement_history";
    history = parsed.data.input;
  } else {
    if (parsed.data.stream !== true) {
      return failure("HOST_COMPACTION_VARIANT_UNSUPPORTED");
    }
    const last = parsed.data.input.at(-1);
    const explicitTrigger = isCompactionTrigger(last);
    const metadataTrigger =
      isStreamedHostCompactionMetadata(headerIdentity) ||
      isStreamedHostCompactionMetadata(embeddedIdentity);
    // Both carriers may be present, but one must not contradict the other
    // about the operation this request represents. Unknown automatic/native
    // forms remain unsupported; a manual declaration cannot mask one.
    if (
      headerIdentity &&
      embeddedIdentity &&
      (headerIdentity.request_kind !== undefined ||
        headerIdentity.compaction !== undefined) &&
      (embeddedIdentity.request_kind !== undefined ||
        embeddedIdentity.compaction !== undefined) &&
      (headerIdentity.request_kind !== embeddedIdentity.request_kind ||
        isStreamedHostCompactionMetadata(headerIdentity) !==
          isStreamedHostCompactionMetadata(embeddedIdentity))
    ) {
      return failure("HOST_COMPACTION_IDENTITY_MISMATCH");
    }
    if (!explicitTrigger && !metadataTrigger) {
      return failure("HOST_COMPACTION_TRIGGER_MISSING");
    }
    history = explicitTrigger
      ? parsed.data.input.slice(0, -1)
      : parsed.data.input;
    if (history.some(isCompactionTrigger)) {
      return failure("HOST_COMPACTION_TRIGGER_INVALID");
    }
    variant = "streamed_compaction_item";
  }

  if (!history.every(isTransparentHistoryItem)) {
    return failure("HOST_COMPACTION_OPAQUE");
  }

  const exactHistory = structuredClone(history);
  return success({
    variant,
    identity: {
      threadId: identity.thread_id,
      turnId: identity.turn_id,
      modelId: parsed.data.model,
    },
    sourceBoundary: sourceBoundary(
      variant,
      identity.thread_id,
      identity.turn_id,
      parsed.data.model,
      exactHistory,
    ),
    history: exactHistory,
  });
}

function transportCheckpoint(checkpoint: CheckpointEnvelope): string {
  return `${HOST_CHECKPOINT_PREFIX}${Buffer.from(
    JSON.stringify(checkpoint),
    "utf8",
  ).toString("base64url")}`;
}

function hostCompactionItemId(checkpoint: CheckpointEnvelope): string {
  return `cmp_${createHash("sha256")
    .update(checkpoint.checkpointId)
    .update("\0")
    .update(checkpoint.sourceBoundary)
    .digest("hex")
    .slice(0, 32)}`;
}

function decodeTransportCheckpoint(
  encoded: string,
  maximumContentBytes: number,
): Result<CheckpointEnvelope, HostCompactionErrorCode> {
  if (!encoded.startsWith(HOST_CHECKPOINT_PREFIX)) {
    return failure("HOST_COMPACTION_OPAQUE");
  }
  const payload = encoded.slice(HOST_CHECKPOINT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) {
    return failure("HOST_CHECKPOINT_INVALID");
  }
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) {
      return failure("HOST_CHECKPOINT_INVALID");
    }
    const parsed = validateCheckpointEnvelope(
      JSON.parse(bytes.toString("utf8")),
      maximumContentBytes,
    );
    return parsed.ok
      ? success(parsed.value)
      : failure("HOST_CHECKPOINT_INVALID");
  } catch {
    return failure("HOST_CHECKPOINT_INVALID");
  }
}

function messageText(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return "";
  }
  if (!("content" in candidate)) return "";
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return "";
  return candidate.content
    .filter((block): block is { text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        "text" in block &&
        typeof block.text === "string",
      ),
    )
    .map((block) => block.text)
    .join("");
}

function isRetainableUserMessage(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const item = candidate as Record<string, unknown>;
  if (item.role !== "user") return false;
  if (item.type !== undefined && item.type !== "message") return false;
  const text = messageText(item).trim();
  if (text.includes(HOST_CHECKPOINT_PREFIX)) return false;
  if (
    /^<codex_internal_context\b[\s\S]*<\/codex_internal_context>$/u.test(
      text,
    ) ||
    /^<goal_context>[\s\S]*<\/goal_context>$/u.test(text)
  ) {
    return false;
  }
  return true;
}

function retainedUserTail(
  history: readonly unknown[],
  maximumBytes: number,
): Result<readonly unknown[], HostCompactionErrorCode> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    return failure("COMPACTION_BUDGET_EXCEEDED");
  }
  const messages = history.filter(isRetainableUserMessage);
  const selected: unknown[] = [];
  let remaining = maximumBytes;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > remaining) {
      if (selected.length === 0) {
        return failure("COMPACTION_BUDGET_EXCEEDED");
      }
      break;
    }
    remaining -= bytes;
    selected.push(structuredClone(message));
  }
  selected.reverse();
  return success(selected);
}

function summaryMessage(checkpoint: CheckpointEnvelope): unknown {
  const marker = transportCheckpoint(checkpoint);
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `${FAROL_CONTEXT_PREAMBLE}\n${marker}\n${JSON.stringify(checkpoint.content, null, 2)}`,
      },
    ],
  };
}

const CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
]);

// A result is cited either by its call ID or, for a tool that answers with a
// receipt token, by that exact token.
function receiptToken(output: unknown): string | null {
  return typeof output === "string" && /^[^\s]{1,160}$/u.test(output)
    ? output
    : null;
}

/**
 * What the host's record proves about tool effects, independent of a model
 * summary. After a compaction the older effects survive only in the previous
 * validated checkpoint, which was itself reconciled when it was made, so its
 * receipts and unknown outcomes carry forward: a later summary can neither
 * cite a receipt nothing proves nor quietly forget an unknown effect.
 */
export function authoritativeHistoryFacts(
  history: readonly unknown[],
  maximumCheckpointContentBytes: number,
): AuthoritativeContextFacts {
  const receipts = new Set<string>();
  const unresolved = new Map<string, string>();
  const carriedWork: AuthoritativeContextFacts["carriedWork"][number][] = [];
  const previous = replayHostCheckpoint(history, maximumCheckpointContentBytes);
  if (previous.ok) {
    const content = previous.value.checkpoint.content;
    for (const item of content.completedWork) {
      for (const ref of item.evidenceRefs) receipts.add(ref);
      if (item.evidenceRefs.length > 0) carriedWork.push(item);
    }
    for (const entry of content.unknownOutcomes) {
      unresolved.set(entry.operationRef, entry.description);
    }
  }
  const calls = new Map<string, string>();
  const delivered = new Set<string>();
  for (const candidate of history) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    if (CALL_TYPES.has(String(item.type))) {
      calls.set(
        item.call_id,
        typeof item.name === "string" && item.name.length > 0
          ? item.name.slice(0, 160)
          : "A tool",
      );
    } else if (OUTPUT_TYPES.has(String(item.type))) {
      delivered.add(item.call_id);
      receipts.add(item.call_id.slice(0, 512));
      const token = receiptToken(item.output);
      if (token !== null) receipts.add(token);
    }
  }
  // An earlier checkpoint's unknown outcome ends when its result arrives.
  for (const callId of delivered) unresolved.delete(callId.slice(0, 160));
  for (const [callId, name] of calls) {
    if (delivered.has(callId) || unresolved.has(callId.slice(0, 160))) continue;
    unresolved.set(
      callId.slice(0, 160),
      `${name} was called but no result was delivered before compaction.`,
    );
  }
  return {
    receipts: [...receipts],
    carriedWork,
    unresolved: [...unresolved].map(([operationRef, description]) => ({
      operationRef,
      description,
    })),
  };
}

export function renderTrustedCheckpointContext(
  checkpoint: CheckpointEnvelope,
): string {
  return `${FAROL_CONTEXT_PREAMBLE}\n${JSON.stringify(checkpoint.content, null, 2)}`;
}

// The next ordinary prompt after a replacement: the rendered checkpoint the
// provider supplies as trusted context, plus the retained user messages the
// host sends again (the streamed variant keeps its own history).
function nextPromptCharacters(
  checkpoint: CheckpointEnvelope,
  retainedTail: readonly unknown[],
): number {
  return [
    renderTrustedCheckpointContext(checkpoint),
    ...retainedTail.map((message) => messageText(message)),
  ].join("\n\n").length;
}

export function buildHostCompactionHandoff(
  request: ParsedHostCompaction,
  candidate: unknown,
  options: Readonly<{
    maximumCheckpointContentBytes: number;
    retainedTailMaximumBytes: number;
    maximumHandoffBytes: number;
    // A replacement that fits the handoff but leaves no room for the next
    // prompt would fail on the next turn, so it is refused here instead of
    // being summarized again.
    maximumNextPromptCharacters?: number;
  }>,
): Result<HostCompactionHandoff, HostCompactionErrorCode> {
  if (
    !Number.isSafeInteger(options.maximumHandoffBytes) ||
    options.maximumHandoffBytes < 1
  ) {
    return failure("COMPACTION_BUDGET_EXCEEDED");
  }
  const parsed = validateCheckpointEnvelope(
    candidate,
    options.maximumCheckpointContentBytes,
  );
  if (!parsed.ok) return failure("HOST_CHECKPOINT_INVALID");
  const checkpoint = parsed.value;
  if (
    checkpoint.binding.hostThreadId !== request.identity.threadId ||
    checkpoint.binding.modelId !== request.identity.modelId
  ) {
    return failure("HOST_COMPACTION_BINDING_MISMATCH");
  }
  if (checkpoint.sourceBoundary !== request.sourceBoundary) {
    return failure("HOST_COMPACTION_SOURCE_MISMATCH");
  }
  const fitsNextPrompt = (retainedTail: readonly unknown[]) =>
    options.maximumNextPromptCharacters === undefined ||
    nextPromptCharacters(checkpoint, retainedTail) <=
      options.maximumNextPromptCharacters;
  if (request.variant === "streamed_compaction_item") {
    if (!fitsNextPrompt([])) return failure("COMPACTION_BUDGET_EXCEEDED");
    const handoff: HostCompactionHandoff = {
      variant: request.variant,
      item: {
        id: hostCompactionItemId(checkpoint),
        type: "compaction",
        encrypted_content: transportCheckpoint(checkpoint),
      },
    };
    return Buffer.byteLength(JSON.stringify(handoff), "utf8") <=
      options.maximumHandoffBytes
      ? success(handoff)
      : failure("COMPACTION_BUDGET_EXCEEDED");
  }
  const retained = retainedUserTail(
    request.history,
    options.retainedTailMaximumBytes,
  );
  if (!retained.ok) return retained;
  if (!fitsNextPrompt(retained.value)) {
    return failure("COMPACTION_BUDGET_EXCEEDED");
  }
  const handoff: HostCompactionHandoff = {
    variant: request.variant,
    response: {
      output: [...retained.value, summaryMessage(checkpoint)],
    },
  };
  return Buffer.byteLength(JSON.stringify(handoff), "utf8") <=
    options.maximumHandoffBytes
    ? success(handoff)
    : failure("COMPACTION_BUDGET_EXCEEDED");
}

export function replayHostCheckpoint(
  input: readonly unknown[],
  maximumCheckpointContentBytes: number,
): Result<ReplayedHostCheckpoint, HostCompactionErrorCode> {
  const candidates: ReplayedHostCheckpoint[] = [];
  let opaque = false;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (
      "type" in item &&
      item.type === "compaction" &&
      "encrypted_content" in item &&
      typeof item.encrypted_content === "string"
    ) {
      const decoded = decodeTransportCheckpoint(
        item.encrypted_content,
        maximumCheckpointContentBytes,
      );
      if (!decoded.ok) {
        if (decoded.error.code === "HOST_COMPACTION_OPAQUE") opaque = true;
        else return decoded;
      } else {
        candidates.push({
          origin: "streamed_compaction_item",
          checkpoint: decoded.value,
        });
      }
      continue;
    }
    const markers = messageText(item)
      .split("\n")
      .filter((line) => line.startsWith(HOST_CHECKPOINT_PREFIX));
    for (const marker of markers) {
      const decoded = decodeTransportCheckpoint(
        marker,
        maximumCheckpointContentBytes,
      );
      if (!decoded.ok) return decoded;
      candidates.push({
        origin: "unary_replacement_history",
        checkpoint: decoded.value,
      });
    }
  }
  if (opaque) return failure("HOST_COMPACTION_OPAQUE");
  if (candidates.length === 0) return failure("HOST_CHECKPOINT_NOT_FOUND");
  if (candidates.length !== 1) return failure("HOST_CHECKPOINT_AMBIGUOUS");
  return success(candidates[0]!);
}
