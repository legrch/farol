import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../src/modules/computer/contract/readonly-computer-contract";
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
const executeFile = promisify(execFile);
let root = "";
let git = "";
let head = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mcp-"));
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  git = (await executeFile("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();
  await executeFile(git, ["init", "--quiet", root]);
  await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, "src", "discovered.ts"),
    "export const protocol = 'mcp-boundary';\n",
    { mode: 0o600 },
  );
  await executeFile(git, ["-C", root, "add", "src/discovered.ts"]);
  await executeFile(git, [
    "-C",
    root,
    "-c",
    "user.name=Farol Test",
    "-c",
    "user.email=farol-test@invalid.example",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  head = (await executeFile(git, ["-C", root, "rev-parse", "HEAD"])).stdout;
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("read-only Computer MCP adapter", () => {
  it("lists only bounded read-only tools and carries delegated authority through real MCP calls", async () => {
    const approval: ComputerApproval = {
      ownerId: "owner-preview",
      computerId: "computer-preview",
      generation: 7,
      workspaces: [{ workspaceId: "farol", root, access: "read" }],
      capabilities: [
        "workspace.list",
        "workspace.read",
        "workspace.search",
        "verification.run",
      ],
      network: "none",
      commands: "verification",
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
      commands: "verification",
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
          attestGit: async () => git,
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
        "computer_workspace_git_status",
        "computer_workspace_git_head",
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

      const status = await client.callTool({
        name: "computer_workspace_git_status",
        arguments: { workspaceId: "farol" },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        operation: {
          kind: "verification.run",
          command: "git.status",
          relativePath: ".",
        },
        output: {
          kind: "workspace.command",
          command: "git.status",
          exitCode: 0,
          network: "none",
        },
      });

      const exactHead = await client.callTool({
        name: "computer_workspace_git_head",
        arguments: { workspaceId: "farol" },
      });
      expect(exactHead.isError).not.toBe(true);
      expect(exactHead.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        operation: {
          kind: "verification.run",
          command: "git.head",
          relativePath: ".",
        },
        output: {
          kind: "workspace.command",
          command: "git.head",
          stdout: head,
          exitCode: 0,
          network: "none",
        },
      });

      const injected = await client.callTool({
        name: "computer_workspace_git_status",
        arguments: { workspaceId: "farol", command: "rm -rf ." },
      });
      expect(injected.isError).toBe(true);

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

  it("accepts only an exactly correlated refusal from the Computer contract", async () => {
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: false,
          correlation: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId:
              request.operation.relativePath === "foreign.txt"
                ? "agent-foreign"
                : request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            operation:
              request.operation.relativePath === "operation.txt"
                ? {
                    kind: "workspace.list" as const,
                    relativePath: request.operation.relativePath,
                  }
                : request.operation,
          },
          error: {
            code: "AUTHORITY_PATH_DENIED",
            source: "owner-restriction",
            retry: "never",
          },
        };
      },
    };
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
      const exact = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "denied.txt" },
      });
      expect(exact.isError).toBe(true);
      expect(exact.structuredContent).toMatchObject({
        ok: false,
        correlation: { participantId: "critic-a", taskId: "task-a" },
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: "owner-restriction",
        },
      });

      const foreign = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "foreign.txt" },
      });
      expect(foreign.isError).toBe(true);
      expect(foreign.structuredContent).toEqual({
        ok: false,
        error: {
          code: "COMPUTER_CONTRACT_CORRELATION",
          source: "contract",
          retry: "never",
        },
      });

      const foreignOperation = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "operation.txt" },
      });
      expect(foreignOperation.isError).toBe(true);
      expect(foreignOperation.structuredContent).toEqual({
        ok: false,
        error: {
          code: "COMPUTER_CONTRACT_CORRELATION",
          source: "contract",
          retry: "never",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
