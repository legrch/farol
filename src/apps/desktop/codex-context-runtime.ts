import type { ContextSession } from "../../modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../modules/chat/infra/repo/private-context-store";
import {
  ChatGptContextSummaryDriver,
  type ChatGptContextSummaryRoutes,
  type SummaryExecutionFence,
} from "./chatgpt-context-summary";
import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
  type CodexChatGptProviderRuntime,
} from "./codex-chatgpt-provider";
import { CodexContextContinuity } from "./codex-context-continuity";
import { PrivateProviderTurnJournal } from "./provider-turn-journal";

export type CodexContextControllerOptions = Readonly<{
  ownerId: string;
  providerProfileId: string;
  stateRoot: string;
  summaryRoutes: ChatGptContextSummaryRoutes;
  // Fences ordinary Computer tools while a summary-only phase runs.
  summaryFence?: SummaryExecutionFence;
  // Whether a task is live in the product; a thread that is not starts
  // under first-turn rules and never receives the residue of a closed task.
  liveTask?: (taskId: string) => boolean;
  maximumSummaryPromptCharacters?: number;
  onContextStateChanged?: (session: ContextSession) => void | Promise<void>;
}>;

export type CodexContextRuntimeOptions = CodexContextControllerOptions &
  Readonly<{
    model: "farol-next/mind" | "farol-next/drive";
    token: string;
    conversation: CodexChatGptConversation;
    // Private directory for the provider's durable initial-request journal.
    providerTurnsRoot: string;
  }>;

export type CodexContextController = Readonly<{
  store: PrivateContextStore;
  continuity: CodexContextContinuity;
}>;

export type CodexContextRuntime = Readonly<{
  provider: CodexChatGptProviderRuntime;
  close(): Promise<void>;
}>;

export function createCodexContextController(
  options: CodexContextControllerOptions,
): CodexContextController {
  const store = new PrivateContextStore({ root: options.stateRoot });
  const summary = new ChatGptContextSummaryDriver({
    store,
    routes: options.summaryRoutes,
    ...(options.summaryFence === undefined
      ? {}
      : { fence: options.summaryFence }),
    ...(options.maximumSummaryPromptCharacters === undefined
      ? {}
      : {
          maximumPromptCharacters: options.maximumSummaryPromptCharacters,
        }),
  });
  const continuity = new CodexContextContinuity({
    ownerId: options.ownerId,
    providerProfileId: options.providerProfileId,
    store,
    summary,
    ...(options.onContextStateChanged === undefined
      ? {}
      : { onStateChanged: options.onContextStateChanged }),
    ...(options.liveTask === undefined ? {} : { liveTask: options.liveTask }),
  });
  return { store, continuity };
}

export async function startCodexContextRuntime(
  options: CodexContextRuntimeOptions,
): Promise<CodexContextRuntime> {
  const controller = createCodexContextController(options);
  const provider = await startCodexChatGptProvider({
    model: options.model,
    token: options.token,
    conversation: options.conversation,
    compaction: controller.continuity,
    turns: new PrivateProviderTurnJournal({ root: options.providerTurnsRoot }),
  });
  let closed = false;

  return {
    provider,
    close: async () => {
      if (closed) return;
      closed = true;
      await provider.close();
    },
  };
}
