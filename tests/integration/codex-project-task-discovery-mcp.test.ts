import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffJournal,
  type HandoffRequestDigester,
  type HandoffMutationGate,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  CodexTaskRouteLaunchSchema,
  ClaudeTaskRouteLaunchSchema,
} from "../../src/modules/computer/infra/mcp/launch-contract";
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
async function fixture(selected = true, canonical = false) {
  let mode = "known";
  let now = 1000;
  let revoked = false;
  let canonicalChanged = false;
  const calls: string[] = [];
  const parameters: unknown[] = [];
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
        return revoked
          ? null
          : canonicalChanged
            ? { ...workspace, project: { ...workspace.project, inode: "4" } }
            : workspace;
      },
    },
    {
      async request(method, params) {
        calls.push(method);
        if (method === "project/list") {
          if (mode === "catalogue-revoke") revoked = true;
          if (mode === "canonical-drift-before") canonicalChanged = true;
          return {
            data: [
              { id: "project", roots: [{ path: workspace.project.root }] },
            ],
            nextCursor: null,
          };
        }
        if (method !== "thread/list") throw new Error("Unexpected task effect");
        parameters.push(params);
        if (mode === "canonical-drift-after") canonicalChanged = true;
        if (mode === "throw") throw new Error("No reply");
        if (mode === "expire") now = 2000;
        if (mode === "abort") controller.abort();
        if (mode === "revoke") revoked = true;
        return {
          data: [
            {
              id: threadId,
              projectId: mode === "foreign" ? "foreign" : "project",
              cwd:
                mode === "canonical" ? workspace.project.root : workspace.root,
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
      discoverCanonicalProjectTasks: canonical,
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
    parameters,
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

describe("separate canonical metadata admission", () => {
  const scope = "canonical-and-selected-writer" as const;
  it("does not broaden existing selected-writer discovery without its separate opt-in", async () => {
    const f = await fixture(true, false);
    try {
      const result = await f.client.callTool({
        name: "codex_project_tasks",
        arguments: { ...input, scope },
      });
      expect(result.structuredContent).toMatchObject({
        status: "refused",
        code: "HANDOFF_CANONICAL_TASKS_NOT_GRANTED",
      });
      expect(f.calls).toEqual([]);
    } finally {
      await close(f);
    }
  });
  it("routes canonical metadata via only its two physically verified roots", async () => {
    const f = await fixture(true, true);
    try {
      f.setMode("canonical");
      const result = await f.client.callTool({
        name: "codex_project_tasks",
        arguments: { ...input, scope },
      });
      expect(result.structuredContent).toMatchObject({
        status: "tasks",
        scope,
        controlGranted: false,
        tasks: [{ id: threadId }],
      });
      expect(f.parameters).toMatchObject([
        {
          cwd: [workspace.root, workspace.project.root],
          projectId: input.projectId,
          useStateDbOnly: true,
        },
      ]);
      expect(f.calls).toEqual(["project/list", "thread/list"]);
    } finally {
      await close(f);
    }
  });
});

describe("canonical metadata negative boundaries", () => {
  const scope = "canonical-and-selected-writer" as const;
  it.each([
    "canonical-drift-before",
    "canonical-drift-after",
    "expire",
    "revoke",
    "abort",
  ])("discloses no canonical metadata after %s", async (mode) => {
    const f = await fixture(true, true);
    try {
      f.setMode(mode);
      const result = await f.route.discoverTasks(
        { ...input, scope },
        { signal: f.controller.signal },
      );
      expect(result.status).not.toBe("tasks");
      expect(JSON.stringify(result)).not.toContain("Canary");
      if (mode === "canonical-drift-before")
        expect(f.calls).not.toContain("thread/list");
    } finally {
      await close(f);
    }
  });
  it("rejects unknown direct-call scope before host I/O", async () => {
    const f = await fixture(true, true);
    try {
      expect(
        await f.route.discoverTasks({
          ...input,
          scope: "all-project",
        } as never),
      ).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_TASKS_INPUT_INVALID",
      });
      expect(
        await f.delegate.discoverTasks({
          ...input,
          scope: "all-project",
        } as never),
      ).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_TASKS_INPUT_INVALID",
      });
      expect(f.calls).toEqual([]);
    } finally {
      await close(f);
    }
  });
  const widerReply = {
    status: "tasks" as const,
    ...input,
    source: "stored" as const,
    snapshot: "non-atomic" as const,
    scope,
    coverage: "single-page-metadata" as const,
    controlGranted: false as const,
    tasks: [
      { id: threadId, title: "Canary", configuredModel: null, updatedAt: 123 },
    ],
    nextCursor: null,
    complete: true,
  };
  it("does not publish a wider delegate reply to a narrow admitted request", async () => {
    const f = await fixture(true, true);
    try {
      vi.spyOn(f.delegate, "discoverTasks").mockResolvedValue(widerReply);
      expect(await f.route.discoverTasks(input)).toMatchObject({
        status: "refused",
        code: "HANDOFF_PROJECT_TASKS_CORRELATION",
      });
    } finally {
      vi.restoreAllMocks();
      await close(f);
    }
  });
  it("does not publish a wider route reply to a narrow public MCP request", async () => {
    const f = await fixture(true, true);
    try {
      vi.spyOn(f.route, "discoverTasks").mockResolvedValue(widerReply);
      const result = await f.client.callTool({
        name: "codex_project_tasks",
        arguments: input,
      });
      expect(result.structuredContent).toMatchObject({
        status: "unavailable",
        code: "HANDOFF_PROJECT_TASKS_CORRELATION",
      });
      expect(JSON.stringify(result)).not.toContain("Canary");
    } finally {
      vi.restoreAllMocks();
      await close(f);
    }
  });
});

it("retains the separate Codex opt-in in sealed launch data and rejects it for Claude", () => {
  const launch = {
    transport: "codex-shared-proxy/v1",
    host: {
      executablePath: "/fixture/codex",
      executableSha256: "a".repeat(64),
      socketPath: "/fixture/host.sock",
      expectedCodexHome: "/fixture/codex-home",
    },
    grant: {
      ...input,
      writerRoot: workspace.root,
      writerIdentity: { device: workspace.device, inode: workspace.inode },
      projectRoot: workspace.project.root,
      projectIdentity: {
        device: workspace.project.device,
        inode: workspace.project.inode,
      },
      gitCommonDirectory: workspace.gitCommonDirectory,
      execution: workspace.execution,
      ...taskGrantPolicy(),
      expiresAt: 2000,
    },
  };
  expect(
    CodexTaskRouteLaunchSchema.parse(launch).grant
      .discoverCanonicalProjectTasks,
  ).toBeUndefined();
  expect(
    CodexTaskRouteLaunchSchema.parse({
      ...launch,
      grant: {
        ...launch.grant,
        discoverProjectTasks: true,
        discoverCanonicalProjectTasks: true,
      },
    }).grant.discoverCanonicalProjectTasks,
  ).toBe(true);
  const claude = {
    transport: "claude-sandboxed-print/v1",
    host: {
      qualification: "fixture-only",
      executablePath: "/fixture/claude",
      executableSha256: "b".repeat(64),
      models: [{ model: "fixture-model", efforts: ["medium"] }],
    },
    grant: { ...launch.grant, harness: "claude-code" },
  };
  expect(ClaudeTaskRouteLaunchSchema.safeParse(claude).success).toBe(true);
  expect(
    ClaudeTaskRouteLaunchSchema.safeParse({
      ...claude,
      grant: { ...claude.grant, discoverCanonicalProjectTasks: true },
    }).success,
  ).toBe(false);
});
