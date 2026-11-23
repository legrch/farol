import { randomUUID } from "node:crypto";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type { SetupCompletionContext } from "../../../src/ui/setup-completion";
import type {
  PrivateChatGptConversationStore,
  ChatGptConversationRecord,
} from "../../../src/apps/desktop/chatgpt-conversation-store";
import type { StagedChatGptAttachments } from "../../../src/apps/desktop/chatgpt-attachment-staging";
import type {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  ChatGptSignInOutcomeDiagnostic,
} from "../../../src/apps/desktop/chatgpt-route";
import type {
  PrivateChatGptTaskJournal,
  ChatGptTaskJournalRecord,
  ChatGptTaskJournalResult,
} from "../../../src/apps/desktop/chatgpt-task-journal";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { AccountObservationConfirmation } from "../account-observation-confirmation";
import { BridgeError } from "../bridge/client";
import type {
  ReadConversationClient,
  ReadConversationProjection,
} from "../bridge/read-conversation";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { captureChatStartupProfile } from "../go-chat-startup-profile";
import type { DesktopAdmission } from "../host/admission";
import { projectReadConversation } from "../read-conversation-projection";

export type ChatgptConfigurationCommand = Exclude<
  Extract<ProductConfigurationCommand, { kind: `chatgpt.${string}` }>,
  {
    kind:
      | "chatgpt.run-deep-test"
      | "chatgpt.deep-test-status"
      | "chatgpt.ack-deep-test"
      | "chatgpt.prepare-attachment-task"
      | "chatgpt.submit-attachment-task"
      | "chatgpt.cancel-attachment-task"
      | "chatgpt.prepare-readonly-task"
      | "chatgpt.inspect-readonly-account"
      | "chatgpt.approve-readonly-account"
      | "chatgpt.submit-readonly-task"
      | "chatgpt.cancel-readonly-task";
  }
>;

type ChatGptVerification = NonNullable<
  ProductSettings["setup"]["chatgpt"]["verified"]
>;

export type PendingChatGptReadonlyTask = Readonly<{
  goAdmission?: ChatComputerAdmissionResponse;
  operationId: string;
  workspaceId: string;
  workspaceLabel: string;
  computerGeneration: number;
  relativePath: string;
  bytes: number;
  contextCharacters: number;
  contextTruncated: boolean;
  excludedPaths: readonly string[];
  prompt: string;
  chatGptVerification: ChatGptVerification;
  expiresAt: number;
}>;

export type PendingChatGptAttachmentTask = Readonly<{
  operationId: string;
  attachments: StagedChatGptAttachments;
  prompt: string;
  chatGptVerification: ChatGptVerification;
  expiresAt: number;
}>;

// One window's original transport client, not a second model/task registry.
export type GoReadonlyConversation = {
  pending: PendingChatGptReadonlyTask | null;
  operationId: string;
  core: DesktopGoCore;
  client: ReadConversationClient;
  start: Promise<ProductConfigurationResult>;
};

// One window's retained inspection and first transport attempt. The Go owner
// mints the account grant, task and turn; no provider state is restored here.
export type DirectChatStart = {
  operationId: string;
  sessionId: string;
  core: DesktopGoCore;
  client: ReadConversationClient;
  confirmation: AccountObservationConfirmation<ReadConversationProjection>;
  inspection: Promise<ProductConfigurationResult>;
  start?: {
    command: Extract<
      ProductConfigurationCommand,
      { kind: "chatgpt.start-conversation" }
    >;
    promise: Promise<ProductConfigurationResult>;
  };
};

type ConversationContinuity =
  "retained" | "not_observed" | "review_required" | "unavailable";
type ChatStartupProfile = ReturnType<typeof captureChatStartupProfile>;

