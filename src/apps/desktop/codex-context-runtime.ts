import type { ContextSession } from "../../modules/chat/domain/context-continuity";
import { PrivateContextStore } from "../../modules/chat/infra/repo/private-context-store";
import {
  ChatGptContextSummaryDriver,
  type ChatGptContextSummaryRoutes,
} from "./chatgpt-context-summary";
import {
  startCodexChatGptProvider,
  type CodexChatGptConversation,
  type CodexChatGptProviderRuntime,
} from "./codex-chatgpt-provider";
import { CodexContextContinuity } from "./codex-context-continuity";

export type CodexContextRuntimeOptions = Readonly<{
  ownerId: string;
  providerProfileId: string;
  stateRoot: string;
  model: "farol-next/mind" | "farol-next/drive";
  token: string;
  conversation: CodexChatGptConversation;
  summaryRoutes: ChatGptContextSummaryRoutes;
  maximumSummaryPromptCharacters?: number;
  onContextStateChanged?: (session: ContextSession) => void | Promise<void>;
}>;

export type CodexContextRuntime = Readonly<{
  provider: CodexChatGptProviderRuntime;
  close(): Promise<void>;
}>;

export async function startCodexContextRuntime(
  options: CodexContextRuntimeOptions,
): Promise<CodexContextRuntime> {
  const store = new PrivateContextStore({ root: options.stateRoot });
  const summary = new ChatGptContextSummaryDriver({
    store,
    routes: options.summaryRoutes,
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
  });
  const provider = await startCodexChatGptProvider({
    model: options.model,
    token: options.token,
    conversation: options.conversation,
    compaction: continuity,
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
