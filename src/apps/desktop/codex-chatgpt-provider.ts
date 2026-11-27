import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Result } from "../../pkg/kernel/domain/result";
import {
  HOST_CHECKPOINT_PREFIX,
  isHostCompactionRequestMetadata,
  type HostCompactionEndpoint,
  type HostCompactionErrorCode,
  type HostCompactionHandoff,
} from "../../modules/chat/infra/client/host-compaction-codec";
import {
  canonicalJson,
  CodexNativeToolRegistry,
  type CodexNativeToolRequest,
  type ResolvedCodexNativeToolCall,
} from "./codex-native-tool-registry";
import type {
  ProviderTurnAdmission,
  ProviderTurnJournal,
} from "./provider-turn-journal";
import type { VisibleOutputItem } from "./chatgpt-visible-output";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../../pkg/model-route/contract";

import {
  currentCallEntry,
  currentCallPrefix,
  deferred,
  digest,
  turnKey,
  turnTag,
  type Deferred,
} from "../../../apps/desktop/provider/identity.ts";
import { ResponseRound } from "../../../apps/desktop/provider/round.ts";
import {
  authorized,
  json,
  readBody,
  refusal,
  startStream,
  writeEvent,
} from "../../../apps/desktop/provider/http.ts";
import {
  compactionMetadataHeader,
  compactionEvents,
  streamedCompactionRequestWith,
} from "../../../apps/desktop/provider/compaction.ts";
import { validateContinuation } from "../../../apps/desktop/provider/continuation.ts";
import {
  admissionCode,
  continuationCode,
  goRefusal,
  toolCatalogueCode,
} from "../../../apps/desktop/provider/outcome.ts";
import {
  bindingFingerprint,
  identityFromRequest,
  responseRequestSchema,
  type ResponseRequest,
} from "../../../apps/desktop/provider/request.ts";
import {
  textDeltaSchema,
  visibleItemSchema,
} from "../../../apps/desktop/provider/stream.ts";
import { modelCatalogue } from "../../../apps/desktop/provider/catalogue.ts";
export { modelCatalogue };
import {
  MAX_PROMPT_CHARACTERS,
  promptFromInput,
} from "../../../apps/desktop/provider/prompt.ts";
export { MAX_PROMPT_CHARACTERS };
import {
  compactionMarkerKind,
  compactionMarkerShape,
  inputContentKinds,
  inputKinds,
  inputRoles,
  metadataKeys,
  record,
  requestKindCompaction,
  requestKindShape,
  toolNames,
  turnMetadataKeys,
} from "../../../apps/desktop/provider/shape.ts";
import {
  extractGoChatRequestSelection,
  goChatRequestIntentSHA256,
  type GoChatRequestSelection,
  type GoChatResponses,
  type GoChatPreparedInput,
} from "../../../apps/desktop/go-chat-responses.ts";

// The longest prompt a Route B turn sends into one ChatGPT message.
export function streamedCompactionRequest(
  candidate: unknown,
  metadataHeader?: string,
): boolean {
  return streamedCompactionRequestWith(
    isHostCompactionRequestMetadata,
    candidate,
    metadataHeader,
  );
}

const MAX_ACTIVE_TURNS = 8;
const TURN_LIFETIME_MS = 15 * 60 * 1_000;

export type CodexChatGptTextDelta = Readonly<{
  sequence: number;
  delta: string;
  text: string;
  observedCharacters: number;
}>;

export type CodexChatGptTurnInput = Readonly<{
  requestedModel: string;
  prompt: string;
  identity: Readonly<{
    sessionId: string;
    threadId: string;
    turnId: string;
    rootTurnId: string;
  }>;
  tools: readonly unknown[];
}>;

export type CodexChatGptConversationResult = Readonly<{
  state: "completed" | "failed_before_submit" | "outcome_unknown";
  code: string | null;
  outputText: string;
  observedProvider: string | null;
  observedModel: string | null;
  observedMode: string | null;
}>;

