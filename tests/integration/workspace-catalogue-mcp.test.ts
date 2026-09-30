import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
} from "../../src/modules/computer/domain/execution-authority";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";

// In-memory MCP and mocked filesystem: no owner files, profiles or live endpoint.
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of close.splice(0)) await dispose();
});

async function connect(
  options: {
    expired?: boolean;
    wrongTask?: boolean;
    revoke?: boolean;
    stopping?: boolean;
    fenced?: boolean;
  } = {},
) {
  const approval: ComputerApproval = {
    ownerId: "owner",
    computerId: "computer",
    generation: 3,
    workspaces: [
      {
        workspaceId: "trial-uuid",
        root: "/approved/trial",
        access: "read",
        rootIdentity: { device: "1", inode: "10" },
      },
      {
        workspaceId: "code-uuid",
        root: "/approved/code",
        access: "read",
        rootIdentity: { device: "1", inode: "20" },
      },
      {
        workspaceId: "foreign-uuid",
        root: "/private/unassigned",
        access: "read",
        rootIdentity: { device: "1", inode: "30" },
      },
    ],
    capabilities: ["workspace.list", "workspace.read"],
    commands: "none",
    network: "none",
    expiresAt: 10000,
  };
  const grant = deriveTaskGrant(
    approval,
    {
      authorityId: "admission",
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 3,
      computerId: "computer",
      computerGeneration: 3,
      workspaces: [
        {
          workspaceId: "trial-uuid",
          root: "/approved/trial",
          mode: "subtree",
          access: "read",
        },
        {
          workspaceId: "code-uuid",
          root: "/approved/code/project",
          mode: "subtree",
          access: "read",
        },
      ],
      capabilities: approval.capabilities,
      commands: "none",
      network: "none",
      expiresAt: 9000,
    },
    1000,
  );
  if (!grant.ok) throw Error(grant.error.code);
  const participant = createParticipantAuthority(grant.value, {
    participantId: "main",
    role: "main",
    mutationOwnership: "none",
  });
  if (!participant.ok) throw Error(participant.error.code);
  let reads = 0;
  const native = vi.fn(async () => {
    reads++;
    return {
      ok: true as const,
      value: {
        kind: "workspace.entries" as const,
        entries: ["must-not-leak.txt"],
        truncated: false,
      },
    };
  });
  const contract = new ReadonlyComputerContractHandler(
    new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([participant.value]),
      {
        async get() {
          return options.revoke && reads >= 2 ? null : approval;
        },
      },
      { execute: native },
      { now: () => (options.expired ? 10001 : 1000) },
    ),
  );
  const binding = {
    ownerId: "owner",
    sessionId: "session",
    taskId: options.wrongTask ? "foreign-task" : "task",
    taskEpoch: 3,
    participantId: "main",
    turnId: "turn",
    generation: 3,
  };
  const blocked = {
    admitted: false,
    code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
  } as const;
  const fence = options.fenced
    ? {
        admits: async () => blocked,
        acquireAdmission: async () => blocked,
        reserveShell: async () => {},
        clearShell: async () => {},
        quarantineShell: () => {},
      }
    : undefined;
  const lifecycle = options.stopping
    ? { isStopping: async () => true, enterHandler: () => () => {} }
    : undefined;
  const server = createReadonlyComputerMcpServer(
    contract,
    binding,
    undefined,
    undefined,
    undefined,
    fence,
    undefined,
    undefined,
    undefined,
    lifecycle,
    undefined,
    undefined,
    participant.value.grant.workspaces
      .filter((scope) => scope.mode === "subtree")
      .map((scope) => scope.workspaceId),
  );
  const client = new Client({ name: "catalogue-fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, native };
}

describe("authority-bound workspace discovery through MCP", () => {
  it.each([{ stopping: true }, { fenced: true }])(
    "does not start discovery while lifecycle admission is closed %j",
    async (options) => {
      const { client, native } = await connect(options);
      const result = await client.callTool({
        name: "computer_workspace_catalogue",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(native).not.toHaveBeenCalled();
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "/approved/",
      );
    },
  );

  it("finds real workspace IDs without owner UUID copying or an invented alias", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain(
      "computer_workspace_catalogue",
    );
    const catalogue = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(catalogue.isError).not.toBe(true);
    expect(catalogue.structuredContent).toMatchObject({
      ok: true,
      workspaces: [
        { workspaceId: "trial-uuid", root: "/approved/trial" },
        { workspaceId: "code-uuid", root: "/approved/code/project" },
      ],
    });
    const encoded = JSON.stringify(catalogue.structuredContent);
    expect(encoded).not.toContain("foreign-uuid");
    expect(encoded).not.toContain("/private/unassigned");
    expect(encoded).not.toContain("must-not-leak.txt");
    const listed = await client.callTool({
      name: "computer_workspace_list",
      arguments: { workspaceId: "code-uuid", relativePath: "." },
    });
    expect(listed.isError).not.toBe(true);
    const guessed = await client.callTool({
      name: "computer_workspace_list",
      arguments: { workspaceId: "code", relativePath: "." },
    });
    expect(guessed.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "task-grant",
        retry: "never",
      },
    });
  });

  it.each([{ expired: true }, { wrongTask: true }])(
    "discloses no roots or filenames after authority refusal %j",
    async (options) => {
      const { client, native } = await connect(options);
      const result = await client.callTool({
        name: "computer_workspace_catalogue",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(native).not.toHaveBeenCalled();
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "/approved/",
      );
    },
  );

  it("discards previously collected roots if current approval is revoked", async () => {
    const { client } = await connect({ revoke: true });
    const result = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_APPROVAL_NOT_FOUND" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "/approved/",
    );
  });
});
