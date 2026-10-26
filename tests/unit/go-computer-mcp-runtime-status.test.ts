import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { BridgeError } from "../../apps/desktop/bridge/client";
import type { ConnectorTerminal } from "../../apps/desktop/bridge/connector-client";
import {
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
  type Json,
  type Outcome,
  type ComputerConnectorWrite,
} from "../../apps/desktop/bridge/wire";
import { runGoComputerMcp } from "../../apps/desktop/computer-mcp/go-main";

// Actual stdio composition with fake IO ports. No socket, private lifecycle
// files, process launch, tunnel, app or provider is exercised here.
const ports = vi.hoisted(() => ({
  capabilities: [] as string[],
  connect: vi.fn(),
  close: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  join: vi.fn(),
  servers: [] as McpServer[],
  toolNames: [] as string[],
  terminal: undefined as ConnectorTerminal | undefined,
  hasUnresolvedEffect: false as boolean | undefined,
  observers: new Set<(terminal: ConnectorTerminal) => void>(),
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
  handleClose: vi.fn(async () => {}),
  closeHandlers: vi.fn(),
  waitForHandlers: vi.fn(async () => {}),
  isStopping: vi.fn(async () => false),
  admissionClosed: false,
  request: vi.fn(),
  duringSetup: undefined as (() => void) | undefined,
  operationsShutdown: vi.fn(async () => true),
  operationsLabels: vi.fn(async () => {}),
}));
vi.mock("../../apps/desktop/operations/store", () => ({
  OperationsStore: class {
    begin() {
      return () => {};
    }
    record() {}
    shutdown = ports.operationsShutdown;
    loadWorkspaceLabels = ports.operationsLabels;
  },
}));
vi.mock("../../apps/desktop/bridge/connector-launch", () => ({
  loadConnectorLaunch: () => ({
    sha256: "b".repeat(64),
    launch: {
      lifecycleRoot: "/private/tmp/farol-runtime-fixture",
      challengeSha256: "c".repeat(64),
      opened: {
        admissionOperationId: "original",
        execution: {
          ownerId: "owner",
          sessionId: "session",
          taskId: "task",
          taskEpoch: "1",
          participantId: "participant",
          turnId: "turn",
          generation: "1",
        },
        endpoint: {
          binding: {
            buildId: "build",
            profileId: "profile",
            backendGeneration: "backend",
            runtimeId: "runtime",
            connectorGeneration: "1",
          },
          socketPath: "/private/tmp/farol-runtime-fixture/computer.sock",
          token: "a".repeat(64),
        },
      },
    },
  }),
}));
vi.mock("../../apps/desktop/bridge/connector-client", () => ({
  SocketConnectorClient: class {
    verifiedContext = { profileId: "profile", backendGeneration: "backend" };
    connect = ports.connect;
    close = ports.close;
    async request(
      method: string,
      body: Json,
      options: { id?: string; operationId?: string } = {},
    ): Promise<Outcome> {
      // Faithful submitted-effect observation; the request port represents a
      // submitted fake write. Neither this fixture nor its result is native proof.
      try {
        const result = (await ports.request(method, body, options)) as Outcome;
        if (
          options.operationId !== undefined &&
          (result.status === "unknown" ||
            (result.data !== null &&
              typeof result.data === "object" &&
              !Array.isArray(result.data) &&
              "phase" in result.data &&
              result.data.phase === "outcome_unknown"))
        )
          ports.hasUnresolvedEffect = true;
        return result;
      } catch (error) {
        if (options.operationId !== undefined) ports.hasUnresolvedEffect = true;
        throw error;
      }
    }
    get terminal() {
      return ports.terminal;
    }
    get hasUnresolvedEffect() {
      return ports.hasUnresolvedEffect;
    }
    onTerminal(observer: (terminal: ConnectorTerminal) => void) {
      ports.subscribe();
      if (ports.terminal) observer(ports.terminal);
      else ports.observers.add(observer);
      return () => {
        ports.unsubscribe();
        ports.observers.delete(observer);
      };
    }
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/private-mcp-lifecycle", () => ({
  PrivateMcpLifecycle: class {
    async join() {
      ports.join();
      return { release: ports.release };
    }
    isStopping = ports.isStopping;
    closeHandlers() {
      ports.admissionClosed = true;
      ports.closeHandlers();
    }
    waitForHandlers = ports.waitForHandlers;
    enterHandler() {
      if (ports.admissionClosed) return null;
      return () => {};
    }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: (factory: () => McpServer) => {
    expect(ports.operationsLabels).toHaveBeenCalledOnce();
    const registration = vi.spyOn(McpServer.prototype, "registerTool");
    ports.servers.push(factory());
    ports.toolNames = registration.mock.calls.map(([name]) => name);
    registration.mockRestore();
    ports.duringSetup?.();
    return { close: ports.handleClose };
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/execution-fence", () => ({
  PrivateExecutionFence: class {
    async acquireAdmission() {
      return { admitted: true as const, release: async () => {} };
    }
  },
}));
function terminal(
  reason: ConnectorTerminal["reason"] = "transport_ended",
  submitted = 0,
  effects = submitted,
): ConnectorTerminal {
  return Object.freeze({
    reason,
    phase: "ready",
    submittedPendingCount: submitted,
    submittedEffectCount: effects,
    binding: Object.freeze({
      buildId: "build",
      profileId: "profile",
      backendGeneration: "backend",
      runtimeId: "runtime",
      connectorGeneration: "1",
    }),
  });
}
function terminate(record = terminal()) {
  if (ports.terminal) return;
  ports.terminal = record;
  if (record.submittedEffectCount > 0) ports.hasUnresolvedEffect = true;
  for (const observer of ports.observers) observer(record);
  ports.observers.clear();
}

it.each(["computer_workspace_write", "computer_mutation_read"])(
  "preserves adapter-boundary UNKNOWN for effects but not safe observation: %s",
  async (name) => {
    ports.capabilities = [
      "computer.workspace.write",
      "computer.workspace.edit",
      "computer.workspace.mutation.read",
    ];
    // The socket received an envelope, but the consumer cannot qualify its body.
    // Go may retain known bytes; those cannot repair the caller's lost outcome.
    ports.request.mockImplementation(async (_method, _body, options) => ({
      status: "ok",
      requestId: options.id,
      operationId: options.operationId,
      context: { profileId: "profile", backendGeneration: "backend" },
      data: { malformed: true },
    }));
    await runGoComputerMcp("fixture");
    const client = new Client({
      name: "adapter-boundary-fixture",
      version: "1.0.0",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), ports.servers[0]!.connect(st)]);
    try {
      const result = await client.callTool({
        name,
        arguments: {
          workspaceId: "workspace",
          relativePath: "fixture.txt",
          operationId: "original",
          ...(name === "computer_workspace_write"
            ? { content: "fixture", expectedSha256: null }
            : {}),
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: "unknown",
        retry: "never",
      });
      expect(ports.hasUnresolvedEffect).toBe(false);
      terminate(terminal("closed", 0));
      await flush();
      expect(ports.release).toHaveBeenCalledExactlyOnceWith({
        effectsUnresolved: name === "computer_workspace_write",
      });
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(ports.request).toHaveBeenCalledTimes(1);
      expect(ports.join).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  },
);
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  ports.capabilities = [];
  ports.terminal = undefined;
  ports.hasUnresolvedEffect = false;
  ports.observers.clear();
  ports.admissionClosed = false;
  ports.duringSetup = undefined;
  ports.isStopping.mockResolvedValue(false);
  ports.waitForHandlers.mockResolvedValue(undefined);
  ports.handleClose.mockResolvedValue(undefined);
  ports.close.mockImplementation(async () => {
    terminate(terminal("closed"));
  });
  ports.request.mockImplementation(() => {
    throw Error("unexpected fixture request");
  });
  ports.connect.mockImplementation(async () => ({
    protocolMajor,
    protocolMinor,
    maxFrameBytes,
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    capabilities: ports.capabilities,
  }));
  vi.spyOn(process, "once").mockReturnValue(process);
  vi.spyOn(process.stdin, "once").mockReturnValue(process.stdin);
  vi.spyOn(process, "exit").mockImplementation(
    (() => undefined) as () => never,
  );
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(async () => {
  for (const server of ports.servers.splice(0)) await server.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each([false, true])(
  "gates status on the completed endpoint handshake: %s",
  async (supported) => {
    ports.capabilities = supported
      ? ["computer.connector.verification"]
      : ["computer.connector.verify"];
    await runGoComputerMcp("/private/tmp/farol-runtime-fixture/launch.json");
    expect(ports.connect).toHaveBeenCalledTimes(1);
    expect(ports.servers).toHaveLength(1);
    expect(ports.toolNames.includes("computer_connection_status")).toBe(
      supported,
    );
    expect(ports.release).not.toHaveBeenCalled();
  },
);
it("does not expose tools after a refused handshake and releases the original adapter lease", async () => {
  ports.connect.mockRejectedValueOnce(Error("handshake refused"));
  await expect(
    runGoComputerMcp("/private/tmp/farol-runtime-fixture/launch.json"),
  ).rejects.toThrow("handshake refused");
  expect(ports.servers).toHaveLength(0);
  expect(ports.connect).toHaveBeenCalledTimes(1);
  expect(ports.close).toHaveBeenCalledTimes(1);
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(ports.subscribe).not.toHaveBeenCalled();
});

it("closes admission and drains once on idle terminal without polling, reopening or inventing a clean exit", async () => {
  ports.capabilities = ["computer.connector.verification"];
  await runGoComputerMcp("fixture");
  terminate();
  expect(ports.admissionClosed).toBe(true);
  expect(ports.closeHandlers).toHaveBeenCalledTimes(1);
  terminate(terminal("transport_failed"));
  await flush();
  expect(ports.handleClose).toHaveBeenCalledTimes(1);
  expect(ports.waitForHandlers).toHaveBeenCalledTimes(1);
  expect(ports.operationsShutdown).toHaveBeenCalledTimes(1);
  expect(ports.close).toHaveBeenCalledTimes(1);
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(ports.unsubscribe).toHaveBeenCalledTimes(1);
  expect(ports.observers.size).toBe(0);
  expect(ports.isStopping).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(ports.connect).toHaveBeenCalledTimes(1);
  expect(ports.servers).toHaveLength(1);
  expect(ports.toolNames).toContain("computer_connection_status");
});

it("handles terminal before the handler is returned and safely removes a late subscription", async () => {
  ports.duringSetup = () => terminate();
  await runGoComputerMcp("fixture");
  expect(ports.admissionClosed).toBe(true);
  await flush();
  expect(ports.handleClose).toHaveBeenCalledTimes(1);
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(ports.unsubscribe).toHaveBeenCalledTimes(1);
  expect(ports.observers.size).toBe(0);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
});

it("keeps normal lifecycle closure clean despite recursive close triggers", async () => {
  ports.isStopping.mockResolvedValue(true);
  await runGoComputerMcp("fixture");
  const signal = vi
    .mocked(process.once)
    .mock.calls.find(([event]) => event === "SIGTERM")![1];
  ports.handleClose.mockImplementation(async () => {
    signal();
  });
  await vi.advanceTimersByTimeAsync(50);
  signal();
  await flush();
  expect(ports.closeHandlers).toHaveBeenCalledTimes(1);
  expect(ports.handleClose).toHaveBeenCalledTimes(1);
  expect(ports.close).toHaveBeenCalledTimes(1);
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(ports.unsubscribe).toHaveBeenCalledTimes(1);
  expect(ports.terminal?.reason).toBe("closed");
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
});

it("reports a transport fault during an already requested lifecycle drain as nonzero", async () => {
  ports.isStopping.mockResolvedValue(true);
  ports.handleClose.mockImplementation(async () => {
    terminate(terminal("transport_failed"));
  });
  await runGoComputerMcp("fixture");
  await vi.advanceTimersByTimeAsync(50);
  expect(ports.release).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
});

it("does not release the original lease or claim success when adapter drain is unconfirmed", async () => {
  ports.waitForHandlers.mockRejectedValueOnce(Error("private fixture detail"));
  await runGoComputerMcp("fixture");
  terminate();
  await flush();
  expect(ports.close).toHaveBeenCalledTimes(1);
  expect(ports.release).not.toHaveBeenCalled();
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(process.stderr.write).toHaveBeenCalledWith(
    "Farol Go Computer MCP shutdown unverified.\n",
  );
});

it("retains a submitted effect as unknown through terminal drain and refuses new tool admission", async () => {
  ports.capabilities = [
    "computer.workspace.write",
    "computer.workspace.edit",
    "computer.workspace.mutation.read",
  ];
  // The retained backend count is a double, not proof of native Go cancellation.
  const backend = { pendingUnknown: 0, retainedEffects: [] as string[] };
  let rejectSubmitted: ((error: BridgeError) => void) | undefined;
  ports.request.mockImplementation(
    (method: string, _body: unknown, options: { operationId: string }) =>
      new Promise((_resolve, reject) => {
        expect(method).toBe("computer.workspace.write");
        backend.retainedEffects.push(options.operationId);
        rejectSubmitted = (error) => {
          backend.pendingUnknown += 1;
          reject(error);
        };
      }),
  );
  let finishDrain = () => {};
  ports.waitForHandlers.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishDrain = resolve;
      }),
  );
  await runGoComputerMcp("fixture");
  const client = new Client({ name: "runtime-fixture", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), ports.servers[0]!.connect(st)]);
  try {
    const write = client.callTool({
      name: "computer_workspace_write",
      arguments: {
        workspaceId: "workspace",
        relativePath: "fixture.txt",
        content: "fixture content",
        operationId: "effect",
        expectedSha256: null,
      },
    });
    await flush();
    expect(ports.request).toHaveBeenCalledTimes(1);
    rejectSubmitted!(new BridgeError("unknown", "connector_transport_ended"));
    terminate(terminal("transport_ended", 1));
    const result = await write;
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      operationId: "effect",
      retry: "never",
    });
    const refused = await client.callTool({
      name: "computer_workspace_write",
      arguments: {
        workspaceId: "workspace",
        relativePath: "fixture.txt",
        content: "fixture content",
        operationId: "new-effect",
        expectedSha256: null,
      },
    });
    expect(refused.structuredContent).toMatchObject({
      status: "refused",
      code: "COMPUTER_MCP_STOPPING",
    });
    expect(ports.release).not.toHaveBeenCalled();
    expect(ports.operationsShutdown).not.toHaveBeenCalled();
    finishDrain();
    await flush();
    expect(ports.operationsShutdown).toHaveBeenCalledTimes(1);
    expect(backend).toEqual({ pendingUnknown: 1, retainedEffects: ["effect"] });
    expect(ports.request).toHaveBeenCalledTimes(1);
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(ports.hasUnresolvedEffect).toBe(true);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith({
      effectsUnresolved: true,
    });
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    await client.close();
  }
});

