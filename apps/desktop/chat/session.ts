import path from "node:path";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import { z } from "zod";
import type {
  ChatGptConversationRecord,
  PrivateChatGptConversationStore,
} from "../../../src/apps/desktop/chatgpt-conversation-store";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  ChatGptTaskJournalResult,
  PrivateChatGptTaskJournal,
} from "../../../src/apps/desktop/chatgpt-task-journal";

// The ChatGPT conversation the owner is continuing and the journal beside it:
// whether the conversation is new, retained or waiting for review, why a new
// task is refused, what a journal result means for the account, how a finished
// operation retains its conversation, how a prepared task is discarded and how
// the attachments are chosen and a staging error classified. Main keeps every
// owner and the window; each `let` there is a late getter or a setter here, so
// a change made while a save or a dialog waits is seen at the next read. The
// result is the caller's failure type: nothing here knows its contract. Nothing
// here retries: a failed save leaves the conversation unavailable, never
// repeated.

export type ChatGptSessionFailureCode =
  | "CHATGPT_TASK_IN_PROGRESS"
  | "CHATGPT_CONVERSATION_STATE_FAILED"
  | "CHATGPT_CONVERSATION_REVIEW_REQUIRED"
  | "CHATGPT_ATTACHMENT_TYPE_UNSUPPORTED"
  | "CHATGPT_ATTACHMENT_TOO_LARGE"
  | "CHATGPT_ATTACHMENT_REFERENCE_MISSING"
  | "CHATGPT_ATTACHMENT_SELECTION_INVALID"
  | "CHATGPT_ATTACHMENT_STAGING_FAILED";

