import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  type RegisteredTool,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationEntrySchema,
  type OperationMetadata,
} from "../../apps/desktop/renderer/operations-contract";
import { createTotalOperationsRecorder } from "../../apps/desktop/operations/recorder";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import {
  createGoComputerMcpServer,
  type GoComputerMcpLifecycle,
  type GoComputerMcpFence,
  type GoComputerMcpOptions,
} from "../../apps/desktop/bridge/computer-mcp.ts";
import {
  validate,
  type ComputerConnectorExecution,
  type Context,
  type Json,
  type Outcome,
} from "../../apps/desktop/bridge/wire.ts";

// SDK in-memory transport and fabricated wire replies only. No Go backend,
// authority, native filesystem, process, socket, app or provider qualification.
const binding: ComputerConnectorExecution = {
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
// Explicit fixture gate; production must inject its existing private fence.
const fixtureOptions = () => ({
  fence: {
    acquireAdmission: async () => ({
      admitted: true as const,
      release: async () => {},
    }),
  },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const connections: { client: Client; server: McpServer }[] = [];
afterEach(async () => {
  for (const { client, server } of connections.splice(0)) {
    await client.close();
    await server.close();
  }
  vi.restoreAllMocks();
});

function dataFor(method: string): Record<string, unknown> {
  switch (method) {
    case "computer.workspace.catalogue":
      return {
        workspaces: [
          { workspaceId: "workspace", root: root.path, approvedRoot: root },
        ],
        consistency: "per-operation",
        next: "use-exact-workspace-id",
      };
    case "computer.workspace.bootstrap":
      return {
        root: root.path,
        approvedRoot: root,
        scope: "subtree",
        complete: false,
        instructions: [
          {
            status: "read",
            relativePath: "AGENTS.md",
            text: "Rule",
            bytes: "4",
          },
          { status: "not_found", relativePath: "src/AGENTS.md" },
          {
            status: "unavailable",
            relativePath: "src/sub/AGENTS.md",
            code: "AUTHORITY_PATH_DENIED",
          },
        ],
        coverage: "root-to-directory",
        consistency: "per-operation",
        precedence: "root-to-directory",
      };
    case "computer.workspace.list":
      return { entries: ["AGENTS.md", "folder/"], truncated: true };
    case "computer.workspace.search":
      return {
        matches: [
          { path: "日本語.md", line: "1", text: "🌊\ttext", truncated: false },
        ],
        resultLimited: false,
        scanLimited: true,
      };
    default:
      return { text: "text", bytes: "4", sha256: "a".repeat(64) };
  }
}

function wireReply(method: string, params: Json, id: string) {
  const body = { ...(params as object) } as Record<string, unknown>;
  delete body.range;
  return {
    status: "ok" as const,
    requestId: id,
    context,
    data: { ...body, ...dataFor(method) } as Record<string, Json>,
  };
}

async function setup(
  options: {
    operations?: GoComputerMcpOptions["operations"];
    connectionStatus?: GoComputerMcpOptions["connectionStatus"];
    codexRead?: GoComputerMcpOptions["codexRead"];
    binding?: ComputerConnectorExecution;
    context?: Context;
    lifecycle?: GoComputerMcpLifecycle;
    fence?: GoComputerMcpFence;
    verification?: GoComputerMcpOptions["verification"];
    mutations?: GoComputerMcpOptions["mutations"];
    processes?: GoComputerMcpOptions["processes"];
    onEffectUnknown?: () => void;
    respond?: (method: string, params: Json, id: string) => unknown;
  } = {},
) {
  const request = vi.fn(
    async (method: string, params: Json, call?: { id?: string }) =>
      // Fixtures intentionally include malformed boundary replies; the real
      // ComputerBridge must validate them even though Client has a DTO type.
      (await (options.respond ?? wireReply)(
        method,
        params,
        call?.id ?? "missing",
      )) as Outcome,
  );
  const registration = vi.spyOn(McpServer.prototype, "registerTool");
  const server = createGoComputerMcpServer(
    new ComputerBridge({ request }),
    options.binding ?? binding,
    options.context ?? context,
    {
      ...(options.operations ? { operations: options.operations } : {}),
      ...(options.connectionStatus
        ? { connectionStatus: options.connectionStatus }
        : {}),
      ...(options.codexRead ? { codexRead: options.codexRead } : {}),
      fence: options.fence ?? fixtureOptions().fence,
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      ...(options.verification ? { verification: options.verification } : {}),
      ...(options.mutations ? { mutations: options.mutations } : {}),
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.onEffectUnknown
        ? { onEffectUnknown: options.onEffectUnknown }
        : {}),
    },
  );
  const tools = new Map<string, RegisteredTool>();
  registration.mock.calls.forEach(([name], index) => {
    const result = registration.mock.results[index];
    if (result?.type === "return")
      tools.set(name, result.value as RegisteredTool);
  });
  registration.mockRestore();
  const client = new Client({
    name: "go-computer-pure-test",
    version: "1.0.0",
  });
  connections.push({ client, server });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { request, client, tools };
}

function handlerContext(signal: AbortSignal): ServerContext {
  // Pure callback fixture: this codec consumes only the SDK's abort signal.
  return {
    mcpReq: { id: "caller-chosen-id", signal },
  } as unknown as ServerContext;
}

describe("selected Go process MCP projection", () => {
  type Processes = NonNullable<GoComputerMcpOptions["processes"]>;
  const target = { operationId: "original-process", handle: "original-handle" };
  const startInput = {
    operationId: target.operationId,
    workspaceId: "workspace",
    relativeCwd: ".",
    command: "synthetic command",
    write: false,
  };
  const ports = () =>
    ({
      start: vi.fn(
        async (
          ...[_input, operationId, call]: Parameters<Processes["start"]>
        ) => ({
          status: "unknown" as const,
          operationId,
          requestId: call.requestId,
          context: call.context,
          code: "fixture_only",
          retry: "never" as const,
        }),
      ),
      read: vi.fn(async (...[input, call]: Parameters<Processes["read"]>) => ({
        status: "unknown" as const,
        operationId: input.operationId,
        requestId: call.requestId,
        context: call.context,
        code: "fixture_only",
        retry: "never" as const,
      })),
      cancel: vi.fn(
        async (
          ...[input, cancelOperationId, call]: Parameters<Processes["cancel"]>
        ) => ({
          status: "unknown" as const,
          operationId: input.operationId,
          cancelOperationId,
          requestId: call.requestId,
          context: call.context,
          code: "fixture_only",
          retry: "never" as const,
        }),
      ),
    }) satisfies Processes;

  it("exposes the complete slice only for the selected Go port", async () => {
    const unavailable = await setup();
    expect(
      (await unavailable.client.listTools()).tools.some((tool) =>
        tool.name.startsWith("computer_shell_"),
      ),
    ).toBe(false);
    const processes = ports();
    const selected = await setup({ processes });
    const shell = (await selected.client.listTools()).tools.filter((tool) =>
      tool.name.startsWith("computer_shell_"),
    );
    expect(shell.map((tool) => tool.name).sort()).toEqual([
      "computer_shell_cancel",
      "computer_shell_read",
      "computer_shell_start",
    ]);
    expect(
      shell.find((tool) => tool.name === "computer_shell_read")?.annotations,
    ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    for (const name of ["computer_shell_start", "computer_shell_cancel"])
      expect(
        shell.find((tool) => tool.name === name)?.annotations,
      ).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    await selected.client.callTool({
      name: "computer_shell_start",
      arguments: startInput,
    });
    expect(processes.start).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: "workspace",
        relativeCwd: ".",
        command: "synthetic command",
        write: false,
      },
      target.operationId,
      expect.objectContaining({ context }),
    );
    const read = await selected.client.callTool({
      name: "computer_shell_read",
      arguments: target,
    });
    expect(read.structuredContent).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      retry: "never",
    });
    expect(processes.read).toHaveBeenCalledExactlyOnceWith(
      { ...target, stdoutOffset: "0", stderrOffset: "0" },
      expect.objectContaining({ context }),
    );
    const cancel = await selected.client.callTool({
      name: "computer_shell_cancel",
      arguments: { ...target, cancelOperationId: "cancel-effect" },
    });
    expect(cancel.structuredContent).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      cancelOperationId: "cancel-effect",
      retry: "never",
    });
    expect(processes.cancel).toHaveBeenCalledExactlyOnceWith(
      target,
      "cancel-effect",
      expect.objectContaining({ context }),
    );
    expect(selected.request).not.toHaveBeenCalled();
  });

  it.each([
    ["computer_shell_start", { ...startInput, command: "\0" }],
    ["computer_shell_start", { ...startInput, command: "🌊".repeat(16385) }],
    ["computer_shell_start", { ...startInput, relativeCwd: "../outside" }],
    ["computer_shell_start", { ...startInput, environment: ["PATH=/other"] }],
    ["computer_shell_read", { ...target, stdoutOffset: 4194305 }],
    [
      "computer_shell_cancel",
      { ...target, cancelOperationId: target.operationId },
    ],
  ])("refuses malformed %s before any Go call", async (name, input) => {
    const processes = ports();
    const { client } = await setup({ processes });
    const result = await client.callTool({ name, arguments: input });
    expect(result.isError).toBe(true);
    expect(processes.start).not.toHaveBeenCalled();
    expect(processes.read).not.toHaveBeenCalled();
    expect(processes.cancel).not.toHaveBeenCalled();
  });

  it("keeps stopping and lost-fence outcomes distinct without a second process call", async () => {
    const processes = ports();
    const stopping = await setup({
      processes,
      lifecycle: { isStopping: async () => true, enterHandler: () => () => {} },
    });
    expect(
      (
        await stopping.client.callTool({
          name: "computer_shell_start",
          arguments: startInput,
        })
      ).structuredContent,
    ).toMatchObject({ status: "refused", operationId: target.operationId });
    expect(processes.start).not.toHaveBeenCalled();
    const lost = await setup({
      processes,
      fence: {
        acquireAdmission: async () => ({
          admitted: true,
          release: async () => {
            throw Error("lost fixture release");
          },
        }),
      },
    });
    expect(
      (
        await lost.client.callTool({
          name: "computer_shell_start",
          arguments: startInput,
        })
      ).structuredContent,
    ).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      code: "COMPUTER_EXECUTION_FENCE_RELEASE_FAILED",
    });
    expect(processes.start).toHaveBeenCalledTimes(1);
  });
});

