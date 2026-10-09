import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
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
    request() {
      throw Error("no observation in composition test");
    }
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/private-mcp-lifecycle", () => ({
  PrivateMcpLifecycle: class {
    async join() {
      return { release: ports.release };
    }
    async isStopping() {
      return false;
    }
    enterHandler() {
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
    return { close: async () => {} };
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
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
});
