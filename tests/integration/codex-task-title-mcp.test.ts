import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { CodexTaskRoute } from "../../src/modules/chat/contract/codex-task-route";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskGrantPolicy } from "../fixtures/task-policy";

const input = {
  key: "019b0000-0000-4000-8000-000000000004",
  dispatchId: "019b0000-0000-4000-8000-000000000001",
  workspaceId: "writer",
  projectId: "project",
  expectedTitle: null,
  title: "Farol · Canary",
};
const binding = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: 1,
  participantId: "participant",
  turnId: "turn",
  generation: 1,
};
async function fixture(
  options: { qualified?: boolean; missing?: boolean } = {},
) {
  let now = 1000;
  let mode = "renamed";
  let calls = 0;
  let signal: AbortSignal | undefined;
  const delegate = {
    async title(
      request: Parameters<NonNullable<CodexTaskRoute["title"]>>[0],
      context?: { signal?: AbortSignal },
    ) {
      calls++;
      signal = context?.signal;
      if (mode === "throw") throw new Error("Lost title reply");
      if (mode === "expire") now = 2000;
      if (mode === "foreign")
        return {
          status: "renamed" as const,
          dispatchId: "019b0000-0000-4000-8000-000000000099",
          title: request.title,
          proof: "readback" as const,
        };
      if (mode === "wrong-title")
        return {
          status: "renamed" as const,
          dispatchId: request.dispatchId,
          title: "Foreign name",
          proof: "readback" as const,
        };
      if (mode === "recorded")
        return {
          status: "recorded" as const,
          dispatchId: request.dispatchId,
          title: request.title,
          proof: "historical" as const,
        };
      if (mode === "unknown")
        return {
          status: "outcome_unknown" as const,
          dispatchId: request.dispatchId,
        };
      return {
        status: "renamed" as const,
        dispatchId: request.dispatchId,
        title: request.title,
        proof: "readback" as const,
      };
    },
    async create() {
      throw new Error("Unexpected inference");
    },
    async message() {
      throw new Error("Unexpected steer");
    },
    async status() {
      return { status: "unknown" as const };
    },
    async result() {
      return { status: "unknown" as const };
    },
  };
  const { title: _title, ...without } = delegate;
  const route = new AdmittedCodexTaskRoute(
    options.missing ? without : delegate,
    {
      workspaceId: "writer",
      projectId: "project",
      ...taskGrantPolicy(),
      expiresAt: 2000,
    },
    () => now,
    { message: false, title: options.qualified === true },
  );
  const server = createReadonlyComputerMcpServer(
    {
      async execute() {
        throw new Error("Unexpected filesystem");
      },
    },
    binding,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    route,
  );
  const client = new Client({ name: "title-route-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    route,
    client,
    server,
    calls: () => calls,
    signal: () => signal,
    setMode(value: string) {
      mode = value;
    },
    expire() {
      now = 2000;
    },
  };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.close();
  await f.server.close();
}
describe("qualified title Computer route", () => {
  it("stays absent and refuses directly until title capability is selected", async () => {
    const f = await fixture();
    try {
      expect(
        (await f.client.listTools()).tools.map((tool) => tool.name),
      ).not.toContain("codex_task_title");
      expect(await f.route.title(input)).toMatchObject({
        status: "refused",
        code: "TASK_CONTROL_NOT_QUALIFIED",
      });
      expect(f.calls()).toBe(0);
    } finally {
      await close(f);
    }
  });
  it("declines qualification when the delegate cannot update titles", async () => {
    await expect(fixture({ qualified: true, missing: true })).rejects.toThrow(
      "HANDOFF_TITLE_UNAVAILABLE",
    );
  });
  it("routes title with request signal, distinguishes current and historical proof, and denies drift", async () => {
    const f = await fixture({ qualified: true });
    try {
      expect(
        (await f.client.listTools()).tools.map((tool) => tool.name),
      ).toContain("codex_task_title");
      const call = () =>
        f.client.callTool({ name: "codex_task_title", arguments: input });
      expect((await call()).structuredContent).toMatchObject({
        status: "renamed",
        proof: "readback",
        title: input.title,
      });
      expect(f.signal()).toBeInstanceOf(AbortSignal);
      f.setMode("recorded");
      expect((await call()).structuredContent).toMatchObject({
        status: "recorded",
        proof: "historical",
      });
      for (const mode of [
        "unknown",
        "throw",
        "foreign",
        "wrong-title",
        "expire",
      ]) {
        f.setMode(mode);
        const response = await call();
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toMatchObject({
          status: "outcome_unknown",
          dispatchId: input.dispatchId,
        });
      }
    } finally {
      await close(f);
    }
  });
  it("rejects expired, cancelled and foreign admission before the delegate", async () => {
    const f = await fixture({ qualified: true });
    try {
      const title = f.route.title.bind(f.route);
      for (const change of [
        { workspaceId: "foreign" },
        { projectId: "foreign" },
      ])
        expect(await title({ ...input, ...change })).toMatchObject({
          status: "refused",
        });
      const controller = new AbortController();
      controller.abort();
      expect(await title(input, { signal: controller.signal })).toMatchObject({
        status: "refused",
      });
      f.expire();
      expect(await title(input)).toMatchObject({ status: "refused" });
      expect(f.calls()).toBe(0);
    } finally {
      await close(f);
    }
  });
  it.each([
    { title: "" },
    { title: "bad\0name" },
    { title: "🧭".repeat(251) },
    { expectedTitle: 7 },
    { dispatchId: "invalid" },
    { unexpected: true },
  ])("rejects malformed title at MCP admission: %j", async (change) => {
    const f = await fixture({ qualified: true });
    try {
      const response = await f.client.callTool({
        name: "codex_task_title",
        arguments: { ...input, ...change },
      });
      expect(response.isError).toBe(true);
      expect(f.calls()).toBe(0);
    } finally {
      await close(f);
    }
  });
});