export type CodexChatGptConversation = Readonly<{
  run(
    input: CodexChatGptTurnInput,
    observer: Readonly<{
      onTextDelta(delta: CodexChatGptTextDelta): void | Promise<void>;
      onVisibleItem?(item: VisibleOutputItem): void | Promise<void>;
      onToolCall(request: CodexNativeToolRequest): Promise<string>;
    }>,
  ): Promise<CodexChatGptConversationResult>;
}>;

export type CodexChatGptCompactionErrorCode =
  | HostCompactionErrorCode
  | "FAROL_COMPACTION_SOURCE_STORE_FAILED"
  | "FAROL_COMPACTION_SOURCE_UNAVAILABLE"
  | "FAROL_COMPACTION_SUMMARY_BLOCKED"
  | "FAROL_COMPACTION_SUMMARY_OUTCOME_UNKNOWN"
  | "FAROL_COMPACTION_STATE_FAILED"
  | "FAROL_COMPACTION_RECONCILIATION_FAILED"
  | "FAROL_COMPACTION_TURN_ACTIVE";

export type CodexChatGptCompaction = Readonly<{
  compact(
    input: Readonly<{
      endpoint: HostCompactionEndpoint;
      body: unknown;
      metadataHeader: string | undefined;
    }>,
  ): Promise<Result<HostCompactionHandoff, CodexChatGptCompactionErrorCode>>;
  // `delivered` is called once the turn carrying `trustedContext` completed
  // in the conversation, so the same checkpoint is not sent again.
  prepareTurn?(
    input: Readonly<{ body: unknown }>,
  ): Promise<
    Result<
      Readonly<{ trustedContext: string | null; delivered?: () => void }>,
      CodexChatGptCompactionErrorCode
    >
  >;
}>;

export type CodexChatGptProviderRuntime = Readonly<{
  providerId: typeof FAROL_PROVIDER_ID;
  model: string;
  port: number;
  baseUrl: string;
  diagnostics(): Readonly<{
    modelRequests: number;
    responseRequests: number;
    unauthorizedRequests: number;
    failedRequests: number;
    activeTurns: number;
    toolCalls: number;
    compactionRequests: number;
    lastRefusalCode: string | null;
    lastInputKinds: readonly string[];
    lastInputRoles: readonly string[];
    lastInputContentKinds: readonly string[];
    lastToolNames: readonly string[];
    lastMetadataKeys: readonly string[];
    lastTurnMetadataKeys: readonly string[];
    lastCompactionMarkerKind: string;
    lastCompactionMarkerShape: readonly string[];
    lastRequestKindCompaction: boolean;
    lastRequestKindShape: readonly string[];
  }>;
  close(): Promise<void>;
}>;

type ProviderOptions = Readonly<{
  model: string;
  token: string;
  conversation?: CodexChatGptConversation;
  // Selected once at startup, before any ActiveProviderTurn is constructed.
  goResponses?: GoChatResponses;
  compaction?: CodexChatGptCompaction;
  // Durable identity of every admitted initial request; see EV-05 in
  // handleResponses.
  turns: ProviderTurnJournal;
  // Marks the thread of an initial request as in use from before its context
  // is prepared until its first round has been served, which is after its
  // durable admission and the start of its conversation run, or until the
  // request is refused first. Releasing twice is harmless.
  threads?: Readonly<{
    hold(identity: CodexChatGptTurnInput["identity"]): (() => void) | null;
  }>;
}>;

type IssuedToolCall = ResolvedCodexNativeToolCall & {
  callId: string;
  itemId: string;
  result: Deferred<string>;
  outputCanonical: string | null;
};

type TurnEvent =
  | Readonly<{ kind: "tool"; call: IssuedToolCall }>
  | Readonly<{
      kind: "visible";
      item: VisibleOutputItem;
      delivered: Deferred<void>;
    }>
  | Readonly<{
      kind: "final";
      result: CodexChatGptConversationResult | null;
      code: string | null;
    }>;