it("registers verification only for the selected Go port and keeps it inside the fence", async () => {
  const events: string[] = [];
  const verify = vi.fn(
    async (_challenge: string, _workspace: string, _call: string) => {
      events.push("go");
      return {
        binding: {
          buildId: "build",
          profileId: "profile",
          backendGeneration: "backend",
          runtimeId: "runtime",
          connectorGeneration: "1",
        },
      };
    },
  );
  const { client, request } = await setup({
    verification: {
      verify,
      verifyCatalogue: vi.fn(async () => {
        throw new Error("unexpected catalogue verification");
      }),
    },
    fence: {
      acquireAdmission: async () => {
        events.push("enter");
        return {
          admitted: true,
          release: async () => {
            events.push("release");
          },
        };
      },
    },
  });
  const response = await client.callTool({
    name: "farol_connector_verify",
    arguments: { challenge: "challenge", workspaceId: "workspace" },
  });
  expect(response.isError).not.toBe(true);
  expect(events).toEqual(["enter", "go", "release"]);
  expect(verify).toHaveBeenCalledWith(
    "challenge",
    "workspace",
    expect.any(String),
  );
  expect(request).not.toHaveBeenCalled();
  verify.mockRejectedValueOnce(
    new BridgeError("unavailable", "go_owner_unavailable"),
  );
  const refused = await client.callTool({
    name: "farol_connector_verify",
    arguments: { challenge: "challenge", workspaceId: "workspace" },
  });
  expect(refused.isError).toBe(true);
  expect(verify).toHaveBeenCalledTimes(2);
  expect(request).not.toHaveBeenCalled();
});