// Main owns the mutable state and the helper definitions. Everything here is a
// late getter, setter or callback, bound to its real receiver at call time; the
// module copies no state and constructs no owner of its own. A constant main
// owns (map, ledger, registry) is passed by reference.
export type ConfigurationChatgptPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  chatGptRoute: () => ChatGptRoute | null;
  chatGptE2eOrigin: () => string | null;
  desktopGoCore: () => DesktopGoCore | null;
  goChatStartupProfile: () => ChatStartupProfile;
  directChatStart: () => DirectChatStart | null;
  setDirectChatStart: (value: DirectChatStart | null) => void;
  goReadonlyConversation: () => GoReadonlyConversation | null;
  setGoReadonlyConversation: (value: GoReadonlyConversation | null) => void;
  pendingChatGptReadonlyTask: () => PendingChatGptReadonlyTask | null;
  pendingChatGptAttachmentTask: () => PendingChatGptAttachmentTask | null;
  recoverableChatGptTask: () => ChatGptTaskJournalRecord | null;
  setRecoverableChatGptTask: (value: ChatGptTaskJournalRecord | null) => void;
  recoverableChatGptObservationPersisted: () => boolean;
  setRecoverableChatGptObservationPersisted: (value: boolean) => void;
  chatGptConversationStore: () => PrivateChatGptConversationStore | null;
  setChatGptConversation: (value: ChatGptConversationRecord | null) => void;
  chatGptTaskJournal: () => PrivateChatGptTaskJournal | null;
  chatGptSignInGeneration: () => number;
  setChatGptSignInGeneration: (value: number) => void;
  chatGptSignInOpenGeneration: () => number | null;
  setChatGptSignInOpenGeneration: (value: number | null) => void;
  setChatGptSignInOutcome: (
    value: ChatGptSignInOutcomeDiagnostic | null,
  ) => void;
  selectedTaskId: () => string;
  browserHomeSurfaceOpen: () => boolean;
  setBrowserHomeSurfaceOpen: (value: boolean) => void;
  setSetupSignInCheck: (value: SetupCompletionContext["signInCheck"]) => void;
  desktopAdmission: Pick<
    DesktopAdmission,
    | "occupied"
    | "reserveAdmitted"
    | "acquire"
    | "closed"
    | "installedUpdateAdmission"
    | "quitInProgress"
  >;
  chatGptSignInBlocked: Pick<ChatGptSignInBlockLedger, "beginAttempt">;
  liveTaskRoutes: ReadonlyMap<string, ChatGptRoute>;
  buildIdentity: Readonly<{ buildId: string }>;
  activeDesktopIdentity: Readonly<{ chatGptPartition: string }>;
  runtimeEnvironment: Parameters<
    typeof captureChatStartupProfile
  >[0]["environment"];
  SIGN_IN_WINDOW_TITLE: string;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  embeddedBrowserEnabled: () => boolean;
  applyLayout: () => void;
  chatGptConversationContinuity: () => ConversationContinuity;
  chatGptJournalObservation: (result: ChatGptTaskJournalResult) => unknown;
  captureChatStartupProfile: typeof captureChatStartupProfile;
  ReadConversationClient: typeof ReadConversationClient;
  AccountObservationConfirmation: typeof AccountObservationConfirmation;
}>;

