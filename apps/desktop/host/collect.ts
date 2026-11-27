import type { OwnedCloser } from "../../../src/apps/desktop/quit-drain";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import { discardChatGptAttachments } from "../../../src/apps/desktop/chatgpt-attachment-staging";
import { goCoreQuitClosers } from "../go-core-quit-closers";
import type { DesktopGoCore } from "../go-core-host";
import type { Cell } from "./cell";
import { observeOperation } from "../operations/observe";
import type { OperationsStore } from "../operations/store";
import type { SavedChatBridgeRuntime } from "../runtime/bridge";

// Quit's collection step: every owned child the drain must wait for, gathered
// in the order main always gathered them. It takes the one-shot owners out of
// main's slots as it goes (each `take` reads and clears its slot at the moment
// the step runs, never at construction), so a child that unregisters itself
// afterwards is still drained and a second collection finds nothing. The
// synchronous effects (discarding the staged attachment, disposing the hosts,
// clearing the expiry timer, aborting the connector start) happen at the same
// points relative to the closers they feed. Nothing here awaits: the closers
// are returned for the drain to run concurrently.

type Closeable = Readonly<{ close: () => Promise<void> }>;

export type CollectPorts = Readonly<{
  installedUpdates: Readonly<{ close: () => Promise<void> }>;
  statePaths: () => Readonly<{ attachmentStaging: string }>;
  takeAttachmentTask: () => Readonly<{ operationId: string }> | null;
  takeAgentCheck: () => Readonly<{
    host: { dispose(): void };
    client: Closeable;
  }> | null;
  takeProductAgent: () => Readonly<{
    expiryTimer?: NodeJS.Timeout | null | undefined;
    host: { dispose(): void };
    client: Closeable;
  }> | null;
  takePersistedProductAgentExpiry: () => Readonly<{
    timer: NodeJS.Timeout;
  }> | null;
  hostCheckClients: Iterable<Closeable>;
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  desktopGoCore: () => DesktopGoCore | null;
  savedBridge: Pick<Cell<SavedChatBridgeRuntime | null>, "get" | "set">;
  connectorStartInFlight: () => Promise<void> | null;
  startupConnectionChecking: () => boolean;
  connectorStartCancellation: () => { abort(): void } | null;
  connectorStartQuitBudgetMs: number;
  stopAndConfirmComputerMcp: (
    connector: SecureMcpConnectorRuntime,
    inFlightStart: Promise<void> | null,
    core: DesktopGoCore | null,
    savedChat: SavedChatBridgeRuntime | null,
    reason: undefined,
    originalStopParent: undefined,
    quitStartDeadlineAt: number | undefined,
  ) => Promise<void>;
  operationsStore: () => OperationsStore;
  takeModelLifecycle: () => Readonly<{ stop: () => Promise<void> }> | null;
  takeRouteB: () => Closeable | null;
  takeRelay: () => Closeable | null;
  disposeChatGptRoutes: () => void;
  disposeRuntimeTaskViews: () => void;
  ownedLocalRuntimes: Iterable<readonly [Closeable, string]>;
  stopRuntime: () => void;
  now: () => number;
}>;

export function quitCollect(
  ports: CollectPorts,
): (context: Readonly<{ deadlineAt: number }>) => readonly OwnedCloser[] {
  return (context) => {
    const closers: OwnedCloser[] = [
      {
        name: "installed-updater",
        close: () => ports.installedUpdates.close(),
      },
    ];
    const attachmentTask = ports.takeAttachmentTask();
    if (attachmentTask) {
      void discardChatGptAttachments(
        ports.statePaths().attachmentStaging,
        attachmentTask.operationId,
      );
    }
    const agentCheck = ports.takeAgentCheck();
    agentCheck?.host.dispose();
    if (agentCheck) {
      closers.push({
        name: "agent-check",
        close: () => agentCheck.client.close(),
      });
    }
    const productAgent = ports.takeProductAgent();
    const persistedExpiry = ports.takePersistedProductAgentExpiry();
    if (persistedExpiry) clearTimeout(persistedExpiry.timer);
    if (productAgent?.expiryTimer) clearTimeout(productAgent.expiryTimer);
    productAgent?.host.dispose();
    if (productAgent) {
      closers.push({
        name: "product-agent",
        close: () => productAgent.client.close(),
      });
    }
    for (const client of ports.hostCheckClients) {
      closers.push({ name: "host-check", close: () => client.close() });
    }
    const connector = ports.secureMcpConnectorRuntime();
    const core = ports.desktopGoCore();
    const savedChat = ports.savedBridge.get();
    const quitStartDeadlineAt =
      connector &&
      (ports.connectorStartInFlight() || ports.startupConnectionChecking())
        ? Math.min(
            context.deadlineAt,
            ports.now() + ports.connectorStartQuitBudgetMs,
          )
        : undefined;
    ports.connectorStartCancellation()?.abort();
    let beforeCore: OwnedCloser | null = null;
    if (connector) {
      const inFlightStart = ports.connectorStartInFlight();
      beforeCore = {
        name: "connector",
        close: async () => {
          try {
            await ports.stopAndConfirmComputerMcp(
              connector,
              inFlightStart,
              core,
              savedChat,
              undefined,
              undefined,
              quitStartDeadlineAt,
            );
          } finally {
            // Even an unconfirmed MCP drain must close account admission.
            // close() waits for already admitted work; it does not cancel Send
            // or turn the rejected connector close into a confirmed drain.
            if (savedChat) {
              await savedChat.close();
              if (ports.savedBridge.get() === savedChat)
                ports.savedBridge.set(null);
            }
          }
        },
      };
    } else if (savedChat) {
      ports.savedBridge.set(null);
      beforeCore = {
        name: "saved-chat-bridge",
        close: () => savedChat.close(),
      };
    }
    closers.push(
      ...goCoreQuitClosers(
        beforeCore,
        core
          ? () =>
              observeOperation(
                ports.operationsStore(),
                { source: "You", kind: "hub.stop", target: {} },
                () => core.close(),
              )
          : null,
        () => ports.now() < context.deadlineAt,
        quitStartDeadlineAt,
      ),
    );
    const model = ports.takeModelLifecycle();
    if (model) {
      closers.push({ name: "model-endpoint", close: () => model.stop() });
    }
    const routeB = ports.takeRouteB();
    if (routeB) closers.push({ name: "route-b", close: () => routeB.close() });
    const relay = ports.takeRelay();
    if (relay)
      closers.push({ name: "caller-relay", close: () => relay.close() });
    ports.disposeChatGptRoutes();
    ports.disposeRuntimeTaskViews();
    for (const [lifetime, name] of ports.ownedLocalRuntimes) {
      closers.push({ name, close: () => lifetime.close() });
    }
    ports.stopRuntime();
    return closers;
  };
}
