import { randomUUID } from "node:crypto";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { BridgeError } from "../bridge/client";
import type { ReadConversationProjection } from "../bridge/read-conversation";
import { projectReadConversation } from "../read-conversation-projection";
import type {
  ConfigurationChatgptPorts,
  ChatgptConfigurationCommand,
} from "./ports";

type ConversationCommand = Extract<
  ChatgptConfigurationCommand,
  {
    kind:
      | "chatgpt.inspect-chat-account"
      | "chatgpt.start-conversation"
      | "chatgpt.observe-readonly-conversation"
      | "chatgpt.ack-readonly-conversation"
      | "chatgpt.follow-readonly-conversation"
      | "chatgpt.recover-task-result"
      | "chatgpt.reset-conversation"
      | "chatgpt.ack-task-result";
  }
>;

export type ConversationPorts = Pick<
  ConfigurationChatgptPorts,
  | "configuration"
  | "chatGptRoute"
  | "chatGptE2eOrigin"
  | "desktopGoCore"
  | "goChatStartupProfile"
  | "directChatStart"
  | "setDirectChatStart"
  | "goReadonlyConversation"
  | "setGoReadonlyConversation"
  | "pendingChatGptReadonlyTask"
  | "pendingChatGptAttachmentTask"
  | "recoverableChatGptTask"
  | "setRecoverableChatGptTask"
  | "recoverableChatGptObservationPersisted"
  | "setRecoverableChatGptObservationPersisted"
  | "chatGptConversationStore"
  | "setChatGptConversation"
  | "chatGptTaskJournal"
  | "desktopAdmission"
  | "runtimeEnvironment"
  | "configurationFailure"
  | "chatGptConversationContinuity"
  | "chatGptJournalObservation"
  | "captureChatStartupProfile"
  | "ReadConversationClient"
  | "AccountObservationConfirmation"
>;