class ActiveProviderTurn {
  readonly key: string;
  readonly tag: string;
  private readonly binding: string;
  private readonly registry: CodexNativeToolRegistry;
  private readonly events: TurnEvent[] = [];
  private readonly issued = new Map<string, IssuedToolCall>();
  private waiter: Deferred<TurnEvent> | null = null;
  private writer: ResponseRound | null = null;
  private pending: IssuedToolCall | null = null;
  private sequence = 0;
  private text = "";
  private streamMode: "unset" | "text" | "visible" = "unset";
  private readonly visibleIds = new Set<string>();
  private readonly visibleDeliveries = new Set<Deferred<void>>();
  private visibleCharacters = 0;
  private streamFailure: Error | null = null;
  private state: "created" | "running" | "ended" = "created";
  private readonly lifetime: NodeJS.Timeout;

  constructor(
    data: ResponseRequest,
    private readonly input: CodexChatGptTurnInput,
    private readonly conversation: CodexChatGptConversation,
    private readonly onToolCallObserved: () => void,
    private readonly onTerminal: () => void,
    // Learns how the conversation run ended before the host hears it, so a
    // repeat sent the moment the host learns cannot race the bookkeeping.
    private readonly onSettled: (
      state: CodexChatGptConversationResult["state"],
    ) => Promise<void> = async () => undefined,
  ) {
    this.key = turnKey(input.identity);
    this.tag = turnTag(input.identity);
    this.binding = bindingFingerprint(data);
    this.registry = CodexNativeToolRegistry.parse(data.tools);
    this.lifetime = setTimeout(
      () => this.cancel("FAROL_TURN_EXPIRED"),
      TURN_LIFETIME_MS,
    );
    this.lifetime.unref?.();
  }

  hasContinuation(data: ResponseRequest): boolean {
    return (
      Array.isArray(data.input) &&
      data.input.some((entry) => currentCallEntry(entry, this.tag))
    );
  }

  ownsForeignContinuation(data: ResponseRequest): boolean {
    if (!Array.isArray(data.input)) return false;
    return data.input.some(
      (entry) =>
        record(entry) &&
        typeof entry.call_id === "string" &&
        this.issued.has(entry.call_id),
    );
  }

  async serveInitial(response: ServerResponse): Promise<boolean> {
    if (this.state !== "created") throw new Error("FAROL_TURN_STATE_INVALID");
    let writer: ResponseRound;
    try {
      writer = await this.attach(response);
    } catch (error) {
      // The host went away before the conversation run was started.
      await this.onSettled("failed_before_submit");
      throw error;
    }
    this.state = "running";
    void Promise.resolve()
      .then(() =>
        this.conversation.run(this.input, {
          onTextDelta: (delta) => this.observeDelta(delta),
          onVisibleItem: (item) => this.observeVisibleItem(item),
          onToolCall: (request) => this.requestTool(request),
        }),
      )
      .then(async (result) => {
        // A source adapter may accidentally catch an observer rejection.
        // That cannot turn a damaged stream into successful durable state.
        const invalidResult =
          (result.state === "completed" && !this.validCompletion(result)) ||
          (result.state === "failed_before_submit" &&
            (this.sequence > 0 || this.issued.size > 0));
        const code =
          this.streamFailure?.message ??
          (invalidResult ? "FAROL_PROVIDER_RESULT_INVALID" : null);
        const settled: CodexChatGptConversationResult = code
          ? { ...result, state: "outcome_unknown", code }
          : result;
        await this.onSettled(settled.state);
        this.push({ kind: "final", result: settled, code });
      })
      .catch(() =>
        this.push({
          kind: "final",
          result: null,
          code: "FAROL_CONVERSATION_FAILED",
        }),
      );
    return this.finishRound(writer);
  }

  async serveContinuation(
    response: ServerResponse,
    data: ResponseRequest,
  ): Promise<boolean> {
    const delivery = this.validateContinuation(data);
    const writer = await this.attach(response);
    const pending = this.pending;
    if (!pending || pending.callId !== delivery.callId) {
      this.detach(writer);
      throw new Error("FAROL_CONTINUATION_INVALID");
    }
    pending.outputCanonical = delivery.outputCanonical;
    this.pending = null;
    pending.result.resolve(delivery.output);
    return this.finishRound(writer);
  }

