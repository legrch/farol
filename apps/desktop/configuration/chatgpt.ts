import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ReadConversationPromptSchema } from "../../../src/pkg/product-settings/chat-conversation";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  journalUnderPromotionLease,
  PromotionPendingRefusal,
} from "../../../src/apps/desktop/chatgpt-journal-lease";
import type { StagedChatGptAttachments } from "../../../src/apps/desktop/chatgpt-attachment-staging";
import {
  buildChatGptAttachmentTaskPrompt,
  buildChatGptReadonlyTaskPrompt,
} from "../../../src/apps/desktop/chatgpt-readonly-task";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import {
  workspaceDeniedPaths,
  workspaceDescriptor,
} from "../../../src/apps/desktop/workspace-descriptor";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import { createChatgptSignin } from "./signin";
import { createChatgptBrowser } from "./browser";
import { createChatgptConversation } from "./conversation";
import { createChatgptAttachment } from "./attachment";
import { createChatgptReadonly } from "./readonly";
import type {
  ChatgptConfigurationCommand,
  ConfigurationChatgptPorts,
} from "./ports";

export type {
  ChatgptConfigurationCommand,
  ConfigurationChatgptPorts,
  DirectChatStart,
  GoReadonlyConversation,
  PendingChatGptAttachmentTask,
  PendingChatGptReadonlyTask,
} from "./ports";

