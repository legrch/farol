import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  journalUnderPromotionLease,
  PromotionPendingRefusal,
} from "../../../src/apps/desktop/chatgpt-journal-lease";
import type { StagedChatGptAttachments } from "../../../src/apps/desktop/chatgpt-attachment-staging";
import { buildChatGptAttachmentTaskPrompt } from "../../../src/apps/desktop/chatgpt-readonly-task";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type {
  ConfigurationChatgptPorts,
  ChatgptConfigurationCommand,
} from "./ports";

type AttachmentCommand = Extract<
  ChatgptConfigurationCommand,
  {
    kind:
      | "chatgpt.prepare-attachment-task"
      | "chatgpt.submit-attachment-task"
      | "chatgpt.cancel-attachment-task";
  }
>;

export type AttachmentPorts = Pick<
  ConfigurationChatgptPorts,
  | "configuration"
  | "chatGptRoute"
  | "pendingChatGptReadonlyTask"
  | "pendingChatGptAttachmentTask"
  | "setPendingChatGptAttachmentTask"
  | "setRecoverableChatGptTask"
  | "setRecoverableChatGptObservationPersisted"
  | "chatGptTaskJournal"
  | "attachmentStagingReady"
  | "setAttachmentStagingReady"
  | "desktopAdmission"
  | "liveTaskRegistry"
  | "buildIdentity"
  | "activeDesktopIdentity"
  | "statePaths"
  | "configurationFailure"
  | "chatGptConversationAdmissionFailure"
  | "retainChatGptConversation"
  | "chatGptAppPreSubmitObservation"
  | "chatGptAttachmentTaskPreview"
  | "attachmentStagingFailure"
  | "discardPreparedChatGptTask"
  | "selectedChatGptAttachmentPaths"
  | "stageChatGptAttachments"
  | "verifyStagedChatGptAttachments"
  | "discardChatGptAttachments"
>;

export function createChatgptAttachment(ports: AttachmentPorts) {
  const {
    configuration,
    chatGptRoute,
    pendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask,
    setPendingChatGptAttachmentTask,
    setRecoverableChatGptTask,
    setRecoverableChatGptObservationPersisted,
    chatGptTaskJournal,
    attachmentStagingReady,
    setAttachmentStagingReady,
    desktopAdmission,
    liveTaskRegistry,
    buildIdentity,
    activeDesktopIdentity,
    statePaths,
    configurationFailure,
    chatGptConversationAdmissionFailure,
    retainChatGptConversation,
    chatGptAppPreSubmitObservation,
    chatGptAttachmentTaskPreview,
    attachmentStagingFailure,
    discardPreparedChatGptTask,
    selectedChatGptAttachmentPaths,
    stageChatGptAttachments,
    verifyStagedChatGptAttachments,
    discardChatGptAttachments,
  } = ports;

  async function configureAttachment(
    command: AttachmentCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
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
    }
  }

  return Object.freeze({ configureAttachment });
}
