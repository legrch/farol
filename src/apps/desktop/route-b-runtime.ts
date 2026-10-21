import type { GoChatResponses } from "../../../apps/desktop/go-chat-responses.ts";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CHATGPT_MODEL_ID as ROUTE_B_MODEL } from "../../pkg/model-route/contract";

import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "./chatgpt-route";
import type { CodexCallerRelayRuntime } from "./codex-caller-relay";
import {
  startCodexChatGptProvider,
  type CodexChatGptCompaction,
  type CodexChatGptConversation,
  type CodexChatGptConversationResult,
  type CodexChatGptProviderRuntime,
} from "./codex-chatgpt-provider";
import {
  PrivateProviderTurnJournal,
  type ProviderTurnJournal,
} from "./provider-turn-journal";
import { failure } from "../../pkg/kernel/domain/result";

// The ChatGPT conversation of one Farol task, as a Route B turn uses it.
export type RouteBConversationSurface = Readonly<{
  runReadonlyTask(
    prompt: string,
    attachments: readonly [],
    observer: ChatGptTaskObserver,
  ): Promise<ChatGptReadonlyTaskResult>;
}>;

export type RouteBSurfaceAdmission =
  | Readonly<{ ok: true; surface: RouteBConversationSurface }>
  | Readonly<{ ok: false; code: string }>;

// A Codex host thread runs in the Farol task with the same identity: the
// first turn admits that task (or is refused, for example at capacity or
// before ChatGPT is verified) and later turns reuse its conversation, which is
// also the retained source continuity summarizes.
export type RouteBTaskSurfaces = Readonly<{
  surfaceFor(threadId: string): Promise<RouteBSurfaceAdmission>;
  settled?(
    threadId: string,
    state: CodexChatGptConversationResult["state"],
  ): void | Promise<void>;
}>;

// The caller relay the Farol connector reaches: each turn that offers
// host tools opens one relay turn bound to exactly that tool catalogue.
export type RouteBToolRelay = Pick<CodexCallerRelayRuntime, "openTurn">;

export type RouteBRuntimeOptions = Readonly<{
  // Private Farol state directory; the provider's turn journal lives inside it.
  stateRoot: string;
  surfaces: RouteBTaskSurfaces;
  // An explicit startup selection; never a fallback from a Go operation.
  goResponses?: GoChatResponses;
  compaction: CodexChatGptCompaction;
  relay?: RouteBToolRelay;
  // The durable journal of admitted initial requests: the private one under
  // the state root unless a test supplies one that stops at an exact point.
  journal?: ProviderTurnJournal;
}>;

export type RouteBRuntime = Readonly<{
  // What an isolated Codex host is launched with as its model provider.
  endpoint: Readonly<{ baseUrl: string; token: string }>;
  provider: CodexChatGptProviderRuntime;
  // True while this process is running a turn of the thread, summarizing it
  // or holding an initial request of it from its preparation until its turn
  // runs, so its private context is in use.
  owns(threadId: string): boolean;
  close(): Promise<void>;
}>;

// New tasks use the provider-local model ID. Historical compound IDs are
// never rebound: the provider's exact-model check refuses an old request.
export { CHATGPT_MODEL_ID as ROUTE_B_MODEL } from "../../pkg/model-route/contract";

function conversationResult(
  result: ChatGptReadonlyTaskResult,
): CodexChatGptConversationResult {
  const state =
    result.state === "completed"
      ? "completed"
      : result.state === "outcome_unknown"
        ? "outcome_unknown"
        : "failed_before_submit";
  return {
    state,
    code:
      state === "completed"
        ? null
        : (result.code ??
          (result.state === "not_authenticated"
            ? "CHATGPT_SIGN_IN_REQUIRED"
            : "CHATGPT_TASK_ERROR")),
    outputText: result.outputText ?? "",
    observedProvider: "chatgpt-web",
    // The page does not report the model or mode it used for this turn.
    observedModel: null,
    observedMode: null,
  };
}

function refusedBeforeSubmit(code: string): CodexChatGptConversationResult {
  return {
    state: "failed_before_submit",
    code,
    outputText: "",
    observedProvider: null,
    observedModel: null,
    observedMode: null,
  };
}

// ChatGPT reaches the host's own tools only through the Farol connector
// tool, bound to this one turn; the relay admits nothing else.
function toolRelayInstruction(ticket: string, binding: string): string {
  return [
    "This Codex task's native tools are available only through the Farol connector tool farol_next_caller_tools,",
    `with ticket ${ticket} and binding ${binding}.`,
    'Describe them first with operation "describe". Invoke one tool at a time with operation "invoke" and a new stable operationId.',
    "Never repeat an invoke whose result you did not receive.",
  ].join(" ");
}

