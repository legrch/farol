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
  pendingChatGptAttachmentTask: fn("pendingChatGptAttachmentTask"),
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
  desktopAdmission: trap("desktopAdmission"),
  chatGptSignInBlocked: trap("chatGptSignInBlocked"),
  liveTaskRoutes: trap("liveTaskRoutes"),
  buildIdentity: trap("buildIdentity"),
  activeDesktopIdentity: trap("activeDesktopIdentity"),
  runtimeEnvironment: "dev",
  SIGN_IN_WINDOW_TITLE: "Fixture sign-in",
  configurationFailure: fn("configurationFailure"),
  embeddedBrowserEnabled: fn("embeddedBrowserEnabled"),
  applyLayout: fn("applyLayout"),
  chatGptConversationContinuity: fn("chatGptConversationContinuity"),
  chatGptJournalObservation: fn("chatGptJournalObservation"),
  captureChatStartupProfile: fn("captureChatStartupProfile"),
  ReadConversationClient: fn("ReadConversationClient"),
  AccountObservationConfirmation: fn("AccountObservationConfirmation"),
};

export function scriptedChatgptPorts(
  overrides: Partial<ConfigurationChatgptPorts> = {},
): ConfigurationChatgptPorts {
  return { ...defaults, ...overrides };
}