  cancel(code: string): void {
    if (this.state === "ended") return;
    this.state = "ended";
    clearTimeout(this.lifetime);
    this.pending?.result.reject(new Error(code));
    this.pending = null;
    for (const delivery of this.visibleDeliveries) {
      delivery.reject(new Error(code));
    }
    this.visibleDeliveries.clear();
    // A blocked stream may still be draining. No queued display or tool call
    // survives cancellation; completeTool also fences already-dequeued calls
    // after every awaited write before any further executable output.
    this.events.length = 0;
    this.push({ kind: "final", result: null, code });
    this.onTerminal();
  }

  private async attach(response: ServerResponse): Promise<ResponseRound> {
    if (this.writer || this.state === "ended") {
      throw new Error("FAROL_TURN_STATE_INVALID");
    }
    const writer = new ResponseRound(response, this.input.requestedModel);
    this.writer = writer;
    await writer.open();
    return writer;
  }

  private detach(writer: ResponseRound): void {
    if (this.writer === writer) this.writer = null;
  }

  private async finishRound(writer: ResponseRound): Promise<boolean> {
    try {
      let event = await this.next();
      while (event.kind === "visible") {
        try {
          if (this.state === "ended") {
            throw new Error("FAROL_HOST_DELIVERY_LOST");
          }
          await writer.visible(event.item);
          event.delivered.resolve();
        } catch (error) {
          event.delivered.reject(
            error instanceof Error
              ? error
              : new Error("FAROL_HOST_DELIVERY_LOST"),
          );
          throw error;
        } finally {
          this.visibleDeliveries.delete(event.delivered);
        }
        event = await this.next();
      }
      if (event.kind === "tool") {
        const call = event.call;
        await writer.completeTool(
          call,
          () =>
            this.state === "running" &&
            this.streamFailure === null &&
            this.pending === call,
        );
        return false;
      }
      const valid = event.result !== null && this.validCompletion(event.result);
      if (valid) await writer.completeFinal();
      else {
        await writer.fail(
          this.streamFailure?.message ??
            event.code ??
            event.result?.code ??
            "FAROL_PROVIDER_RESULT_INVALID",
        );
      }
      this.state = "ended";
      clearTimeout(this.lifetime);
      this.onTerminal();
      return true;
    } finally {
      this.detach(writer);
    }
  }

  private validCompletion(result: CodexChatGptConversationResult): boolean {
    return (
      this.state === "running" &&
      this.streamFailure === null &&
      result.state === "completed" &&
      result.code === null &&
      result.outputText === this.text &&
      this.text.length > 0 &&
      this.pending === null
    );
  }

  private failStream(): never {
    this.streamFailure ??= new Error("FAROL_PROVIDER_STREAM_INVALID");
    throw this.streamFailure;
  }

  private async observeDelta(input: CodexChatGptTextDelta): Promise<void> {
    if (this.streamFailure) throw this.streamFailure;
    const parsed = textDeltaSchema.safeParse(input);
    if (!parsed.success) this.failStream();
    const delta = parsed.data;
    if (
      this.state !== "running" ||
      this.streamMode === "visible" ||
      delta.sequence !== this.sequence + 1 ||
      delta.observedCharacters !== delta.text.length ||
      delta.text !== `${this.text}${delta.delta}` ||
      !this.writer
    ) {
      this.failStream();
    }
    this.streamMode = "text";
    this.sequence = delta.sequence;
    this.text = delta.text;
    await this.writer.delta(delta.delta);
  }

  private async observeVisibleItem(input: VisibleOutputItem): Promise<void> {
    if (this.streamFailure) throw this.streamFailure;
    const parsed = visibleItemSchema.safeParse(input);
    if (!parsed.success) this.failStream();
    const item = parsed.data;
    const separator = this.visibleIds.size > 0 ? 2 : 0;
    if (
      this.state !== "running" ||
      this.streamMode === "text" ||
      item.sequence !== this.sequence + 1 ||
      this.visibleIds.has(item.id) ||
      this.visibleIds.size >= 512 ||
      this.visibleCharacters + item.text.length + separator > 256 * 1_024
    ) {
      this.failStream();
    }
    this.streamMode = "visible";
    this.sequence = item.sequence;
    this.visibleIds.add(item.id);
    this.visibleCharacters += item.text.length + separator;
    if (item.channel === "answer") {
      this.text += `${this.text ? "\n\n" : ""}${item.text}`;
    }
    // Display observations and actual tool requests share the same ordered
    // queue. A status arriving while Codex executes a tool waits for the next
    // response round; it cannot interleave SSE writes or execute that tool.
    const delivered = deferred<void>();
    this.visibleDeliveries.add(delivered);
    this.push({ kind: "visible", item, delivered });
    await delivered.promise;
  }