export function createConfigurationChatgpt(ports: ConfigurationChatgptPorts) {
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
    chatGptSignInGeneration,
    setChatGptSignInGeneration,
    chatGptSignInOpenGeneration,
    setChatGptSignInOpenGeneration,
    setChatGptSignInOutcome,
    selectedTaskId,
    browserHomeSurfaceOpen,
    setBrowserHomeSurfaceOpen,
    setSetupSignInCheck,
    desktopAdmission,
    chatGptSignInBlocked,
    liveTaskRoutes,
    buildIdentity,
    activeDesktopIdentity,
    runtimeEnvironment,
    SIGN_IN_WINDOW_TITLE,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
    chatGptConversationContinuity,
    chatGptJournalObservation,
    captureChatStartupProfile,
    ReadConversationClient,
    AccountObservationConfirmation,
  } = ports;

  // Main retains parsed-command admission, its settings-availability guard and
  // the deep-test commands.
  async function configureAdmittedChatgpt(
    command: ChatgptConfigurationCommand,
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
      case "chatgpt.open-sign-in": {
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        chatGptSignInBlocked.beginAttempt();
        setChatGptSignInOutcome(null);
        setChatGptSignInGeneration(chatGptSignInGeneration() + 1);
        setChatGptSignInOpenGeneration(chatGptSignInGeneration());
        if (embeddedBrowserEnabled()) {
          // Renderer presentation has already selected the home document.
          // Starting sign-in never changes that explicit selection.
          applyLayout();
        }
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          opened = await chatGptRoute()!.openForSignIn(SIGN_IN_WINDOW_TITLE);
        } catch {
          opened = { status: "unreachable" };
        }
        const recorded =
          opened.status === "opened"
            ? await configuration()!.markSetupVisited("chatgpt")
            : await configuration()!.recordChatGptObservation({
                state: "unreachable",
              });
        return ProductConfigurationResultSchema.parse({
          ...recorded,
          ...(opened.status === "unreachable"
            ? {
                evidence: {
                  kind: "chatgpt.readiness",
                  state: "unreachable",
                  code: "CHATGPT_PAGE_UNREACHABLE",
                },
              }
            : {}),
        });
      }
      case "chatgpt.observe-sign-in": {
        const original = chatGptRoute();
        let observation: Awaited<
          ReturnType<ChatGptRoute["observeSignInStatus"]>
        > = { state: "unknown", binding: null };
        if (original && command.buildId === buildIdentity.buildId) {
          try {
            observation = await original.observeSignInStatus();
            if (
              desktopAdmission.closed() ||
              chatGptRoute() !== original ||
              !original.isCurrentSignInStatus(observation)
            )
              observation = { state: "unknown", binding: null };
          } catch {
            observation = { state: "unknown", binding: null };
          }
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "chatgpt.sign-in-status",
            observationId: command.observationId,
            buildId: command.buildId,
            ...observation,
          },
        });
      }
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
      case "chatgpt.open-browser": {
        if (!embeddedBrowserEnabled() || !chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (chatGptSignInOpenGeneration() !== null) {
          return configurationFailure("CHATGPT_SIGN_IN_IN_PROGRESS");
        }
        if (
          desktopAdmission.occupied("chatgpt-task") ||
          desktopAdmission.occupied("connector-task")
        ) {
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        }
        setBrowserHomeSurfaceOpen(true);
        applyLayout();
        let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
        try {
          opened = await chatGptRoute()!.retryFailedOpen();
        } catch {
          opened = { status: "unreachable" };
        }
        if (opened.status !== "opened") {
          applyLayout();
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
      case "chatgpt.toggle-sidebar": {
        const visibleRoute =
          browserHomeSurfaceOpen() && selectedTaskId() === ""
            ? chatGptRoute()
            : liveTaskRoutes.get(selectedTaskId());
        if (!embeddedBrowserEnabled() || !visibleRoute) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (!(await visibleRoute.toggleSidebar())) {
          return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
        });
      }
      case "chatgpt.verify": {
        setSetupSignInCheck(null);
        if (!chatGptRoute()) {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        const route = chatGptRoute()!;
        const observed = await route.observe();
        const recorded = await configuration()!.recordChatGptObservation(
          observed.state === "authenticated"
            ? {
                state: "authenticated",
                profile: "chatgpt.app-partition/1",
                runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
                buildId: buildIdentity.buildId,
                protocol: "chatgpt-page-readiness/1",
              }
            : { state: observed.state },
        );
        if (recorded.ok && observed.state === "authenticated") {
          const observation = await route.observeSignInStatus();
          if (
            chatGptRoute() === route &&
            route.isCurrentSignInStatus(observation) &&
            observation.state === "authenticated" &&
            observation.binding !== null
          )
            setSetupSignInCheck({
              buildId: buildIdentity.buildId,
              binding: observation.binding,
            });
        }
        return ProductConfigurationResultSchema.parse({
          ...recorded,
          evidence: { kind: "chatgpt.readiness", ...observed },
        });
      }
      case "chatgpt.sign-in-return":
      case "chatgpt.verification-return": {
        if (embeddedBrowserEnabled()) {
          // This ends observation only. Renderer navigation conceals the retained
          // view; a later read or popup outcome cannot change that destination.
          const observingSignIn = chatGptRoute()?.returnFromSignIn() ?? false;
          // Readonly checks may already have ended sign-in mode. Explicit Return
          // still retires that observation generation without restoring layout.
          if (!observingSignIn) setChatGptSignInOpenGeneration(null);
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
