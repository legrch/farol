import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskGrantPolicy } from "../fixtures/task-policy";
const key = "019b0000-0000-4000-8000-000000000017";
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
    async lookupProjectPreference(request: {
      workspaceId: string;
      projectId: string;
    }) {
      calls++;
      if (mode === "expire") now = 100;
      return {
        status: "resolved",
        ...request,
        projectId: mode === "foreign" ? "foreign" : request.projectId,
        key,
        persistence: "immutable-local-receipt",
        selection: "latest-local-publication",
        snapshot: "non-atomic",
        controlGranted: false,
        ...(mode === "extra" ? { preview: "private" } : {}),
      };
    },
    async projectPreference(request: typeof input) {
      calls++;
      if (mode === "expire") now = 100;
      return {
        status: request.operation === "remember" ? "remembered" : "resolved",
        key:
          mode === "foreign"
            ? "019b0000-0000-4000-8000-000000000018"
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

it("preferred lookup is read-only and accepts no arbitrary handle/root", async () => {
  const f = await fixture();
  try {
    const tool = (await f.client.listTools()).tools.find(
      (item) => item.name === "codex_project_preferred",
    );
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(
      (
        await f.client.callTool({
          name: "codex_project_preferred",
          arguments: { workspaceId: "selected", projectId: "saved" },
        })
      ).structuredContent,
    ).toMatchObject({ status: "resolved", key });
    const before = f.calls;
    expect(
      (
        await f.client.callTool({
          name: "codex_project_preferred",
          arguments: { workspaceId: "selected", projectId: "foreign" },
        })
      ).isError,
    ).toBe(true);
    expect(f.calls).toBe(before);
    expect(
      (
        await f.client.callTool({
          name: "codex_project_preferred",
          arguments: {
            workspaceId: "selected",
            projectId: "saved",
            root: "/outside",
          },
        })
      ).isError,
    ).toBe(true);
    expect(f.calls).toBe(before);
  } finally {
    await close(f);
  }
});
it.each(["foreign", "extra", "expire"])(
  "preferred %s response never discloses a handle or claims resolved",
  async (mode) => {
    const f = await fixture();
    try {
      f.setMode(mode);
      const result = await f.client.callTool({
        name: "codex_project_preferred",
        arguments: { workspaceId: "selected", projectId: "saved" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).not.toHaveProperty("key");
    } finally {
      await close(f);
    }
  },
);