  private async requestTool(request: CodexNativeToolRequest): Promise<string> {
    if (this.streamFailure) throw this.streamFailure;
    if (this.state !== "running" || this.pending !== null) {
      throw new Error("FAROL_TOOL_CALL_STATE_INVALID");
    }
    const resolved = this.registry.resolve(request);
    const callId = `${currentCallPrefix(this.tag)}${randomBytes(8).toString("hex")}`;
    const call: IssuedToolCall = {
      ...resolved,
      callId,
      itemId: `fc_${randomUUID()}`,
      result: deferred<string>(),
      outputCanonical: null,
    };
    this.issued.set(callId, call);
    this.pending = call;
    this.onToolCallObserved();
    this.push({ kind: "tool", call });
    return call.result.promise;
  }

  private validateContinuation(data: ResponseRequest): Readonly<{
    callId: string;
    output: string;
    outputCanonical: string;
  }> {
    if (this.state !== "running" || !this.pending) {
      throw new Error("FAROL_CONTINUATION_STATE_INVALID");
    }
    return validateContinuation(data, {
      key: this.key,
      tag: this.tag,
      binding: this.binding,
      issued: this.issued,
      pending: this.pending,
    });
  }

  private push(event: TurnEvent): void {
    if (this.state === "ended" && event.kind !== "final") return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter.resolve(event);
    } else {
      this.events.push(event);
    }
  }

  private next(): Promise<TurnEvent> {
    const event = this.events.shift();
    if (event) return Promise.resolve(event);
    if (this.waiter) throw new Error("FAROL_TURN_STATE_INVALID");
    this.waiter = deferred<TurnEvent>();
    return this.waiter.promise;
  }
}

async function handleResponses(
  raw: unknown,
  response: ServerResponse,
  options: ProviderOptions,
  turns: Map<string, ActiveProviderTurn>,
  onToolCallObserved: () => void,
  onRefusal: (code: string) => void,
): Promise<void> {
  const parsed = responseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    onRefusal("FAROL_REQUEST_INVALID");
    refusal(response, 400, "FAROL_REQUEST_INVALID");
    return;
  }
  if (parsed.data.model !== options.model) {
    refusal(response, 422, "FAROL_MODEL_UNAVAILABLE");
    return;
  }
  const identity = identityFromRequest(parsed.data);
  const key = turnKey(identity);
  if (options.goResponses) {
    try {
      const requestSelection = extractGoChatRequestSelection(parsed.data);
      await options.goResponses.serve({
        key,
        identity,
        request: parsed.data,
        response,
        prepareInitial: async () => {
          const release = options.threads
            ? options.threads.hold(identity)
            : () => undefined;
          if (!release) {
            const code = "FAROL_COMPACTION_TURN_ACTIVE";
            onRefusal(code);
            refusal(response, 409, code);
            return null;
          }
          try {
            return await prepareInitialInput(
              raw,
              parsed.data,
              key,
              response,
              options,
              onRefusal,
              requestSelection,
            );
          } finally {
            release();
          }
        },
        onToolCall: onToolCallObserved,
      });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const { code, status } = goRefusal(error);
        onRefusal(code);
        refusal(response, status, code);
        return;
      }
      throw error;
    }
    return;
  }
  const existing = turns.get(key);
  if (existing) {
    if (!existing.hasContinuation(parsed.data)) {
      refusal(response, 409, "FAROL_CONTINUATION_REQUIRED");
      return;
    }
    try {
      await existing.serveContinuation(response, parsed.data);
    } catch (error) {
      if (error instanceof Error && !response.headersSent) {
        onRefusal(continuationCode(error.message));
        refusal(response, 409, "FAROL_CONTINUATION_INVALID");
        return;
      }
      existing.cancel("FAROL_HOST_DELIVERY_LOST");
      throw error;
    }
    return;
  }
  const tag = turnTag(identity);
  if (
    [...turns.values()].some((turn) =>
      turn.ownsForeignContinuation(parsed.data),
    )
  ) {
    refusal(response, 409, "FAROL_CONTINUATION_FOREIGN");
    return;
  }
  if (
    Array.isArray(parsed.data.input) &&
    parsed.data.input.some((entry) => currentCallEntry(entry, tag))
  ) {
    refusal(response, 409, "FAROL_CONTINUATION_NOT_FOUND");
    return;
  }
  if (turns.size >= MAX_ACTIVE_TURNS) {
    refusal(response, 503, "FAROL_PROVIDER_BUSY");
    return;
  }
  // From here the thread is in use: its context is prepared, the request is
  // admitted durably and its conversation run starts before the hold ends,
  // so nothing closes the task in between.
  const release = options.threads
    ? options.threads.hold(identity)
    : () => undefined;
  if (!release) {
    onRefusal("FAROL_COMPACTION_TURN_ACTIVE");
    refusal(response, 409, "FAROL_COMPACTION_TURN_ACTIVE");
    return;
  }
  try {
    await serveInitialRequest(
      raw,
      parsed.data,
      identity,
      key,
      response,
      options,
      turns,
      onToolCallObserved,
      onRefusal,
    );
  } finally {
    release();
  }
}