// One admission owner per host thread: an ordinary turn and a context summary
// of the same thread never overlap. A summary is refused while a turn of its
// thread is running (so the running turn keeps its tools and its result is
// delivered), and a new turn is refused while its thread is being summarized,
// so no relay turn is ever open during a summary: the summary reaches no host
// tool whatever its history asks for. Other threads are not affected.
export class RouteBAdmission {
  private readonly running = new Set<string>();
  private readonly summarizing = new Set<string>();
  // Initial requests held from their preparation (which may confirm a
  // context handoff) through durable admission until their turn runs. They
  // do not exclude each other or a turn; they only mark the thread as in
  // use, so it is continuously owned and cannot be closed in between.
  private readonly held = new Map<string, number>();

  owns(threadId: string): boolean {
    return (
      this.running.has(threadId) ||
      this.summarizing.has(threadId) ||
      (this.held.get(threadId) ?? 0) > 0
    );
  }

  hold(threadId: string): () => void {
    this.held.set(threadId, (this.held.get(threadId) ?? 0) + 1);
    let holding = true;
    return () => {
      if (!holding) return;
      holding = false;
      const remaining = (this.held.get(threadId) ?? 1) - 1;
      if (remaining > 0) this.held.set(threadId, remaining);
      else this.held.delete(threadId);
    };
  }

  // Scoped preparation exclusion only. Go keeps lifecycle/queue ownership;
  // an already running original summary cannot admit a new preparation.
  tryHold(threadId: string): (() => void) | null {
    if (this.summarizing.has(threadId)) return null;
    return this.hold(threadId);
  }

  beginTurn(threadId: string): boolean {
    if (this.summarizing.has(threadId) || this.running.has(threadId)) {
      return false;
    }
    this.running.add(threadId);
    return true;
  }

  endTurn(threadId: string): void {
    this.running.delete(threadId);
  }

  // A summary also waits for held initial requests: a held preparation may
  // still be confirming a context handoff after its turn ended, and a summary
  // must not read or advance that thread's context in the meantime.
  beginSummary(threadId: string): boolean {
    if (
      this.running.has(threadId) ||
      this.summarizing.has(threadId) ||
      (this.held.get(threadId) ?? 0) > 0
    ) {
      return false;
    }
    this.summarizing.add(threadId);
    return true;
  }

  endSummary(threadId: string): void {
    this.summarizing.delete(threadId);
  }
}

function compactionThread(
  input: Readonly<{
    metadataHeader: string | undefined;
    body: unknown;
  }>,
): string | null {
  const candidates: unknown[] = [];
  try {
    if (input.metadataHeader) candidates.push(JSON.parse(input.metadataHeader));
  } catch {
    // An unreadable header names no thread; the codec refuses it later.
  }
  const body = input.body as { client_metadata?: Record<string, unknown> };
  candidates.push(body?.client_metadata);
  const embedded = body?.client_metadata?.["x-codex-turn-metadata"];
  if (typeof embedded === "string") {
    try {
      candidates.push(JSON.parse(embedded));
    } catch {
      // The codec rejects malformed metadata before submitting a summary.
    }
  }
  for (const candidate of candidates) {
    const threadId = (candidate as { thread_id?: unknown } | undefined)
      ?.thread_id;
    if (typeof threadId === "string" && threadId.length > 0) return threadId;
  }
  return null;
}

// Host compaction for a thread owns that thread for the whole summary. Turn
// preparation needs no owner of its own: the provider holds the thread of an
// initial request from before its preparation until its turn runs.
export function admittedCompaction(
  inner: CodexChatGptCompaction,
  admission: RouteBAdmission,
): CodexChatGptCompaction {
  return {
    compact: async (input) => {
      const threadId = compactionThread(input);
      if (threadId && !admission.beginSummary(threadId)) {
        return failure("FAROL_COMPACTION_TURN_ACTIVE");
      }
      try {
        return await inner.compact(input);
      } finally {
        if (threadId) admission.endSummary(threadId);
      }
    },
    ...(inner.prepareTurn
      ? { prepareTurn: (input) => inner.prepareTurn!(input) }
      : {}),
  };
}

/**
 * Runs each Route B turn in its task's ChatGPT conversation and streams the
 * observed text back to the host. When the host offers tools, the turn opens
 * one relay turn for exactly that catalogue: a tool ChatGPT invokes through
 * the connector becomes a function call the host executes, and its output
 * returns the same way.
 */
