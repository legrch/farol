import { randomBytes } from "node:crypto";
import path from "node:path";

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
import { PrivateProviderTurnJournal } from "./provider-turn-journal";
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

// The caller relay the Farol Next connector reaches: each turn that offers
// host tools opens one relay turn bound to exactly that tool catalogue.
export type RouteBToolRelay = Pick<CodexCallerRelayRuntime, "openTurn">;

export type RouteBRuntimeOptions = Readonly<{
  // Private Next state directory; the provider's turn journal lives inside it.
  stateRoot: string;
  surfaces: RouteBTaskSurfaces;
  compaction: CodexChatGptCompaction;
  relay?: RouteBToolRelay;
}>;

export type RouteBRuntime = Readonly<{
  // What an isolated Codex host is launched with as its model provider.
  endpoint: Readonly<{ baseUrl: string; token: string }>;
  provider: CodexChatGptProviderRuntime;
  // True while this process is running a turn of the thread, summarizing it
  // or preparing a turn of it, so its private context is in use.
  owns(threadId: string): boolean;
  close(): Promise<void>;
}>;

export const ROUTE_B_MODEL = "farol-next/mind";

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

// ChatGPT reaches the host's own tools only through the Farol Next connector
// tool, bound to this one turn; the relay admits nothing else.
function toolRelayInstruction(ticket: string, binding: string): string {
  return [
    "This Codex task's native tools are available only through the Farol Next connector tool farol_next_caller_tools,",
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
  // Turns being prepared, which may confirm a context handoff. They do not
  // exclude each other or a turn; they only mark the thread as in use.
  private readonly preparing = new Map<string, number>();

  owns(threadId: string): boolean {
    return (
      this.running.has(threadId) ||
      this.summarizing.has(threadId) ||
      (this.preparing.get(threadId) ?? 0) > 0
    );
  }

  beginPrepare(threadId: string): void {
    this.preparing.set(threadId, (this.preparing.get(threadId) ?? 0) + 1);
  }

  endPrepare(threadId: string): void {
    const remaining = (this.preparing.get(threadId) ?? 1) - 1;
    if (remaining > 0) this.preparing.set(threadId, remaining);
    else this.preparing.delete(threadId);
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

  beginSummary(threadId: string): boolean {
    if (this.running.has(threadId) || this.summarizing.has(threadId)) {
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
  for (const candidate of candidates) {
    const threadId = (candidate as { thread_id?: unknown } | undefined)
      ?.thread_id;
    if (typeof threadId === "string" && threadId.length > 0) return threadId;
  }
  return null;
}

// Host compaction for a thread owns that thread for the whole summary.
export function admittedCompaction(
  inner: CodexChatGptCompaction,
  admission: RouteBAdmission,
): CodexChatGptCompaction {
  return {
    compact: async (input) => {
      const threadId = compactionThread(input);
      if (threadId && !admission.beginSummary(threadId)) {
        return failure("FAROL_NEXT_COMPACTION_TURN_ACTIVE");
      }
      try {
        return await inner.compact(input);
      } finally {
        if (threadId) admission.endSummary(threadId);
      }
    },
    ...(inner.prepareTurn
      ? {
          prepareTurn: async (input) => {
            const threadId = compactionThread({
              metadataHeader: undefined,
              body: input.body,
            });
            if (threadId) admission.beginPrepare(threadId);
            try {
              return await inner.prepareTurn!(input);
            } finally {
              if (threadId) admission.endPrepare(threadId);
            }
          },
        }
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
    turns: new PrivateProviderTurnJournal({
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
