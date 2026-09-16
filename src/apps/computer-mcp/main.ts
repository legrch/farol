import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "node:path";
import process from "node:process";

import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";
import { createReadonlyComputerMcpServer } from "../../modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import {
  loadReadonlyComputerLaunchContract,
  materializeReadonlyComputerLaunch,
} from "./launch-contract";

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
  const workspace = new NativeReadonlyWorkspace({
    helperPath: path.join(path.dirname(entryFile), "computer-safe-open.py"),
    helper: NEXT_SAFE_OPEN_HELPER,
  });
  const launch = materializeReadonlyComputerLaunch(
    await loadReadonlyComputerLaunchContract(launchFile, workspace),
    Date.now(),
  );
  const contract = new ReadonlyComputerContractHandler(
    new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository(launch.participants),
      new InMemoryComputerApprovalRepository([launch.approval]),
      workspace,
      { now: () => Date.now() },
    ),
  );
  const handle = serveStdio(
    () => createReadonlyComputerMcpServer(contract, launch.binding),
    {
      legacy: "serve",
      onerror: () => {
        process.stderr.write("Farol Next Computer MCP transport failed.\n");
      },
    },
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch(() => {
  process.stderr.write("Farol Next Computer MCP failed to start.\n");
  process.exit(1);
});