export function chatGptTaskConversation(
  surfaces: RouteBTaskSurfaces,
  relay?: RouteBToolRelay,
  admission: RouteBAdmission = new RouteBAdmission(),
): CodexChatGptConversation {
  return {
    run: async (input, observer) => {
      const threadId = input.identity.threadId;
      if (!admission.beginTurn(threadId)) {
        return refusedBeforeSubmit("ROUTE_B_THREAD_BUSY");
      }
      try {
        return await runAdmitted(surfaces, relay, threadId, input, observer);
      } finally {
        admission.endTurn(threadId);
      }
    },
  };
}

async function runAdmitted(
  surfaces: RouteBTaskSurfaces,
  relay: RouteBToolRelay | undefined,
  threadId: string,
  input: Parameters<CodexChatGptConversation["run"]>[0],
  observer: Parameters<CodexChatGptConversation["run"]>[1],
): Promise<CodexChatGptConversationResult> {
  const admitted = await surfaces.surfaceFor(threadId);
  if (!admitted.ok) return refusedBeforeSubmit(admitted.code);
  let toolTurn: ReturnType<RouteBToolRelay["openTurn"]> | null = null;
  // Every path after admission reports how the turn ended, so the task
  // never stays running after a refusal.
  const settle = async (result: CodexChatGptConversationResult) => {
    toolTurn?.close();
    await surfaces.settled?.(threadId, result.state);
    return result;
  };
  let prompt = input.prompt;
  if (input.tools.length > 0) {
    if (!relay) {
      return settle(refusedBeforeSubmit("ROUTE_B_TOOL_RELAY_UNAVAILABLE"));
    }
    try {
      toolTurn = relay.openTurn({
        identity: input.identity,
        tools: input.tools,
        invoke: (resolved) =>
          observer.onToolCall({
            name: resolved.name,
            ...(resolved.namespace === null
              ? {}
              : { namespace: resolved.namespace }),
            arguments: resolved.arguments,
          }),
      });
    } catch {
      return settle(refusedBeforeSubmit("ROUTE_B_TOOL_RELAY_REFUSED"));
    }
    prompt = `${prompt}\n\n${toolRelayInstruction(toolTurn.ticket, toolTurn.binding)}`;
  }
  let result: CodexChatGptConversationResult;
  try {
    result = conversationResult(
      await admitted.surface.runReadonlyTask(prompt, [], {
        onTextDelta: (delta) => observer.onTextDelta(delta),
        onVisibleItem: async (item) => {
          if (!observer.onVisibleItem) {
            throw new Error("FAROL_VISIBLE_OUTPUT_UNSUPPORTED");
          }
          await observer.onVisibleItem(item);
        },
      }),
    );
  } catch {
    result = {
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
      outputText: "",
      observedProvider: "chatgpt-web",
      observedModel: null,
      observedMode: null,
    };
  }
  return settle(result);
}

export async function startRouteBRuntime(
  options: RouteBRuntimeOptions,
): Promise<RouteBRuntime> {
  if (!path.isAbsolute(options.stateRoot)) {
    throw new Error("ROUTE_B_STATE_ROOT_NOT_ABSOLUTE");
  }
  // A fresh token per start: only a host this process launched knows it.
  const token = randomBytes(32).toString("base64url");
  if (options.goResponses) {
    const transport = options.goResponses;
    const admission = new RouteBAdmission();
    const provider = await startCodexChatGptProvider({
      model: ROUTE_B_MODEL,
      token,
      goResponses: transport,
      compaction: admittedCompaction(
        {
          ...options.compaction,
          compact: (input) => {
            const threadId = compactionThread(input);
            if (threadId && transport.owns(threadId)) {
              return Promise.resolve(failure("FAROL_COMPACTION_TURN_ACTIVE"));
            }
            return options.compaction.compact(input);
          },
        },
        admission,
      ),
      threads: { hold: (identity) => admission.tryHold(identity.threadId) },
      turns:
        options.journal ??
        new PrivateProviderTurnJournal({
          root: path.join(options.stateRoot, "provider-turns"),
        }),
    });
    return {
      endpoint: { baseUrl: `${provider.baseUrl}/v1`, token },
      provider,
      owns: (threadId) => transport.owns(threadId) || admission.owns(threadId),
      close: () => provider.close(),
    };
  }
  const admission = new RouteBAdmission();
  const provider = await startCodexChatGptProvider({
    model: ROUTE_B_MODEL,
    token,
    conversation: chatGptTaskConversation(
      options.surfaces,
      options.relay,
      admission,
    ),
    compaction: admittedCompaction(options.compaction, admission),
    threads: { hold: (identity) => admission.hold(identity.threadId) },
    turns:
      options.journal ??
      new PrivateProviderTurnJournal({
        root: path.join(options.stateRoot, "provider-turns"),
      }),
  });
  return {
    endpoint: { baseUrl: `${provider.baseUrl}/v1`, token },
    provider,
    owns: (threadId) => admission.owns(threadId),
    close: () => provider.close(),
  };
}
