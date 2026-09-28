import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunMutableComputerAction } from "../../src/modules/computer/app/service/run-mutable-computer-action";
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
import { Sha256WorkspaceMutationDigester } from "../../src/modules/computer/infra/native/sha256-workspace-mutation-digester";
import { MutableComputerContractHandler } from "../../src/modules/computer/infra/mutable-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { InMemoryWorkspaceMutationRepository } from "../../src/modules/computer/infra/repo/in-memory-workspace-mutations";
import { rootIdentityOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mutable-mcp-")),
  );
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, ".git"), { mode: 0o700 });
  await fs.writeFile(path.join(root, ".git", "config"), "safe\n", {
    mode: 0o600,
  });
  await fs.writeFile(path.join(root, "README.md"), "before\n", { mode: 0o600 });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("mutable Computer MCP adapter", () => {
  it("exposes explicit write/edit tools and redelivers one operation without repeating it", async () => {
    const approval: ComputerApproval = {
      ownerId: "owner-preview",
      computerId: "computer-preview",
      generation: 7,
      workspaces: [
        {
          workspaceId: "farol",
          root,
          access: "write",
          rootIdentity: rootIdentityOf(root),
        },
      ],
      capabilities: ["workspace.read", "workspace.write"],
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
          access: "write",
        },
      ],
      capabilities: ["workspace.read", "workspace.write"],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    };
    const grant = deriveTaskGrant(approval, admission, 1_000);
    if (!grant.ok) throw new Error(grant.error.code);
    const main = createParticipantAuthority(grant.value, {
      participantId: "main-a",
      role: "main",
      mutationOwnership: "task",
    });
    if (!main.ok) throw new Error(main.error.code);
    const agent = delegateParticipantAuthority(main.value, {
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "task",
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "task",
    });
    if (!critic.ok) throw new Error(critic.error.code);

    const authorities = new InMemoryAuthorityRepository([
      main.value,
      agent.value,
      critic.value,
    ]);
    const approvals = new InMemoryComputerApprovalRepository([approval]);
    const native = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
      attestInterpreter: async () => "/usr/bin/python3",
    });
    const mutable = new MutableComputerContractHandler(
      new RunMutableComputerAction(
        authorities,
        approvals,
        new InMemoryWorkspaceMutationRepository(),
        new Sha256WorkspaceMutationDigester(),
        native,
        { now: () => 1_000 },
      ),
    );
    const binding = {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    };
    const unavailableReadonly = {
      async execute(): Promise<never> {
        throw new Error("unused");
      },
    };
    const server = createReadonlyComputerMcpServer(
      unavailableReadonly,
      binding,
      mutable,
    );
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "computer_workspace_bootstrap",
        "computer_guidance_search",
        "computer_guidance_fetch",
        "computer_workspace_list",
        "computer_workspace_read",
        "computer_workspace_search",
        "computer_workspace_git_status",
        "computer_workspace_git_head",
        "computer_workspace_write",
        "computer_workspace_edit",
      ]);
      const writeTool = tools.tools.find(
        (tool) => tool.name === "computer_workspace_write",
      );
      expect(writeTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });

      const writeArguments = {
        operationId: "mutation-write-a",
        workspaceId: "farol",
        relativePath: "README.md",
        expectedSha256: digest("before\n"),
        content: "after\n",
      };
      const written = await client.callTool({
        name: "computer_workspace_write",
        arguments: writeArguments,
      });
      expect(written.isError).not.toBe(true);
      expect(written.structuredContent).toMatchObject({
        operationId: "mutation-write-a",
        participantId: "critic-a",
        redelivered: false,
        receipt: { afterSha256: digest("after\n") },
      });
      expect(JSON.stringify(written.structuredContent)).not.toContain(
        '"content"',
      );

      const redelivered = await client.callTool({
        name: "computer_workspace_write",
        arguments: writeArguments,
      });
      expect(redelivered.structuredContent).toMatchObject({
        operationId: "mutation-write-a",
        redelivered: true,
      });

      const edited = await client.callTool({
        name: "computer_workspace_edit",
        arguments: {
          operationId: "mutation-edit-a",
          workspaceId: "farol",
          relativePath: "README.md",
          expectedSha256: digest("after\n"),
          edits: [{ oldText: "after", newText: "finished" }],
        },
      });
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({
        operationId: "mutation-edit-a",
        receipt: { operation: "edit", replacements: 1 },
      });
      expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
        "finished\n",
      );

      const denied = await client.callTool({
        name: "computer_workspace_write",
        arguments: {
          operationId: "mutation-denied-a",
          workspaceId: "farol",
          relativePath: ".git/config",
          expectedSha256: digest("safe\n"),
          content: "changed\n",
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