export function createConfigurationChatgpt(ports: ConfigurationChatgptPorts) {
  const {
    configuration,
    chatGptRoute,
    desktopGoCore,
    goReadonlyConversation,
    pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask,
    setPendingChatGptAttachmentTask,
    chatGptTaskJournal,
    chatGptSignInOpenGeneration,
    selectedTaskId,
    attachmentStagingReady,
    setAttachmentStagingReady,
    desktopAdmission,
    liveTaskRegistry,
    compiledGoCore,
    nativeWorkspace,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
    chatGptConversationAdmissionFailure,
    chatGptAttachmentTaskPreview,
    chatGptReadonlyTaskPreview,
    attachmentStagingFailure,
    discardPreparedChatGptTask,
    discardPreparedReadonlyTask,
    withdrawGoReadonlyAdmission,
    selectedChatGptAttachmentPaths,
    selectedWorkspaceFile,
    workspaceReadFailure,
    stageChatGptAttachments,
    discardChatGptAttachments,
  } = ports;

  const signin = createChatgptSignin(ports);

  const browser = createChatgptBrowser(ports);

  const conversation = createChatgptConversation(ports);

  const attachment = createChatgptAttachment(ports);

  const readonly = createChatgptReadonly(ports);

  // Main retains parsed-command admission, its settings-availability guard and
  // the deep-test commands.
  async function configureAdmittedChatgpt(
    command: ChatgptConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "chatgpt.inspect-chat-account":
      case "chatgpt.start-conversation":
      case "chatgpt.observe-readonly-conversation":
      case "chatgpt.ack-readonly-conversation":
      case "chatgpt.follow-readonly-conversation":
      case "chatgpt.recover-task-result":
      case "chatgpt.reset-conversation":
      case "chatgpt.ack-task-result":
        return conversation.configureConversation(command);
      case "chatgpt.open-sign-in":
      case "chatgpt.observe-sign-in":
      case "chatgpt.verify":
      case "chatgpt.sign-in-return":
      case "chatgpt.verification-return":
        return signin.configureSignin(command);
      case "chatgpt.present-browser": {
        if (!embeddedBrowserEnabled() || !chatGptRoute())
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        applyLayout();
        if (desktopAdmission.occupied("chatgpt-task"))
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        // Task and sign-in surfaces already have their own retained identities.
        // Navigation must reveal them, never replace them with the home route.
        if (chatGptSignInOpenGeneration() !== null || selectedTaskId() !== "")
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
          });
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          // open() joins an in-flight open or retains the existing document. It
          // creates only an absent surface and never discards a failed one.
          opened = await chatGptRoute()!.open();
        } catch {
          opened = { status: "unreachable" };
        }
        // Route failure may conceal its page. Reapply current shell ownership so
        // a retained failed home document remains accessible without retrying it.
        applyLayout();
        if (opened.status !== "opened")
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
      case "chatgpt.present-browser":
      case "chatgpt.open-browser":
      case "chatgpt.toggle-sidebar":
        return browser.configureBrowser(command);
      case "chatgpt.prepare-attachment-task": {
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (desktopAdmission.occupied("chatgpt-task")) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        const conversationFailure = chatGptConversationAdmissionFailure();
        if (conversationFailure) return conversationFailure;
        if (!attachmentStagingReady()) {
          return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
        }
        if (pendingChatGptReadonlyTask()) {
          return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_PENDING");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        const verification = snapshot.settings.setup.chatgpt.verified;
        if (!verification) {
          return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
        }
        const existing = pendingChatGptAttachmentTask();
        if (existing) {
          const current =
            Date.now() < existing.expiresAt &&
            isDeepStrictEqual(existing.chatGptVerification, verification);
          if (current) {
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot,
              evidence: chatGptAttachmentTaskPreview(existing),
            });
          }
          setPendingChatGptAttachmentTask(null);
          try {
            await discardChatGptAttachments(
              statePaths().attachmentStaging,
              existing.operationId,
            );
          } catch {
            setAttachmentStagingReady(false);
            return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
          }
          if (!(await discardPreparedChatGptTask(existing.operationId))) {
            return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
          }
        }
        const selected = await selectedChatGptAttachmentPaths();
        if (selected === "cancelled") {
          return configurationFailure("CHATGPT_ATTACHMENT_PICKER_CANCELLED");
        }
        if (selected === "invalid") {
          return configurationFailure("CHATGPT_ATTACHMENT_SELECTION_INVALID");
        }
        const operationId = randomUUID();
        let attachments: StagedChatGptAttachments;
        try {
          attachments = await stageChatGptAttachments({
            root: statePaths().attachmentStaging,
            operationId,
            paths: selected,
          });
        } catch (error) {
          return attachmentStagingFailure(error);
        }
        const prompt = buildChatGptAttachmentTaskPrompt({
          attachments: attachments.attachments,
        });
        if (!chatGptTaskJournal()) {
          await discardChatGptAttachments(
            statePaths().attachmentStaging,
            operationId,
          ).catch(() => {
            setAttachmentStagingReady(false);
          });
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        try {
          const journal = chatGptTaskJournal()!;
          await journalUnderPromotionLease(liveTaskRegistry, () =>
            journal.prepare({
              operationId,
              kind: "attachment",
            }),
          );
        } catch (error) {
          await discardChatGptAttachments(
            statePaths().attachmentStaging,
            operationId,
          ).catch(() => {
            setAttachmentStagingReady(false);
          });
          return configurationFailure(
            error instanceof PromotionPendingRefusal
              ? "CHATGPT_TASK_PROMOTION_PENDING"
              : "CHATGPT_TASK_JOURNAL_FAILED",
          );
        }
        setPendingChatGptAttachmentTask({
          operationId,
          attachments,
          prompt: prompt.text,
          chatGptVerification: verification,
          expiresAt: Date.now() + 10 * 60_000,
        });
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot,
          evidence: chatGptAttachmentTaskPreview(
            pendingChatGptAttachmentTask()!,
          ),
        });
      }
      case "chatgpt.prepare-attachment-task":
      case "chatgpt.submit-attachment-task":
      case "chatgpt.cancel-attachment-task":
        return attachment.configureAttachment(command);
      case "chatgpt.prepare-readonly-task": {
        if (goReadonlyConversation())
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (desktopAdmission.occupied("chatgpt-task")) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        const conversationFailure = chatGptConversationAdmissionFailure();
        if (conversationFailure) return conversationFailure;
        if (pendingChatGptAttachmentTask()) {
          return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
        }
        const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
        try {
          const snapshot = configuration()!.snapshot();
          if (snapshot.status !== "ready") {
            return configurationFailure("SETTINGS_UNAVAILABLE");
          }
          if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          }
          const chatGptVerification = snapshot.settings.setup.chatgpt.verified;
          if (!chatGptVerification) {
            return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
          }
          const workspace = snapshot.settings.computer.workspaces.find(
            (candidate) => candidate.workspaceId === command.workspaceId,
          );
          const computerVerification =
            snapshot.settings.setup.computer.verified;
          if (
            !workspace ||
            computerVerification?.workspaceId !== workspace.workspaceId ||
            computerVerification.configRevision !==
              snapshot.settings.computer.generation
          ) {
            return configurationFailure("WORKSPACE_NOT_FOUND");
          }
          const workspaceIdentity = workspace.rootIdentity;
          if (!workspaceIdentity) {
            return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
          }
          const pending = pendingChatGptReadonlyTask();
          if (pending) {
            const pendingStillCurrent =
              Date.now() < pending.expiresAt &&
              pending.computerGeneration ===
                snapshot.settings.computer.generation &&
              isDeepStrictEqual(
                pending.chatGptVerification,
                chatGptVerification,
              );
            if (pendingStillCurrent) {
              if (pending.workspaceId !== workspace.workspaceId) {
                return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
              }
              return ProductConfigurationResultSchema.parse({
                ok: true,
                snapshot,
                evidence: chatGptReadonlyTaskPreview(pending),
              });
            }
            if (!(await discardPreparedReadonlyTask(pending))) {
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
          }
          const relativePath = await selectedWorkspaceFile(workspace, {
            title: "Choose a text file for the read-only ChatGPT task",
            buttonLabel: "Use Selected File",
          });
          if (relativePath === "cancelled") {
            return configurationFailure("WORKSPACE_FILE_PICKER_CANCELLED");
          }
          if (relativePath === "invalid") {
            return configurationFailure("WORKSPACE_FILE_SELECTION_INVALID");
          }
          // The user selected this file for this new pending operation. Bind its
          // identity before the read; demo IDs and settings do not admit a turn.
          const operationId = randomUUID();
          let text: string;
          let bytes: number;
          let goAdmission: ChatComputerAdmissionResponse | undefined;
          if (compiledGoCore !== null) {
            if (!desktopGoCore())
              return configurationFailure("WORKSPACE_READ_FAILED");
            try {
              const observed = await desktopGoCore()!.readForIntent(
                operationId,
                workspace.workspaceId,
                relativePath,
              );
              goAdmission = observed.admission;
              if (observed.result.status !== "ok") {
                if (!(await withdrawGoReadonlyAdmission(goAdmission)))
                  return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
                return workspaceReadFailure(
                  observed.result.code ?? "WORKSPACE_READ_FAILED",
                );
              }
              text = observed.result.data.text;
              bytes = Number(observed.result.data.bytes);
            } catch {
              // No TS/Python fallback or fresh key after a possibly effective
              // Go admission. The exact Go owner remains fenced for inspection.
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
          } else {
            // Explicit legacy build only. This branch is never an error fallback.
            const workspaceResult = await nativeWorkspace.execute({
              workspace: workspaceDescriptor(workspace, workspaceIdentity),
              operation: { kind: "workspace.read", relativePath },
            });
            if (!workspaceResult.ok)
              return workspaceReadFailure(workspaceResult.error.code);
            if (workspaceResult.value.kind !== "workspace.text")
              return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
            text = workspaceResult.value.text;
            bytes = workspaceResult.value.bytes;
          }
          const prompt = buildChatGptReadonlyTaskPrompt({
            workspaceLabel: workspace.label,
            relativePath,
            text,
          });
          if (
            goAdmission &&
            !ReadConversationPromptSchema.safeParse(prompt.text).success
          ) {
            if (!(await withdrawGoReadonlyAdmission(goAdmission)))
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            return configurationFailure("CHATGPT_PROMPT_TOO_LARGE");
          }
          const expiresAt = Date.now() + 10 * 60_000;
          const excludedPaths = workspaceDeniedPaths(workspace);
          if (goAdmission === undefined) {
            if (!chatGptTaskJournal()) {
              if (!(await withdrawGoReadonlyAdmission(goAdmission)))
                return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
              return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
            }
            try {
              const journal = chatGptTaskJournal()!;
              await journalUnderPromotionLease(liveTaskRegistry, () =>
                journal.prepare({
                  operationId,
                  kind: "readonly",
                }),
              );
            } catch (error) {
              if (!(await withdrawGoReadonlyAdmission(goAdmission)))
                return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
              return configurationFailure(
                error instanceof PromotionPendingRefusal
                  ? "CHATGPT_TASK_PROMOTION_PENDING"
                  : "CHATGPT_TASK_JOURNAL_FAILED",
              );
            }
          }
          setPendingChatGptReadonlyTask({
            operationId,
            workspaceId: workspace.workspaceId,
            workspaceLabel: workspace.label,
            computerGeneration: snapshot.settings.computer.generation,
            relativePath,
            bytes,
            ...(goAdmission ? { goAdmission } : {}),
            contextCharacters: prompt.contextCharacters,
            contextTruncated: prompt.contextTruncated,
            excludedPaths,
            prompt: prompt.text,
            chatGptVerification,
            expiresAt,
          });
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot,
            evidence: chatGptReadonlyTaskPreview(pendingChatGptReadonlyTask()!),
          });
        } finally {
          chatAdmission.release();
        }
      }
      case "chatgpt.prepare-readonly-task":
      case "chatgpt.inspect-readonly-account":
      case "chatgpt.approve-readonly-account":
      case "chatgpt.submit-readonly-task":
      case "chatgpt.cancel-readonly-task":
        return readonly.configureReadonly(command);
    }
  }

  return Object.freeze({ configureAdmittedChatgpt });
}
