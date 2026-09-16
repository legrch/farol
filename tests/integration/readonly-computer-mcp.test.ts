import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mcp-"));
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, "src", "discovered.ts"),
    "export const protocol = 'mcp-boundary';\n",
    { mode: 0o600 },
  );
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("read-only Computer MCP adapter", () => {
  it("lists only read-only tools and carries delegated authority through a real MCP call", async () => {
    const approval: ComputerApproval = {
      ownerId: "owner-preview",
      computerId: "computer-preview",
      generation: 7,
      workspaces: [{ workspaceId: "farol", root, access: "read" }],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
      expiresAt: 20_000,
    };
    const admission: TaskAdmission = {
      authorityId: "authority-task-a",
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      computerId: "computer-preview",
      computerGeneration: 7,
      workspaces: [
        {
          workspaceId: "farol",
          mode: "subtree",
          root,
          access: "read",
        },
      ],
      capabilities: approval.capabilities,
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    };
    const grant = deriveTaskGrant(approval, admission, 1_000);
    if (!grant.ok) throw new Error(grant.error.code);
    const main = createParticipantAuthority(grant.value, {
      participantId: "main-a",
      role: "main",
      mutationOwnership: "none",
    });
    if (!main.ok) throw new Error(main.error.code);
    const agent = delegateParticipantAuthority(main.value, {
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "none",
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!critic.ok) throw new Error(critic.error.code);

    const contract = new ReadonlyComputerContractHandler(
      new RunReadonlyComputerAction(
        new InMemoryAuthorityRepository([
          main.value,
          agent.value,
          critic.value,
        ]),
        new InMemoryComputerApprovalRepository([approval]),
        new NativeReadonlyWorkspace({
          helperPath: sourceHelper,
          helper: NEXT_SAFE_OPEN_HELPER,
          attestInterpreter: async () => "/usr/bin/python3",
        }),
        { now: () => 1_000 },
      ),
    );
    const server = createReadonlyComputerMcpServer(contract, {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    });
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "computer_workspace_list",
        "computer_workspace_read",
        "computer_workspace_search",
      ]);
      expect(
        listed.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false,
        ),
      ).toBe(true);

      const searched = await client.callTool({
        name: "computer_workspace_search",
        arguments: {
          workspaceId: "farol",
          relativePath: ".",
          pattern: "mcp-boundary",
        },
      });
      expect(searched.isError).not.toBe(true);
      expect(searched.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        output: {
          kind: "workspace.matches",
          matches: [{ path: "src/discovered.ts", line: 1 }],
        },
      });

      const read = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/discovered.ts",
        },
      });
      expect(read.structuredContent).toMatchObject({
        participantId: "critic-a",
        taskId: "task-a",
        output: {
          kind: "workspace.text",
          text: "export const protocol = 'mcp-boundary';\n",
        },
      });
      expect((read.structuredContent as { callId?: unknown }).callId).toEqual(
        expect.any(String),
      );

      const spoofed = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/discovered.ts",
          ownerId: "owner-attacker",
        },
      });
      expect(spoofed.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
