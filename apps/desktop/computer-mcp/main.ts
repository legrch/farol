import { PersistentClaudeHandoff } from "../../../src/modules/chat/app/service/persistent-claude-handoff";
import { AdmittedClaudeTaskRoute } from "../../../src/modules/chat/infra/native/admitted-claude-task-route";
import { SandboxedClaudePrintHost } from "../../../src/modules/chat/infra/native/sandboxed-claude-print-host";
import { PrivateClaudeHandoffJournal } from "../../../src/modules/chat/infra/repo/private-claude-handoff-journal";
import { ClaudeTaskProcessPeer } from "../../../src/modules/computer/infra/peer/claude-task-process-peer";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { connectorLaunchBasename } from "../bridge/connector-launch";
import { runGoComputerMcp } from "./go-main";

import { RunMutableComputerAction } from "../../../src/modules/computer/app/service/run-mutable-computer-action";
import { RunReadonlyComputerAction } from "../../../src/modules/computer/app/service/run-readonly-computer-action";
import { createReadonlyComputerMcpServer } from "../../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { MutableComputerContractHandler } from "../../../src/modules/computer/infra/mutable-contract-handler";
import {
  NativeReadonlyWorkspace,
  SAFE_OPEN_HELPER,
} from "../../../src/modules/computer/infra/native/native-readonly-workspace";
import { Sha256WorkspaceMutationDigester } from "../../../src/modules/computer/infra/native/sha256-workspace-mutation-digester";
import { ReadonlyComputerContractHandler } from "../../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../../src/modules/computer/infra/repo/in-memory-authorities";
import { CurrentOwnerComputerApprovals } from "../../../src/modules/computer/infra/repo/current-owner-computer-approvals";
import { RenewableComputerAuthority } from "../../../src/modules/computer/infra/mcp/renewable-computer-authority";
import {
  renewingReadonlyComputerContract,
  renewingMutableComputerContract,
} from "../../../src/modules/computer/infra/mcp/renewing-computer-contracts";
import { InMemoryComputerApprovalRepository } from "../../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { PrivateWorkspaceMutationStore } from "../../../src/modules/computer/infra/repo/private-workspace-mutation-store";
import {
  loadReadonlyComputerLaunchContract,
  materializeReadonlyComputerLaunch,
  serializeReadonlyComputerLaunchContract,
  ReadonlyComputerLaunchContractSchema,
} from "../../../src/modules/computer/infra/mcp/launch-contract";
import { PrivateConnectorVerificationRecorder } from "../../../src/modules/computer/infra/mcp/connector-verification-receipt";
import { PrivateExecutionFence } from "../../../src/modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../../src/modules/computer/infra/mcp/private-mcp-lifecycle";
import { PrivateDevMcpProofRecorder } from "../../../src/modules/computer/infra/mcp/dev-mcp-proof";
import { CodexCallerRelayClient } from "./codex-caller-relay-client";
import { SavedChatBridgeClient } from "./saved-chat-bridge-client";
import { SandboxedWorkspaceShell } from "../../../src/modules/computer/infra/native/sandboxed-workspace-shell";
import { PersistentCodexHandoff } from "../../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../../src/modules/chat/infra/native/admitted-codex-task-route";
import { PhysicalCodexHandoffAuthority } from "../../../src/modules/chat/infra/native/physical-codex-handoff-authority";
import { Sha256HandoffRequestDigester } from "../../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { SharedCodexProxyHost } from "../../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { PrivateCodexHandoffJournal } from "../../../src/modules/chat/infra/repo/private-codex-handoff-journal";

function launchContractArgument(arguments_: readonly string[]): string {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--launch-contract" ||
    arguments_[1] === undefined
  ) {
    throw new Error("COMPUTER_MCP_ARGUMENTS_INVALID");
  }
  return arguments_[1];
}

