import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskGrantPolicy } from "../fixtures/task-policy";
const key = "a6c11016-b7b7-4d32-a5ec-8bd1e57ee521";
const input = {
  key,
  workspaceId: "selected",
  projectId: "saved",
  operation: "remember" as const,
};
async function fixture() {
  let now = 1;
  let mode = "valid";
  let calls = 0;
  const delegate = {
    async projectPreference(request: typeof input) {
      calls++;
      if (mode === "expire") now = 100;
      return {
        status: request.operation === "remember" ? "remembered" : "resolved",
        key:
          mode === "foreign"
            ? "b6c11016-b7b7-4d32-a5ec-8bd1e57ee521"
            : request.key,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        persistence: "immutable-local-receipt",
        catalogue: "current-non-atomic",
        controlGranted: false,
        ...(mode === "extra" ? { preview: "private" } : {}),
      };
    },
  };
  const route = new AdmittedCodexTaskRoute(
    delegate as never,
    {
      ...taskGrantPolicy(),
      workspaceId: "selected",
      projectId: "saved",
      expiresAt: 100,
    },
    () => now,
  );
  const server = createReadonlyComputerMcpServer(
    {
      async execute() {
        throw new Error("Unexpected Computer filesystem");
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
    route,
  );
  const client = new Client({ name: "preference-fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    client,
    server,
    route,
    get calls() {
      return calls;
    },
    setMode(value: string) {
      mode = value;
    },
    expire() {
      now = 100;
    },
  };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.close();
  await f.server.close();
}
it("advertises immutable local preference, not a read-only/provider mutation", async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const tool = tools.find((item) => item.name === "codex_project_preference");
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
    expect(
      (
        await f.client.callTool({
          name: "codex_project_preference",
          arguments: input,
        })
      ).structuredContent,
    ).toMatchObject({ status: "remembered", key, controlGranted: false });
    expect(f.calls).toBe(1);
  } finally {
    await close(f);
  }
});
it.each(["workspaceId", "projectId"])(
  "foreign %s is refused before delegation",
  async (field) => {
    const f = await fixture();
    try {
      expect(
        (
          await f.client.callTool({
            name: "codex_project_preference",
            arguments: { ...input, [field]: "foreign" },
          })
        ).isError,
      ).toBe(true);
      expect(f.calls).toBe(0);
    } finally {
      await close(f);
    }
  },
);
it.each(["foreign", "extra"])(
  "rejects %s public receipt without claiming remembered",
  async (mode) => {
    const f = await fixture();
    try {
      f.setMode(mode);
      const r = await f.client.callTool({
        name: "codex_project_preference",
        arguments: input,
      });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toMatchObject({
        status: "outcome_unknown",
        key,
      });
    } finally {
      await close(f);
    }
  },
);
it("expiry before delegation is refused; after remember is outcome-unknown", async () => {
  const f = await fixture();
  try {
    f.setMode("expire");
    const r = await f.client.callTool({
      name: "codex_project_preference",
      arguments: input,
    });
    expect(r.structuredContent).toMatchObject({ status: "outcome_unknown" });
    expect(f.calls).toBe(1);
    const later = await f.client.callTool({
      name: "codex_project_preference",
      arguments: input,
    });
    expect(later.structuredContent).toMatchObject({ status: "refused" });
    expect(f.calls).toBe(1);
  } finally {
    await close(f);
  }
});
