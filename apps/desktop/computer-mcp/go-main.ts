import path from "node:path";
import { OperationsStore } from "../operations/store";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  ConnectorMutationBridge,
  connectorSupportsMutations,
} from "../bridge/connector-mutation";
import {
  ConnectorProcessBridge,
  connectorSupportsProcesses,
} from "../bridge/connector-process";
import { SocketConnectorClient } from "../bridge/connector-client";
import { loadConnectorLaunch } from "../bridge/connector-launch";
import { ComputerBridge } from "../bridge/computer";
import { ConnectorVerificationBridge } from "../bridge/connector-verification";
import { createGoComputerMcpServer } from "../bridge/computer-mcp";
import {
  selectedCodexReadBridge,
  type SelectedCodexReadBridge,
} from "../bridge/selected-codex-read";
import { PrivateMcpLifecycle } from "../../../src/modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateExecutionFence } from "../../../src/modules/computer/infra/mcp/execution-fence";

// Stdio, socket and existing adapter drain mechanics only. This path never
// constructs a workspace helper, authority repository, shell or provider host.
export async function runGoComputerMcp(file: string): Promise<void> {
  const { launch, sha256 } = loadConnectorLaunch(file);
  const lifecycle = new PrivateMcpLifecycle(launch.lifecycleRoot);
  const lease = await lifecycle.join(sha256);
  const client = new SocketConnectorClient(launch.opened.endpoint);
  let mutations: ConnectorMutationBridge | undefined;
  let processes: ConnectorProcessBridge | undefined;
  let codexRead: SelectedCodexReadBridge | undefined;
  let connectionStatusAvailable = false;
  try {
    const identity = await client.connect();
    codexRead = selectedCodexReadBridge(client, launch.opened, identity);
    // connect() has validated the actual endpoint handshake. An old backend
    // without this method must not advertise a status tool that cannot work.
    connectionStatusAvailable = identity.capabilities.includes(
      "computer.connector.verification",
    );
    if (connectorSupportsMutations(identity)) {
      mutations = new ConnectorMutationBridge(
        client,
        launch.opened,
        client.verifiedContext,
      );
    }
    if (connectorSupportsProcesses(identity)) {
      processes = new ConnectorProcessBridge(
        client,
        launch.opened,
        client.verifiedContext,
      );
    }
  } catch (error) {
    await client.close();
    // No module request has been admitted before the completed handshake.
    await lease.release();
    throw error;
  }
  const fence = new PrivateExecutionFence({ root: launch.lifecycleRoot });
  const bridge = new ComputerBridge(client);
  const verification = new ConnectorVerificationBridge(
    client,
    launch.opened,
    launch.challengeSha256,
  );
  const operations = new OperationsStore(
    path.join(path.dirname(path.dirname(launch.lifecycleRoot)), "operations"),
  );
  await operations.loadWorkspaceLabels();
  let effectOutcomeUnknown = false;
  const handle = serveStdio(
    () =>
      createGoComputerMcpServer(
        bridge,
        launch.opened.execution,
        client.verifiedContext,
        {
          operations,
          lifecycle,
          fence,
          verification,
          onEffectUnknown: () => {
            effectOutcomeUnknown = true;
          },
          ...(connectionStatusAvailable
            ? { connectionStatus: verification }
            : {}),
          ...(mutations ? { mutations } : {}),
          ...(processes ? { processes } : {}),
          ...(codexRead ? { codexRead } : {}),
        },
      ),
    {
      legacy: "serve",
      onerror: () => {
        process.stderr.write("Farol Go Computer MCP transport failed.\n");
      },
    },
  );
  let closing: Promise<void> | undefined;
  let poll: NodeJS.Timeout;
  let unsubscribeTerminal: (() => void) | undefined;
  let transportFailed = false;
  const close = (): Promise<void> => {
    if (closing) return closing;
    // Publish the one drain before invoking cleanup ports that may reenter close.
    closing = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        handle.close(),
        lifecycle.waitForHandlers(),
      ]);
      await operations.shutdown();
      await client.close();
      if (client.terminal && client.terminal.reason !== "closed")
        transportFailed = true;
      if (results.some((result) => result.status !== "fulfilled"))
        throw new Error("COMPUTER_MCP_GO_DRAIN_UNCONFIRMED");
      // Handler drain and backend result retention cannot exclude a caller's
      // lost reply or earlier UNKNOWN. Keep the original active marker intact.
      // Missing observation from this selected adapter also fails closed.
      if (
        client.hasUnresolvedEffect !== false ||
        effectOutcomeUnknown ||
        client.terminal?.submittedEffectCount !== 0
      )
        throw new Error("COMPUTER_MCP_GO_EFFECT_UNRESOLVED");
      // This settles this adapter, not native Go handlers. The desktop then
      // closes its exact Go owner before confirming the overall connector drain.
      await lease.release();
    });
    lifecycle.closeHandlers();
    clearInterval(poll);
    unsubscribeTerminal?.();
    unsubscribeTerminal = undefined;
    void closing.then(
      // A settled adapter drain cannot turn unexpected connector EOF into
      // clean lifecycle shutdown or prove native Go work was cancelled.
      () => process.exit(transportFailed ? 1 : 0),
      () => {
        process.stderr.write("Farol Go Computer MCP shutdown unverified.\n");
        process.exit(1);
      },
    );
    return closing;
  };
  const requestClose = () => {
    void close().catch(() => undefined);
  };
  poll = setInterval(() => {
    void lifecycle
      .isStopping()
      .then((stopping) => {
        if (stopping) requestClose();
      })
      .catch(requestClose);
  }, 50);
  process.once("SIGINT", requestClose);
  process.once("SIGTERM", requestClose);
  process.stdin.once("end", requestClose);
  // Subscribe only after the handshake, handle and close path are ready. A
  // terminal between setup and subscription is delivered synchronously once.
  const unsubscribe = client.onTerminal((terminal) => {
    if (terminal.reason !== "closed") transportFailed = true;
    requestClose();
  });
  if (closing) unsubscribe();
  else unsubscribeTerminal = unsubscribe;
}
