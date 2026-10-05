import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  ConnectorMutationBridge,
  connectorSupportsMutations,
} from "../../../apps/desktop/bridge/connector-mutation";
import { SocketConnectorClient } from "../../../apps/desktop/bridge/connector-client";
import { loadConnectorLaunch } from "../../../apps/desktop/bridge/connector-launch";
import { ComputerBridge } from "../../../apps/desktop/bridge/computer";
import { ConnectorVerificationBridge } from "../../../apps/desktop/bridge/connector-verification";
import { createGoComputerMcpServer } from "../../../apps/desktop/bridge/computer-mcp";
import { PrivateMcpLifecycle } from "../../modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";

// Stdio, socket and existing adapter drain mechanics only. This path never
// constructs a workspace helper, authority repository, shell or provider host.
export async function runGoComputerMcp(file: string): Promise<void> {
  const { launch, sha256 } = loadConnectorLaunch(file);
  const lifecycle = new PrivateMcpLifecycle(launch.lifecycleRoot);
  const lease = await lifecycle.join(sha256);
  const client = new SocketConnectorClient(launch.opened.endpoint);
  let mutations: ConnectorMutationBridge | undefined;
  try {
    const identity = await client.connect();
    if (connectorSupportsMutations(identity)) {
      mutations = new ConnectorMutationBridge(
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
  const handle = serveStdio(
    () =>
      createGoComputerMcpServer(
        bridge,
        launch.opened.execution,
        client.verifiedContext,
        { lifecycle, fence, verification, ...(mutations ? { mutations } : {}) },
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
  const close = (): Promise<void> => {
    if (closing) return closing;
    lifecycle.closeHandlers();
    clearInterval(poll);
    closing = (async () => {
      const results = await Promise.allSettled([
        handle.close(),
        lifecycle.waitForHandlers(),
      ]);
      await client.close();
      if (results.some((result) => result.status !== "fulfilled"))
        throw new Error("COMPUTER_MCP_GO_DRAIN_UNCONFIRMED");
      // This settles this adapter, not native Go handlers. The desktop then
      // closes its exact Go owner before confirming the overall connector drain.
      await lease.release();
    })();
    void closing.then(
      () => process.exit(0),
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
}
