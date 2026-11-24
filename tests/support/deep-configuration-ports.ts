import type { ConfigurationDeepPorts } from "../../apps/desktop/configuration/deep";

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

const defaults: ConfigurationDeepPorts = {
  configuration: fn("configuration"),
  desktopGoCore: fn("desktopGoCore"),
  secureMcpConnectorRuntime: fn("secureMcpConnectorRuntime"),
  chatGptRoute: fn("chatGptRoute"),
  liveTaskRoutes: trap("liveTaskRoutes"),
  selectedTaskId: fn("selectedTaskId"),
  section: fn("section"),
  shellOverlay: fn("shellOverlay"),
  browserHomeSurfaceOpen: fn("browserHomeSurfaceOpen"),
  setBrowserHomeSurfaceOpen: fn("setBrowserHomeSurfaceOpen"),
  deepTestRecoveryReady: fn("deepTestRecoveryReady"),
  setDeepTestRecoveryReady: fn("setDeepTestRecoveryReady"),
  recoverableDeepTests: fn("recoverableDeepTests"),
  setRecoverableDeepTests: fn("setRecoverableDeepTests"),
  pendingChatGptReadonlyTask: fn("pendingChatGptReadonlyTask"),
  pendingChatGptAttachmentTask: fn("pendingChatGptAttachmentTask"),
  recoverableChatGptTask: fn("recoverableChatGptTask"),
  connectorStartInFlight: fn("connectorStartInFlight"),
  summaryFenceRecovery: fn("summaryFenceRecovery"),
  desktopAdmission: trap("desktopAdmission"),
  liveTaskRegistry: trap("liveTaskRegistry"),
  buildIdentity: trap("buildIdentity"),
  statePaths: fn("statePaths"),
  configurationFailure: fn("configurationFailure"),
  chatGptConversationAdmissionFailure: fn(
    "chatGptConversationAdmissionFailure",
  ),
  currentSurfaceLayout: fn("currentSurfaceLayout"),
  connectorRuntimeUncertain: fn("connectorRuntimeUncertain"),
  computerConnectorAdmission: fn("computerConnectorAdmission"),
  currentConnectorAttachment: fn("currentConnectorAttachment"),
  selectedConnectorApp: fn("selectedConnectorApp"),
  connectorWorkspaceSelection: fn("connectorWorkspaceSelection"),
  connectorAppBindingCurrent: fn("connectorAppBindingCurrent"),
};

export function scriptedDeepPorts(
  overrides: Partial<ConfigurationDeepPorts> = {},
): ConfigurationDeepPorts {
  return { ...defaults, ...overrides };
}
