import { PassThrough } from "node:stream";
import {
  type JSONRPCResponse,
  type ListToolsResult,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { expect, it, vi } from "vitest";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import {
  createGoComputerMcpServer,
  type GoComputerMcpOptions,
} from "../../apps/desktop/bridge/computer-mcp.ts";
import type {
  ComputerConnectorExecution,
  Context,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// Real pinned SDK entry, legacy codec and stdio framing over memory streams.
// Fabricated ports only: no Go, process, socket, filesystem, app or provider proof.
const execution: ComputerConnectorExecution = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  generation: "18446744073709551615",
};
const context: Context = { profileId: "profile", backendGeneration: "backend" };
const root = { path: "/approved", device: "1", inode: "2" };

function connection(factory: McpServerFactory) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors: Error[] = [];
  const inbound: string[] = [];
  const outbound: string[] = [];
  const pending = new Map<number, (reply: JSONRPCResponse) => void>();
  let buffered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    for (
      let end = buffered.indexOf("\n");
      end >= 0;
      end = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      outbound.push(line);
      const reply = JSON.parse(line) as JSONRPCResponse;
      if (typeof reply.id === "number") pending.get(reply.id)?.(reply);
    }
  });
  const handle = serveStdio(factory, {
    legacy: "serve",
    transport: new StdioServerTransport(input, output),
    onerror: (error) => errors.push(error),
  });
  const send = (message: object, fragmented = false) => {
    const bytes = `${JSON.stringify(message)}\n`;
    inbound.push(bytes);
    if (fragmented) {
      input.write(bytes.slice(0, 13));
      input.write(bytes.slice(13));
    } else input.write(bytes);
  };
  return {
    errors,
    inbound,
    outbound,
    notify: (method: string) => send({ jsonrpc: "2.0", method }),
    request: (id: number, method: string, params: object, fragmented = false) =>
      new Promise<JSONRPCResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              JSON.stringify({
                missingReply: { id, method },
                errors: errors.map((error) => error.message),
                inbound,
                outbound,
              }),
            ),
          );
        }, 3000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply);
        });
        send({ jsonrpc: "2.0", id, method, params }, fragmented);
      }),
    close: async () => {
      await handle.close();
      input.destroy();
      output.destroy();
      expect(pending.size).toBe(0);
    },
  };
}

const initialize = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "go-computer-pure-stdio-test", version: "1.0.0" },
};

it("serves legacy initialize, strict tool schemas and catalogue through the real SDK factory", async () => {
  const events: string[] = [];
  const request = vi.fn(
    async (
      method: string,
      params: Json,
      call?: { id?: string },
    ): Promise<Outcome> => {
      expect(method).toBe("computer.workspace.catalogue");
      events.push("bridge");
      return {
        status: "ok",
        requestId: call?.id ?? "missing",
        context,
        data: {
          ...(params as Record<string, Json>),
          workspaces: [
            { workspaceId: "workspace", root: root.path, approvedRoot: root },
          ],
          consistency: "per-operation",
          next: "use-exact-workspace-id",
        },
      };
    },
  );
  const mutations = {
    write: vi.fn(async (_input, operationId, call) => ({
      status: "unknown" as const,
      operationId,
      requestId: call.requestId,
      context: call.context,
      code: "fixture_only",
      retry: "never" as const,
    })),
    edit: vi.fn(async (_input, operationId, call) => ({
      status: "unknown" as const,
      operationId,
      requestId: call.requestId,
      context: call.context,
      code: "fixture_only",
      retry: "never" as const,
    })),
    read: vi.fn(async (input, call) => ({
      status: "refused" as const,
      operationId: input.operationId,
      requestId: call.requestId,
      context: call.context,
      code: "fixture_only",
      retry: "never" as const,
    })),
  } satisfies NonNullable<GoComputerMcpOptions["mutations"]>;
  const verify = vi.fn(async () => ({
    binding: {
      buildId: "build",
      profileId: "profile",
      backendGeneration: "backend",
      runtimeId: "runtime",
      connectorGeneration: "1",
    },
  }));
  const factory = vi.fn<McpServerFactory>(() =>
    createGoComputerMcpServer(
      new ComputerBridge({ request }),
      execution,
      context,
      {
        mutations,
        verification: { verify },
        lifecycle: {
          isStopping: async () => {
            events.push("stopping");
            return false;
          },
          enterHandler: () => {
            events.push("enter");
            return () => {
              events.push("leave");
            };
          },
        },
        fence: {
          acquireAdmission: async () => {
            events.push("acquire");
            return {
              admitted: true,
              release: async () => {
                events.push("release");
              },
            };
          },
        },
      },
    ),
  );
  const wire = connection(factory);
  try {
    expect(factory).not.toHaveBeenCalled();
    const initialized = await wire.request(1, "initialize", initialize, true);
    expect(initialized).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "farol-next-computer", version: "0.1.0-preview.0" },
        capabilities: { tools: { listChanged: true } },
      },
    });
    wire.notify("notifications/initialized");
    const listed = await wire.request(2, "tools/list", {});
    expect(listed).not.toHaveProperty("error");
    if (!("result" in listed)) throw Error("tools_list_failed");
    const tools = (listed.result as ListToolsResult).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "computer_mutation_read",
      "computer_workspace_bootstrap",
      "computer_workspace_catalogue",
      "computer_workspace_edit",
      "computer_workspace_list",
      "computer_workspace_read",
      "computer_workspace_search",
      "computer_workspace_write",
      "farol_next_connector_verify",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
    expect(
      tools.find((tool) => tool.name === "computer_workspace_write")
        ?.inputSchema.required,
    ).toEqual([
      "operationId",
      "workspaceId",
      "relativePath",
      "content",
      "expectedSha256",
    ]);
    expect(
      tools.find((tool) => tool.name === "computer_workspace_edit")?.inputSchema
        .properties?.edits,
    ).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 256,
      items: { type: "object", additionalProperties: false },
    });
    expect(request).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    const catalogue = await wire.request(3, "tools/call", {
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(catalogue).toMatchObject({
      id: 3,
      result: {
        structuredContent: {
          status: "ok",
          context,
          data: {
            ...execution,
            workspaces: [
              { workspaceId: "workspace", root: root.path, approvedRoot: root },
            ],
          },
        },
      },
    });
    expect(catalogue).not.toHaveProperty("error");
    if (!("result" in catalogue)) throw Error("catalogue_failed");
    expect(catalogue.result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "enter",
      "stopping",
      "acquire",
      "stopping",
      "bridge",
      "release",
      "leave",
      "stopping",
    ]);
    const denied = await wire.request(4, "tools/call", {
      name: "computer_workspace_catalogue",
      arguments: { extra: true },
    });
    expect(denied).toMatchObject({ id: 4, result: { isError: true } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ era: "legacy" });
    expect(wire.errors).toEqual([]);
    expect(mutations.write).not.toHaveBeenCalled();
    expect(mutations.edit).not.toHaveBeenCalled();
    expect(mutations.read).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  } finally {
    await wire.close();
  }
});

it("reports a factory exception and answers initialize with -32603 instead of losing the reply", async () => {
  const failure = new Error("pure_factory_failure");
  const wire = connection(() => {
    throw failure;
  });
  try {
    expect(await wire.request(1, "initialize", initialize)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Internal server error" },
    });
    // The SDK awaits the error reply before invoking its reporting callback.
    await expect.poll(() => wire.errors).toEqual([failure]);
  } finally {
    await wire.close();
  }
});
