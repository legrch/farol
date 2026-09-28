import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import type {
  CodexTaskHistory,
  CodexTaskRoute,
} from "../../src/modules/chat/contract/codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskGrantPolicy } from "../fixtures/task-policy";
const threadId = "019b0000-0000-4000-8000-000000000001";
const turnId = "019b0000-0000-4000-8000-000000000002";
const request = {
  threadId,
  turnId,
  workspaceId: "writer",
  projectId: "project",
};
const known: CodexTaskHistory = {
  status: "history",
  source: "stored",
  snapshot: "non-atomic",
  coverage: "single-page-text-only",
  threadId,
  turnId,
  turnStatus: "completed",
  sortDirection: "asc",
  items: [
    {
      kind: "agent_message",
      id: "answer",
      phase: "final_answer",
      text: "Exact stored answer",
    },
  ],
  nextCursor: null,
  complete: true,
};
function route(
  history: NonNullable<CodexTaskRoute["history"]>,
): CodexTaskRoute {
  return {
    history,
    observeEnabled: true,
    async create() {
      throw new Error("Unexpected create");
    },
    async message() {
      throw new Error("Unexpected steer");
    },
    async status() {
      return { status: "unknown" };
    },
    async result() {
      return { status: "unknown" };
    },
  };
}
async function connected(tasks?: CodexTaskRoute) {
  const server = createReadonlyComputerMcpServer(
    {
      async execute() {
        throw new Error("Unexpected Computer execution");
      },
    },
    {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "participant",
      turnId: "turn",
      generation: 1,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    tasks,
  );
  const client = new Client({ name: "history-fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server };
}
function withoutHistory(tasks: CodexTaskRoute) {
  const { history: _unused, ...rest } = tasks;
  return rest;
}
describe("scoped stored history MCP and admission", () => {
  it("publishes a readonly route with cancellation context and refuses malformed/uncorrelated disclosures", async () => {
    let value: unknown = known;
    let signal: AbortSignal | undefined;
    const { client, server } = await connected(
      route(async (_input, context) => {
        signal = context?.signal;
        if (value === "throw") throw new Error("Unavailable");
        return value as CodexTaskHistory;
      }),
    );
    try {
      expect(
        (await client.listTools()).tools.find(
          (t) => t.name === "codex_task_history",
        )?.annotations?.readOnlyHint,
      ).toBe(true);
      const call = (extra: object = {}) =>
        client.callTool({
          name: "codex_task_history",
          arguments: { ...request, ...extra },
        });
      expect((await call()).structuredContent).toEqual(known);
      expect(signal).toBeDefined();
      for (const malformed of [
        { ...known, threadId: "019b0000-0000-4000-8000-000000000099" },
        { ...known, turnId: "019b0000-0000-4000-8000-000000000099" },
        { ...known, source: "live" },
        { ...known, extra: "raw private transcript" },
        { ...known, items: [...known.items, ...known.items] },
        { ...known, items: [{ ...known.items[0], text: "🔥".repeat(8193) }] },
        { ...known, nextCursor: "more", complete: true },
      ]) {
        value = malformed;
        expect((await call()).structuredContent).toMatchObject({
          status: "refused",
          code: "HANDOFF_HISTORY_CORRELATION",
        });
      }
      value = known;
      expect((await call({ tail: true })).structuredContent).toMatchObject({
        status: "refused",
      });
      expect(
        (await call({ cursor: "previous" })).structuredContent,
      ).toMatchObject({ status: "refused" });
      value = { ...known, complete: false, nextCursor: "same" };
      expect((await call({ cursor: "same" })).structuredContent).toMatchObject({
        status: "refused",
      });
      value = "throw";
      expect((await call()).structuredContent).toMatchObject({
        status: "unavailable",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it.each([
    undefined,
    { ...route(async () => known), observeEnabled: false },
    withoutHistory(route(async () => known)),
  ])("does not expose unselected or missing history", async (tasks) => {
    const { client, server } = await connected(tasks);
    try {
      expect(
        (await client.listTools()).tools.some(
          (t) => t.name === "codex_task_history",
        ),
      ).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("seals exact workspace/project/thread and rechecks expiry/cancellation/identity after reads", async () => {
    let now = 1000;
    let mode = "normal";
    let calls = 0;
    const controller = new AbortController();
    const delegate = route(async () => {
      calls++;
      if (mode === "expire") now = 2000;
      if (mode === "abort") controller.abort();
      return mode === "foreign"
        ? { ...known, turnId: "019b0000-0000-4000-8000-000000000099" }
        : known;
    });
    const admitted = new AdmittedCodexTaskRoute(
      delegate,
      {
        workspaceId: "writer",
        projectId: "project",
        observeThreadId: threadId,
        ...taskGrantPolicy(),
        expiresAt: 2000,
      },
      () => now,
    );
    for (const changed of [
      { workspaceId: "other" },
      { projectId: "other" },
      { threadId: "019b0000-0000-4000-8000-000000000099" },
    ])
      expect(await admitted.history({ ...request, ...changed })).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
    expect(calls).toBe(0);
    expect(await admitted.history(request)).toEqual(known);
    mode = "foreign";
    expect(await admitted.history(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_HISTORY_CORRELATION",
    });
    mode = "expire";
    expect(await admitted.history(request)).toMatchObject({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    now = 1000;
    mode = "abort";
    expect(
      await admitted.history(request, { signal: controller.signal }),
    ).toMatchObject({ status: "refused", code: "HANDOFF_HISTORY_CANCELLED" });
    const count = calls;
    expect(
      await admitted.history(request, { signal: controller.signal }),
    ).toMatchObject({ status: "refused" });
    expect(calls).toBe(count);
    const noHistory = withoutHistory(delegate);
    expect(
      await new AdmittedCodexTaskRoute(
        noHistory,
        {
          workspaceId: "writer",
          projectId: "project",
          observeThreadId: threadId,
          ...taskGrantPolicy(),
          expiresAt: 2000,
        },
        () => now,
      ).history(request),
    ).toMatchObject({ status: "refused", code: "HANDOFF_HISTORY_UNAVAILABLE" });
  });
});
