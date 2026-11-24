import type { ConfigurationChatgptPorts } from "../../apps/desktop/configuration/chatgpt";

// Test-only. Every port starts as one that fails loudly when a test did not
// script it, so a handler can never reach main's state or a native owner by
// accident. This grants no host authority and is not live-provider evidence.
function unscripted(name: string): never {
  throw new Error(`PORT_UNSCRIPTED:${name}`);
}
const fn = (name: string): never =>
  (() => {
    unscripted(name);
  }) as never;
const trap = (name: string): never =>
  new Proxy(
    {},
    { get: (_target, property) => unscripted(`${name}.${String(property)}`) },
  ) as never;

const defaults: ConfigurationChatgptPorts = {
  configuration: fn("configuration"),
  chatGptRoute: fn("chatGptRoute"),
  chatGptE2eOrigin: fn("chatGptE2eOrigin"),
  desktopGoCore: fn("desktopGoCore"),
  goChatStartupProfile: fn("goChatStartupProfile"),
  directChatStart: fn("directChatStart"),
  setDirectChatStart: fn("setDirectChatStart"),
  goReadonlyConversation: fn("goReadonlyConversation"),
  setGoReadonlyConversation: fn("setGoReadonlyConversation"),
  pendingChatGptReadonlyTask: fn("pendingChatGptReadonlyTask"),
  setPendingChatGptReadonlyTask: fn("setPendingChatGptReadonlyTask"),
  pendingChatGptAttachmentTask: fn("pendingChatGptAttachmentTask"),
  setPendingChatGptAttachmentTask: fn("setPendingChatGptAttachmentTask"),
  recoverableChatGptTask: fn("recoverableChatGptTask"),
  setRecoverableChatGptTask: fn("setRecoverableChatGptTask"),
  recoverableChatGptObservationPersisted: fn(
    "recoverableChatGptObservationPersisted",
  ),
  setRecoverableChatGptObservationPersisted: fn(
    "setRecoverableChatGptObservationPersisted",
  ),
  chatGptConversationStore: fn("chatGptConversationStore"),
  setChatGptConversation: fn("setChatGptConversation"),
  chatGptTaskJournal: fn("chatGptTaskJournal"),
  chatGptSignInGeneration: fn("chatGptSignInGeneration"),
  setChatGptSignInGeneration: fn("setChatGptSignInGeneration"),
  chatGptSignInOpenGeneration: fn("chatGptSignInOpenGeneration"),
  setChatGptSignInOpenGeneration: fn("setChatGptSignInOpenGeneration"),
  setChatGptSignInOutcome: fn("setChatGptSignInOutcome"),
  selectedTaskId: fn("selectedTaskId"),
  browserHomeSurfaceOpen: fn("browserHomeSurfaceOpen"),
  setBrowserHomeSurfaceOpen: fn("setBrowserHomeSurfaceOpen"),
  setSetupSignInCheck: fn("setSetupSignInCheck"),
  attachmentStagingReady: fn("attachmentStagingReady"),
  setAttachmentStagingReady: fn("setAttachmentStagingReady"),
  desktopAdmission: trap("desktopAdmission"),
  chatGptSignInBlocked: trap("chatGptSignInBlocked"),
  liveTaskRoutes: trap("liveTaskRoutes"),
  liveTaskRegistry: trap("liveTaskRegistry"),
  readonlyAccountConfirmations: trap("readonlyAccountConfirmations"),
  buildIdentity: trap("buildIdentity"),
  activeDesktopIdentity: trap("activeDesktopIdentity"),
  runtimeEnvironment: "dev",
  compiledGoCore: null,
  nativeWorkspace: trap("nativeWorkspace"),
  SIGN_IN_WINDOW_TITLE: "Fixture sign-in",
  statePaths: fn("statePaths"),
  configurationFailure: fn("configurationFailure"),
  embeddedBrowserEnabled: fn("embeddedBrowserEnabled"),
  applyLayout: fn("applyLayout"),
  chatGptConversationContinuity: fn("chatGptConversationContinuity"),
  chatGptConversationAdmissionFailure: fn(
    "chatGptConversationAdmissionFailure",
  ),
  retainChatGptConversation: fn("retainChatGptConversation"),
  chatGptJournalObservation: fn("chatGptJournalObservation"),
  chatGptAppPreSubmitObservation: fn("chatGptAppPreSubmitObservation"),
  chatGptAttachmentTaskPreview: fn("chatGptAttachmentTaskPreview"),
  chatGptReadonlyTaskPreview: fn("chatGptReadonlyTaskPreview"),
  attachmentStagingFailure: fn("attachmentStagingFailure"),
  discardPreparedChatGptTask: fn("discardPreparedChatGptTask"),
  discardPreparedReadonlyTask: fn("discardPreparedReadonlyTask"),
  withdrawGoReadonlyAdmission: fn("withdrawGoReadonlyAdmission"),
  readonlyAccountCurrent: fn("readonlyAccountCurrent"),
  selectedChatGptAttachmentPaths: fn("selectedChatGptAttachmentPaths"),
  selectedWorkspaceFile: fn("selectedWorkspaceFile"),
  workspaceReadFailure: fn("workspaceReadFailure"),
  captureChatStartupProfile: fn("captureChatStartupProfile"),
  stageChatGptAttachments: fn("stageChatGptAttachments"),
  verifyStagedChatGptAttachments: fn("verifyStagedChatGptAttachments"),
  discardChatGptAttachments: fn("discardChatGptAttachments"),
  ReadConversationClient: fn("ReadConversationClient"),
  AccountObservationConfirmation: fn("AccountObservationConfirmation"),
  ReadAccountConfirmation: fn("ReadAccountConfirmation"),
};

export function scriptedChatgptPorts(
  overrides: Partial<ConfigurationChatgptPorts> = {},
): ConfigurationChatgptPorts {
  return { ...defaults, ...overrides };
}