export function createChatgptConversation(ports: ConversationPorts) {
  const {
    configuration,
    chatGptRoute,
    chatGptE2eOrigin,
    desktopGoCore,
    goChatStartupProfile,
    directChatStart,
    setDirectChatStart,
    goReadonlyConversation,
    setGoReadonlyConversation,
    pendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask,
    recoverableChatGptTask,
    setRecoverableChatGptTask,
    recoverableChatGptObservationPersisted,
    setRecoverableChatGptObservationPersisted,
    chatGptConversationStore,
    setChatGptConversation,
    chatGptTaskJournal,
    desktopAdmission,
    runtimeEnvironment,
    configurationFailure,
    chatGptConversationContinuity,
    chatGptJournalObservation,
    captureChatStartupProfile,
    ReadConversationClient,
    AccountObservationConfirmation,
  } = ports;

  async function configureConversation(
    command: ConversationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "chatgpt.inspect-chat-account": {
        const route = chatGptRoute();
        const core = desktopGoCore();
        const profile = goChatStartupProfile();
        const snapshot = configuration()!.snapshot();
        if (!route || !core || !profile || snapshot.status !== "ready")
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        if (
          directChatStart() ||
          goReadonlyConversation() ||
          desktopAdmission.occupied("chatgpt-task") ||
          pendingChatGptReadonlyTask() ||
          pendingChatGptAttachmentTask() ||
          recoverableChatGptTask() ||
          snapshot.settings.setup.chatgpt.outcomeUnknown ||
          desktopAdmission.installedUpdateAdmission ||
          desktopAdmission.quitInProgress
        )
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        const revision = snapshot.settings.revision;
        let selected: ReturnType<typeof captureChatStartupProfile>;
        try {
          selected = captureChatStartupProfile({
            environment: runtimeEnvironment,
            e2e: process.env.FAROL_E2E === "1",
            origin: chatGptE2eOrigin(),
            tasks: snapshot.settings.tasks,
          });
        } catch {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (
          !selected ||
          selected.snapshot.configSHA256 !== profile.snapshot.configSHA256
        )
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        const model = selected.snapshot;
        const operationId = command.operationId;
        const sessionId = randomUUID();
        const client = new ReadConversationClient(null, core.chat);
        const current = () => {
          const now = configuration()?.snapshot();
          return (
            directChatStart()?.operationId === operationId &&
            desktopGoCore() === core &&
            chatGptRoute() === route &&
            goChatStartupProfile() === profile &&
            !desktopAdmission.installedUpdateAdmission &&
            !desktopAdmission.quitInProgress &&
            now?.status === "ready" &&
            now.settings.revision === revision &&
            !now.settings.setup.chatgpt.outcomeUnknown
          );
        };
        const confirmation =
          new AccountObservationConfirmation<ReadConversationProjection>({
            current,
            read: () => route.observeAccount(),
            commit: (account) => {
              const start = directChatStart()?.start;
              if (!start || !current())
                throw new BridgeError(
                  "refused",
                  "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
                );
              return client.startAuthorized({
                sessionId,
                prompt: start.command.prompt,
                policy: model.policy,
                profiles: model.profiles,
                requested: {},
                ...account,
              });
            },
          });
        const inspection = Promise.resolve().then(async () => {
          const chatAdmission =
            desktopAdmission.reserveAdmitted("chatgpt-task");
          try {
            const inspected = await confirmation.inspect();
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot: configuration()!.snapshot(),
              evidence: {
                kind: "chatgpt.chat-account-preview",
                operationId,
                sessionId,
                ...inspected,
              },
            });
          } catch (error) {
            return configurationFailure(
              error instanceof BridgeError && error.state === "refused"
                ? "CHATGPT_ACCOUNT_CONFIRMATION_INVALID"
                : "CHATGPT_CONVERSATION_UNCONFIRMED",
            );
          } finally {
            chatAdmission.release();
          }
        });
        setDirectChatStart({
          operationId,
          sessionId,
          core,
          client,
          confirmation,
          inspection,
        });
        return inspection;
      }
      case "chatgpt.start-conversation": {
        const pending = directChatStart();
        if (
          !pending ||
          command.operationId !== pending.operationId ||
          pending.start ||
          goReadonlyConversation() ||
          desktopAdmission.occupied("chatgpt-task") ||
          desktopGoCore() !== pending.core
        )
          return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
        const captured = structuredClone(command);
        const start = Promise.resolve().then(async () => {
          const chatAdmission =
            desktopAdmission.reserveAdmitted("chatgpt-task");
          try {
            const projection = await pending.confirmation.confirm(
              captured.confirmationId,
            );
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot: configuration()!.snapshot(),
              evidence: projectReadConversation(
                captured.operationId,
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
        });
        pending.start = { command: captured, promise: start };
        // Pin before fresh account observation or admission. This same client is
        // the only host PrepareNext consumer, including after a lost reply.
        setGoReadonlyConversation({
          pending: null,
          operationId: pending.operationId,
          core: pending.core,
          client: pending.client,
          start,
        });
        return start;
      }
      case "chatgpt.observe-readonly-conversation":
      case "chatgpt.ack-readonly-conversation":
      case "chatgpt.follow-readonly-conversation": {
        const active = goReadonlyConversation();
        if (
          !active ||
          active.operationId !== command.operationId ||
          desktopGoCore() !== active.core
        )
          return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
        try {
          const projection =
            command.kind === "chatgpt.follow-readonly-conversation"
              ? await active.client.follow(command.handleId, command.prompt)
              : command.kind === "chatgpt.observe-readonly-conversation"
                ? await active.client.progress(command.handleId, command.cursor)
                : await (async () => {
                    await active.client.acknowledge(
                      command.handleId,
                      command.resultId,
                    );
                    return active.client.snapshot(
                      command.handleId,
                      command.cursor,
                    );
                  })();
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: projectReadConversation(command.operationId, projection),
          });
        } catch (error) {
          return configurationFailure(
            error instanceof BridgeError && error.state === "refused"
              ? "CHATGPT_CONVERSATION_REFUSED"
              : "CHATGPT_CONVERSATION_UNCONFIRMED",
          );
        }
      }
      case "chatgpt.recover-task-result": {
        const retained = recoverableChatGptTask();
        if (!retained || retained.result === null) {
          return configurationFailure("CHATGPT_TASK_RESULT_NOT_FOUND");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "chatgpt.task-recovery",
            operationId: retained.operationId,
            taskKind: retained.kind,
            ...retained.result,
            conversationContinuity: chatGptConversationContinuity(),
            redelivered: true,
            deliveryAckRequired: true,
          },
        });
      }
      case "chatgpt.reset-conversation": {
        if (desktopAdmission.occupied("chatgpt-task")) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        if (pendingChatGptReadonlyTask() || pendingChatGptAttachmentTask()) {
          return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
        }
        const snapshot = configuration()!.snapshot();
        if (
          snapshot.status === "ready" &&
          snapshot.settings.setup.chatgpt.outcomeUnknown
        ) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        if (!chatGptConversationStore() || !chatGptRoute()) {
          return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
        }
        try {
          await chatGptConversationStore()!.clear();
          setChatGptConversation(null);
          chatGptRoute()!.resetConversation();
        } catch {
          return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: { kind: "chatgpt.conversation-reset", state: "new" },
        });
      }
      case "chatgpt.ack-task-result": {
        if (!chatGptTaskJournal()) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        const retained = recoverableChatGptTask();
        if (
          retained?.operationId === command.operationId &&
          retained.result !== null &&
          !recoverableChatGptObservationPersisted()
        ) {
          const recorded = await configuration()!.recordChatGptObservation(
            chatGptJournalObservation(retained.result),
          );
          if (!recorded.ok)
            return ProductConfigurationResultSchema.parse(recorded);
          setRecoverableChatGptObservationPersisted(true);
        }
        try {
          await chatGptTaskJournal()!.acknowledgeDelivery(command.operationId);
        } catch {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        if (recoverableChatGptTask()?.operationId === command.operationId) {
          setRecoverableChatGptTask(null);
          setRecoverableChatGptObservationPersisted(false);
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
    }
  }

  return Object.freeze({ configureConversation });
}
