import type { ConfigurationSupportPorts } from "../../apps/desktop/configuration/support";

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

const defaults: ConfigurationSupportPorts = {
  configuration: fn("configuration"),
  configurationFailure: fn("configurationFailure"),
  openExternal: fn("openExternal"),
  selectedSupportExportTarget: fn("selectedSupportExportTarget"),
  productTasksState: fn("productTasksState"),
  operationsStore: fn("operationsStore"),
  writeSupportExport: fn("writeSupportExport"),
  buildIdentity: trap("buildIdentity"),
  runtimeState: fn("runtimeState"),
  runtimeError: fn("runtimeError"),
  runtime: fn("runtime"),
  productAgentCapabilityAvailable: fn("productAgentCapabilityAvailable"),
  routeBRuntime: fn("routeBRuntime"),
  taskCountsBeforeRuntimeExit: fn("taskCountsBeforeRuntimeExit"),
  streamControllers: trap("streamControllers"),
  pendingComputer: trap("pendingComputer"),
  taskSurfaceFailures: trap("taskSurfaceFailures"),
  chatGptRoute: fn("chatGptRoute"),
  setupSignInCheck: fn("setupSignInCheck"),
  desktopAdmission: trap("desktopAdmission"),
  activeAuthorityChangeKind: fn("activeAuthorityChangeKind"),
};

export function scriptedSupportPorts(
  overrides: Partial<ConfigurationSupportPorts> = {},
): ConfigurationSupportPorts {
  return { ...defaults, ...overrides };
}
