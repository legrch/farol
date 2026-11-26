import { quitCollect } from "../../apps/desktop/host/collect";
import type { OwnedCloser } from "../../src/apps/desktop/quit-drain";

// Build the real Quit collection step over a characterization context whose
// fields stand in for main's owners. Each field is read when the collection
// runs, never when it is built, and each one-shot slot is cleared as main's
// takes clear theirs. Test-only; it grants no host authority.
type Context = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function take(context: Context, name: string): any {
  const value = context[name] ?? null;
  context[name] = null;
  return value;
}

export function collectFromContext(
  context: Context,
): (value: { deadlineAt: number }) => readonly OwnedCloser[] {
  return (value) =>
    quitCollect({
      installedUpdates: context.installedUpdates,
      statePaths: () => ({ attachmentStaging: "/controlled-only/staging" }),
      takeAttachmentTask: () => take(context, "pendingChatGptAttachmentTask"),
      takeAgentCheck: () => take(context, "activeCodexAgentCheck"),
      takeProductAgent: () => take(context, "activeProductAgentSession"),
      takePersistedProductAgentExpiry: () =>
        take(context, "persistedProductAgentExpiry"),
      hostCheckClients: context.hostCheckClients,
      secureMcpConnectorRuntime: () => context.secureMcpConnectorRuntime,
      desktopGoCore: () => context.desktopGoCore,
      savedBridge: context.bridge.saved,
      connectorStartInFlight: () => context.connectorStartInFlight,
      startupConnectionChecking: () => context.startupConnectionChecking,
      connectorStartCancellation: () => context.connectorStartCancellation,
      connectorStartQuitBudgetMs: context.CONNECTOR_START_QUIT_BUDGET_MS,
      stopAndConfirmComputerMcp: (...args: unknown[]) =>
        context.stopAndConfirmComputerMcp(...args),
      operationsStore: () => context.operationsStore(),
      takeModelLifecycle: () => take(context, "modelLifecycle"),
      takeRouteB: () => {
        const routeB = context.contextHost.routeB.get();
        context.contextHost.routeB.set(null);
        return routeB;
      },
      takeRelay: () => {
        const relay = context.bridge.relay.get();
        context.bridge.relay.set(null);
        return relay;
      },
      disposeChatGptRoutes: () => context.disposeChatGptRoutes(),
      disposeRuntimeTaskViews: () => context.disposeTaskViews("runtime"),
      ownedLocalRuntimes: context.ownedLocalRuntimes,
      stopRuntime: () => context.stopRuntime(),
      now: () => Date.now(),
    })(value);
}