async function main(): Promise<void> {
  const launchFile = launchContractArgument(process.argv.slice(2));
  const entryFile = process.argv[1];
  if (entryFile === undefined || !path.isAbsolute(entryFile)) {
    throw new Error("COMPUTER_MCP_ENTRY_INVALID");
  }
  if (path.basename(launchFile) === connectorLaunchBasename) {
    // Selection is explicit and terminal. An unavailable Go owner never falls
    // through to a legacy authority, helper, shell or provider route.
    await runGoComputerMcp(launchFile);
    return;
  }
  const workspace = new NativeReadonlyWorkspace({
    helperPath: path.join(path.dirname(entryFile), "computer-safe-open.py"),
    helper: SAFE_OPEN_HELPER,
  });
  const loaded = await loadReadonlyComputerLaunchContract(
    launchFile,
    workspace,
  );
  const launchDigest = createHash("sha256")
    .update(serializeReadonlyComputerLaunchContract(loaded))
    .digest("hex");
  const lifecycle = new PrivateMcpLifecycle(path.dirname(launchFile));
  // Registration precedes every optional host process and stdio serving.
  const source = loaded.schema === 2 ? loaded.approvalSource : undefined;
  const approvals = source
    ? new CurrentOwnerComputerApprovals(source, Date.now)
    : new InMemoryComputerApprovalRepository([loaded.approval]);
  const renewable = source
    ? new RenewableComputerAuthority(loaded, approvals, Date.now)
    : undefined;
  // Reconnect may reuse an expired launch ceiling. Only a fresh read of the
  // current owner policy permits materialization; its lifecycle digest and
  // operation journals remain unchanged.
  const initial = await renewable?.admitExecution(15_000);
  const launch = materializeReadonlyComputerLaunch(
    initial
      ? ReadonlyComputerLaunchContractSchema.parse({
          ...loaded,
          approval: initial.approval,
          admission: {
            ...loaded.admission,
            expiresAt: initial.approval.expiresAt,
          },
        })
      : loaded,
    Date.now(),
  );
  const lifecycleLease = await lifecycle.join(launchDigest);
  const authorities =
    renewable ?? new InMemoryAuthorityRepository(launch.participants);
  const readonlyHandler = new ReadonlyComputerContractHandler(
    new RunReadonlyComputerAction(authorities, approvals, workspace, {
      now: () => Date.now(),
    }),
  );
  const mutableHandler = launch.mutationEnabled
    ? new MutableComputerContractHandler(
        new RunMutableComputerAction(
          authorities,
          approvals,
          new PrivateWorkspaceMutationStore({ root: path.dirname(launchFile) }),
          new Sha256WorkspaceMutationDigester(),
          workspace,
          { now: () => Date.now() },
        ),
      )
    : undefined;
  const contract = renewable
    ? renewingReadonlyComputerContract(readonlyHandler, renewable)
    : readonlyHandler;
  const mutableContract =
    renewable && mutableHandler
      ? renewingMutableComputerContract(mutableHandler, renewable)
      : mutableHandler;
  const connectorVerification = launch.connectorVerification
    ? new PrivateConnectorVerificationRecorder({
        root: path.dirname(launchFile),
        challengeSha256: launch.connectorVerification.challengeSha256,
      })
    : undefined;
  const callerRelay = launch.callerRelay
    ? new CodexCallerRelayClient(launch.callerRelay)
    : undefined;
  const savedChat = launch.savedChat
    ? new SavedChatBridgeClient(launch.savedChat)
    : undefined;
  const fence = new PrivateExecutionFence({ root: path.dirname(launchFile) });
  const taskLaunch = launch.codexTasks;
  const sharedHost = taskLaunch
    ? await SharedCodexProxyHost.attach({
        ...taskLaunch.host,
        cwd: path.dirname(launchFile),
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          error.message === "CODEX_PROXY_CLEANUP_UNVERIFIED"
        )
          throw error;
        process.stderr.write(
          "Codex task route unavailable; Computer remains ready.\n",
        );
        return undefined;
      })
    : undefined;
  const codexTasks =
    taskLaunch && sharedHost
      ? new AdmittedCodexTaskRoute(
          new PersistentCodexHandoff(
            new PhysicalCodexHandoffAuthority({
              workspaceId: taskLaunch.grant.workspaceId,
              writerRoot: taskLaunch.grant.writerRoot,
              writerIdentity: taskLaunch.grant.writerIdentity,
              projectRoot: taskLaunch.grant.projectRoot,
              projectIdentity: taskLaunch.grant.projectIdentity,
              gitCommonDirectory: taskLaunch.grant.gitCommonDirectory,
              execution: taskLaunch.grant.execution,
            }),
            sharedHost,
            new PrivateCodexHandoffJournal(
              path.join(path.dirname(launchFile), "codex-task-journal"),
            ),
            new Sha256HandoffRequestDigester(),
            taskLaunch.grant.expiresAt,
            fence,
            Date.now,
            taskLaunch.grant.observeThreadId,
          ),
          taskLaunch.grant,
        )
      : undefined;
  const devMcpProof = launch.devMcpProof
    ? new PrivateDevMcpProofRecorder(
        path.dirname(path.dirname(launch.devMcpProof.workspaceRoot)),
        launch.devMcpProof,
      )
    : undefined;
  // The desktop raises a fence in the launch root while a summary-only
  // phase runs; no tool executes until it is lowered.
  const shell =
    launch.approval.commands === "workspace"
      ? new SandboxedWorkspaceShell(
          launch.approval,
          launch.participants.at(-1)!,
          launch.binding,
          path.dirname(launchFile),
          undefined,
          launch.gitSettingsHome ?? undefined,
          renewable,
        )
      : undefined;
  const claudeLaunch = launch.claudeTasks;
  const claudeAuthority = claudeLaunch
    ? new PhysicalCodexHandoffAuthority(claudeLaunch.grant)
    : undefined;
  // No desktop issuer emits this fixture-only grant. Native Claude remains unqualified.
  const claudeTasks =
    claudeLaunch && claudeAuthority && shell
      ? new AdmittedClaudeTaskRoute(
          new PersistentClaudeHandoff(
            claudeAuthority,
            new SandboxedClaudePrintHost(
              claudeLaunch.host,
              new ClaudeTaskProcessPeer(
                shell,
                fence,
                claudeLaunch.grant.expiresAt,
                async () => {
                  const current = await claudeAuthority.resolve(
                    claudeLaunch.grant.workspaceId,
                  );
                  return (
                    Date.now() < claudeLaunch.grant.expiresAt &&
                    current !== null
                  );
                },
              ),
              claudeLaunch.grant.expiresAt,
            ),
            new PrivateClaudeHandoffJournal(
              path.join(path.dirname(launchFile), "claude-task-journal"),
            ),
            {
              digest(value: unknown) {
                return createHash("sha256")
                  .update(JSON.stringify(value))
                  .digest("hex");
              },
            },
            claudeLaunch.grant,
            fence,
            Date.now,
          ),
          claudeLaunch.grant,
        )
      : undefined;
  const handle = serveStdio(
    () =>
      createReadonlyComputerMcpServer(
        contract,
        launch.binding,
        mutableContract,
        connectorVerification,
        callerRelay,
        fence,
        devMcpProof,
        codexTasks,
        shell,
        lifecycle,
        savedChat,
        claudeTasks,
        launch.workspaceCatalogueIds,
      ),
    {
      legacy: "serve",
      onerror: () => {
        process.stderr.write("Farol Computer MCP transport failed.\n");
      },
    },
  );
  let closing = false;
  let poll: NodeJS.Timeout | undefined;
  const close = () => {
    if (closing) return;
    closing = true;
    if (poll) clearInterval(poll);
    lifecycle.closeHandlers();
    const shellDrain = shell?.closeAndWait() ?? Promise.resolve("confirmed");
    const handlerDrain = lifecycle.waitForHandlers();
    const proxyDrain = sharedHost?.closeAndWait() ?? Promise.resolve(true);
    void Promise.allSettled([
      shellDrain,
      handle.close(),
      handlerDrain,
      proxyDrain,
    ]).then(async (results) => {
      if (
        results[0]?.status !== "fulfilled" ||
        results[0].value !== "confirmed" ||
        results[1]?.status !== "fulfilled" ||
        results[2]?.status !== "fulfilled" ||
        results[3]?.status !== "fulfilled" ||
        results[3].value !== true
      ) {
        process.stderr.write("Farol Computer MCP shutdown unverified.\n");
        process.exit(1);
      }
      await lifecycleLease.release();
      process.exit(0);
    });
  };
  poll = setInterval(() => {
    void lifecycle
      .isStopping()
      .then((stopping) => {
        if (stopping) close();
      })
      .catch(close);
  }, 50);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.stdin.once("end", close);
  process.once("exit", () => shell?.close());
}

void main().catch(() => {
  process.stderr.write("Farol Computer MCP failed to start.\n");
  process.exit(1);
});
