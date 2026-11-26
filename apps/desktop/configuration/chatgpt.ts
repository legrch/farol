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
  MAX_CHATGPT_CONTEXT_CHARACTERS,
  buildChatGptAttachmentTaskPrompt,
  buildChatGptReadonlyTaskPrompt,
} from "../../../src/apps/desktop/chatgpt-readonly-task";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import {
  workspaceDeniedPaths,
  workspaceDescriptor,
} from "../../../src/apps/desktop/workspace-descriptor";
import { BridgeError } from "../bridge/client";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import { readAccountFailure } from "../read-account-commands";
import { projectReadConversation } from "../read-conversation-projection";
import { createChatgptSignin } from "./signin";
import { createChatgptBrowser } from "./browser";
import { createChatgptConversation } from "./conversation";
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
    chatGptE2eOrigin,
    desktopGoCore,
    goChatStartupProfile,
    goReadonlyConversation,
    setGoReadonlyConversation,
    pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask,
    setPendingChatGptAttachmentTask,
    setRecoverableChatGptTask,
    setRecoverableChatGptObservationPersisted,
    chatGptTaskJournal,
    chatGptSignInOpenGeneration,
    selectedTaskId,
    attachmentStagingReady,
    setAttachmentStagingReady,
    desktopAdmission,
    liveTaskRegistry,
    readonlyAccountConfirmations,
    buildIdentity,
    activeDesktopIdentity,
    runtimeEnvironment,
    compiledGoCore,
    nativeWorkspace,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
    chatGptConversationAdmissionFailure,
    retainChatGptConversation,
    chatGptAppPreSubmitObservation,
    chatGptAttachmentTaskPreview,
    chatGptReadonlyTaskPreview,
    attachmentStagingFailure,
    discardPreparedChatGptTask,
    discardPreparedReadonlyTask,
    withdrawGoReadonlyAdmission,
    readonlyAccountCurrent,
    selectedChatGptAttachmentPaths,
    selectedWorkspaceFile,
    workspaceReadFailure,
    captureChatStartupProfile,
    stageChatGptAttachments,
    verifyStagedChatGptAttachments,
    discardChatGptAttachments,
    ReadConversationClient,
    ReadAccountConfirmation,
  } = ports;

  const signin = createChatgptSignin(ports);

  const browser = createChatgptBrowser(ports);

  const conversation = createChatgptConversation(ports);

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
      case "chatgpt.submit-attachment-task": {
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        const chatAdmission = desktopAdmission.acquire("chatgpt-task");
        if (!chatAdmission)
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        try {
          const pending = pendingChatGptAttachmentTask();
          if (!pending || pending.operationId !== command.operationId) {
            return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND");
          }
          if (Date.now() >= pending.expiresAt) {
            setPendingChatGptAttachmentTask(null);
            await discardChatGptAttachments(
              statePaths().attachmentStaging,
              pending.operationId,
            ).catch(() => {
              setAttachmentStagingReady(false);
            });
            if (!(await discardPreparedChatGptTask(pending.operationId))) {
              return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
            }
            return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_EXPIRED");
          }
          const snapshot = configuration()!.snapshot();
          if (snapshot.status !== "ready") {
            return configurationFailure("SETTINGS_UNAVAILABLE");
          }
          if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          }
          if (
            !isDeepStrictEqual(
              snapshot.settings.setup.chatgpt.verified,
              pending.chatGptVerification,
            )
          ) {
            setPendingChatGptAttachmentTask(null);
            await discardChatGptAttachments(
              statePaths().attachmentStaging,
              pending.operationId,
            ).catch(() => {
              setAttachmentStagingReady(false);
            });
            if (!(await discardPreparedChatGptTask(pending.operationId))) {
              return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
            }
            return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
          }
          try {
            await verifyStagedChatGptAttachments(pending.attachments);
          } catch (error) {
            setPendingChatGptAttachmentTask(null);
            await discardChatGptAttachments(
              statePaths().attachmentStaging,
              pending.operationId,
            ).catch(() => {
              setAttachmentStagingReady(false);
            });
            if (!(await discardPreparedChatGptTask(pending.operationId))) {
              return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
            }
            return attachmentStagingFailure(error);
          }
          if (!chatGptTaskJournal()) {
            return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
          }
          try {
            const journal = chatGptTaskJournal()!;
            await journalUnderPromotionLease(liveTaskRegistry, () =>
              journal.markDispatchIntent(pending.operationId),
            );
          } catch (error) {
            return configurationFailure(
              error instanceof PromotionPendingRefusal
                ? "CHATGPT_TASK_PROMOTION_PENDING"
                : "CHATGPT_TASK_JOURNAL_FAILED",
            );
          }
          setPendingChatGptAttachmentTask(null);

          let task: Awaited<ReturnType<ChatGptRoute["runReadonlyTask"]>>;
          let stagingCleanup: "removed" | "pending_startup_cleanup" = "removed";
          try {
            try {
              task = await chatGptRoute()!.runReadonlyTask(
                pending.prompt,
                pending.attachments.attachments,
              );
            } catch {
              task = {
                state: "outcome_unknown",
                code: "CHATGPT_TASK_ERROR",
                deltaCount: 0,
                observedCharacters: 0,
              };
            }
          } finally {
            try {
              await discardChatGptAttachments(
                statePaths().attachmentStaging,
                pending.operationId,
              );
            } catch {
              setAttachmentStagingReady(false);
              stagingCleanup = "pending_startup_cleanup";
            }
            chatAdmission.release();
          }
          const journalResult = {
            state: task.state,
            code: task.code,
            deltaCount: task.deltaCount,
            observedCharacters: task.observedCharacters,
            attachmentCount: pending.attachments.attachments.length,
            totalBytes: pending.attachments.attachments.reduce(
              (total, attachment) => total + attachment.bytes,
              0,
            ),
            stagingCleanup,
          } as const;
          const conversationContinuity = await retainChatGptConversation(
            pending.operationId,
            task.state,
          );
          try {
            await chatGptTaskJournal()!.retainResult(
              pending.operationId,
              journalResult,
            );
            setRecoverableChatGptTask(await chatGptTaskJournal()!.load());
          } catch {
            const unknown = await configuration()!.recordChatGptObservation({
              state: "outcome_unknown",
            });
            if (!unknown.ok) {
              return ProductConfigurationResultSchema.parse(unknown);
            }
            return ProductConfigurationResultSchema.parse({
              ...unknown,
              evidence: {
                kind: "chatgpt.task-recovery",
                operationId: pending.operationId,
                taskKind: "attachment",
                state: "outcome_unknown",
                code: "CHATGPT_TASK_RESULT_PERSIST_FAILED",
                deltaCount: task.deltaCount,
                observedCharacters: task.observedCharacters,
                attachmentCount: journalResult.attachmentCount,
                totalBytes: journalResult.totalBytes,
                stagingCleanup,
                conversationContinuity,
                redelivered: false,
                deliveryAckRequired: false,
              },
            });
          }
          const observation =
            task.state === "completed"
              ? {
                  state: "authenticated" as const,
                  profile: "chatgpt.app-partition/1",
                  runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
                  buildId: buildIdentity.buildId,
                  protocol: "chatgpt-page-attachment-task/1",
                }
              : task.state === "not_authenticated"
                ? { state: "signed_out" as const }
                : task.state === "outcome_unknown"
                  ? { state: "outcome_unknown" as const }
                  : task.code === "CHATGPT_PAGE_UNREACHABLE"
                    ? { state: "unreachable" as const }
                    : (chatGptAppPreSubmitObservation(task.code) ?? {
                        state: "unsupported" as const,
                      });
          const recorded =
            await configuration()!.recordChatGptObservation(observation);
          if (!recorded.ok)
            return ProductConfigurationResultSchema.parse(recorded);
          setRecoverableChatGptObservationPersisted(true);
          return ProductConfigurationResultSchema.parse({
            ...recorded,
            evidence: {
              kind: "chatgpt.attachment-task",
              operationId: pending.operationId,
              state: task.state,
              code: task.code,
              attachmentCount: pending.attachments.attachments.length,
              totalBytes: pending.attachments.attachments.reduce(
                (total, attachment) => total + attachment.bytes,
                0,
              ),
              deltaCount: task.deltaCount,
              observedCharacters: task.observedCharacters,
              stagingCleanup,
              conversationContinuity,
              redelivered: false,
              deliveryAckRequired: true,
            },
          });
        } finally {
          // Also covers preparation exits before the existing dispatch finalizer.
          // Release is identity-bound: a repeated release cannot clear a successor.
          chatAdmission.release();
        }
      }
      case "chatgpt.cancel-attachment-task": {
        if (desktopAdmission.occupied("chatgpt-task")) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        const pending = pendingChatGptAttachmentTask();
        if (!pending || pending.operationId !== command.operationId) {
          return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND");
        }
        setPendingChatGptAttachmentTask(null);
        try {
          await discardChatGptAttachments(
            statePaths().attachmentStaging,
            pending.operationId,
          );
        } catch {
          setAttachmentStagingReady(false);
          return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
        }
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
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
      case "chatgpt.inspect-readonly-account":
      case "chatgpt.approve-readonly-account": {
        const pending = pendingChatGptReadonlyTask();
        const route = chatGptRoute();
        const core = desktopGoCore();
        if (desktopAdmission.occupied("chatgpt-task"))
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        if (!pending || pending.operationId !== command.operationId)
          return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
        if (
          !route ||
          !core ||
          !pending.goAdmission ||
          !readonlyAccountCurrent(pending, route, core)
        )
          return configurationFailure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
        let confirmation = readonlyAccountConfirmations.get(pending);
        if (
          !confirmation &&
          command.kind === "chatgpt.inspect-readonly-account"
        ) {
          confirmation = new ReadAccountConfirmation({
            admission: pending.goAdmission,
            current: () => readonlyAccountCurrent(pending, route, core),
            read: () => route.observeAccount(),
            approve: (input) => core.approveReadAccount(input),
          });
          readonlyAccountConfirmations.set(pending, confirmation);
        }
        if (!confirmation)
          return configurationFailure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
        const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
        try {
          if (command.kind === "chatgpt.inspect-readonly-account")
            await confirmation.inspect();
          else await confirmation.confirm(command.confirmationId);
          if (!readonlyAccountCurrent(pending, route, core))
            return configurationFailure(
              command.kind === "chatgpt.inspect-readonly-account"
                ? "CHATGPT_ACCOUNT_CONFIRMATION_INVALID"
                : "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
            );
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()?.snapshot(),
            evidence: chatGptReadonlyTaskPreview(pending),
          });
        } catch (error) {
          return configurationFailure(readAccountFailure(command, error));
        } finally {
          chatAdmission.release();
        }
      }
      case "chatgpt.submit-readonly-task": {
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        const chatAdmission = desktopAdmission.acquire("chatgpt-task");
        if (!chatAdmission)
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        try {
          const pending = pendingChatGptReadonlyTask();
          if (!pending || pending.operationId !== command.operationId) {
            return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
          }
          if (Date.now() >= pending.expiresAt) {
            if (!(await discardPreparedReadonlyTask(pending))) {
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
            return configurationFailure("CHATGPT_TASK_PREVIEW_EXPIRED");
          }
          const snapshot = configuration()!.snapshot();
          if (snapshot.status !== "ready") {
            return configurationFailure("SETTINGS_UNAVAILABLE");
          }
          if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
            if (!(await discardPreparedReadonlyTask(pending))) {
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          }
          if (
            !isDeepStrictEqual(
              snapshot.settings.setup.chatgpt.verified,
              pending.chatGptVerification,
            )
          ) {
            if (!(await discardPreparedReadonlyTask(pending))) {
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
            return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
          }
          const workspace = snapshot.settings.computer.workspaces.find(
            (candidate) => candidate.workspaceId === pending.workspaceId,
          );
          const computerVerification =
            snapshot.settings.setup.computer.verified;
          if (
            !workspace ||
            snapshot.settings.computer.generation !==
              pending.computerGeneration ||
            computerVerification?.workspaceId !== pending.workspaceId ||
            computerVerification.configRevision !== pending.computerGeneration
          ) {
            if (!(await discardPreparedReadonlyTask(pending))) {
              return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
            }
            return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
          }
          if (pending.goAdmission) {
            if (!ReadConversationPromptSchema.safeParse(pending.prompt).success)
              return configurationFailure("CHATGPT_PROMPT_TOO_LARGE");
            const core = desktopGoCore();
            const profile = goChatStartupProfile();
            if (!core || !profile)
              return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
            if (
              readonlyAccountConfirmations.get(pending)?.projection()?.state !==
              "approved"
            )
              return configurationFailure(
                "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
              );
            let current: ReturnType<typeof captureChatStartupProfile>;
            try {
              current = captureChatStartupProfile({
                environment: runtimeEnvironment,
                e2e: process.env.FAROL_E2E === "1",
                origin: chatGptE2eOrigin(),
                tasks: snapshot.settings.tasks,
              });
            } catch {
              return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
            }
            if (
              !current ||
              current.snapshot.configSHA256 !== profile.snapshot.configSHA256
            )
              return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
            const client = new ReadConversationClient(
              {
                resolve: (input) => core.resolveReadIntent(input),
                promote: (input) => core.promoteReadIntent(input),
              },
              core.chat,
            );
            const admission = pending.goAdmission;
            const start = Promise.resolve().then(
              async (): Promise<ProductConfigurationResult> => {
                try {
                  const projection = await client.start(
                    {
                      admission,
                      policy: current.snapshot.policy,
                      profiles: current.snapshot.profiles,
                      requested: {},
                    },
                    pending.prompt,
                  );
                  return ProductConfigurationResultSchema.parse({
                    ok: true,
                    snapshot: configuration()!.snapshot(),
                    evidence: projectReadConversation(
                      pending.operationId,
                      projection,
                    ),
                  });
                } catch (error) {
                  return configurationFailure(
                    error instanceof BridgeError && error.state === "refused"
                      ? "CHATGPT_CONVERSATION_REFUSED"
                      : "CHATGPT_CONVERSATION_UNCONFIRMED",
                  );
                } finally {
                  chatAdmission.release();
                }
              },
            );
            // Publish the original attempt before any await so repeated IPC cannot
            // mint another promotion or Send after a lost renderer reply.
            setGoReadonlyConversation({
              pending,
              operationId: pending.operationId,
              core,
              client,
              start,
            });
            return await start;
          }
          if (!chatGptTaskJournal()) {
            return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
          }
          try {
            const journal = chatGptTaskJournal()!;
            await journalUnderPromotionLease(liveTaskRegistry, () =>
              journal.markDispatchIntent(pending.operationId),
            );
          } catch (error) {
            return configurationFailure(
              error instanceof PromotionPendingRefusal
                ? "CHATGPT_TASK_PROMOTION_PENDING"
                : "CHATGPT_TASK_JOURNAL_FAILED",
            );
          }

          setPendingChatGptReadonlyTask(null);
          let task: Awaited<ReturnType<ChatGptRoute["runReadonlyTask"]>>;
          try {
            try {
              task = await chatGptRoute()!.runReadonlyTask(pending.prompt);
            } catch {
              task = {
                state: "outcome_unknown",
                code: "CHATGPT_TASK_ERROR",
                deltaCount: 0,
                observedCharacters: 0,
              };
            }
          } finally {
            chatAdmission.release();
          }
          const journalResult = {
            state: task.state,
            code: task.code,
            deltaCount: task.deltaCount,
            observedCharacters: task.observedCharacters,
          } as const;
          const conversationContinuity = await retainChatGptConversation(
            pending.operationId,
            task.state,
          );
          try {
            await chatGptTaskJournal()!.retainResult(
              pending.operationId,
              journalResult,
            );
            setRecoverableChatGptTask(await chatGptTaskJournal()!.load());
          } catch {
            const unknown = await configuration()!.recordChatGptObservation({
              state: "outcome_unknown",
            });
            if (!unknown.ok) {
              return ProductConfigurationResultSchema.parse(unknown);
            }
            return ProductConfigurationResultSchema.parse({
              ...unknown,
              evidence: {
                kind: "chatgpt.task-recovery",
                operationId: pending.operationId,
                taskKind: "readonly",
                state: "outcome_unknown",
                code: "CHATGPT_TASK_RESULT_PERSIST_FAILED",
                deltaCount: task.deltaCount,
                observedCharacters: task.observedCharacters,
                attachmentCount: 0,
                totalBytes: 0,
                stagingCleanup: null,
                conversationContinuity,
                redelivered: false,
                deliveryAckRequired: false,
              },
            });
          }
          const observation =
            task.state === "completed"
              ? {
                  state: "authenticated" as const,
                  profile: "chatgpt.app-partition/1",
                  runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
                  buildId: buildIdentity.buildId,
                  protocol: "chatgpt-page-readonly-task/1",
                }
              : task.state === "not_authenticated"
                ? { state: "signed_out" as const }
                : task.state === "outcome_unknown"
                  ? { state: "outcome_unknown" as const }
                  : task.code === "CHATGPT_PAGE_UNREACHABLE"
                    ? { state: "unreachable" as const }
                    : (chatGptAppPreSubmitObservation(task.code) ?? {
                        state: "unsupported" as const,
                      });
          const recorded =
            await configuration()!.recordChatGptObservation(observation);
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          setRecoverableChatGptObservationPersisted(true);
          return ProductConfigurationResultSchema.parse({
            ...recorded,
            evidence: {
              kind: "chatgpt.readonly-task",
              operationId: pending.operationId,
              state: task.state,
              code: task.code,
              workspaceId: pending.workspaceId,
              relativePath: pending.relativePath,
              bytes: pending.bytes,
              contextCharacters: pending.contextCharacters,
              contextLimit: MAX_CHATGPT_CONTEXT_CHARACTERS,
              contextTruncated: pending.contextTruncated,
              deltaCount: task.deltaCount,
              observedCharacters: task.observedCharacters,
              conversationContinuity,
              redelivered: false,
              deliveryAckRequired: true,
            },
          });
        } finally {
          // Also covers preparation exits before the existing dispatch finalizer.
          // Release is identity-bound: a repeated release cannot clear a successor.
          chatAdmission.release();
        }
      }
      case "chatgpt.cancel-readonly-task": {
        const conversation = goReadonlyConversation();
        if (
          conversation?.pending?.operationId === command.operationId &&
          !conversation.client.canWithdrawAdmission()
        )
          return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
        if (desktopAdmission.occupied("chatgpt-task")) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        if (
          !pendingChatGptReadonlyTask() ||
          pendingChatGptReadonlyTask()!.operationId !== command.operationId
        ) {
          return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
        }
        const pending = pendingChatGptReadonlyTask()!;
        const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
        try {
          if (!(await discardPreparedReadonlyTask(pending)))
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          if (
            conversation?.pending === pending &&
            goReadonlyConversation() === conversation
          )
            setGoReadonlyConversation(null);
        } finally {
          chatAdmission.release();
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
    }
  }

  return Object.freeze({ configureAdmittedChatgpt });
}
