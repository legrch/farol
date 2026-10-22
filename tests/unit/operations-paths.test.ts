import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";
import { operationsDirectory } from "../../apps/desktop/operations/paths";
import { OperationsStore } from "../../apps/desktop/operations/store";
import {
  protocolMajor,
  protocolMinor,
  maxFrameBytes,
} from "../../apps/desktop/bridge/wire";
import { runGoComputerMcp } from "../../apps/desktop/computer-mcp/go-main";

// Real composition/store and SDK tool dispatch, with disposable filesystem state.
// Socket, lifecycle and fence ports are fixtures, not native/provider qualification.
const ports = vi.hoisted(() => ({
  lifecycleRoot: "",
  server: undefined as McpServer | undefined,
}));
vi.mock("../../apps/desktop/bridge/connector-launch", () => ({
  loadConnectorLaunch: () => ({
    sha256: "b".repeat(64),
    launch: {
      lifecycleRoot: ports.lifecycleRoot,
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
          socketPath: "/private/tmp/farol-operation-fixture/computer.sock",
          token: "a".repeat(64),
        },
      },
    },
  }),
}));
vi.mock("../../apps/desktop/bridge/connector-client", () => ({
  SocketConnectorClient: class {
    verifiedContext = { profileId: "profile", backendGeneration: "backend" };
    terminal = { reason: "closed", submittedEffectCount: 0 };
    hasUnresolvedEffect = false;
    async connect() {
      return {
        protocolMajor,
        protocolMinor,
        maxFrameBytes,
        buildId: "build",
        profileId: "profile",
        backendGeneration: "backend",
        capabilities: [],
      };
    }
    async close() {}
    onTerminal() {
      return () => {};
    }
    async request(_method: string, params: object, call: { id: string }) {
      return {
        status: "ok",
        requestId: call.id,
        context: this.verifiedContext,
        data: { ...params, entries: ["README.md"], truncated: false },
      };
    }
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/private-mcp-lifecycle", () => ({
  PrivateMcpLifecycle: class {
    async join() {
      return { release: async () => {} };
    }
    async isStopping() {
      return false;
    }
    enterHandler() {
      return () => {};
    }
    closeHandlers() {}
    async waitForHandlers() {}
  },
}));
vi.mock("../../src/modules/computer/infra/mcp/execution-fence", () => ({
  PrivateExecutionFence: class {
    async acquireAdmission() {
      return { admitted: true, release: async () => {} };
    }
  },
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: (factory: () => McpServer) => {
    ports.server = factory();
    return {
      close: async () => {
        await ports.server?.close();
      },
    };
  },
}));

it("wires the admitted MCP lifecycle layout to Desktop's store and owner label index", async () => {
  const userData = fs.mkdtempSync(
    path.join(os.tmpdir(), "farol-operation-paths-"),
  );
  // Pin the actual Desktop constructor argument rather than a second path literal.
  const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
  const argument = source.match(
    /function operationsStore\(\): OperationsStore \{\s*return \(operationsLog \?\?= new OperationsStore\(\s*([\s\S]*?),\s*\)\);\s*\}/u,
  )?.[1];
  expect(argument).toBeDefined();
  expect(source).toContain(
    'import { operationsDirectory } from "../../../apps/desktop/operations/paths";',
  );
  const directory = vm.runInNewContext(argument!, {
    path,
    operationsDirectory,
    app: {
      getPath: (name: string) => {
        expect(name).toBe("userData");
        return userData;
      },
    },
  }) as string;
  const desktop = new OperationsStore(directory);
  ports.lifecycleRoot = path.join(
    userData,
    "farol-private",
    "secure-mcp-connector",
    "computer-authority",
  );
  const once = vi.spyOn(process, "once").mockReturnValue(process);
  vi.spyOn(process.stdin, "once").mockReturnValue(process.stdin);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const load = vi.spyOn(OperationsStore.prototype, "loadWorkspaceLabels");
  let mcp: OperationsStore | undefined;
  let client: Client | undefined;
  try {
    desktop.setWorkspaceLabels([
      { workspaceId: "workspace", label: "Owner Docs" },
    ]);
    expect(await desktop.flush(5000)).toBe(true);
    await runGoComputerMcp("fixture");
    const loaded = load.mock.contexts[0];
    if (!(loaded instanceof OperationsStore))
      throw Error("fixture store missing");
    mcp = loaded;
    client = new Client({ name: "operations-wiring-fixture", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), ports.server!.connect(st)]);
    const result = await client.callTool({
      name: "computer_workspace_list",
      arguments: { workspaceId: "workspace", relativePath: "." },
    });
    expect(result.isError).not.toBe(true);
    expect(await mcp!.flush(5000)).toBe(true);
    expect((await desktop.snapshot(5000)).entries).toMatchObject([
      {
        source: "ChatGPT",
        kind: "computer_workspace_list",
        outcome: "done",
        target: { workspace: "Owner Docs", relativePath: "." },
      },
    ]);
    expect(mcp!.directory).toBe(desktop.directory);
    expect(
      fs.existsSync(path.join(userData, "farol-private", "operations")),
    ).toBe(false);
  } finally {
    await client?.close();
    const stop = once.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
    stop?.();
    if (stop) await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    await mcp?.shutdown(5000);
    await desktop.shutdown(5000);
    vi.restoreAllMocks();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