async function prepareInitialInput(
  raw: unknown,
  data: ResponseRequest,
  key: string,
  response: ServerResponse,
  options: ProviderOptions,
  onRefusal: (code: string) => void,
  requestSelection?: GoChatRequestSelection,
): Promise<GoChatPreparedInput | null> {
  const intentSHA256 = requestSelection
    ? goChatRequestIntentSHA256(data, requestSelection)
    : undefined;
  let trustedContext: string | null = null;
  let contextDelivered: (() => void) | undefined;
  if (options.compaction?.prepareTurn) {
    const prepared = await options.compaction.prepareTurn({
      body: structuredClone(raw),
    });
    if (!prepared.ok) {
      refusal(response, 409, prepared.error.code);
      return null;
    }
    trustedContext = prepared.value.trustedContext;
    contextDelivered = prepared.value.delivered;
  }
  const prompt = promptFromInput(
    data.input,
    trustedContext,
    HOST_CHECKPOINT_PREFIX,
  );
  if (prompt === null) {
    refusal(response, 422, "FAROL_INPUT_UNSUPPORTED");
    return null;
  }
  try {
    CodexNativeToolRegistry.parse(data.tools);
  } catch (error) {
    onRefusal(toolCatalogueCode(error));
    refusal(response, 422, "FAROL_TOOL_CATALOGUE_INVALID");
    return null;
  }
  // A host may repeat an initial request after a terminal answer, a lost
  // stream or a restart. The logical request is recorded durably, with its
  // immutable intent, after every local refusal and before anything reaches
  // ChatGPT, so a repeat never starts a second conversation run and the same
  // identity cannot carry a different request. A deliberately new identity
  // with the same text is a new request.
  return {
    prompt,
    ...(contextDelivered ? { completed: contextDelivered } : {}),
    admit: async () => {
      let admission: ProviderTurnAdmission;
      try {
        admission = await options.turns.admit(
          key,
          intentSHA256 ??
            digest(
              canonicalJson({
                model: data.model,
                input: data.input,
                tools: data.tools,
              }),
            ),
        );
      } catch {
        onRefusal("FAROL_TURN_JOURNAL_UNAVAILABLE");
        refusal(response, 503, "FAROL_TURN_JOURNAL_UNAVAILABLE");
        return false;
      }
      if (admission !== "admitted") {
        const code = admissionCode(admission);
        onRefusal(code);
        refusal(response, 409, code);
        return false;
      }
      return true;
    },
  };
}

