import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import type { ReadonlyComputerContract } from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import type { CodexCallerRelayPort } from "../../src/modules/computer/infra/mcp/codex-caller-relay-port";

const binding = {
  ownerId: "owner-route-b",
  sessionId: "session-route-b",
  taskId: "task-route-b",
  taskEpoch: 3,
  participantId: "main-route-b",
  turnId: "turn-route-b",
  generation: 3,
};

const ticket = "a".repeat(64);
const turnBinding = "b".repeat(64);

describe("Codex caller relay MCP tool", () => {
  it("exposes one static tool and forwards exact describe/invoke operations", async () => {
    const computer: ReadonlyComputerContract = { execute: vi.fn() };
    const request = vi.fn<CodexCallerRelayPort["request"]>(async (input) =>
      input.operation === "describe"
        ? {
            ok: true,
            operation: "describe" as const,
            catalogue: {
              fingerprint: "c".repeat(64),
              tools: [
                {
                  name: "get_goal",
                  namespace: null,
                  description: "Read the current goal.",
                  parameters: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
              unsupported: [],
            },
          }
        : {
            ok: true,
            operation: "invoke" as const,
            operationId: input.operationId,
            output: '{"status":"active"}',
          },
    );
    const server = createReadonlyComputerMcpServer(
      computer,
      binding,
      undefined,
      undefined,
      { request },
    );
    const client = new Client({ name: "route-b-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      expect(
        listed.tools.find((tool) => tool.name === "farol_host_tools"),
      ).toMatchObject({
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      });

      const described = await client.callTool({
        name: "farol_host_tools",
        arguments: { operation: "describe", ticket, binding: turnBinding },
      });
      expect(described.isError).not.toBe(true);
      expect(described.structuredContent).toMatchObject({
        ok: true,
        operation: "describe",
        catalogue: {
          tools: [{ name: "get_goal", namespace: null }],
        },
      });

      const invoked = await client.callTool({
        name: "farol_host_tools",
        arguments: {
          operation: "invoke",
          ticket,
          binding: turnBinding,
          operationId: "operation-route-b",
          name: "get_goal",
          namespace: null,
          arguments: {},
        },
      });
      expect(invoked.isError).not.toBe(true);
      expect(invoked.content).toEqual([
        { type: "text", text: '{"status":"active"}' },
      ]);
      expect(request).toHaveBeenNthCalledWith(1, {
        operation: "describe",
        ticket,
        binding: turnBinding,
      });
      expect(request).toHaveBeenNthCalledWith(2, {
        operation: "invoke",
        ticket,
        binding: turnBinding,
        operationId: "operation-route-b",
        name: "get_goal",
        namespace: null,
        arguments: {},
      });
      expect(computer.execute).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns relay refusals as MCP errors and rejects malformed calls before forwarding", async () => {
    const request = vi.fn<CodexCallerRelayPort["request"]>(async () => ({
      ok: false,
      error: { code: "CALLER_RELAY_TICKET_NOT_FOUND", retry: "never" },
    }));
    const server = createReadonlyComputerMcpServer(
      { execute: vi.fn() },
      binding,
      undefined,
      undefined,
      { request },
    );
    const client = new Client({ name: "route-b-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const refused = await client.callTool({
        name: "farol_host_tools",
        arguments: { operation: "describe", ticket, binding: turnBinding },
      });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toEqual({
        ok: false,
        error: { code: "CALLER_RELAY_TICKET_NOT_FOUND", retry: "never" },
      });

      const malformed = await client.callTool({
        name: "farol_host_tools",
        arguments: {
          operation: "invoke",
          ticket,
          binding: turnBinding,
          operationId: "bad",
          name: "get_goal",
          namespace: null,
          arguments: "not-an-object",
        },
      });
      expect(malformed.isError).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
