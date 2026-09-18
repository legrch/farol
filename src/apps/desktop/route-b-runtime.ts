import { randomBytes } from "node:crypto";
import path from "node:path";

import type {
  ChatGptReadonlyTaskResult,
  ChatGptTaskObserver,
} from "./chatgpt-route";
import {
  startCodexChatGptProvider,
  type CodexChatGptCompaction,
  type CodexChatGptConversation,
  type CodexChatGptConversationResult,
  type CodexChatGptProviderRuntime,
} from "./codex-chatgpt-provider";
import { PrivateProviderTurnJournal } from "./provider-turn-journal";

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

export type RouteBRuntimeOptions = Readonly<{
  // Private Next state directory; the provider's turn journal lives inside it.
  stateRoot: string;
  surfaces: RouteBTaskSurfaces;
  compaction: CodexChatGptCompaction;
}>;

export type RouteBRuntime = Readonly<{
  // What an isolated Codex host is launched with as its model provider.
  endpoint: Readonly<{ baseUrl: string; token: string }>;
  provider: CodexChatGptProviderRuntime;
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

/**
 * Runs each Route B turn in its task's ChatGPT conversation and streams the
 * observed text back to the host. This surface has no tool path of its own:
 * a ChatGPT answer is text, and host tools are reached separately.
 */
export function chatGptTaskConversation(
  surfaces: RouteBTaskSurfaces,
): CodexChatGptConversation {
  return {
    run: async (input, observer) => {
      const threadId = input.identity.threadId;
      const admitted = await surfaces.surfaceFor(threadId);
      if (!admitted.ok) {
        return {
          state: "failed_before_submit",
          code: admitted.code,
          outputText: "",
          observedProvider: null,
          observedModel: null,
          observedMode: null,
        };
      }
      let result: CodexChatGptConversationResult;
      try {
        result = conversationResult(
          await admitted.surface.runReadonlyTask(input.prompt, [], {
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
      await surfaces.settled?.(threadId, result.state);
      return result;
    },
  };
}

export async function startRouteBRuntime(
  options: RouteBRuntimeOptions,
): Promise<RouteBRuntime> {
  if (!path.isAbsolute(options.stateRoot)) {
    throw new Error("ROUTE_B_STATE_ROOT_NOT_ABSOLUTE");
  }
  // A fresh token per start: only a host this process launched knows it.
  const token = randomBytes(32).toString("base64url");
  const provider = await startCodexChatGptProvider({
    model: ROUTE_B_MODEL,
    token,
    conversation: chatGptTaskConversation(options.surfaces),
    compaction: options.compaction,
    turns: new PrivateProviderTurnJournal({
      root: path.join(options.stateRoot, "provider-turns"),
    }),
  });
  return {
    endpoint: { baseUrl: `${provider.baseUrl}/v1`, token },
    provider,
    close: () => provider.close(),
  };
}
