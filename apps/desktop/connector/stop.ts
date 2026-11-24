import { drainComputerConnector } from "../../../src/apps/desktop/computer-connector-drain";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { DesktopGoCore } from "../go-core-host";
import type { Cell } from "../host/cell";
import { observeOperation } from "../operations/observe";
import type { OperationsStore } from "../operations/store";
import type { SavedChatBridgeRuntime } from "../runtime/bridge";

// Stopping the one Secure MCP connector and confirming that it stopped: the
// private lifecycle that start and stop share, and the ordered stop path that
// drains an in-flight start, stops the connector, closes the saved chat and the
// Go owner, then confirms the lifecycle. Main keeps every owner; each `let`
// there is a late getter here, so the optional arguments default to the live
// owners at the moment of the call, never at the moment this is built. The
// saved chat is the bridge's own cell: the compare-and-clear runs against it at
// the same moment as before. Nothing here retries a stop or reinterprets a
// failure: an unconfirmed stop is thrown, never acknowledged.

// The three calls the stop path makes on the private lifecycle. Main's own
// lifecycle has more, which consumers outside this path still call.
export type StopLifecycle = Readonly<{
  beginStop: () => Promise<void>;
  waitForStop: () => Promise<void>;
  confirmStop: () => Promise<void>;
}>;

export type ConnectorStopPorts<L extends StopLifecycle> = Readonly<{
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  desktopGoCore: () => DesktopGoCore | null;
  saved: Pick<Cell<SavedChatBridgeRuntime | null>, "get" | "set">;
  operationsStore: () => OperationsStore;
  statePaths: () => Readonly<{ secureMcpLaunch: string }>;
  // The concrete lifecycle is a module class; main builds it.
  createLifecycle: (secureMcpLaunch: string) => L;
}>;

export function createConnectorStop<L extends StopLifecycle>(
  ports: ConnectorStopPorts<L>,
) {
  const {
    secureMcpConnectorRuntime,
    desktopGoCore,
    saved,
    operationsStore,
    statePaths,
    createLifecycle,
  } = ports;

  let desktopComputerMcpLifecycle: L | null = null;
  function computerMcpLifecycle(): L {
    // Boot owns one lifecycle so concurrent Start/Stop share stop admission.
    desktopComputerMcpLifecycle ??= createLifecycle(
      statePaths().secureMcpLaunch,
    );
    return desktopComputerMcpLifecycle;
  }

  async function stopAndConfirmComputerMcp(
    connector = secureMcpConnectorRuntime(),
    inFlightStart: Promise<void> | null = null,
    core = desktopGoCore(),
    savedChat = saved.get(),
    reason?: "owner_stop",
    originalStopParent?: string,
    quitStartDeadlineAt?: number,
  ): Promise<void> {
    if (!connector) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
    // Ordinary Stop is forbidden while C7 owns an unresolved original. Only
    // the already-admitted original parent may execute its single native effect.
    if (core && originalStopParent === undefined) {
      const custody = await core.observeOriginalStop();
      if (custody.restricted) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
    }
    if (
      core?.independentSession &&
      inFlightStart === null &&
      !connector.isRunning()
    ) {
      if (originalStopParent !== undefined)
        throw new Error("CONNECTOR_STOP_UNCONFIRMED");
      // This run never owned the retained legacy tunnel. Close only its current
      // native connector/account ports; old lifecycle markers remain history.
      await savedChat?.close();
      await core.closeComputerConnector(reason);
      return;
    }
    const lifecycle = computerMcpLifecycle();
    await observeOperation(
      operationsStore(),
      { source: "You", kind: "connection.stop", target: {} },
      () =>
        connector.observeStopAttempt(() =>
          drainComputerConnector({
            beginStop: () => lifecycle.beginStop(),
            startInFlight: inFlightStart,
            startDeadlineAt: quitStartDeadlineAt,
            waitForMcpStop: () => lifecycle.waitForStop(),
            stopConnector: () => connector.stop(),
            closeSavedChat: async () => {
              // Wait for admitted account work before closing its Browser endpoint.
              try {
                if (savedChat) {
                  await savedChat.close();
                  if (saved.get() === savedChat) saved.set(null);
                }
              } finally {
                // Withdraw the original Go owner even when the old adapter drain fails.
                // A failure remains unconfirmed; it cannot authorize a new launch.
                if (
                  quitStartDeadlineAt !== undefined &&
                  Date.now() >= quitStartDeadlineAt
                )
                  throw new Error("CONNECTOR_STOP_UNCONFIRMED");
                await core?.closeComputerConnector(reason, originalStopParent);
              }
            },
            confirmStop: () => lifecycle.confirmStop(),
          }),
        ),
    );
  }

  return { computerMcpLifecycle, stopAndConfirmComputerMcp };
}
