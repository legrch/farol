import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffJournal,
  type HandoffRequestDigester,
  type HandoffMutationGate,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { taskGrantPolicy } from "../fixtures/task-policy";
const threadId = "019b0000-0000-4000-8000-000000000001";
const workspace = {
  root: "/fixture/writer",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/fixture/project/.git",
  project: {
    root: "/fixture/project",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/fixture/project/.git",
  },
  execution: {
    sandbox: "read-only" as const,
    approvalPolicy: "on-request" as const,
  },
};
const input = { workspaceId: "writer", projectId: "project" };
async function fixture(selected = true) {
  let mode = "known";
  let now = 1000;
  let revoked = false;
  const calls: string[] = [];
  const never = new Proxy(
    {},
    {
      get() {
        throw new Error(
          "Discovery must not use journal/digester/mutation fence",
        );
      },
    },
  );
  const controller = new AbortController();
  const delegate = new PersistentCodexHandoff(
    {
      async resolve() {
        return revoked ? null : workspace;
      },
    },
    {
      async request(method) {
        calls.push(method);
        if (method === "project/list") {
          if (mode === "catalogue-revoke") revoked = true;
          return {
            data: [
              { id: "project", roots: [{ path: workspace.project.root }] },
            ],
            nextCursor: null,
          };
        }
        if (method !== "thread/list") throw new Error("Unexpected task effect");
        if (mode === "throw") throw new Error("No reply");
        if (mode === "expire") now = 2000;
        if (mode === "abort") controller.abort();
        if (mode === "revoke") revoked = true;
        return {
          data: [
            {
              id: threadId,
              projectId: mode === "foreign" ? "foreign" : "project",
              cwd: workspace.root,
              name: "Canary",
              model: "fixture-model",
              updatedAt: 123,
              preview: "PRIVATE",
            },
          ],
          nextCursor: null,
        };
      },
    },
    never as HandoffJournal,
    never as HandoffRequestDigester,
    2000,
    never as HandoffMutationGate,
    () => now,
  );
  const route = new AdmittedCodexTaskRoute(
    delegate,
    {
      ...input,
      ...taskGrantPolicy(),
      expiresAt: 2000,
      discoverProjectTasks: selected,
    },
    () => now,
  );
  const server = createReadonlyComputerMcpServer(
    {
      async execute() {
        throw new Error("No filesystem in fixture");
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
  const client = new Client({
    name: "project-discovery-fixture",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    delegate,
    route,
    client,
    server,
    calls,
    controller,
    setMode(value: string) {
      mode = value;
    },
  };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.close();
  await f.server.close();
}
describe("sealed project metadata discovery route", () => {
  it("does not broaden a normal create grant into discovery", async () => {
    const f = await fixture(false);
    try {
      expect(
        (await f.client.listTools()).tools.map((t) => t.name),
      ).not.toContain("codex_project_tasks");
      expect(await f.route.discoverTasks(input)).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_TASKS_NOT_GRANTED",
      });
      expect(f.calls).toEqual([]);
    } finally {
      await close(f);
    }
  });
  it("routes only selected project/current writer metadata without observation or control", async () => {
    const f = await fixture();
    try {
      expect((await f.client.listTools()).tools.map((t) => t.name)).toContain(
        "codex_project_tasks",
      );
      const response = await f.client.callTool({
        name: "codex_project_tasks",
        arguments: input,
      });
      expect(response.structuredContent).toMatchObject({
        status: "tasks",
        ...input,
        scope: "selected-writer",
        controlGranted: false,
        tasks: [
          { id: threadId, title: "Canary", configuredModel: "fixture-model" },
        ],
      });
      expect(JSON.stringify(response)).not.toContain("PRIVATE");
      expect(f.calls).toEqual(["project/list", "thread/list"]);
      const before = f.calls.length;
      expect(
        (
          await f.client.callTool({
            name: "codex_project_tasks",
            arguments: { ...input, projectId: "foreign" },
          })
        ).isError,
      ).toBe(true);
      expect(f.calls.length).toBe(before);
    } finally {
      await close(f);
    }
  });
  it.each([
    "foreign",
    "throw",
    "expire",
    "abort",
    "revoke",
    "catalogue-revoke",
  ])("does not disclose metadata after %s boundary failure", async (mode) => {
    const f = await fixture();
    try {
      f.setMode(mode);
      const result = await f.route.discoverTasks(input, {
        signal: f.controller.signal,
      });
      expect(result.status).not.toBe("tasks");
      expect(JSON.stringify(result)).not.toContain("Canary");
      if (mode === "catalogue-revoke")
        expect(f.calls).not.toContain("thread/list");
    } finally {
      await close(f);
    }
  });
  it("rejects a root path or malformed cursor from the MCP caller", async () => {
    const f = await fixture();
    try {
      for (const change of [
        { writerRoot: "/other" },
        { cursor: "bad\0cursor" },
      ])
        expect(
          (
            await f.client.callTool({
              name: "codex_project_tasks",
              arguments: { ...input, ...change },
            })
          ).isError,
        ).toBe(true);
      expect(f.calls).toEqual([]);
    } finally {
      await close(f);
    }
  });
});