async function serveInitialRequest(
  raw: unknown,
  data: ResponseRequest,
  identity: CodexChatGptTurnInput["identity"],
  key: string,
  response: ServerResponse,
  options: ProviderOptions,
  turns: Map<string, ActiveProviderTurn>,
  onToolCallObserved: () => void,
  onRefusal: (code: string) => void,
): Promise<void> {
  const prepared = await prepareInitialInput(
    raw,
    data,
    key,
    response,
    options,
    onRefusal,
  );
  if (!prepared || !(await prepared.admit())) return;
  const prompt = prepared.prompt;
  const contextDelivered = prepared.completed;
  if (!options.conversation) throw new Error("FAROL_PROVIDER_OPTIONS_INVALID");
  let turn: ActiveProviderTurn;
  try {
    turn = new ActiveProviderTurn(
      data,
      {
        requestedModel: data.model,
        prompt,
        identity,
        tools: structuredClone(data.tools),
      },
      options.conversation,
      onToolCallObserved,
      () => turns.delete(key),
      async (state) => {
        if (state === "completed") contextDelivered?.();
        // Nothing reached ChatGPT, so a repeat of this request is a new
        // attempt rather than a duplicate. A record that cannot be removed
        // stays, and a repeat is refused as already submitted.
        if (state === "failed_before_submit") {
          await options.turns.release(key).catch(() => undefined);
        }
      },
    );
  } catch (error) {
    onRefusal(toolCatalogueCode(error));
    refusal(response, 422, "FAROL_TOOL_CATALOGUE_INVALID");
    return;
  }
  turns.set(key, turn);
  try {
    await turn.serveInitial(response);
  } catch (error) {
    turn.cancel("FAROL_HOST_DELIVERY_LOST");
    throw error;
  }
}

async function handleCompaction(
  endpoint: HostCompactionEndpoint,
  raw: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  options: ProviderOptions,
): Promise<void> {
  // Compaction is a new request on the selected route, even when it reads a
  // historical checkpoint. Never relabel a stale alias as the current model.
  if (!record(raw) || raw.model !== options.model) {
    refusal(response, 422, "FAROL_MODEL_UNAVAILABLE");
    return;
  }
  if (!options.compaction) {
    refusal(response, 501, "FAROL_COMPACTION_UNAVAILABLE");
    return;
  }
  const result = await options.compaction.compact({
    endpoint,
    body: structuredClone(raw),
    metadataHeader: compactionMetadataHeader(request),
  });
  if (!result.ok) {
    refusal(response, 422, result.error.code);
    return;
  }
  const handoff = result.value;
  if (
    (endpoint === "responses_compact" &&
      handoff.variant !== "unary_replacement_history") ||
    (endpoint === "responses" && handoff.variant !== "streamed_compaction_item")
  ) {
    refusal(response, 500, "FAROL_COMPACTION_RESULT_INVALID");
    return;
  }
  if (handoff.variant === "unary_replacement_history") {
    json(response, 200, handoff.response);
    return;
  }

  const responseId = `resp_${randomUUID()}`;
  startStream(response);
  for (const { event, data } of compactionEvents(
    responseId,
    options.model,
    handoff.item,
  )) {
    await writeEvent(response, event, data);
  }
  response.end();
}

async function readProviderBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false }>> {
  if (
    request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
  ) {
    refusal(response, 415, "FAROL_CONTENT_TYPE_INVALID");
    return { ok: false };
  }
  try {
    return { ok: true, value: await readBody(request) };
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "FAROL_REQUEST_INVALID";
    refusal(response, code === "FAROL_REQUEST_TOO_LARGE" ? 413 : 400, code);
    return { ok: false };
  }
}

