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
  it("exposes bounded project resolution only through a configured task port and rejects foreign/malformed readback", async () => {
    const known = {
      status: "resolved" as const,
      workspaceId: "writer",
      writerRoot: "/fixture/writer",
      projectRoot: "/fixture/project",
      complete: true as const,
      pages: 1,
      matches: [{ projectId: "saved-project", name: "Project" }],
      selectedProjectId: "saved-project",
      selection: "requested-id" as const,
    };
    let mode = "known";
    let signal: AbortSignal | undefined;
    const route: CodexTaskRoute = {
      async resolveProject(_input, context) {
        signal = context?.signal;
        if (mode === "throw") throw new Error("No reply");
        if (mode === "foreign") return { ...known, workspaceId: "foreign" };
        if (mode === "malformed")
          return {
            ...known,
            status: "missing",
            selectedProjectId: null,
            selection: null,
          };
        return known;
      },
      async create() {
        throw new Error("unexpected create");
      },
      async message() {
        throw new Error("unexpected message");
      },
      async status() {
        return { status: "unknown" };
      },
      async result() {
        return { status: "unknown" };
      },
    };
    const { client, server } = await connected(route);
    try {
      const call = () =>
        client.callTool({
          name: "codex_project_resolve",
          arguments: { workspaceId: "writer" },
        });
      expect(
        (await client.listTools()).tools.some(
          (tool) =>
            tool.name === "codex_project_resolve" &&
            tool.annotations?.readOnlyHint === true,
        ),
      ).toBe(true);
      expect((await call()).structuredContent).toEqual(known);
      expect(signal).toBeDefined();
      for (const changed of ["foreign", "malformed"]) {
        mode = changed;
        expect((await call()).structuredContent).toMatchObject({
          status: "refused",
          code: "HANDOFF_PROJECT_RESOLVE_CORRELATION",
        });
      }
      mode = "throw";
      expect((await call()).structuredContent).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_RESOLVE_UNAVAILABLE",
      });
    } finally {
      await client.close();
      await server.close();
    }
    const absent = await connected();
    try {
      expect(
        (await absent.client.listTools()).tools.some(
          (tool) => tool.name === "codex_project_resolve",
        ),
      ).toBe(false);
    } finally {
      await absent.client.close();
      await absent.server.close();
    }
  });

  it("validates active message bytes before delegate and exposes exact steer receipt", async () => {
    const messages: Array<{
      message: string;
      reasoningEffort: string | undefined;
    }> = [];
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
        messages.push({
          message: input.message,
          reasoningEffort: input.reasoningEffort,
        });
        return {
          status: "steered",
          dispatchId: input.dispatchId,
          turnId: "issued-turn",
        };
      },
    };
    const { client, server } = await connected(route);
    const steerKey = randomUUID();
    const send = (
      message: string,
      reasoningEffort?: string,
      messageKey = steerKey,
    ) =>
      client.callTool({
        name: "codex_task_message",
        arguments: {
          key: messageKey,
          dispatchId: key,
          workspaceId: "writer",
          projectId: "saved-project",
          message,
          model: "gpt-6-luna",
          reasoningEffort,
        },
      });
    try {
      for (const message of ["", "bad\0message", "😀".repeat(2_049)])
        expect((await send(message)).isError).toBe(true);
      expect(messages).toEqual([]);
      const accepted = await send("  One steer\r\n", "medium");
      expect(accepted.structuredContent).toEqual({
        status: "steered",
        dispatchId: key,
      });
      expect(messages).toEqual([
        { message: "  One steer\r\n", reasoningEffort: "medium" },
      ]);
      expect((await send("Invalid effort", "")).isError).toBe(true);
      const noEffort = await send(
        "No effort override",
        undefined,
        randomUUID(),
      );
      expect(noEffort.structuredContent).toEqual({
        status: "steered",
        dispatchId: key,
      });
      expect(messages).toEqual([
        { message: "  One steer\r\n", reasoningEffort: "medium" },
        { message: "No effort override", reasoningEffort: undefined },
      ]);
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
      expect(tools).not.toContain("codex_task_continue");
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
        threadRuntime: {
          scope: "thread",
          source: "thread/read",
          snapshot: "non-atomic",
          state: "unavailable",
        },
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

describe("thread-wide runtime through the actual MCP boundary", () => {
  it("preserves waiting flags and refuses malformed runtime without another task effect", async () => {
    const snapshot = {
      scope: "thread" as const,
      source: "thread/read" as const,
      snapshot: "non-atomic" as const,
    };
    let threadRuntime: any = {
      ...snapshot,
      state: "active",
      activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
    };
    const calls: string[] = [];
    const route: CodexTaskRoute = {
      observeEnabled: true,
      async observe(request) {
        calls.push("observe");
        return {
          status: "observed",
          threadId: request.threadId,
          title: null,
          model: null,
          turns: [],
          hasMoreTurns: false,
          threadRuntime,
        };
      },
      async create() {
        throw new Error("NO_TASK_START_ALLOWED");
      },
      async message() {
        throw new Error("NO_CONTROL_ALLOWED");
      },
      async status(dispatchId) {
        calls.push("status");
        return {
          status: "known",
          dispatchId,
          threadId: "private",
          turnId: "private",
          turnStatus: "inProgress",
          threadRuntime,
        };
      },
      async result(dispatchId) {
        calls.push("result");
        return {
          status: "running",
          dispatchId,
          threadId: "private",
          turnId: "private",
          threadRuntime,
        };
      },
    };
    const { client, server } = await connected(route);
    const operations = [
      { name: "codex_task_status", arguments: { dispatchId: key } },
      { name: "codex_task_result", arguments: { dispatchId: key } },
      {
        name: "codex_task_observe",
        arguments: { threadId: key, projectId: "saved", workspaceId: "writer" },
      },
    ];
    try {
      for (const operation of operations) {
        const result = await client.callTool(operation);
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ threadRuntime });
        expect(JSON.stringify(result.structuredContent)).not.toContain(
          "private",
        );
      }
      for (const malformed of [
        { ...snapshot, state: "active", activeFlags: ["unknown"] },
        {
          ...snapshot,
          state: "active",
          activeFlags: ["waitingOnApproval"],
          payload: "private",
        },
        { ...snapshot, scope: "turn", state: "idle" },
      ]) {
        threadRuntime = malformed;
        for (const operation of operations) {
          const result = await client.callTool(operation);
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({
            status: "outcome_unknown",
          });
          expect(result.structuredContent).not.toHaveProperty("threadRuntime");
        }
      }
      threadRuntime = undefined;
      for (const operation of operations) {
        const result = await client.callTool(operation);
        expect(result.structuredContent).toMatchObject({
          threadRuntime: { ...snapshot, state: "unavailable" },
        });
      }
      expect(calls).toEqual(
        Array.from({ length: 5 }, () => ["status", "result", "observe"]).flat(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("Codex task MCP exact receipt correlation", () => {
  for (const kind of ["observe", "adopt"] as const)
    it(`never accepts a crossed selected-task ${kind} receipt`, async () => {
      const threadId = randomUUID();
      const turnId = randomUUID();
      const foreign = randomUUID();
      const route: CodexTaskRoute = {
        observeEnabled: true,
        create: async () => {
          throw new Error("unexpected create");
        },
        message: async () => {
          throw new Error("unexpected message");
        },
        status: async () => ({ status: "unknown" }),
        result: async () => ({ status: "unknown" }),
        observe: async () => ({
          status: "observed",
          threadId: foreign,
          title: "FOREIGN TITLE",
          model: "foreign-model",
          turns: [],
          hasMoreTurns: false,
        }),
        adopt: async () => ({ status: "adopted", dispatchId: foreign }),
      };
      const { client, server } = await connected(route);
      try {
        const response = await client.callTool({
          name: `codex_task_${kind}`,
          arguments: {
            threadId,
            workspaceId: "writer",
            projectId: "saved-project",
            ...(kind === "adopt" ? { turnId } : {}),
          },
        });
        expect(response.structuredContent).toEqual(
          kind === "observe"
            ? { status: "outcome_unknown", threadId }
            : { status: "outcome_unknown", dispatchId: turnId },
        );
        expect(response.isError).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });
  for (const tool of ["codex_task_status", "codex_task_result"] as const)
    it(`never relabels another dispatch's ${tool} as the requested task`, async () => {
      const foreign = randomUUID();
      const calls: string[] = [];
      const route: CodexTaskRoute = {
        create: async () => {
          throw new Error("unexpected create");
        },
        message: async () => {
          throw new Error("unexpected message");
        },
        async status(dispatchId) {
          calls.push(`status:${dispatchId}`);
          return {
            status: "known",
            dispatchId: foreign,
            threadId: "foreign-thread",
            turnId: "foreign-turn",
            turnStatus: "completed",
          };
        },
        async result(dispatchId) {
          calls.push(`result:${dispatchId}`);
          return {
            status: "completed",
            dispatchId: foreign,
            threadId: "foreign-thread",
            turnId: "foreign-turn",
            finalItemId: "foreign-item",
            text: "FOREIGN TASK RESULT",
          };
        },
      };
      const { client, server } = await connected(route);
      try {
        const response = await client.callTool({
          name: tool,
          arguments: { dispatchId: key },
        });
        expect(response.structuredContent).toEqual({
          status: "outcome_unknown",
          dispatchId: key,
        });
        expect(response.isError).toBe(true);
        expect(calls).toEqual([
          `${tool === "codex_task_status" ? "status" : "result"}:${key}`,
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    });

  for (const kind of ["create", "continue", "message"] as const)
    it(`never accepts a crossed ${kind} acknowledgement`, async () => {
      const foreign = randomUUID();
      const route: CodexTaskRoute = {
        controlCapabilities: { message: true, continue: true },
        create: async () => ({
          status: "dispatched",
          dispatchId: foreign,
          threadId: "foreign-thread",
          turnId: "foreign-turn",
        }),
        continue: async () => ({
          status: "dispatched",
          dispatchId: foreign,
          threadId: "foreign-thread",
          turnId: "foreign-turn",
        }),
        message: async () => ({
          status: "steered",
          dispatchId: foreign,
          turnId: "foreign-turn",
        }),
        status: async () => ({ status: "unknown" }),
        result: async () => ({ status: "unknown" }),
      };
      const { client, server } = await connected(route);
      try {
        const input =
          kind === "create"
            ? {
                key,
                workspaceId: "writer",
                projectId: "saved-project",
                message: "one create",
              }
            : kind === "continue"
              ? { key, dispatchId: randomUUID(), message: "one follow-up" }
              : {
                  key: randomUUID(),
                  dispatchId: key,
                  workspaceId: "writer",
                  projectId: "saved-project",
                  message: "one steer",
                  model: "fixture",
                };
        const response = await client.callTool({
          name: `codex_task_${kind}`,
          arguments: input,
        });
        expect(response.structuredContent).toEqual({
          status: "outcome_unknown",
          dispatchId: key,
        });
        expect(response.isError).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    });
});

describe("Codex task MCP closed receipts", () => {
  type Method =
    | "create"
    | "continue"
    | "message"
    | "status"
    | "result"
    | "observe"
    | "adopt";
  const threadId = "9ae7d486-d3dc-4bb0-a257-b9c86e360120";
  const reference = { dispatchId: key, threadId, turnId: "issued-turn" };
  const receipt = (method: Method): object => {
    switch (method) {
      case "create":
      case "continue":
        return { status: "dispatched", ...reference };
      case "message":
        return { status: "steered", dispatchId: key, turnId: reference.turnId };
      case "status":
        return { status: "known", ...reference, turnStatus: "completed" };
      case "result":
        return {
          status: "completed",
          ...reference,
          finalItemId: "final-item",
          text: "Exact answer",
        };
      case "observe":
        return {
          status: "observed",
          threadId,
          title: "Selected title",
          model: "selected-model",
          turns: [{ id: reference.turnId, status: "completed" }],
          hasMoreTurns: false,
        };
      case "adopt":
        return { status: "adopted", dispatchId: key };
    }
  };
  const request = (method: Method) => {
    switch (method) {
      case "create":
        return {
          key,
          workspaceId: "writer",
          projectId: "saved-project",
          message: "one create",
        };
      case "continue":
        return { key, dispatchId: randomUUID(), message: "one follow-up" };
      case "message":
        return {
          key: randomUUID(),
          dispatchId: key,
          workspaceId: "writer",
          projectId: "saved-project",
          message: "one steer",
          model: "fixture",
        };
      case "status":
      case "result":
        return { dispatchId: key };
      case "observe":
        return { threadId, workspaceId: "writer", projectId: "saved-project" };
      case "adopt":
        return {
          threadId,
          turnId: key,
          workspaceId: "writer",
          projectId: "saved-project",
        };
    }
  };
  // An intentionally untrusted port result bypasses static DTOs here, so the
  // production consumer must parse the actual received value at runtime.
  async function invoke(method: Method, value: unknown) {
    const calls: string[] = [];
    const take = (called: Method) => {
      calls.push(called);
      return value;
    };
    const route: CodexTaskRoute = {
      observeEnabled: true,
      controlCapabilities: { message: true, continue: true },
      create: async () =>
        take("create") as Awaited<ReturnType<CodexTaskRoute["create"]>>,
      continue: async () =>
        take("continue") as Awaited<
          ReturnType<NonNullable<CodexTaskRoute["continue"]>>
        >,
      message: async () =>
        take("message") as Awaited<ReturnType<CodexTaskRoute["message"]>>,
      status: async () =>
        take("status") as Awaited<ReturnType<CodexTaskRoute["status"]>>,
      result: async () =>
        take("result") as Awaited<ReturnType<CodexTaskRoute["result"]>>,
      observe: async () =>
        take("observe") as Awaited<
          ReturnType<NonNullable<CodexTaskRoute["observe"]>>
        >,
      adopt: async () =>
        take("adopt") as Awaited<
          ReturnType<NonNullable<CodexTaskRoute["adopt"]>>
        >,
    };
    const { client, server } = await connected(route);
    try {
      const response = await client.callTool({
        name: `codex_task_${method}`,
        arguments: request(method),
      });
      // Parsing is pure. An invalid response neither replays an effect nor
      // invokes another provider method as recovery; the original ID survives.
      expect(calls).toEqual([method]);
      return response;
    } finally {
      await client.close();
      await server.close();
    }
  }
  const unknown = (method: Method) =>
    method === "observe"
      ? { status: "outcome_unknown", threadId }
      : { status: "outcome_unknown", dispatchId: key };
  const methods: Method[] = [
    "create",
    "continue",
    "message",
    "status",
    "result",
    "observe",
    "adopt",
  ];
  for (const method of methods) {
    it(`keeps a valid ${method} receipt and omits private execution lineage where required`, async () => {
      const response = await invoke(method, receipt(method));
      expect(response.isError).not.toBe(true);
      if (
        ["create", "continue", "message", "status", "result", "adopt"].includes(
          method,
        )
      ) {
        expect(response.structuredContent).not.toHaveProperty("threadId");
        expect(response.structuredContent).not.toHaveProperty("turnId");
        expect(response.structuredContent).not.toHaveProperty("finalItemId");
      }
    });
    it(`preserves an original unknown ${method} receipt without recovery or success`, async () => {
      const response = await invoke(method, unknown(method));
      expect(response.structuredContent).toEqual(unknown(method));
      expect(response.isError).toBe(true);
    });
    for (const [name, value] of [
      ["null", null],
      ["array", []],
      ["missing state", {}],
      ["unsupported state", { ...receipt(method), status: "complete" }],
      [
        "unexpected private field",
        { ...receipt(method), providerTranscript: "PRIVATE TRANSCRIPT" },
      ],
      [
        "crossed unknown",
        method === "observe"
          ? { status: "outcome_unknown", threadId: randomUUID() }
          : { status: "outcome_unknown", dispatchId: randomUUID() },
      ],
    ] as const)
      it(`rejects ${name} on ${method} while retaining the requested identity`, async () => {
        const response = await invoke(method, value);
        expect(response.structuredContent).toEqual(unknown(method));
        expect(response.isError).toBe(true);
      });
  }
  for (const method of [
    "create",
    "continue",
    "message",
    "observe",
    "adopt",
  ] as const) {
    it(`retains a closed known refusal on ${method}`, async () => {
      const value = {
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      };
      const response = await invoke(method, value);
      expect(response.structuredContent).toEqual(value);
      expect(response.isError).toBe(true);
    });
    it(`never converts a malformed ${method} refusal into retryable no-effect proof`, async () => {
      const response = await invoke(method, {
        status: "refused",
        code: "",
        dispatchId: key,
      });
      expect(response.structuredContent).toEqual(unknown(method));
      expect(response.isError).toBe(true);
    });
  }
  for (const method of ["status", "result"] as const)
    it(`retains absent ${method} as unknown without inventing a dispatch`, async () => {
      const response = await invoke(method, { status: "unknown" });
      expect(response.structuredContent).toEqual({ status: "unknown" });
      expect(response.isError).not.toBe(true);
    });
  for (const state of [
    "inProgress",
    "completed",
    "failed",
    "interrupted",
  ] as const)
    it(`preserves the exact known ${state} turn state`, async () => {
      const response = await invoke("status", {
        ...receipt("status"),
        turnStatus: state,
      });
      expect(response.structuredContent).toMatchObject({
        status: "known",
        dispatchId: key,
        turnStatus: state,
      });
      expect(response.isError).not.toBe(true);
    });
  for (const state of ["running", "failed", "interrupted"] as const)
    it(`retains a ${state} result without inventing final text`, async () => {
      const response = await invoke("result", {
        status: state,
        ...reference,
        threadRuntime: {
          scope: "thread",
          source: "thread/read",
          snapshot: "non-atomic",
          state: "active",
          activeFlags: ["waitingOnApproval"],
        },
      });
      expect(response.structuredContent).toMatchObject({
        status: state,
        dispatchId: key,
      });
      expect(response.structuredContent).not.toHaveProperty("text");
      if (state === "running")
        expect(response.structuredContent).toHaveProperty(
          "threadRuntime.activeFlags",
          ["waitingOnApproval"],
        );
      expect(response.isError).not.toBe(true);
    });
  for (const [method, name, change] of [
    ["create", "missing turn", { turnId: undefined }],
    ["continue", "oversized thread", { threadId: "t".repeat(121) }],
    ["message", "NUL turn", { turnId: "bad\0turn" }],
    ["status", "unsupported turn state", { turnStatus: "waiting" }],
    ["status", "malformed runtime", { threadRuntime: { state: "idle" } }],
    ["result", "missing final item", { finalItemId: undefined }],
    ["result", "empty result", { text: "" }],
    ["result", "NUL result", { text: "bad\0result" }],
    ["result", "oversized result", { text: "x".repeat(256 * 1024 + 1) }],
    ["observe", "oversized title", { title: "t".repeat(1001) }],
    ["observe", "NUL title", { title: "bad\0title" }],
    ["observe", "oversized model", { model: "m".repeat(121) }],
    [
      "observe",
      "oversized turns page",
      {
        turns: Array.from({ length: 101 }, () => ({
          id: "turn",
          status: "completed",
        })),
      },
    ],
    [
      "observe",
      "malformed turn",
      { turns: [{ id: "turn", status: "waiting" }] },
    ],
    [
      "observe",
      "private turn field",
      {
        turns: [
          { id: "turn", status: "completed", text: "PRIVATE TURN CONTENT" },
        ],
      },
    ],
    ["observe", "non-boolean page state", { hasMoreTurns: "false" }],
  ] as const)
    it(`rejects ${name} from ${method}`, async () => {
      const response = await invoke(method, { ...receipt(method), ...change });
      expect(response.structuredContent).toEqual(unknown(method));
      expect(response.isError).toBe(true);
    });
  it("preserves the existing producer's maximum Unicode result without lowering its byte allowance", async () => {
    const text = "漢".repeat(256 * 1024);
    expect(new TextEncoder().encode(text).byteLength).toBe(768 * 1024);
    const response = await invoke("result", { ...receipt("result"), text });
    expect(response.structuredContent).toEqual({
      status: "completed",
      dispatchId: key,
      text,
    });
    expect(response.isError).not.toBe(true);
  });
});
