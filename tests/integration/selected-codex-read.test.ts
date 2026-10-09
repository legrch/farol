import { EventEmitter } from "node:events";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  SocketConnectorClient,
  type ConnectorSocket,
} from "../../apps/desktop/bridge/connector-client.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import { createGoComputerMcpServer } from "../../apps/desktop/bridge/computer-mcp.ts";
import { frame, parseJSON } from "../../apps/desktop/bridge/frame.ts";
import {
  selectedCodexReadBridge,
  selectedCodexReadMethod,
} from "../../apps/desktop/bridge/selected-codex-read.ts";
import {
  maxFrameBytes,
  protocolMajor,
  protocolMinor,
  type ComputerConnectorOpened,
  type Identity,
  type Json,
  type TaskSelectedCodexReadResponse,
} from "../../apps/desktop/bridge/wire.ts";

// Actual socket codec/handshake, selected-read bridge and MCP SDK over memory
// streams. The backend replies are controlled DTOs; no Go/native/provider proof.
const root = {
  path: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/project/.git",
};
type Mutable<T> = T extends readonly (infer V)[]
  ? Mutable<V>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const selection = {
  binding: {
    provider: "codex" as const,
    profileId: "profile",
    hostId: "codex",
    projectId: "project",
    workspaceId: "writer",
    project: { ...root, path: "/fixture/project" },
    writer: root,
    modelAlias: "selected",
    model: "fixture-model",
    effort: "high",
    configDigest: "a".repeat(64),
  },
  reference: { threadId: "thread-exact", turnId: "turn-exact" },
};
function opened(witness = true): Mutable<ComputerConnectorOpened> {
  return {
    endpoint: {
      binding: {
        buildId: "build",
        profileId: "profile",
        backendGeneration: "backend",
        runtimeId: "runtime",
        connectorGeneration: "1",
      },
      socketPath: "/fixture/socket",
      token: "a".repeat(64),
    },
    execution: {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: "1",
      participantId: "participant",
      turnId: "turn",
      generation: "1",
    },
    admissionOperationId: "open",
    ...(witness ? { codexRead: structuredClone(selection) } : {}),
  };
}
function identity(capability = true): Mutable<Identity> {
  return {
    protocolMajor,
    protocolMinor,
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    maxFrameBytes,
    capabilities: [
      "core.status",
      ...(capability ? [selectedCodexReadMethod] : []),
    ],
  };
}
class MemorySocket extends EventEmitter implements ConnectorSocket {
  destroyed = false;
  writable = true;
  writableLength = 0;
  reads = 0;
  lost = false;
  alter:
    ((response: Mutable<TaskSelectedCodexReadResponse>) => void) | undefined;
  constructor(private readonly peer: Identity) {
    super();
  }
  write(bytes: Uint8Array): boolean {
    const value = parseJSON(
      Buffer.from(bytes).subarray(4).toString("utf8"),
    ) as {
      id?: string;
      method?: string;
      params?: { body?: { includeResult?: boolean } };
    };
    queueMicrotask(() => {
      if (!value.method) {
        this.emit("data", frame(opened().endpoint.binding));
        return;
      }
      let data: unknown = this.peer;
      if (value.method === selectedCodexReadMethod) {
        this.reads++;
        if (this.lost) {
          this.emit("end");
          return;
        }
        const response: Mutable<TaskSelectedCodexReadResponse> = {
          selection: structuredClone(selection),
          lifecycle: "completed",
          text: value.params?.body?.includeResult === true ? "final text" : "",
          source: "stored",
          snapshot: "non_atomic",
          retained: false,
          resultEvidence: "provider_history",
        };
        this.alter?.(response);
        data = response;
      }
      this.emit(
        "data",
        frame({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            status: "ok",
            requestId: value.id,
            context: { profileId: "profile", backendGeneration: "backend" },
            data,
          },
        }),
      );
    });
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.writable = false;
  }
}
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of close.splice(0).reverse()) await dispose();
});
async function socket(capability = true) {
  const stream = new MemorySocket(identity(capability));
  const client = new SocketConnectorClient(opened().endpoint, () => stream);
  close.push(() => client.close());
  const connecting = client.connect();
  stream.emit("connect");
  return { client, stream, identity: await connecting };
}
async function mcp(capability = true) {
  const selected = await socket(capability);
  const reader = selectedCodexReadBridge(
    selected.client,
    opened(capability),
    selected.identity,
  );
  const server = createGoComputerMcpServer(
    new ComputerBridge(selected.client),
    opened().execution,
    selected.client.verifiedContext,
    {
      fence: {
        acquireAdmission: async () => ({
          admitted: true,
          release: async () => {},
        }),
      },
      ...(reader ? { codexRead: reader } : {}),
    },
  );
  const client = new McpClient({ name: "selected-read-cpu", version: "1" });
  close.push(
    () => server.close(),
    () => client.close(),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { ...selected, mcp: client, reader };
}

it("omits the tool on old backends and exposes one exact read on selected backends", async () => {
  const old = await mcp(false);
  expect(
    (await old.mcp.listTools()).tools.some(
      (t) => t.name === "codex_selected_thread_read",
    ),
  ).toBe(false);
  await expect(
    old.client.request(selectedCodexReadMethod, {}),
  ).rejects.toMatchObject({ state: "unsupported" });
  expect(old.stream.reads).toBe(0);
  const selected = await mcp();
  const tools = (await selected.mcp.listTools()).tools.filter(
    (t) => t.name === "codex_selected_thread_read",
  );
  expect(tools).toHaveLength(1);
  expect(tools[0]?.inputSchema.additionalProperties).toBe(false);
  expect(tools[0]?.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  for (const includeResult of [false, true]) {
    const result = await selected.mcp.callTool({
      name: "codex_selected_thread_read",
      arguments: { includeResult },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      data: {
        selection,
        text: includeResult ? "final text" : "",
        source: "stored",
        snapshot: "non_atomic",
        retained: false,
        resultEvidence: "provider_history",
      },
    });
  }
  expect(selected.stream.reads).toBe(2);
  expect(selected.client.hasUnresolvedEffect).toBe(false);
});

it.each([
  { threadId: "other" },
  { turnId: "other" },
  { includeResult: null },
  { socketPath: "/other" },
])(
  "rejects caller target/malformed input before socket read %j",
  async (input) => {
    const selected = await mcp();
    expect(
      (
        await selected.mcp.callTool({
          name: "codex_selected_thread_read",
          arguments: input,
        })
      ).isError,
    ).toBe(true);
    await expect(
      selected.client.request(selectedCodexReadMethod, input as Json),
    ).rejects.toMatchObject({ state: "refused" });
    expect(selected.stream.reads).toBe(0);
  },
);

it.each([
  "missing-witness",
  "missing-capability",
  "partial",
  "foreign-profile",
  "duplicate-capability",
])("refuses incomplete/crossed selection %s without IO", (mode) => {
  const receipt = opened(mode !== "missing-witness");
  const peer = identity(mode !== "missing-capability");
  if (mode === "partial")
    delete (receipt.codexRead!.reference as { turnId?: string }).turnId;
  if (mode === "foreign-profile")
    receipt.codexRead!.binding.profileId = "other";
  if (mode === "duplicate-capability")
    peer.capabilities = [...peer.capabilities, selectedCodexReadMethod];
  const request = vi.fn();
  expect(() => selectedCodexReadBridge({ request }, receipt, peer)).toThrow(
    "selected_codex_read_selection_invalid",
  );
  expect(request).not.toHaveBeenCalled();
});

it.each([
  "thread",
  "turn",
  "model",
  "retained",
  "evidence",
  "oversize",
  "nonterminal-text",
  "unrequested-text",
])("withholds crossed/invalid reply %s at MCP", async (mode) => {
  const selected = await mcp();
  selected.stream.alter = (data) => {
    if (mode === "thread") data.selection.reference.threadId = "other";
    if (mode === "turn") data.selection.reference.turnId = "other";
    if (mode === "model") data.selection.binding.model = "other";
    if (mode === "retained") data.retained = true;
    if (mode === "evidence") data.resultEvidence = "";
    if (mode === "oversize") data.text = "🌊".repeat(16385);
    if (mode === "unrequested-text") data.text = "unsolicited text";
    if (mode === "nonterminal-text") {
      data.lifecycle = "running";
      data.resultEvidence = "";
    }
  };
  const result = await selected.mcp.callTool({
    name: "codex_selected_thread_read",
    arguments: { includeResult: mode !== "unrequested-text" },
  });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ status: "unknown" });
  expect(result.structuredContent).not.toHaveProperty("data");
  expect(selected.stream.reads).toBe(1);
});

it("retains lost reply terminal state and never reconnects or reads again", async () => {
  const selected = await mcp();
  selected.stream.lost = true;
  for (let i = 0; i < 2; i++) {
    const result = await selected.mcp.callTool({
      name: "codex_selected_thread_read",
      arguments: { includeResult: true },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("data");
  }
  expect(selected.stream.reads).toBe(1);
  expect(selected.client.terminal?.reason).toBe("transport_ended");
});