describe("Go Computer Search MCP (pure/in-memory only)", () => {
  const name = "computer_workspace_search";
  const input = {
    workspaceId: "workspace",
    relativePath: ".",
    pattern: "日本語|🌊",
  };

  it("publishes the legacy input shape with conservative RE2 and partial-result limits", async () => {
    const { client, request, tools } = await setup();
    const advertised = (await client.listTools()).tools.find(
      (tool) => tool.name === name,
    )!;
    expect(Object.keys(advertised.inputSchema.properties ?? {})).toEqual([
      "workspaceId",
      "relativePath",
      "pattern",
    ]);
    expect(advertised.inputSchema.required).toEqual([
      "workspaceId",
      "relativePath",
      "pattern",
    ]);
    expect(advertised.inputSchema.additionalProperties).toBe(false);
    for (const limitation of [
      "conservative RE2",
      "Python",
      "4096 UTF-8 bytes",
      "resultLimited",
      "scanLimited",
      "truncated",
      "no fallback",
    ])
      expect(advertised.description).toContain(limitation);
    const result = await client.callTool({ name, arguments: input });
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      data: { pattern: input.pattern, ...dataFor("computer.workspace.search") },
    });
    const ctx = handlerContext(new AbortController().signal);
    await Promise.all([
      tools.get(name)!.executor(input, ctx),
      tools.get(name)!.executor(input, ctx),
    ]);
    expect(request).toHaveBeenCalledTimes(3);
    const ids = request.mock.calls.map(([method, params, call]) => {
      expect(method).toBe("computer.workspace.search");
      expect(params).toEqual({ ...binding, ...input, callId: call?.id });
      return call?.id;
    });
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain("caller-chosen-id");
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "preserves empty SDK results and independent limits %s/%s",
    async (resultLimited, scanLimited) => {
      const { client, request } = await setup({
        respond: (method, params, id) => {
          const raw = wireReply(method, params, id);
          raw.data = { ...raw.data, matches: [], resultLimited, scanLimited };
          return raw;
        },
      });
      const result = await client.callTool({ name, arguments: input });
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        data: { matches: [], resultLimited, scanLimited },
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { pattern: "" },
    { pattern: "🌊".repeat(1025) },
    { pattern: "\ud800" },
    { pattern: "bad\npattern" },
    { pattern: "bad\tpattern" },
    { relativePath: "../file" },
    { relativePath: "src\\file" },
    { callId: "injected" },
    { ownerId: "injected" },
    { context },
    { authority: "allow" },
  ])(
    "rejects invalid public Search input without dispatch %#",
    async (extra) => {
      const { client, request } = await setup();
      expect(
        (await client.callTool({ name, arguments: { ...input, ...extra } }))
          .isError,
      ).toBe(true);
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("dispatches unsupported regex syntax once to the Go owner without choosing another engine", async () => {
    const { client, request } = await setup({
      respond: (_method, _params, id) => ({
        status: "refused",
        requestId: id,
        context,
        code: "WORKSPACE_INVALID_REQUEST",
      }),
    });
    const result = await client.callTool({
      name,
      arguments: { ...input, pattern: "\\w+" },
    });
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      code: "WORKSPACE_INVALID_REQUEST",
      retry: "never",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("computer.workspace.search");
  });
  it.each([
    { pattern: "crossed" },
    { ownerId: "crossed" },
    {
      matches: [
        { path: "../private", line: "1", text: "private", truncated: false },
      ],
    },
    {
      matches: [{ path: "file", line: "0", text: "private", truncated: false }],
    },
    {
      matches: [
        { path: "file", line: "1", text: "a".repeat(501), truncated: false },
      ],
    },
  ])(
    "withholds crossed or malformed Search replies at the SDK boundary %#",
    async (extra) => {
      const { client, request } = await setup({
        respond: (method, params, id) => {
          const raw = wireReply(method, params, id);
          raw.data = { ...raw.data, ...extra };
          return raw;
        },
      });
      const result = await client.callTool({ name, arguments: input });
      expect(result.structuredContent).toMatchObject({
        status: "unknown",
        retry: "never",
      });
      expect(result.structuredContent).not.toHaveProperty("data");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    new BridgeError("unavailable", "go_owner_unavailable"),
    new BridgeError("unknown", "go_outcome_unknown"),
  ])(
    "preserves selected-backend failure with one call and no fallback %#",
    async (error) => {
      const { client, request } = await setup({
        respond: () => {
          throw error;
        },
      });
      const result = await client.callTool({ name, arguments: input });
      expect(result.structuredContent).toMatchObject({
        status: error.state,
        code: error.code,
        retry: "never",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("does not dispatch Search when the run fence refuses admission", async () => {
    const acquireAdmission = vi.fn(async () => ({
      admitted: false as const,
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
    }));
    const { client, request } = await setup({ fence: { acquireAdmission } });
    expect(
      (await client.callTool({ name, arguments: input })).structuredContent,
    ).toMatchObject({
      status: "refused",
      code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
      retry: "never",
    });
    expect(acquireAdmission).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["before", "during", "release", "release-fails"])(
    "keeps Search abort and release suppression inside the existing fence: %s",
    async (mode) => {
      const entered = deferred<void>();
      const gate = deferred<void>();
      const release = vi.fn(async () => {
        if (mode === "release") {
          entered.resolve();
          await gate.promise;
        }
        if (mode === "release-fails") throw Error("private release error");
      });
      const { tools, request } = await setup({
        fence: { acquireAdmission: async () => ({ admitted: true, release }) },
        respond: async (method, params, id) => {
          if (mode === "during") {
            entered.resolve();
            await gate.promise;
          }
          return wireReply(method, params, id);
        },
      });
      const controller = new AbortController();
      if (mode === "before") controller.abort();
      const pending = tools
        .get(name)!
        .executor(input, handlerContext(controller.signal));
      if (mode === "during" || mode === "release") {
        await entered.promise;
        controller.abort();
        gate.resolve();
      }
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        status: mode === "before" ? "refused" : "unknown",
        retry: "never",
      });
      expect(result.structuredContent).not.toHaveProperty("data");
      expect(request).toHaveBeenCalledTimes(mode === "before" ? 0 : 1);
      expect(release).toHaveBeenCalledTimes(mode === "before" ? 0 : 1);
      expect(JSON.stringify(result)).not.toContain("private release error");
    },
  );
});

describe("Go Computer MCP codec (pure/in-memory only)", () => {
  it("requires a fence port at construction; there is no permissive production default", () => {
    const request = vi.fn();
    expect(() =>
      createGoComputerMcpServer(
        new ComputerBridge({ request }),
        binding,
        context,
        {} as Parameters<typeof createGoComputerMcpServer>[3],
      ),
    ).toThrow("invalid_computer_mcp_fence");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["computer_workspace_catalogue", {}],
    [
      "computer_workspace_bootstrap",
      { workspaceId: "workspace", relativeDirectory: "." },
    ],
    [
      "computer_workspace_list",
      { workspaceId: "workspace", relativePath: "." },
    ],
    [
      "computer_workspace_read",
      { workspaceId: "workspace", relativePath: "file" },
    ],
    [
      "computer_workspace_search",
      { workspaceId: "workspace", relativePath: ".", pattern: "🌊" },
    ],
  ])(
    "holds the injected fence across the whole Go operation for %s",
    async (name, input) => {
      const order: string[] = [];
      const { client } = await setup({
        fence: {
          acquireAdmission: async () => {
            order.push("acquire");
            return {
              admitted: true,
              release: async () => {
                order.push("release");
              },
            };
          },
        },
        lifecycle: {
          enterHandler: () => {
            order.push("enter");
            return () => {
              order.push("leave");
            };
          },
          isStopping: async () => {
            order.push("stopping");
            return false;
          },
        },
        respond: (method, params, id) => {
          order.push("Go operation");
          return wireReply(method, params, id);
        },
      });
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError).toBeUndefined();
      expect(order).toEqual([
        "enter",
        "stopping",
        "acquire",
        "stopping",
        "Go operation",
        "release",
        "stopping",
        "leave",
      ]);
    },
  );

  it.each([
    { admitted: false, code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
    { admitted: false, code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" },
    { admitted: "unknown" },
    { admitted: true },
    { admitted: false, code: "private\nerror" },
    null,
  ])(
    "withholds dispatch for denied or malformed fence admission %#",
    async (admission) => {
      const acquireAdmission = vi.fn(async () => admission);
      const { client, request } = await setup({
        fence: { acquireAdmission } as unknown as GoComputerMcpFence,
      });
      const result = await client.callTool({
        name: "computer_workspace_catalogue",
        arguments: {},
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { status: "refused", retry: "never" },
      });
      expect(result.structuredContent).not.toHaveProperty("data");
      expect(JSON.stringify(result)).not.toContain("private");
      expect(request).not.toHaveBeenCalled();
      expect(acquireAdmission).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes fence acquisition errors without retrying or invoking Go", async () => {
    const acquireAdmission = vi.fn(async () => {
      throw Error("private gate error");
    });
    const { client, request } = await setup({ fence: { acquireAdmission } });
    const result = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      code: "COMPUTER_EXECUTION_FENCE_UNREADABLE",
      retry: "never",
    });
    expect(JSON.stringify(result)).not.toContain("private gate error");
    expect(request).not.toHaveBeenCalled();
    expect(acquireAdmission).toHaveBeenCalledTimes(1);
  });

  it("awaits fence release before disclosure and checks abort once release finishes", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const release = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const { tools, request } = await setup({
      fence: { acquireAdmission: async () => ({ admitted: true, release }) },
    });
    const controller = new AbortController();
    let disclosed = false;
    const pending = tools
      .get("computer_workspace_catalogue")!
      .executor({}, handlerContext(controller.signal))
      .then((result) => {
        disclosed = true;
        return result;
      });
    await entered.promise;
    expect(disclosed).toBe(false);
    controller.abort();
    gate.resolve();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      code: "computer_mcp_aborted_after_dispatch",
      retry: "never",
    });
    expect(result.structuredContent).not.toHaveProperty("data");
    expect(release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("withholds the result when fence release fails and preserves the unknown Go outcome", async () => {
    const release = vi.fn(async () => {
      throw Error("private release error");
    });
    const { client, request } = await setup({
      fence: { acquireAdmission: async () => ({ admitted: true, release }) },
    });
    const result = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      code: "COMPUTER_EXECUTION_FENCE_RELEASE_FAILED",
      retry: "never",
    });
    expect(result.structuredContent).not.toHaveProperty("data");
    expect(JSON.stringify(result)).not.toContain("private release error");
    expect(release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "stop"])(
    "releases a pending fence admission after %s without dispatch",
    async (mode) => {
      const gate = deferred<void>();
      const entered = deferred<void>();
      const release = vi.fn(async () => {});
      let stopping = false;
      const { tools, request } = await setup({
        fence: {
          acquireAdmission: async () => {
            entered.resolve();
            await gate.promise;
            return { admitted: true, release };
          },
        },
        lifecycle: {
          enterHandler: () => () => {},
          isStopping: async () => stopping,
        },
      });
      const controller = new AbortController();
      const pending = tools
        .get("computer_workspace_catalogue")!
        .executor({}, handlerContext(controller.signal));
      await entered.promise;
      if (mode === "abort") controller.abort();
      if (mode === "stop") stopping = true;
      gate.resolve();
      expect(await pending).toMatchObject({
        isError: true,
        structuredContent: { status: "refused", retry: "never" },
      });
      expect(request).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("uses unique wire IDs even when concurrent SDK handlers have the same caller ID", async () => {
    const { tools, request } = await setup();
    const ctx = handlerContext(new AbortController().signal);
    const tool = tools.get("computer_workspace_catalogue")!;
    await Promise.all([tool.executor({}, ctx), tool.executor({}, ctx)]);
    expect(request).toHaveBeenCalledTimes(2);
    const ids = request.mock.calls.map(([, , call]) => call?.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain("caller-chosen-id");
  });
  it("advertises exactly five public tools, preserves strict schemas and dispatches each Go operation once", async () => {
    const { client, request } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "computer_workspace_catalogue",
      "computer_workspace_bootstrap",
      "computer_workspace_list",
      "computer_workspace_read",
      "computer_workspace_search",
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description?.length).toBeGreaterThan(50);
    }
    const inputs = [
      {},
      { workspaceId: "workspace", relativeDirectory: "src/sub" },
      { workspaceId: "workspace", relativePath: "." },
      { workspaceId: "workspace", relativePath: "file.md" },
      { workspaceId: "workspace", relativePath: ".", pattern: "🌊" },
    ];
    for (const [index, tool] of tools.entries()) {
      const result = await client.callTool({
        name: tool.name,
        arguments: inputs[index],
      });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ status: "ok", context });
      expect(request).toHaveBeenCalledTimes(index + 1);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent,
      );
    }
    const ids = request.mock.calls.map(([method, params, call]) => {
      expect(method).toMatch(
        /^computer\.workspace\.(catalogue|bootstrap|list|read|search)$/u,
      );
      expect(params).toMatchObject(binding);
      expect(params).toHaveProperty("callId", call?.id);
      expect(validate("id", call?.id)).toBe(true);
      expect(call?.id).not.toBe("caller-chosen-id");
      return call?.id;
    });
    expect(new Set(ids).size).toBe(5);
  });

  it("retains bootstrap completeness, catalogue provenance, list truncation and read page metadata", async () => {
    const { client } = await setup({
      respond: (method, params, id) => {
        const reply = wireReply(method, params, id);
        if (method === "computer.workspace.read")
          reply.data = {
            ...reply.data,
            text: "text",
            bytes: "4",
            sha256: "",
            page: {
              offset: "9007199254740991",
              size: "18446744073709551615",
              nextOffset: "9007199254740995",
            },
          };
        return reply;
      },
    });
    const catalogue = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(catalogue.structuredContent).toMatchObject({
      data: dataFor("computer.workspace.catalogue"),
    });
    const bootstrap = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "workspace", relativeDirectory: "src/sub" },
    });
    expect(bootstrap.structuredContent).toMatchObject({
      data: dataFor("computer.workspace.bootstrap"),
    });
    expect(bootstrap.isError).toBeUndefined();
    const list = await client.callTool({
      name: "computer_workspace_list",
      arguments: { workspaceId: "workspace", relativePath: "." },
    });
    expect(list.structuredContent).toMatchObject({
      data: { truncated: true, entries: ["AGENTS.md", "folder/"] },
    });
    const read = await client.callTool({
      name: "computer_workspace_read",
      arguments: {
        workspaceId: "workspace",
        relativePath: "file",
        offset: Number.MAX_SAFE_INTEGER,
        length: 4,
      },
    });
    expect(read.structuredContent).toMatchObject({
      data: {
        sha256: "",
        bytes: "4",
        page: {
          offset: "9007199254740991",
          size: "18446744073709551615",
          nextOffset: "9007199254740995",
        },
      },
    });
  });

  it.each([
    [{}, undefined],
    [{ offset: 0 }, { offset: "0", length: 65536 }],
    [{ length: 4 }, { offset: "0", length: 4 }],
    [
      { offset: Number.MAX_SAFE_INTEGER, length: 262144 },
      { offset: "9007199254740991", length: 262144 },
    ],
  ])(
    "maps window defaults and exact current wire types %#",
    async (window, range) => {
      const { client, request } = await setup();
      await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "workspace",
          relativePath: "file",
          ...window,
        },
      });
      const params = request.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(params.range).toEqual(range);
      if (range === undefined)
        expect(Object.hasOwn(params, "range")).toBe(false);
    },
  );

  it("snapshots trusted identity and context before later caller mutation", async () => {
    const mutableBinding = { ...binding };
    const mutableContext = { ...context };
    const { client, request } = await setup({
      binding: mutableBinding,
      context: mutableContext,
    });
    mutableBinding.ownerId = "other";
    mutableBinding.generation = "0";
    mutableContext.profileId = "other";
    const result = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(request.mock.calls[0]?.[1]).toMatchObject(binding);
    expect(result.structuredContent).toMatchObject({ status: "ok", context });
  });

  it.each([
    { ...binding, generation: 1 },
    { ...binding, taskEpoch: "18446744073709551616" },
    { ...binding, ownerId: "bad owner" },
    { ...binding, authority: "allow" },
    { ...binding, participantId: undefined },
  ])(
    "rejects malformed trusted execution before registration %#",
    (invalid) => {
      const request = vi.fn();
      expect(() =>
        createGoComputerMcpServer(
          new ComputerBridge({ request }),
          invalid as unknown as ComputerConnectorExecution,
          context,
          fixtureOptions(),
        ),
      ).toThrow("invalid_computer_mcp_binding");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects trusted context extras and accessors without invoking them", () => {
    const request = vi.fn();
    const getter = vi.fn(() => "owner");
    const invalid = { ...binding };
    Object.defineProperty(invalid, "ownerId", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      createGoComputerMcpServer(
        new ComputerBridge({ request }),
        invalid,
        context,
        fixtureOptions(),
      ),
    ).toThrow("invalid_computer_mcp_binding");
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      createGoComputerMcpServer(
        new ComputerBridge({ request }),
        binding,
        { ...context, authority: "allow" } as Context,
        fixtureOptions(),
      ),
    ).toThrow("invalid_computer_mcp_binding");
    expect(() =>
      createGoComputerMcpServer(
        new ComputerBridge({ request }),
        binding,
        { ...context, profileId: "" },
        fixtureOptions(),
      ),
    ).toThrow("invalid_computer_mcp_binding");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: "other" },
    { context },
    { authority: "allow" },
    { callId: "caller" },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: "0" },
    { length: 3 },
    { length: 262145 },
    { length: "4" },
    { relativePath: "." },
    { relativePath: "../file" },
    { relativePath: "/file" },
    { relativePath: "dir//file" },
    { relativePath: "dir\\file" },
    { relativePath: "bad\nfile" },
  ])(
    "rejects public authority injection and invalid read input without dispatch %#",
    async (extra) => {
      const { client, request } = await setup();
      const result = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "workspace", relativePath: "file", ...extra },
      });
      expect(result.isError).toBe(true);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["refused", "unknown", "unavailable", "unsupported"] as const)(
    "preserves %s and never retries",
    async (status) => {
      const { client, request } = await setup({
        respond: (_method, _params, id) => ({
          status,
          requestId: id,
          context,
          code: "EXACT_CODE",
        }),
      });
      const result = await client.callTool({
        name: "computer_workspace_catalogue",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status,
        code: "EXACT_CODE",
        retry: "never",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves classified refusal source and withholds crossed response data", async () => {
    const { client, request } = await setup({
      respond: (_method, params, id) => ({
        status: "refused",
        requestId: id,
        context,
        code: "AUTHORITY_PATH_DENIED",
        data: {
          request: params,
          code: "AUTHORITY_PATH_DENIED",
          source: "task-grant",
          retry: "never",
        },
      }),
    });
    const result = await client.callTool({
      name: "computer_workspace_list",
      arguments: { workspaceId: "workspace", relativePath: "." },
    });
    expect(result.structuredContent).toMatchObject({
      status: "refused",
      refusal: { source: "task-grant", code: "AUTHORITY_PATH_DENIED" },
    });
    request.mockImplementation(async (method, params, call) => ({
      ...wireReply(method, params, call?.id ?? "missing"),
      context: { ...context, profileId: "crossed" },
    }));
    const crossed = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(crossed.structuredContent).toMatchObject({
      status: "unknown",
      code: "crossed_computer_response",
      retry: "never",
    });
    expect(crossed.structuredContent).not.toHaveProperty("data");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([true, "reject", "no-handler"])(
    "fails closed on lifecycle admission %#",
    async (mode) => {
      const release = vi.fn();
      const { client, request } = await setup({
        lifecycle: {
          enterHandler: () => (mode === "no-handler" ? null : release),
          isStopping: async () => {
            if (mode === "reject") throw Error("private detail");
            return true;
          },
        },
      });
      const result = await client.callTool({
        name: "computer_workspace_catalogue",
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({
        status: "refused",
        code: "COMPUTER_MCP_STOPPING",
      });
      expect(request).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(mode === "no-handler" ? 0 : 1);
    },
  );

  it("does not dispatch an already aborted handler", async () => {
    const { tools, request } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await tools
      .get("computer_workspace_catalogue")!
      .executor({}, handlerContext(controller.signal));
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        status: "refused",
        code: "computer_mcp_aborted_before_dispatch",
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("checks abort again after asynchronous lifecycle admission", async () => {
    const gate = deferred<boolean>();
    const entered = deferred<void>();
    const release = vi.fn();
    const { tools, request } = await setup({
      lifecycle: {
        enterHandler: () => release,
        isStopping: () => {
          entered.resolve();
          return gate.promise;
        },
      },
    });
    const controller = new AbortController();
    const pending = tools
      .get("computer_workspace_catalogue")!
      .executor({}, handlerContext(controller.signal));
    await entered.promise;
    controller.abort();
    gate.resolve(false);
    expect(await pending).toMatchObject({
      structuredContent: {
        status: "refused",
        code: "computer_mcp_aborted_before_dispatch",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "stop", "release-fails"])(
    "suppresses data after dispatch on %s, without a second call",
    async (mode) => {
      const gate = deferred<void>();
      const entered = deferred<void>();
      let stopping = false;
      const release = vi.fn(() => {
        if (mode === "release-fails") throw Error("private detail");
      });
      const { tools, request } = await setup({
        lifecycle: {
          enterHandler: () => release,
          isStopping: async () => stopping,
        },
      });
      request.mockImplementation(async (method, params, call) => {
        entered.resolve();
        await gate.promise;
        return wireReply(method, params, call?.id ?? "missing");
      });
      const controller = new AbortController();
      const pending = tools
        .get("computer_workspace_read")!
        .executor(
          { workspaceId: "workspace", relativePath: "file" },
          handlerContext(controller.signal),
        );
      await entered.promise;
      if (mode === "abort") controller.abort();
      if (mode === "stop") stopping = true;
      gate.resolve();
      const result = await pending;
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { status: "unknown", retry: "never" },
      });
      expect(result.structuredContent).not.toHaveProperty("data");
      expect(JSON.stringify(result)).not.toContain("private detail");
      expect(request).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("does not expose transport exception text or invent retry authority", async () => {
    const { client, request } = await setup({
      respond: () => {
        throw Error("private detail");
      },
    });
    const result = await client.callTool({
      name: "computer_workspace_catalogue",
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      status: "unknown",
      code: "computer_transport_failed",
      retry: "never",
    });
    expect(JSON.stringify(result)).not.toContain("private detail");
    request.mockRejectedValueOnce(
      new BridgeError("unsupported", "EXACT_UNSUPPORTED"),
    );
    expect(
      (
        await client.callTool({
          name: "computer_workspace_catalogue",
          arguments: {},
        })
      ).structuredContent,
    ).toMatchObject({
      status: "unsupported",
      code: "EXACT_UNSUPPORTED",
      retry: "never",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("Go Computer mutation MCP (pure/in-memory only)", () => {
  const target = {
    workspaceId: "workspace",
    relativePath: "note.md",
    operationId: "caller-operation",
  };
  const writeInput = { ...target, content: "text", expectedSha256: null };
  const editInput = {
    ...target,
    expectedSha256: "a".repeat(64),
    edits: [{ oldText: "old", newText: "new" }],
  };
  const mutations = () =>
    ({
      write: vi.fn(async (_input, operationId, call) => ({
        status: "unknown" as const,
        operationId,
        requestId: call.requestId,
        context: call.context,
        code: "response_timeout",
        retry: "never" as const,
      })),
      edit: vi.fn(async (_input, operationId, call) => ({
        status: "unknown" as const,
        operationId,
        requestId: call.requestId,
        context: call.context,
        code: "response_timeout",
        retry: "never" as const,
      })),
      read: vi.fn(async (input, call) => ({
        status: "refused" as const,
        operationId: input.operationId,
        requestId: call.requestId,
        context: call.context,
        code: "COMPUTER_MUTATION_NOT_FOUND",
        retry: "never" as const,
      })),
    }) satisfies NonNullable<GoComputerMcpOptions["mutations"]>;

  it("advertises effects only when the host supplies mutations and requires operationId", async () => {
    const absent = await setup();
    expect(
      (await absent.client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain("computer_workspace_write");
    const selected = mutations();
    const { client } = await setup({ mutations: selected });
    const tools = (await client.listTools()).tools;
    for (const name of [
      "computer_workspace_write",
      "computer_workspace_edit",
      "computer_mutation_read",
    ]) {
      const tool = tools.find((entry) => entry.name === name)!;
      expect(tool.inputSchema.required).toContain("operationId");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBe(
        name === "computer_mutation_read",
      );
      if (name !== "computer_mutation_read")
        expect(tool.annotations?.idempotentHint).toBe(false);
    }
    expect(
      tools.find((tool) => tool.name === "computer_workspace_catalogue")
        ?.description,
    ).toContain("bounded mutations");
    const { operationId: _operationId, ...missing } = writeInput;
    expect(
      (
        await client.callTool({
          name: "computer_workspace_write",
          arguments: missing,
        })
      ).isError,
    ).toBe(true);
    expect(selected.write).not.toHaveBeenCalled();
  });
  it("uses the existing fence once per call, forwards caller IDs and returns them on UNKNOWN", async () => {
    const selected = mutations();
    const release = vi.fn(async () => {});
    const acquireAdmission = vi.fn(async () => ({
      admitted: true as const,
      release,
    }));
    const { client, request } = await setup({
      mutations: selected,
      fence: { acquireAdmission },
    });
    for (const [name, input] of [
      ["computer_workspace_write", writeInput],
      ["computer_workspace_edit", editInput],
      ["computer_mutation_read", target],
    ] as const) {
      const out = await client.callTool({ name, arguments: input });
      expect(out.isError).toBe(true);
      expect(out.structuredContent).toMatchObject({
        operationId: target.operationId,
        retry: "never",
      });
    }
    expect(selected.write).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: target.workspaceId,
        relativePath: target.relativePath,
        content: "text",
      },
      target.operationId,
      expect.objectContaining({ requestId: expect.any(String), context }),
    );
    expect(selected.edit).toHaveBeenCalledTimes(1);
    expect(selected.read).toHaveBeenCalledExactlyOnceWith(
      target,
      expect.objectContaining({ context }),
    );
    expect(acquireAdmission).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves published connector mutation names and maps public preimage spelling once", async () => {
    const selected = mutations();
    const { client } = await setup({ mutations: selected });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("computer_workspace_search");
    for (const alias of [
      "computer_write",
      "computer_edit",
      "farol_computer_search",
    ])
      expect(names).not.toContain(alias);
    const expectedSha256 = "b".repeat(64);
    await client.callTool({
      name: "computer_workspace_write",
      arguments: { ...writeInput, expectedSha256 },
    });
    expect(selected.write).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: target.workspaceId,
        relativePath: target.relativePath,
        content: "text",
        expectedSHA256: expectedSha256,
      },
      target.operationId,
      expect.objectContaining({ context }),
    );
    await client.callTool({
      name: "computer_workspace_edit",
      arguments: editInput,
    });
    expect(selected.edit).toHaveBeenCalledExactlyOnceWith(
      {
        workspaceId: target.workspaceId,
        relativePath: target.relativePath,
        edits: editInput.edits,
        expectedSHA256: editInput.expectedSha256,
      },
      target.operationId,
      expect.objectContaining({ context }),
    );
  });
  it("refuses missing or misspelled public preimages before invoking mutations", async () => {
    const selected = mutations();
    const { client } = await setup({ mutations: selected });
    const { expectedSha256: _createOnly, ...withoutWriteHash } = writeInput;
    const { expectedSha256: _editHash, ...withoutEditHash } = editInput;
    for (const [name, input] of [
      ["computer_workspace_write", withoutWriteHash],
      [
        "computer_workspace_write",
        { ...withoutWriteHash, expectedSHA256: "b".repeat(64) },
      ],
      [
        "computer_workspace_write",
        { ...writeInput, expectedSHA256: "b".repeat(64) },
      ],
      [
        "computer_workspace_edit",
        { ...withoutEditHash, expectedSHA256: "b".repeat(64) },
      ],
      ["computer_workspace_edit", { ...editInput, expectedSha256: null }],
    ] as const)
      expect((await client.callTool({ name, arguments: input })).isError).toBe(
        true,
      );
    expect(selected.write).not.toHaveBeenCalled();
    expect(selected.edit).not.toHaveBeenCalled();
  });
  it("preserves the operation ID when abort or fence release makes the outcome unknown", async () => {
    const selected = mutations();
    const controller = new AbortController();
    selected.write.mockImplementationOnce(async (_input, operationId, call) => {
      controller.abort();
      return {
        status: "unknown",
        operationId,
        requestId: call.requestId,
        context: call.context,
        code: "response_timeout",
        retry: "never",
      };
    });
    const { tools } = await setup({ mutations: selected });
    const out = await tools
      .get("computer_workspace_write")!
      .executor(writeInput, handlerContext(controller.signal));
    expect(out.structuredContent).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      code: "computer_mcp_aborted_after_dispatch",
    });
    const broken = await setup({
      mutations: mutations(),
      fence: {
        acquireAdmission: async () => ({
          admitted: true,
          release: async () => {
            throw Error("fixture");
          },
        }),
      },
    });
    const response = await broken.client.callTool({
      name: "computer_workspace_edit",
      arguments: editInput,
    });
    expect(response.structuredContent).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      code: "COMPUTER_EXECUTION_FENCE_RELEASE_FAILED",
    });
  });
  it("retains an effect aborted during the final stopping await before releasing its handler", async () => {
    const controller = new AbortController();
    const finalCheck = deferred<boolean>();
    const enteredFinalCheck = deferred<void>();
    const events: string[] = [];
    let checks = 0;
    const write = vi.fn<
      NonNullable<GoComputerMcpOptions["mutations"]>["write"]
    >(async (_input, operationId, call) => ({
      status: "ok",
      operationId,
      requestId: call.requestId,
      context: call.context,
    }));
    const { tools } = await setup({
      mutations: { ...mutations(), write },
      lifecycle: {
        enterHandler: () => () => events.push("leave"),
        isStopping: async () => {
          if (++checks !== 3) return false;
          enteredFinalCheck.resolve();
          return finalCheck.promise;
        },
      },
      onEffectUnknown: () => events.push("unknown"),
    });
    const pending = tools
      .get("computer_workspace_write")!
      .executor(writeInput, handlerContext(controller.signal));
    await enteredFinalCheck.promise;
    controller.abort();
    finalCheck.resolve(false);
    expect((await pending).structuredContent).toMatchObject({
      status: "unknown",
      operationId: target.operationId,
      code: "computer_mcp_aborted_after_dispatch",
      retry: "never",
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["unknown", "leave"]);
  });
  it("blocks stopping/denied-fence effects without replay or dropping the caller ID", async () => {
    const selected = mutations();
    const { client } = await setup({
      mutations: selected,
      fence: {
        acquireAdmission: async () => ({
          admitted: false,
          code: "AUTHORITY_EXPIRED",
        }),
      },
    });
    expect(
      (
        await client.callTool({
          name: "computer_workspace_write",
          arguments: writeInput,
        })
      ).structuredContent,
    ).toMatchObject({
      status: "refused",
      operationId: target.operationId,
      code: "AUTHORITY_EXPIRED",
    });
    expect(selected.write).not.toHaveBeenCalled();
    const stopping = await setup({
      mutations: selected,
      lifecycle: { isStopping: async () => true, enterHandler: () => () => {} },
    });
    expect(
      (
        await stopping.client.callTool({
          name: "computer_workspace_edit",
          arguments: editInput,
        })
      ).structuredContent,
    ).toMatchObject({
      status: "refused",
      operationId: target.operationId,
      code: "COMPUTER_MCP_STOPPING",
    });
    expect(selected.edit).not.toHaveBeenCalled();
  });
});

it("routes explicit empty catalogue verification through the same admission fence", async () => {
  const events: string[] = [];
  const verify = vi.fn(async () => {
    throw new Error("must not list a workspace");
  });
  const verifyCatalogue = vi.fn(async (_challenge: string, _call: string) => {
    events.push("catalogue");
    return {
      binding: {
        buildId: "build",
        profileId: "profile",
        backendGeneration: "backend",
        runtimeId: "runtime",
        connectorGeneration: "1",
      },
    };
  });
  const { client, request } = await setup({
    verification: { verify, verifyCatalogue },
    fence: {
      acquireAdmission: async () => {
        events.push("enter");
        return {
          admitted: true,
          release: async () => {
            events.push("release");
          },
        };
      },
    },
  });
  const out = await client.callTool({
    name: "farol_connector_verify_catalogue",
    arguments: { challenge: "challenge" },
  });
  expect(out.isError).not.toBe(true);
  expect(events).toEqual(["enter", "catalogue", "release"]);
  expect(verifyCatalogue).toHaveBeenCalledWith("challenge", expect.any(String));
  expect(verify).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

const shellLogStart = {
  operationId: "op",
  workspaceId: "workspace",
  relativeCwd: "src",
  command: "echo PRIVATE-CANARY",
  stdin: "PRIVATE-STDIN",
  write: false,
};
const shellLogTarget = {
  workspace: "workspace",
  relativePath: "src",
  command: "echo",
};
const unknownLogTarget = { handle: "handle", start: "unknown" } as const;
const recordedToolCases: {
  name: string;
  input: Record<string, unknown>;
  target: OperationMetadata["target"];
  start?: "known" | "unknown" | "repeated" | "refused" | "evicted";
}[] = [
  { name: "computer_connection_status", input: {}, target: {} },
  {
    name: "farol_connector_verify_catalogue",
    input: { challenge: "private-challenge" },
    target: {},
  },
  {
    name: "farol_connector_verify",
    input: { challenge: "private-challenge", workspaceId: "workspace" },
    target: { workspace: "workspace" },
  },
  { name: "computer_workspace_catalogue", input: {}, target: {} },
  {
    name: "computer_workspace_bootstrap",
    input: { workspaceId: "workspace", relativeDirectory: "src" },
    target: { workspace: "workspace", relativePath: "src" },
  },
  {
    name: "computer_workspace_list",
    input: { workspaceId: "workspace", relativePath: "." },
    target: { workspace: "workspace", relativePath: "." },
  },
  {
    name: "computer_workspace_read",
    input: { workspaceId: "workspace", relativePath: "README.md" },
    target: { workspace: "workspace", relativePath: "README.md" },
  },
  {
    name: "computer_workspace_search",
    input: {
      workspaceId: "workspace",
      relativePath: ".",
      pattern: "PRIVATE-CANARY",
    },
    target: { workspace: "workspace", relativePath: "." },
  },
  {
    name: "computer_workspace_write",
    input: {
      operationId: "op",
      workspaceId: "workspace",
      relativePath: "x",
      expectedSha256: null,
      content: "PRIVATE-CANARY",
    },
    target: { workspace: "workspace", relativePath: "x" },
  },
  {
    name: "computer_workspace_edit",
    input: {
      operationId: "op",
      workspaceId: "workspace",
      relativePath: "x",
      expectedSha256: "a".repeat(64),
      edits: [{ oldText: "PRIVATE-CANARY", newText: "secret" }],
    },
    target: { workspace: "workspace", relativePath: "x" },
  },
  {
    name: "computer_mutation_read",
    input: { operationId: "op", workspaceId: "workspace", relativePath: "x" },
    target: { workspace: "workspace", relativePath: "x" },
  },
  {
    name: "computer_shell_start",
    input: shellLogStart,
    target: shellLogTarget,
  },
  ...(["computer_shell_read", "computer_shell_cancel"] as const).flatMap(
    (name) => {
      const input = {
        operationId: "op",
        handle: "handle",
        ...(name === "computer_shell_cancel"
          ? { cancelOperationId: "cancel" }
          : {}),
      };
      return [
        { name, input, target: unknownLogTarget },
        { name, input, target: shellLogTarget, start: "known" as const },
        { name, input, target: shellLogTarget, start: "unknown" as const },
        { name, input, target: shellLogTarget, start: "repeated" as const },
        { name, input, target: unknownLogTarget, start: "refused" as const },
        { name, input, target: unknownLogTarget, start: "evicted" as const },
        {
          name,
          input: { ...input, handle: "different-handle" },
          target: { handle: "different-handle", start: "unknown" as const },
          start: "known" as const,
        },
        {
          name,
          input: { ...input, operationId: "different-op" },
          target: unknownLogTarget,
          start: "known" as const,
        },
      ];
    },
  ),
  {
    name: "codex_selected_thread_read",
    input: { includeResult: true },
    target: {},
  },
];
it.each([
  "a+b.txt",
  "资料/Проект/notes [v1] #1,=~.md",
  "Release notes/a b.md",
  "nested/".repeat(30) + "[file]+.txt",
  "x".repeat(4096),
])(
  "records tool-valid unusual paths through MCP: case %#",
  async (relativePath) => {
    const record = vi.fn();
    const recorder = createTotalOperationsRecorder({ record });
    recorder.setWorkspaceLabels([
      { workspaceId: "workspace", label: "Owner Docs" },
    ]);
    const { client, request } = await setup({
      operations: recorder,
      respond: async () => {
        throw new BridgeError("refused", "OPERATION_REFUSED");
      },
    });
    await client.callTool({
      name: "computer_workspace_read",
      arguments: { workspaceId: "workspace", relativePath },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).toEqual({
      source: "ChatGPT",
      kind: "computer_workspace_read",
      target: {
        workspace: "Owner Docs",
        workspaceIdentity: createHash("sha256")
          .update("workspace")
          .digest("hex"),
        relativePath,
      },
    });
    expect(record.mock.calls[0]![1]).toBe("refused");
  },
);

it("records an unlisted MCP refusal code as counted unknown without changing the reply", async () => {
  const record = vi.fn();
  const recorder = createTotalOperationsRecorder({ record });
  const { client, request } = await setup({
    operations: recorder,
    respond: async () => {
      throw new BridgeError("refused", "FUTURE_MCP_CODE");
    },
  });
  const reply = await client.callTool({
    name: "computer_workspace_read",
    arguments: { workspaceId: "workspace", relativePath: "README.md" },
  });
  expect(reply.structuredContent).toMatchObject({
    status: "refused",
    code: "FUTURE_MCP_CODE",
  });
  expect(request).toHaveBeenCalledOnce();
  expect(record.mock.calls[0]!.slice(1, 3)).toEqual([
    "unknown",
    "OPERATION_CODE_UNMAPPED",
  ]);
  expect(recorder.diagnostics().unmappedCodes).toBe(1);
});

it.each(
  recordedToolCases.flatMap((test) =>
    ["workspace", "My private sentence about the owner", "Owner Docs"].map(
      (workspaceId) => ({ ...test, workspaceId }),
    ),
  ),
)(
  "resolves the target for $name (start: $start, workspace: $workspaceId)",
  async ({ name, input: originalInput, target, start, workspaceId }) => {
    const input = {
      ...originalInput,
      ...("workspaceId" in originalInput ? { workspaceId } : {}),
    };
    const record = vi.fn();
    const refused = async (): Promise<never> => {
      throw new BridgeError("refused", "OPERATION_REFUSED");
    };
    // Fabricated start/result only; no command or provider is executed.
    const processes: NonNullable<GoComputerMcpOptions["processes"]> = {
      start: async (_input, operationId, call) => {
        if (start === "refused") return refused();
        if (start === "unknown")
          return {
            status: "unknown",
            operationId,
            requestId: call.requestId,
            context: call.context,
            code: "FIXTURE_UNKNOWN",
            retry: "never",
          };
        return {
          status: "ok",
          operationId,
          requestId: call.requestId,
          context: call.context,
          data: {
            execution: binding,
            callId: call.requestId,
            operationId,
            handle: "handle",
          },
        };
      },
      read: async (input, call) => ({
        status: "refused",
        operationId: input.operationId,
        requestId: call.requestId,
        context: call.context,
        code: "OPERATION_REFUSED",
        stdout: "PRIVATE-OUTPUT",
        stderr: "PRIVATE-OUTPUT",
      }),
      cancel: refused,
    };
    const recorder = createTotalOperationsRecorder({ record });
    recorder.setWorkspaceLabels([
      { workspaceId: "workspace", label: "Owner Docs" },
    ]);
    const { client, tools } = await setup({
      operations: recorder,
      respond: refused,
      verification: { verify: refused, verifyCatalogue: refused },
      connectionStatus: { observe: refused },
      mutations: { write: refused, edit: refused, read: refused },
      processes,
      codexRead: { read: refused },
    });
    // Any newly registered kind must receive an explicit target expectation.
    expect([...tools.keys()].sort()).toEqual(
      [...new Set(recordedToolCases.map(({ name }) => name))].sort(),
    );
    if (start) {
      await client.callTool({
        name: "computer_shell_start",
        arguments: { ...shellLogStart, workspaceId },
      });
      if (start === "repeated")
        await client.callTool({
          name: "computer_shell_start",
          arguments: {
            ...shellLogStart,
            workspaceId: "other",
            command: "other secret",
          },
        });
      if (start === "evicted")
        for (let i = 0; i < 1024; i++)
          await tools
            .get("computer_shell_start")!
            .executor(
              { ...shellLogStart, operationId: `other-${i}` },
              handlerContext(new AbortController().signal),
            );
      record.mockClear();
    }
    const reply = await client.callTool({ name, arguments: input });
    expect(record).toHaveBeenCalledOnce();
    const [metadata, outcome, code, durationMs] = record.mock.calls[0]!;
    const { workspace, relativePath, ...rest } = target;
    const safeTarget = {
      ...rest,
      ...(workspace === undefined
        ? {}
        : {
            workspace:
              workspaceId === "workspace"
                ? "Owner Docs"
                : "[unknown workspace]",
          }),
      ...(workspace !== undefined && workspaceId === "workspace"
        ? {
            workspaceIdentity: createHash("sha256")
              .update("workspace")
              .digest("hex"),
          }
        : {}),
      ...(workspace !== undefined &&
      workspaceId === "workspace" &&
      relativePath !== undefined
        ? { relativePath }
        : {}),
      ...(target.command === undefined
        ? {}
        : { command: target.command === "git" ? "git" : "other" }),
      ...(target.handle === undefined ? {} : { handle: "unrecognized" }),
    };
    expect(metadata).toEqual({
      kind: name,
      source: name === "codex_selected_thread_read" ? "Codex" : "ChatGPT",
      target: safeTarget,
    });
    expect(outcome).toBe(name === "computer_shell_start" ? "done" : "refused");
    expect(code).toBe(
      (reply.structuredContent as Record<string, unknown> | undefined)?.code ??
        null,
    );
    expect(durationMs).toEqual(expect.any(Number));
    const entry = OperationEntrySchema.parse({
      ...metadata,
      outcome,
      code,
      durationMs: Math.round(durationMs),
      id: "00000000-0000-4000-8000-000000000000",
      at: 0,
    });
    expect(entry.target).toEqual(safeTarget);
    expect(JSON.stringify(record.mock.calls)).not.toMatch(
      /My private sentence|PRIVATE-CANARY|PRIVATE-STDIN|PRIVATE-OUTPUT|private-challenge|secret|"(?:content|text|stdin|stdout|stderr|arguments|edits|pattern)":/,
    );
  },
);
