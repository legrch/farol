import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { BridgeError } from "../../apps/desktop/bridge/client";
import type { ConnectorTerminal } from "../../apps/desktop/bridge/connector-client";
import {
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
} from "../../apps/desktop/bridge/wire";
import { runGoComputerMcp } from "../../apps/desktop/computer-mcp/go-main";

// Actual stdio composition with fake IO ports. No socket, private lifecycle
// files, process launch, tunnel, app or provider is exercised here.
const ports = vi.hoisted(() => ({
  capabilities: [] as string[],
  connect: vi.fn(),
  close: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  servers: [] as McpServer[],
  toolNames: [] as string[],
  terminal: undefined as ConnectorTerminal | undefined,
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
    request = ports.request;
    get terminal() {
      return ports.terminal;
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
): ConnectorTerminal {
  return Object.freeze({
    reason,
    phase: "ready",
    submittedPendingCount: submitted,
    submittedEffectCount: submitted,
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
  for (const observer of ports.observers) observer(record);
  ports.observers.clear();
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  ports.capabilities = [];
  ports.terminal = undefined;
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
    finishDrain();
    await flush();
    expect(backend).toEqual({ pendingUnknown: 1, retainedEffects: ["effect"] });
    expect(ports.request).toHaveBeenCalledTimes(1);
    expect(ports.close).toHaveBeenCalledTimes(1);
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  } finally {
    await client.close();
  }
});
