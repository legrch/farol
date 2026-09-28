import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { AdmittedClaudeTaskRoute } from "../../src/modules/chat/infra/native/admitted-claude-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskPolicyIdentity } from "../../src/pkg/owner-config/contract";
const key = "019b0000-0000-4000-8000-000000000020";
const tasks = {
  defaultHarness: "codex",
  harnesses: {
    codex: {
      defaultModel: "local",
      models: { local: { model: "fixture-codex" } },
    },
    "claude-code": {
      defaultModel: "small",
      models: { small: { model: "fixture-model", defaultEffort: "medium" } },
    },
  },
};
async function fixture() {
  let now = 1;
  let calls = 0;
  let seen: unknown;
  let mode = "valid";
  const delegate = {
    async create(request: unknown) {
      seen = request;
      calls++;
      if (mode === "expire") now = 100;
      return {
        status: "dispatched",
        dispatchId:
          mode === "foreign" ? "019b0000-0000-4000-8000-000000000021" : key,
        sessionId: key,
        evidence: "local-process-start",
        nativeVisibility: "not-qualified",
        ...(mode === "extra" ? { transcript: "private" } : {}),
      };
    },
    async status() {
      return { status: "unknown" };
    },
  };
  const route = new AdmittedClaudeTaskRoute(
    delegate as never,
    {
      workspaceId: "selected",
      projectId: "saved",
      tasks,
      configSha256: createHash("sha256")
        .update(taskPolicyIdentity(tasks))
        .digest("hex"),
      expiresAt: 100,
    },
    () => now,
  );
  const server = createReadonlyComputerMcpServer(
    {
      async execute() {
        throw Error("Unexpected Computer");
      },
    },
    {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "main",
      turnId: "turn",
      generation: 1,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    route,
  );
  const client = new Client({ name: "claude-task-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    client,
    server,
    get calls() {
      return calls;
    },
    get seen() {
      return seen;
    },
    mode(value: string) {
      mode = value;
    },
  };
}
const request = {
  key,
  workspaceId: "selected",
  projectId: "saved",
  message: "Read fixture",
};
it("public create/status routes resolve configured Claude alias, without changing global default", async () => {
  const f = await fixture();
  try {
    expect((await f.client.listTools()).tools.map((t) => t.name)).toContain(
      "claude_task_create",
    );
    const result = await f.client.callTool({
      name: "claude_task_create",
      arguments: request,
    });
    expect(result.isError).not.toBe(true);
    expect(f.seen).toMatchObject({
      modelBinding: {
        selection: {
          harness: "claude-code",
          modelAlias: "small",
          model: "fixture-model",
          effort: "medium",
        },
      },
    });
    expect(tasks.defaultHarness).toBe("codex");
    expect(
      (
        await f.client.callTool({
          name: "claude_task_status",
          arguments: { dispatchId: key },
        })
      ).structuredContent,
    ).toEqual({ status: "unknown" });
  } finally {
    await f.client.close();
    await f.server.close();
  }
});
it.each([
  { workspaceId: "foreign" },
  { projectId: "foreign" },
  { harness: "codex" },
  { model: "missing" },
  { message: "🧭".repeat(2049) },
  { private: true },
])("refuses wrong grant/config or closed input %j", async (change) => {
  const f = await fixture();
  try {
    expect(
      (
        await f.client.callTool({
          name: "claude_task_create",
          arguments: { ...request, ...change },
        })
      ).isError,
    ).toBe(true);
    expect(f.calls).toBe(0);
  } finally {
    await f.client.close();
    await f.server.close();
  }
});
it.each(["foreign", "extra", "expire"])(
  "%s response never claims successful dispatch",
  async (mode) => {
    const f = await fixture();
    f.mode(mode);
    try {
      const r = await f.client.callTool({
        name: "claude_task_create",
        arguments: request,
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        status: "outcome_unknown",
        dispatchId: key,
      });
    } finally {
      await f.client.close();
      await f.server.close();
    }
  },
);
