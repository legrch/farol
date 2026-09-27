import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { CodexTaskRoute } from "../../src/modules/chat/contract/codex-task-route";
import type { ReadonlyComputerContract } from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";

const key = "41949674-c1e4-4a73-9098-4d31da6e7aaa";
const binding = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: 1,
  participantId: "participant",
  turnId: "turn",
  generation: 1,
};
const computer: ReadonlyComputerContract = {
  async execute() {
    throw new Error("unexpected Computer call");
  },
};

async function connected(route?: CodexTaskRoute) {
  const server = createReadonlyComputerMcpServer(
    computer,
    binding,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    route,
  );
  const client = new Client({ name: "task-route-fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

describe("Codex task Computer MCP surface", () => {
  it("validates active message bytes before delegate and exposes exact steer receipt", async () => {
    const messages: string[] = [];
    const route: CodexTaskRoute = {
      controlCapabilities: { message: true },
      async create() {
        throw new Error("unexpected create");
      },
      async status() {
        throw new Error("unexpected status");
      },
      async result() {
        throw new Error("unexpected result");
      },
      async message(input) {
        messages.push(input.message);
        return {
          status: "steered",
          dispatchId: input.dispatchId,
          turnId: "issued-turn",
        };
      },
    };
    const { client, server } = await connected(route);
    const steerKey = randomUUID();
    const send = (message: string) =>
      client.callTool({
        name: "codex_task_message",
        arguments: {
          key: steerKey,
          dispatchId: key,
          workspaceId: "writer",
          projectId: "saved-project",
          message,
          model: "gpt-6-luna",
          reasoningEffort: "medium",
        },
      });
    try {
      for (const message of ["", "bad\0message", "😀".repeat(2_049)])
        expect((await send(message)).isError).toBe(true);
      expect(messages).toEqual([]);
      const accepted = await send("  One steer\r\n");
      expect(accepted.structuredContent).toEqual({
        status: "steered",
        dispatchId: key,
      });
      expect(messages).toEqual(["  One steer\r\n"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("validates UTF-8 bytes and NUL before dispatching through the real MCP route", async () => {
    const forwarded: string[] = [];
    const route: CodexTaskRoute = {
      async message() {
        throw new Error("unexpected message");
      },
      async create(input) {
        forwarded.push(input.message);
        return {
          status: "dispatched",
          dispatchId: input.key,
          threadId: "private-thread",
          turnId: "private-turn",
        };
      },
      async status() {
        throw new Error("unexpected status");
      },
      async result() {
        throw new Error("unexpected result");
      },
    };
    const { client, server } = await connected(route);
    const create = (message: string) =>
      client.callTool({
        name: "codex_task_create",
        arguments: {
          key,
          workspaceId: "writer",
          projectId: "saved-project",
          message,
        },
      });
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "codex_task_create",
      );
      expect(advertised?.inputSchema).toMatchObject({
        properties: { message: { minLength: 1, maxLength: 8_192 } },
      });
      expect(advertised?.description).toContain("8,192 UTF-8 bytes");
      for (const message of [
        "",
        "with\0nul",
        "a".repeat(8_193),
        "я".repeat(4_097),
        "😀".repeat(2_049),
      ]) {
        const rejected = await create(message);
        expect(rejected.isError).toBe(true);
        expect(forwarded).toEqual([]);
      }
      for (const message of [
        "a".repeat(8_192),
        "я".repeat(4_096),
        "😀".repeat(2_048),
        "  line one\r\nline two  ",
      ]) {
        const accepted = await create(message);
        expect(accepted.isError).not.toBe(true);
        expect(accepted.structuredContent).toEqual({
          status: "dispatched",
          dispatchId: key,
        });
      }
      expect(forwarded).toEqual([
        "a".repeat(8_192),
        "я".repeat(4_096),
        "😀".repeat(2_048),
        "  line one\r\nline two  ",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not advertise tasks with only a Computer folder grant", async () => {
    const { client, server } = await connected();
    try {
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("codex_task_create");
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("codex_task_status");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes one create/status/result and exposes only the dispatch handle", async () => {
    const calls: string[] = [];
    const route: CodexTaskRoute = {
      async message() {
        throw new Error("unexpected message");
      },
      async create(request) {
        calls.push(`create:${request.key}:${request.projectId}`);
        return {
          status: "dispatched",
          dispatchId: request.key,
          threadId: "private-thread",
          turnId: "private-turn",
        };
      },
      async status(dispatchId) {
        calls.push(`status:${dispatchId}`);
        return {
          status: "known",
          dispatchId,
          threadId: "private-thread",
          turnId: "private-turn",
          turnStatus: "completed",
        };
      },
      async result(dispatchId) {
        calls.push(`result:${dispatchId}`);
        return {
          status: "completed",
          dispatchId,
          threadId: "private-thread",
          turnId: "private-turn",
          finalItemId: "private-item",
          text: "Exact fixture answer",
        };
      },
    };
    const { client, server } = await connected(route);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("codex_task_create");
      expect(tools).toContain("codex_task_status");
      expect(tools).toContain("codex_task_result");
      expect(tools).not.toContain("codex_task_message");
      const created = await client.callTool({
        name: "codex_task_create",
        arguments: {
          key,
          workspaceId: "writer",
          projectId: "saved-project",
          message: "Read the H1",
        },
      });
      expect(created.structuredContent).toEqual({
        status: "dispatched",
        dispatchId: key,
      });
      const status = await client.callTool({
        name: "codex_task_status",
        arguments: { dispatchId: key },
      });
      expect(status.structuredContent).toEqual({
        status: "known",
        dispatchId: key,
        turnStatus: "completed",
      });
      const result = await client.callTool({
        name: "codex_task_result",
        arguments: { dispatchId: key },
      });
      expect(result.structuredContent).toEqual({
        status: "completed",
        dispatchId: key,
        text: "Exact fixture answer",
      });
      expect(calls).toEqual([
        `create:${key}:saved-project`,
        `status:${key}`,
        `result:${key}`,
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps a lost create acknowledgement outcome-unknown with the same key", async () => {
    let count = 0;
    const route: CodexTaskRoute = {
      async message() {
        throw new Error("unexpected message");
      },
      async create() {
        count += 1;
        throw new Error("lost acknowledgement");
      },
      async status(dispatchId) {
        return { status: "outcome_unknown", dispatchId };
      },
      async result(dispatchId) {
        return { status: "outcome_unknown", dispatchId };
      },
    };
    const { client, server } = await connected(route);
    try {
      const response = await client.callTool({
        name: "codex_task_create",
        arguments: {
          key,
          workspaceId: "writer",
          projectId: "saved-project",
          message: "Read the H1",
        },
      });
      expect(response.structuredContent).toEqual({
        status: "outcome_unknown",
        dispatchId: key,
      });
      expect(response.isError).toBe(true);
      expect(count).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
