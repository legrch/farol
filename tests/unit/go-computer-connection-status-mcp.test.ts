import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import {
  createGoComputerMcpServer,
  type GoComputerMcpOptions,
} from "../../apps/desktop/bridge/computer-mcp.ts";

// SDK in-memory integration, with a fabricated observation port. No native Go,
// external MCP tunnel or file/command acceptance is inferred from these tests.
const execution = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "1",
  participantId: "participant",
  turnId: "turn",
  generation: "1",
};
const context = { profileId: "profile", backendGeneration: "backend" };
const binding = {
  ...context,
  buildId: "build",
  runtimeId: "runtime",
  connectorGeneration: "1",
};
const connections: { client: Client; server: McpServer }[] = [];
afterEach(async () => {
  for (const pair of connections.splice(0)) {
    await pair.client.close();
    await pair.server.close();
  }
});
async function connect(options: Partial<GoComputerMcpOptions> = {}) {
  const request = vi.fn(async () => {
    throw new Error("unexpected workspace request");
  });
  const registration = vi.spyOn(McpServer.prototype, "registerTool");
  const server = createGoComputerMcpServer(
    new ComputerBridge({ request }),
    execution,
    context,
    {
      fence: {
        acquireAdmission: async () => ({
          admitted: true as const,
          release: async () => {},
        }),
      },
      ...options,
    },
  );
  const statusIndex = registration.mock.calls.findIndex(
    ([name]) => name === "computer_connection_status",
  );
  const statusTool =
    statusIndex >= 0
      ? (registration.mock.results[statusIndex]!.value as RegisteredTool)
      : undefined;
  registration.mockRestore();
  const client = new Client({
    name: "connection-status-fixture",
    version: "1.0.0",
  });
  connections.push({ client, server });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, request, statusTool };
}
it("does not advertise status merely because verification exists", async () => {
  const f = await connect({
    verification: {
      verify: vi.fn(async () => ({ binding })),
      verifyCatalogue: vi.fn(async () => ({ binding })),
    },
  });
  const tools = (await f.client.listTools()).tools;
  expect(tools.some((x) => x.name === "farol_connector_verify")).toBe(true);
  expect(tools.some((x) => x.name === "computer_connection_status")).toBe(
    false,
  );
});
it("registers a read-only status and observes without verification", async () => {
  const observe = vi.fn(async () => ({ binding }));
  const verify = vi.fn(async () => {
    throw new Error("must not verify");
  });
  const f = await connect({
    connectionStatus: { observe },
    verification: {
      verify,
      verifyCatalogue: vi.fn(async () => {
        throw new Error("unexpected catalogue verification");
      }),
    },
  });
  const tool = (await f.client.listTools()).tools.find(
    (x) => x.name === "computer_connection_status",
  );
  expect(tool?.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  });
  const result = await f.client.callTool({
    name: "computer_connection_status",
    arguments: {},
  });
  expect(result.structuredContent).toMatchObject({
    status: "ok",
    context,
    data: {
      connection: "responding",
      attachment: "not_checked",
      newFileOrCommandTests: false,
      capabilities: { shell: "not_registered", tasks: "not_registered" },
    },
  });
  expect(observe).toHaveBeenCalledTimes(1);
  expect(verify).not.toHaveBeenCalled();
  expect(f.request).not.toHaveBeenCalled();
});
it("passes a fresh status identifier to the authenticated Go observation only", async () => {
  const observe = vi.fn(async () => ({ binding }));
  const f = await connect({ connectionStatus: { observe } });
  await f.client.callTool({
    name: "computer_connection_status",
    arguments: { checkId: "fresh-status-check" },
  });
  expect(observe).toHaveBeenCalledWith("fresh-status-check");
  expect(f.request).not.toHaveBeenCalled();
});
it("does not enter Go observation when the existing fence refuses", async () => {
  const observe = vi.fn(async () => ({ binding }));
  const f = await connect({
    connectionStatus: { observe },
    fence: {
      acquireAdmission: async () => ({
        admitted: false as const,
        code: "COMPUTER_MCP_STOPPING",
      }),
    },
  });
  const result = await f.client.callTool({
    name: "computer_connection_status",
    arguments: {},
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: "refused",
    code: "COMPUTER_MCP_STOPPING",
    retry: "never",
  });
  expect(observe).not.toHaveBeenCalled();
});
it("rejects invented status inputs without an observation", async () => {
  const observe = vi.fn(async () => ({ binding }));
  const f = await connect({ connectionStatus: { observe } });
  const result = await f.client.callTool({
    name: "computer_connection_status",
    arguments: { challenge: "must-not-be-used", workspaceId: "foreign" },
  });
  expect(result.isError).toBe(true);
  expect(observe).not.toHaveBeenCalled();
});
it("suppresses a known observation when admission release is unknown", async () => {
  const observe = vi.fn(async () => ({ binding }));
  const f = await connect({
    connectionStatus: { observe },
    fence: {
      acquireAdmission: async () => ({
        admitted: true,
        release: async () => {
          throw Error("private release detail");
        },
      }),
    },
  });
  const result = await f.client.callTool({
    name: "computer_connection_status",
    arguments: {},
  });
  expect(result.structuredContent).toMatchObject({
    status: "unknown",
    code: "COMPUTER_EXECUTION_FENCE_RELEASE_FAILED",
    retry: "never",
  });
  expect(result.structuredContent).not.toHaveProperty("data");
  expect(observe).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("private release detail");
});
it("keeps an observation failure instead of inventing a healthy result", async () => {
  const observe = vi.fn(async () => {
    throw new BridgeError("unknown", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE");
  });
  const f = await connect({ connectionStatus: { observe } });
  const result = await f.client.callTool({
    name: "computer_connection_status",
    arguments: {},
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    status: "unknown",
    code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
    retry: "never",
  });
  expect(observe).toHaveBeenCalledTimes(1);
});

it.each(["before", "during", "release", "stop"])(
  "withholds current status across %s cancellation/closure",
  async (mode) => {
    const controller = new AbortController();
    let stopping = false;
    const observe = vi.fn(async () => {
      if (mode === "during") controller.abort();
      if (mode === "stop") stopping = true;
      return { binding };
    });
    const release = vi.fn(async () => {
      if (mode === "release") controller.abort();
    });
    const f = await connect({
      connectionStatus: { observe },
      lifecycle: {
        isStopping: async () => stopping,
        enterHandler: () => () => {},
      },
      fence: { acquireAdmission: async () => ({ admitted: true, release }) },
    });
    if (mode === "before") controller.abort();
    const result = await f.statusTool!.executor({}, {
      mcpReq: { id: "outer", signal: controller.signal },
    } as unknown as ServerContext);
    expect(result.structuredContent).toMatchObject({
      status: mode === "before" ? "refused" : "unknown",
      retry: "never",
    });
    expect(result.structuredContent).not.toHaveProperty("data");
    expect(observe).toHaveBeenCalledTimes(mode === "before" ? 0 : 1);
    expect(release).toHaveBeenCalledTimes(mode === "before" ? 0 : 1);
  },
);
