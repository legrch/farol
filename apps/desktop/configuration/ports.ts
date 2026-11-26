import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type { SetupCompletionContext } from "../../../src/ui/setup-completion";
import type { PromotionLeaseRegistry } from "../../../src/apps/desktop/chatgpt-journal-lease";
import type {
  PrivateChatGptConversationStore,
  ChatGptConversationRecord,
} from "../../../src/apps/desktop/chatgpt-conversation-store";
import type {
  discardChatGptAttachments,
  stageChatGptAttachments,
  verifyStagedChatGptAttachments,
  StagedChatGptAttachments,
} from "../../../src/apps/desktop/chatgpt-attachment-staging";
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
import type { workspaceDescriptor } from "../../../src/apps/desktop/workspace-descriptor";
import type { AccountObservationConfirmation } from "../account-observation-confirmation";
import type {
  ReadConversationClient,
  ReadConversationProjection,
} from "../bridge/read-conversation";
import type { ChatComputerAdmissionResponse } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { captureChatStartupProfile } from "../go-chat-startup-profile";
import type { DesktopAdmission } from "../host/admission";
import type { ReadAccountConfirmation } from "../read-account-confirmation";

export type ChatgptConfigurationCommand = Exclude<
  Extract<ProductConfigurationCommand, { kind: `chatgpt.${string}` }>,
  {
    kind:
      | "chatgpt.run-deep-test"
      | "chatgpt.deep-test-status"
      | "chatgpt.ack-deep-test";
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
type ConversationTaskState =
  | "completed"
  | "not_authenticated"
  | "failed_before_submit"
  | "outcome_unknown";
type ChatStartupProfile = ReturnType<typeof captureChatStartupProfile>;

// The legacy native workspace as the explicit legacy read uses it. Main adapts
// the real owner to this closed shape.
type NativeWorkspaceReadResult =
  | Readonly<{ ok: false; error: Readonly<{ code: string }> }>
  | Readonly<{
      ok: true;
      value:
        | Readonly<{ kind: "workspace.text"; text: string; bytes: number }>
        | Readonly<{ kind: "workspace.other" }>;
    }>;

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
  setPendingChatGptReadonlyTask: (
    value: PendingChatGptReadonlyTask | null,
  ) => void;
  pendingChatGptAttachmentTask: () => PendingChatGptAttachmentTask | null;
  setPendingChatGptAttachmentTask: (
    value: PendingChatGptAttachmentTask | null,
  ) => void;
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
  attachmentStagingReady: () => boolean;
  setAttachmentStagingReady: (value: boolean) => void;
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
  liveTaskRegistry: PromotionLeaseRegistry;
  readonlyAccountConfirmations: WeakMap<
    PendingChatGptReadonlyTask,
    ReadAccountConfirmation
  >;
  buildIdentity: Readonly<{ buildId: string }>;
  activeDesktopIdentity: Readonly<{ chatGptPartition: string }>;
  runtimeEnvironment: Parameters<
    typeof captureChatStartupProfile
  >[0]["environment"];
  compiledGoCore: unknown;
  nativeWorkspace: Readonly<{
    execute: (
      request: Readonly<{
        workspace: ReturnType<typeof workspaceDescriptor>;
        operation: Readonly<{ kind: "workspace.read"; relativePath: string }>;
      }>,
    ) => Promise<NativeWorkspaceReadResult>;
  }>;
  SIGN_IN_WINDOW_TITLE: string;
  statePaths: () => Readonly<{ attachmentStaging: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  embeddedBrowserEnabled: () => boolean;
  applyLayout: () => void;
  chatGptConversationContinuity: () => ConversationContinuity;
  chatGptConversationAdmissionFailure: () => ProductConfigurationResult | null;
  retainChatGptConversation: (
    operationId: string,
    taskState: ConversationTaskState,
  ) => Promise<ConversationContinuity>;
  chatGptJournalObservation: (result: ChatGptTaskJournalResult) => unknown;
  chatGptAppPreSubmitObservation: (code: string | null) => unknown;
  chatGptAttachmentTaskPreview: (
    pending: PendingChatGptAttachmentTask,
  ) => Readonly<Record<string, unknown>>;
  chatGptReadonlyTaskPreview: (
    pending: PendingChatGptReadonlyTask,
  ) => Readonly<Record<string, unknown>>;
  attachmentStagingFailure: (error: unknown) => ProductConfigurationResult;
  discardPreparedChatGptTask: (operationId: string) => Promise<boolean>;
  discardPreparedReadonlyTask: (
    pending: PendingChatGptReadonlyTask,
  ) => Promise<boolean>;
  withdrawGoReadonlyAdmission: (
    admission: ChatComputerAdmissionResponse | undefined,
  ) => Promise<boolean>;
  readonlyAccountCurrent: (
    pending: PendingChatGptReadonlyTask,
    route: ChatGptRoute,
    core: DesktopGoCore,
  ) => boolean;
  selectedChatGptAttachmentPaths: () => Promise<
    readonly string[] | "cancelled" | "invalid"
  >;
  selectedWorkspaceFile: (
    workspace: ApprovedProductWorkspace,
    labels: Readonly<{ title: string; buttonLabel: string }>,
  ) => Promise<string | "cancelled" | "invalid">;
  workspaceReadFailure: (code: string) => ProductConfigurationResult;
  captureChatStartupProfile: typeof captureChatStartupProfile;
  stageChatGptAttachments: typeof stageChatGptAttachments;
  verifyStagedChatGptAttachments: typeof verifyStagedChatGptAttachments;
  discardChatGptAttachments: typeof discardChatGptAttachments;
  ReadConversationClient: typeof ReadConversationClient;
  AccountObservationConfirmation: typeof AccountObservationConfirmation;
  ReadAccountConfirmation: typeof ReadAccountConfirmation;
}>;
