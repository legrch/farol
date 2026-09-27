import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ReadonlyComputerContract } from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import type {
  SavedChatBridgeOperation,
  SavedChatBridgeResponse,
} from "../../src/pkg/saved-chat-bridge/protocol";

type Route = Readonly<{
  request(
    operation: SavedChatBridgeOperation,
  ): Promise<SavedChatBridgeResponse>;
}>;

async function connected(route?: Route) {
  const computer: ReadonlyComputerContract = {
    async execute() {
      throw new Error("Unexpected Computer request");
    },
  };
  const server = createReadonlyComputerMcpServer(
    computer,
    {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "participant",
      turnId: "turn",
      generation: 1,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    route,
  );
  const client = new Client({ name: "saved-chat-fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

describe("saved ChatGPT route through Computer MCP", () => {
  it("is absent without the app-owned Browser endpoint", async () => {
    const { client, server } = await connected();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("chatgpt_chat_create");
      expect(names).not.toContain("chatgpt_chat_status");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("validates UTF-8 bytes and reaches one real MCP create/status adapter", async () => {
    const key = randomUUID();
    const calls: SavedChatBridgeOperation[] = [];
    const { client, server } = await connected({
      async request(operation) {
        calls.push(operation);
        return operation.operation === "create"
          ? { status: "outcome_unknown", dispatchId: operation.request.key }
          : { status: "outcome_unknown", dispatchId: operation.dispatchId };
      },
    });
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("chatgpt_chat_create");
      expect(names).toContain("chatgpt_chat_status");
      const bad = await client.callTool({
        name: "chatgpt_chat_create",
        arguments: {
          key,
          title: "Test",
          firstMessage: "😀".repeat(2049),
        },
      });
      expect(bad.isError).toBe(true);
      const nul = await client.callTool({
        name: "chatgpt_chat_create",
        arguments: { key, title: "Test", firstMessage: "no\0send" },
      });
      expect(nul.isError).toBe(true);
      expect(calls).toEqual([]);
      const created = await client.callTool({
        name: "chatgpt_chat_create",
        arguments: { key, title: "Test", firstMessage: "One harmless message" },
      });
      expect(created.structuredContent).toEqual({
        status: "outcome_unknown",
        dispatchId: key,
      });
      expect(created.isError).toBe(true);
      const status = await client.callTool({
        name: "chatgpt_chat_status",
        arguments: { dispatchId: key, recheck: true },
      });
      expect(status.structuredContent).toEqual({
        status: "outcome_unknown",
        dispatchId: key,
      });
      expect(calls).toEqual([
        {
          operation: "create",
          request: { key, title: "Test", firstMessage: "One harmless message" },
        },
        { operation: "status", dispatchId: key, recheck: true },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not publish a response for another dispatch key", async () => {
    const key = randomUUID();
    const other = randomUUID();
    const { client, server } = await connected({
      async request() {
        return {
          status: "verified",
          dispatchId: other,
          conversationUrl:
            "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc",
          titleVerified: true,
        };
      },
    });
    try {
      for (const [name, arguments_] of [
        ["chatgpt_chat_create", { key, title: "Test", firstMessage: "One" }],
        ["chatgpt_chat_status", { dispatchId: key }],
      ] as const) {
        const response = await client.callTool({ name, arguments: arguments_ });
        expect(response.structuredContent).toEqual({
          status: "outcome_unknown",
          dispatchId: key,
        });
        expect(response.isError).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