it("preserves the original marker when the selected adapter observation is missing", async () => {
  await runGoComputerMcp("fixture");
  ports.hasUnresolvedEffect = undefined;
  const signal = vi
    .mocked(process.once)
    .mock.calls.find(([event]) => event === "SIGTERM")![1];
  signal();
  await flush();
  expect(ports.terminal?.submittedEffectCount).toBe(0);
  expect(ports.release).toHaveBeenCalledExactlyOnceWith({
    effectsUnresolved: true,
  });
  expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(ports.request).not.toHaveBeenCalled();
});

it.each([
  "known",
  "returned-unknown",
  "backend-unknown",
  "lost-result",
  "timeout",
  "protocol-throw",
] as const)(
  "releases the drained lifetime while reporting %s effects independently",
  async (kind) => {
    ports.capabilities = [
      "computer.workspace.write",
      "computer.workspace.edit",
      "computer.workspace.mutation.read",
    ];
    let knownBackendBytes: object | undefined;
    ports.request.mockImplementation(
      async (
        method: string,
        body: ComputerConnectorWrite,
        options: { id: string; operationId: string },
      ) => {
        expect(method).toBe("computer.workspace.write");
        const data = {
          execution: body.execution,
          callId: options.id,
          workspaceId: body.workspaceId,
          relativePath: body.relativePath,
          operationId: options.operationId,
          computerGeneration: "1",
          origin: {
            binding: terminal().binding,
            execution: body.execution,
            callId: options.id,
            operation: "write",
          },
          phase: "completed",
          publication: "durable",
          receipt: {
            operation: "write",
            relativePath: body.relativePath,
            bytes: String(Buffer.byteLength(body.content)),
            afterSHA256: createHash("sha256")
              .update(body.content)
              .digest("hex"),
            replacements: 0,
          },
        };
        // A fake Go ledger may have known bytes even when the caller loses them.
        knownBackendBytes = data;
        if (kind === "lost-result")
          throw new BridgeError("unknown", "connector_transport_ended");
        if (kind === "timeout")
          throw new BridgeError("unknown", "response_timeout");
        if (kind === "protocol-throw")
          throw Error("private protocol fixture detail");
        const base = {
          requestId: options.id,
          context: { profileId: "profile", backendGeneration: "backend" },
          operationId: options.operationId,
        };
        if (kind === "returned-unknown")
          return {
            ...base,
            status: "unknown",
            code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          };
        if (kind === "backend-unknown") {
          const { receipt: _receipt, ...withoutReceipt } = data;
          return {
            ...base,
            status: "ok",
            data: {
              ...withoutReceipt,
              phase: "outcome_unknown",
              publication: "memory_only",
              failure: {
                code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
                source: "operation-store",
                retry: "never",
              },
            },
          };
        }
        return { ...base, status: "ok", data };
      },
    );
    await runGoComputerMcp("fixture");
    const client = new Client({ name: "runtime-fixture", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), ports.servers[0]!.connect(st)]);
    try {
      const result = await client.callTool({
        name: "computer_workspace_write",
        arguments: {
          workspaceId: "workspace",
          relativePath: "fixture.txt",
          content: "fixture content",
          operationId: "original",
          expectedSha256: null,
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: kind === "known" ? "ok" : "unknown",
        operationId: "original",
        ...(kind === "known" ? {} : { retry: "never" }),
      });
      expect(ports.hasUnresolvedEffect).toBe(kind !== "known");
      expect(knownBackendBytes).toMatchObject({ phase: "completed" });
      const signal = vi
        .mocked(process.once)
        .mock.calls.find(([event]) => event === "SIGTERM")![1];
      signal();
      await flush();
      // All submitted requests were removed before this terminal, and drain succeeds.
      expect(ports.terminal).toMatchObject({
        reason: "closed",
        submittedPendingCount: 0,
        submittedEffectCount: 0,
      });
      expect(ports.handleClose).toHaveBeenCalledTimes(1);
      expect(ports.waitForHandlers).toHaveBeenCalledTimes(1);
      expect(ports.close).toHaveBeenCalledTimes(1);
      expect(ports.release).toHaveBeenCalledExactlyOnceWith({
        effectsUnresolved: kind !== "known",
      });
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(process.stderr.write).toHaveBeenCalledWith(
        "FAROL_MCP_GO_DRAIN:" +
          JSON.stringify({
            schema: 1,
            drained: true,
            effectsUnresolved: kind !== "known",
          }) +
          "\n",
      );
      expect(ports.request).toHaveBeenCalledTimes(1);
      expect(ports.connect).toHaveBeenCalledTimes(1);
      expect(ports.join).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
    }
  },
);

it.each([0, 1])(
  "uses effect count, not read-only pending count, to fence terminal drain: %s",
  async (effects) => {
    await runGoComputerMcp("fixture");
    terminate(terminal("transport_ended", 1, effects));
    await flush();
    expect(ports.hasUnresolvedEffect).toBe(effects > 0);
    expect(ports.waitForHandlers).toHaveBeenCalledTimes(1);
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith({
      effectsUnresolved: effects > 0,
    });
    expect(ports.join).toHaveBeenCalledTimes(1);
    expect(ports.request).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  },
);