export type ChatGptSessionPorts<Failure> = Readonly<{
  chatGptConversationStore: () => Pick<
    PrivateChatGptConversationStore,
    "load" | "retain" | "markUnresolved"
  > | null;
  setChatGptConversationStore: (value: null) => void;
  chatGptConversation: () => ChatGptConversationRecord | null;
  setChatGptConversation: (value: ChatGptConversationRecord | null) => void;
  chatGptRoute: () => Pick<ChatGptRoute, "currentConversationUrl"> | null;
  goReadonlyConversation: () => object | null;
  directChatStart: () => object | null;
  chatGptTaskJournal: () => Pick<
    PrivateChatGptTaskJournal,
    "discardPrepared"
  > | null;
  window: () => BrowserWindow | null;
  activeDesktopIdentity: Readonly<{ chatGptPartition: string }>;
  buildIdentity: Readonly<{ buildId: string }>;
  configurationFailure: (error: ChatGptSessionFailureCode) => Failure;
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions,
  ) => Promise<Readonly<{ canceled: boolean; filePaths: string[] }>>;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function createChatGptSession<Failure>(
  ports: ChatGptSessionPorts<Failure>,
) {
  const {
    chatGptConversationStore,
    setChatGptConversationStore,
    chatGptConversation,
    setChatGptConversation,
    chatGptRoute,
    goReadonlyConversation,
    directChatStart,
    chatGptTaskJournal,
    window,
    activeDesktopIdentity,
    buildIdentity,
    configurationFailure,
    showOpenDialog,
    env,
  } = ports;

  function chatGptConversationState():
    "new" | "retained" | "review_required" | "unavailable" {
    if (!chatGptConversationStore()) return "unavailable";
    if (chatGptConversation()?.state === "retained") return "retained";
    if (chatGptConversation()?.state === "unresolved") return "review_required";
    return "new";
  }

  function chatGptConversationAdmissionFailure(): Failure | null {
    if (goReadonlyConversation() || directChatStart())
      return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
    if (!chatGptConversationStore()) {
      return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
    }
    if (chatGptConversation()?.state === "unresolved") {
      return configurationFailure("CHATGPT_CONVERSATION_REVIEW_REQUIRED");
    }
    return null;
  }

  function chatGptConversationContinuity():
    "retained" | "not_observed" | "review_required" | "unavailable" {
    const state = chatGptConversationState();
    return state === "new" ? "not_observed" : state;
  }

  const chatGptAppPreSubmitCodes = new Set([
    "CHATGPT_APP_SELECTION_MISSING",
    "CHATGPT_APP_SELECTION_AMBIGUOUS",
    "CHATGPT_APP_SELECTION_CONFLICT",
    "CHATGPT_APP_SELECTION_LOST",
    "CHATGPT_COMPOSER_DRAFT_PRESENT",
  ]);

  function chatGptAppPreSubmitObservation(code: string | null) {
    if (code === null || !chatGptAppPreSubmitCodes.has(code)) return null;
    return {
      state: "authenticated" as const,
      profile: "chatgpt.app-partition/1",
      runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
      buildId: buildIdentity.buildId,
      protocol: "chatgpt-page-app-binding-block/1",
    };
  }

  // Main reads the store again after each await. A save that failed in the
  // meantime has cleared it, and that read then throws inside the try below.
  function chatGptConversationStoreNow() {
    const store = chatGptConversationStore();
    if (!store) throw new TypeError("The conversation store was cleared");
    return store;
  }

  async function retainChatGptConversation(
    operationId: string,
    taskState:
      | "completed"
      | "not_authenticated"
      | "failed_before_submit"
      | "outcome_unknown",
  ): Promise<"retained" | "not_observed" | "review_required" | "unavailable"> {
    if (
      taskState === "not_authenticated" ||
      taskState === "failed_before_submit"
    ) {
      return chatGptConversationContinuity();
    }
    const store = chatGptConversationStore();
    const route = chatGptRoute();
    if (!store || !route) return "unavailable";
    const conversationUrl = route.currentConversationUrl();
    try {
      if (conversationUrl === null) {
        await store.markUnresolved(operationId);
        setChatGptConversation(await chatGptConversationStoreNow().load());
        return "review_required";
      }
      await store.retain({ operationId, conversationUrl });
      setChatGptConversation(await chatGptConversationStoreNow().load());
      return "retained";
    } catch {
      setChatGptConversationStore(null);
      setChatGptConversation(null);
      return "unavailable";
    }
  }

  function chatGptJournalObservation(result: ChatGptTaskJournalResult) {
    if (result.state === "completed") {
      return {
        state: "authenticated" as const,
        profile: "chatgpt.app-partition/1",
        runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
        buildId: buildIdentity.buildId,
        protocol: "chatgpt-page-task-recovery/1",
      };
    }
    if (result.state === "not_authenticated") {
      return { state: "signed_out" as const };
    }
    if (result.state === "outcome_unknown") {
      return { state: "outcome_unknown" as const };
    }
    const bindingBlock = chatGptAppPreSubmitObservation(result.code);
    if (bindingBlock !== null) return bindingBlock;
    return result.code === "CHATGPT_PAGE_UNREACHABLE"
      ? { state: "unreachable" as const }
      : { state: "unsupported" as const };
  }

  async function discardPreparedChatGptTask(
    operationId: string,
  ): Promise<boolean> {
    const journal = chatGptTaskJournal();
    if (!journal) return false;
    try {
      await journal.discardPrepared(operationId);
      return true;
    } catch {
      return false;
    }
  }

  async function selectedChatGptAttachmentPaths(): Promise<
    readonly string[] | "cancelled" | "invalid"
  > {
    if (env.FAROL_E2E === "1") {
      try {
        const parsed = z
          .array(z.string().refine((value) => path.isAbsolute(value)))
          .min(1)
          .max(4)
          .safeParse(
            JSON.parse(env.FAROL_E2E_ATTACHMENTS ?? "null") as unknown,
          );
        return parsed.success ? parsed.data : "invalid";
      } catch {
        return "invalid";
      }
    }
    const owner = window();
    if (!owner) return "invalid";
    const selected = await showOpenDialog(owner, {
      title: "Choose up to four attachments",
      buttonLabel: "Review Attachments",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Supported images and documents",
          extensions: ["png", "jpg", "jpeg", "webp", "pdf", "txt", "md"],
        },
      ],
      securityScopedBookmarks: false,
    });
    if (selected.canceled) return "cancelled";
    if (selected.filePaths.length < 1 || selected.filePaths.length > 4) {
      return "invalid";
    }
    return selected.filePaths;
  }

  function attachmentStagingFailure(error: unknown): Failure {
    const code = error instanceof Error ? error.message : "";
    if (code === "ATTACHMENT_TYPE_UNSUPPORTED") {
      return configurationFailure("CHATGPT_ATTACHMENT_TYPE_UNSUPPORTED");
    }
    if (
      code === "ATTACHMENT_TOO_LARGE" ||
      code === "ATTACHMENT_TOTAL_TOO_LARGE"
    ) {
      return configurationFailure("CHATGPT_ATTACHMENT_TOO_LARGE");
    }
    if (
      code === "ATTACHMENT_SOURCE_MISSING" ||
      code === "ATTACHMENT_REFERENCE_MISSING" ||
      code === "ATTACHMENT_REFERENCE_CHANGED"
    ) {
      return configurationFailure("CHATGPT_ATTACHMENT_REFERENCE_MISSING");
    }
    if (
      code === "ATTACHMENT_SELECTION_INVALID" ||
      code === "ATTACHMENT_DUPLICATE_NAME" ||
      code === "ATTACHMENT_EMPTY" ||
      code === "ATTACHMENT_SOURCE_UNSAFE"
    ) {
      return configurationFailure("CHATGPT_ATTACHMENT_SELECTION_INVALID");
    }
    return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
  }

  return {
    conversationState: chatGptConversationState,
    admissionFailure: chatGptConversationAdmissionFailure,
    continuity: chatGptConversationContinuity,
    preSubmitObservation: chatGptAppPreSubmitObservation,
    retain: retainChatGptConversation,
    journalObservation: chatGptJournalObservation,
    discardPrepared: discardPreparedChatGptTask,
    selectedAttachmentPaths: selectedChatGptAttachmentPaths,
    attachmentStagingFailure,
  };
}