export async function startCodexChatGptProvider(
  options: ProviderOptions,
): Promise<CodexChatGptProviderRuntime> {
  if (
    // Historical low-level context fixtures keep their exact original IDs.
    // The production route supplies CHATGPT_MODEL_ID exclusively; its exact
    // request-model guard never treats these strings as aliases of chatgpt.
    (options.model !== CHATGPT_MODEL_ID &&
      options.model !== "legacy-route/mind" &&
      options.model !== "legacy-route/drive") ||
    Boolean(options.conversation) === Boolean(options.goResponses) ||
    options.token.length < 16 ||
    options.token.length > 512 ||
    /[\r\n]/u.test(options.token)
  ) {
    throw new Error("FAROL_PROVIDER_OPTIONS_INVALID");
  }

  let modelRequests = 0;
  let responseRequests = 0;
  let unauthorizedRequests = 0;
  let failedRequests = 0;
  let toolCalls = 0;
  let compactionRequests = 0;
  let lastRefusalCode: string | null = null;
  let lastInputKinds: string[] = [];
  let lastInputRoles: string[] = [];
  let lastInputContentKinds: string[] = [];
  let lastToolNames: string[] = [];
  let lastMetadataKeys: string[] = [];
  let lastTurnMetadataKeys: string[] = [];
  let lastCompactionMarkerKind = "absent";
  let lastCompactionMarkerShape: string[] = [];
  let lastRequestKindCompaction = false;
  let lastRequestKindShape: string[] = [];
  const turns = new Map<string, ActiveProviderTurn>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!authorized(request, options.token)) {
        unauthorizedRequests += 1;
        refusal(response, 401, "FAROL_PROVIDER_UNAUTHORIZED");
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        modelRequests += 1;
        json(response, 200, {
          object: "list",
          data: [modelCatalogue(options.model)],
        });
        return;
      }
      if (
        request.method === "POST" &&
        (url.pathname === "/v1/responses" ||
          url.pathname === "/v1/responses/compact")
      ) {
        const body = await readProviderBody(request, response);
        if (!body.ok) return;
        lastInputKinds = inputKinds(body.value);
        lastInputRoles = inputRoles(body.value);
        lastInputContentKinds = inputContentKinds(body.value);
        lastToolNames = toolNames(body.value);
        lastMetadataKeys = metadataKeys(body.value);
        lastTurnMetadataKeys = turnMetadataKeys(body.value);
        lastCompactionMarkerKind = compactionMarkerKind(body.value);
        lastCompactionMarkerShape = compactionMarkerShape(body.value);
        lastRequestKindCompaction = requestKindCompaction(body.value);
        lastRequestKindShape = requestKindShape(body.value);
        const endpoint =
          url.pathname === "/v1/responses/compact"
            ? "responses_compact"
            : streamedCompactionRequest(
                  body.value,
                  compactionMetadataHeader(request),
                )
              ? "responses"
              : null;
        if (endpoint !== null) {
          compactionRequests += 1;
          await handleCompaction(
            endpoint,
            body.value,
            request,
            response,
            options,
          );
          return;
        }
        responseRequests += 1;
        await handleResponses(
          body.value,
          response,
          options,
          turns,
          () => {
            toolCalls += 1;
          },
          (code) => {
            lastRefusalCode = code;
          },
        );
        return;
      }
      refusal(response, 404, "FAROL_PROVIDER_NOT_FOUND");
    })().catch(() => {
      failedRequests += 1;
      if (!response.headersSent) {
        refusal(response, 500, "FAROL_PROVIDER_FAILED");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("FAROL_PROVIDER_BIND_FAILED");
  }
  const port = address.port;
  return {
    providerId: FAROL_PROVIDER_ID,
    model: options.model,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    diagnostics: () => ({
      modelRequests,
      responseRequests,
      unauthorizedRequests,
      failedRequests,
      activeTurns: options.goResponses?.activeResponses ?? turns.size,
      toolCalls,
      compactionRequests,
      lastRefusalCode,
      lastInputKinds: [...lastInputKinds],
      lastInputRoles: [...lastInputRoles],
      lastInputContentKinds: [...lastInputContentKinds],
      lastToolNames: [...lastToolNames],
      lastMetadataKeys: [...lastMetadataKeys],
      lastTurnMetadataKeys: [...lastTurnMetadataKeys],
      lastCompactionMarkerKind,
      lastCompactionMarkerShape: [...lastCompactionMarkerShape],
      lastRequestKindCompaction,
      lastRequestKindShape: [...lastRequestKindShape],
    }),
    close: async () => {
      await options.goResponses?.close();
      for (const turn of [...turns.values()]) {
        turn.cancel("FAROL_PROVIDER_CLOSED");
      }
      turns.clear();
      server.closeAllConnections();
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
