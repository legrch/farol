import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CodexTaskReadContext } from "../../src/modules/chat/contract/codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import { describe, expect, it } from "vitest";
import {
  PersistentCodexHandoff,
  type HandoffHost,
  type HandoffJournal,
  type HandoffRecord,
} from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { taskGrantPolicy } from "../fixtures/task-policy";

const dispatchId = "41949674-c1e4-4a73-9098-4d31da6e7aaa";
const threadId = "bca9bd38-e20c-4c0c-89e3-542de18b33bc";
const turnId = "df7243fd-1d1c-4fef-b76c-57bbdeae226a";
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
const record: HandoffRecord = {
  requestDigest: "fixture",
  workspaceId: "writer",
  workspace,
  projectId: "saved-project",
  threadId,
  turnId,
  threadIntent: true,
  turnIntent: true,
};
const selection = {
  workspaceId: "writer",
  projectId: "saved-project",
  threadId,
};

// In-memory authority/journal/provider only: no native host, files or inference.
function fixture() {
  let time = 1000;
  const controller = new AbortController();
  const calls: Array<{ method: string; deadlineAt?: number }> = [];
  let after: (method: string) => void | Promise<void> = () => {};
  let pageTurns = false;
  let pageItems = false;
  let completed = false;
  let journalReads = 0;
  let authorityReads = 0;
  let afterJournal: (count: number) => void = () => {};
  let afterAuthority: (count: number) => void = () => {};
  const forbidden = async (): Promise<never> => {
    throw Error("READ_MUST_NOT_MUTATE");
  };
  const journal: HandoffJournal = {
    read: async () => {
      afterJournal(++journalReads);
      return record;
    },
    reserve: forbidden,
    claimThread: forbidden,
    recordThread: forbidden,
    claimTurn: forbidden,
    recordTurn: forbidden,
    claimMessage: forbidden,
    readMessage: forbidden,
    recordMessage: forbidden,
  };
  const host: HandoffHost = {
    async request(method, raw, deadlineAt) {
      calls.push({
        method,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
      });
      const params = raw as { cursor?: string | null };
      let value: unknown;
      if (method === "project/list")
        value = {
          data: [
            { id: "saved-project", roots: [{ path: workspace.project.root }] },
          ],
          nextCursor: null,
        };
      else if (method === "thread/read")
        value = {
          thread: {
            id: threadId,
            projectId: "saved-project",
            cwd: workspace.root,
            model: "fixture-model",
            name: "Fixture",
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
        };
      else if (method === "thread/turns/list")
        value =
          pageTurns && params.cursor === null
            ? {
                data: [{ id: "other-turn", status: "completed" }],
                nextCursor: "next",
              }
            : {
                data: [
                  {
                    id: turnId,
                    status: completed ? "completed" : "inProgress",
                  },
                ],
                nextCursor: null,
              };
      else if (method === "thread/items/list")
        value = {
          data: [
            {
              turnId,
              item: {
                id: "final-item",
                type: "agentMessage",
                phase: "final_answer",
                text: "EXACT_FIXTURE_RESULT",
              },
            },
          ],
          nextCursor: pageItems && params.cursor === null ? "next" : null,
        };
      else if (method === "model/list")
        value = {
          data: [],
          nextCursor: pageItems && params.cursor === undefined ? "next" : null,
        };
      else throw Error("READ_METHOD_UNEXPECTED");
      await after(method);
      return value;
    },
  };
  const service = new PersistentCodexHandoff(
    {
      resolve: async () => {
        afterAuthority(++authorityReads);
        return workspace;
      },
    },
    host,
    journal,
    { digest: () => "fixture", digestMessage: () => "fixture" },
    5000,
    { run: forbidden },
    () => time,
    threadId,
  );
  const context = { signal: controller.signal, deadlineAt: 2000 };
  const call = (kind: "status" | "result" | "observe") =>
    kind === "observe"
      ? service.observe(selection, context)
      : service[kind](dispatchId, context);
  return {
    service,
    context,
    controller,
    calls,
    call,
    expire: () => {
      time = 2000;
    },
    now: () => time,
    onResponse: (action: (method: string) => void | Promise<void>) => {
      after = action;
    },
    onJournal: (action: (count: number) => void) => {
      afterJournal = action;
    },
    onAuthority: (action: (count: number) => void) => {
      afterAuthority = action;
    },
    setPages: () => {
      pageTurns = true;
    },
    setCompleted: () => {
      completed = true;
    },
    setItemPages: () => {
      pageItems = true;
    },
  };
}

for (const kind of ["status", "result", "observe"] as const) {
  describe(`${kind} read admission`, () => {
    it.each(["abort", "expiry"])(
      "starts no provider read after %s",
      async (reason) => {
        const f = fixture();
        if (reason === "abort") f.controller.abort();
        else f.expire();
        expect(await f.call(kind)).not.toHaveProperty("text");
        expect(f.calls).toEqual([]);
      },
    );
    it("carries the same absolute deadline on every provider read", async () => {
      const f = fixture();
      const result = await f.call(kind);
      expect(result.status).toBe(
        kind === "observe"
          ? "observed"
          : kind === "result"
            ? "running"
            : "known",
      );
      expect(f.calls.length).toBeGreaterThan(0);
      expect(f.calls.every((call) => call.deadlineAt === 2000)).toBe(true);
      expect(
        f.calls.every((call) =>
          [
            "project/list",
            "thread/read",
            "thread/turns/list",
            "thread/items/list",
          ].includes(call.method),
        ),
      ).toBe(true);
    });
    it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
      "refuses invalid deadline %s before provider reads",
      async (deadlineAt) => {
        const f = fixture();
        const result =
          kind === "observe"
            ? await f.service.observe(selection, { deadlineAt })
            : await f.service[kind](dispatchId, { deadlineAt });
        expect(result.status).not.toBe(
          kind === "observe" ? "observed" : "known",
        );
        expect(f.calls).toEqual([]);
      },
    );
  });
}

describe("no extra read or disclosure after admission ends between awaits", () => {
  it.each(["abort", "expiry"])(
    "stops status after thread/read %s",
    async (reason) => {
      const f = fixture();
      f.onResponse((method) => {
        if (method === "thread/read")
          reason === "abort" ? f.controller.abort() : f.expire();
      });
      expect(await f.call("status")).toEqual({
        status: "outcome_unknown",
        dispatchId,
      });
      expect(f.calls.map((call) => call.method)).toEqual(["thread/read"]);
    },
  );
  it("stops status pagination after the first page expires", async () => {
    const f = fixture();
    f.setPages();
    f.onResponse((method) => {
      if (method === "thread/turns/list") f.expire();
    });
    expect(await f.call("status")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
    expect(f.calls.map((call) => call.method)).toEqual([
      "thread/read",
      "thread/turns/list",
    ]);
  });
  it("stops observation after project enumeration aborts", async () => {
    const f = fixture();
    f.onResponse((method) => {
      if (method === "project/list") f.controller.abort();
    });
    expect(await f.call("observe")).toMatchObject({ status: "refused" });
    expect(f.calls.map((call) => call.method)).toEqual(["project/list"]);
  });
  it("stops observation before turns after thread/read expires", async () => {
    const f = fixture();
    f.onResponse((method) => {
      if (method === "thread/read") f.expire();
    });
    expect(await f.call("observe")).toMatchObject({ status: "refused" });
    expect(f.calls.map((call) => call.method)).toEqual([
      "project/list",
      "thread/read",
    ]);
  });
  it("stops after journal revocation before resolving provider state", async () => {
    const f = fixture();
    f.onJournal(() => f.controller.abort());
    expect(await f.call("status")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
    expect(f.calls).toEqual([]);
  });
  it("does not publish the last status after final physical revalidation aborts", async () => {
    const f = fixture();
    f.onAuthority((count) => {
      if (count === 2) f.controller.abort();
    });
    expect(await f.call("status")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
  });
  it("never publishes final content after an item response revokes admission", async () => {
    const f = fixture();
    f.setCompleted();
    f.onResponse((method) => {
      if (method === "thread/items/list") f.controller.abort();
    });
    expect(await f.call("result")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
    expect(
      f.calls.filter((call) => call.method === "thread/items/list"),
    ).toHaveLength(1);
  });
  it("stops result pagination after item admission expires", async () => {
    const f = fixture();
    f.setCompleted();
    f.setItemPages();
    f.onResponse((method) => {
      if (method === "thread/items/list") f.expire();
    });
    expect(await f.call("result")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
    expect(
      f.calls.filter((call) => call.method === "thread/items/list"),
    ).toHaveLength(1);
  });
  it("does not publish a result after the final authority read expires", async () => {
    const f = fixture();
    f.setCompleted();
    f.onAuthority((count) => {
      if (count === 4) f.expire();
    });
    expect(await f.call("result")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
  });
});

describe("admitted public task route read guard", () => {
  it.each(["status", "result"] as const)(
    "does not delegate %s after task admission expires",
    async (kind) => {
      let calls = 0;
      const delegate = {
        create: async () => ({ status: "refused" as const, code: "fixture" }),
        message: async () => ({ status: "refused" as const, code: "fixture" }),
        status: async () => {
          calls++;
          return { status: "unknown" as const };
        },
        result: async () => {
          calls++;
          return { status: "unknown" as const };
        },
      };
      const route = new AdmittedCodexTaskRoute(
        delegate,
        {
          workspaceId: "writer",
          projectId: "saved-project",
          ...taskGrantPolicy(),
          expiresAt: 2000,
        },
        () => 2000,
      );
      expect(await route[kind](dispatchId)).toEqual({
        status: "outcome_unknown",
        dispatchId,
      });
      expect(calls).toBe(0);
    },
  );
});

describe("bounded route disclosure and deadlines", () => {
  it.each(["status", "result"] as const)(
    "clips %s deadline and discards delegate success after expiry",
    async (kind) => {
      const f = fixture();
      const contexts: Array<unknown> = [];
      const delegate = {
        create: async (): Promise<never> => {
          throw Error("NO_INFERENCE");
        },
        message: async (): Promise<never> => {
          throw Error("NO_CONTROL");
        },
        status: async (_id: string, context?: CodexTaskReadContext) => {
          contexts.push(context);
          f.expire();
          return {
            status: "known" as const,
            dispatchId,
            threadId,
            turnId,
            turnStatus: "completed",
          };
        },
        result: async (_id: string, context?: CodexTaskReadContext) => {
          contexts.push(context);
          f.expire();
          return {
            status: "completed" as const,
            dispatchId,
            threadId,
            turnId,
            finalItemId: "final-item",
            text: "DO_NOT_DISCLOSE",
          };
        },
      };
      const route = new AdmittedCodexTaskRoute(
        delegate,
        {
          workspaceId: "writer",
          projectId: "saved-project",
          ...taskGrantPolicy(),
          expiresAt: 2000,
        },
        f.now,
      );
      expect(await route[kind](dispatchId, { deadlineAt: 9999 })).toEqual({
        status: "outcome_unknown",
        dispatchId,
      });
      expect(contexts).toEqual([{ signal: undefined, deadlineAt: 2000 }]);
    },
  );

  it("respects a caller's shorter read deadline", async () => {
    const f = fixture();
    const delegate = {
      create: async (): Promise<never> => {
        throw Error("NO_INFERENCE");
      },
      message: async (): Promise<never> => {
        throw Error("NO_CONTROL");
      },
      status: f.service.status.bind(f.service),
      result: f.service.result.bind(f.service),
    };
    const route = new AdmittedCodexTaskRoute(
      delegate,
      {
        workspaceId: "writer",
        projectId: "saved-project",
        ...taskGrantPolicy(),
        expiresAt: 2000,
      },
      f.now,
    );
    expect(await route.status(dispatchId, { deadlineAt: 1500 })).toMatchObject({
      status: "known",
    });
    expect(f.calls.every((call) => call.deadlineAt === 1500)).toBe(true);
  });

  it("does not perform final authority reads after the result journal aborts", async () => {
    const f = fixture();
    f.setCompleted();
    f.onJournal((count) => {
      if (count === 2) f.controller.abort();
    });
    let reads = 0;
    f.onAuthority(() => {
      reads++;
    });
    expect(await f.call("result")).toEqual({
      status: "outcome_unknown",
      dispatchId,
    });
    expect(reads).toBe(2);
    expect(f.calls.map((call) => call.method)).toEqual([
      "thread/read",
      "thread/turns/list",
    ]);
  });
});

const binding = {
  ownerId: "fixture-owner",
  sessionId: "fixture-session",
  taskId: "fixture-task",
  taskEpoch: 1,
  participantId: "fixture-participant",
  turnId: "fixture-turn",
  generation: 1,
};
async function mcpFixture(options: { release?: () => Promise<void> } = {}) {
  const f = fixture();
  const contexts: CodexTaskReadContext[] = [];
  let markCompleted: (value: unknown) => void = () => {};
  const completed = new Promise<unknown>((resolve) => {
    markCompleted = resolve;
  });
  const recordCompletion = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      const value = await operation;
      markCompleted(value);
      return value;
    } catch (error) {
      markCompleted({ error });
      throw error;
    }
  };
  const delegate = {
    readModels: async (
      workspaceId: string,
      fresh = false,
      context: CodexTaskReadContext = {},
    ) => {
      contexts.push(context);
      return recordCompletion(
        f.service.readModels(workspaceId, fresh, context),
      );
    },
    create: async (): Promise<never> => {
      throw Error("NO_INFERENCE");
    },
    message: async (): Promise<never> => {
      throw Error("NO_CONTROL");
    },
    status: async (id: string, context: CodexTaskReadContext = {}) => {
      contexts.push(context);
      return recordCompletion(f.service.status(id, context));
    },
    result: async (id: string, context: CodexTaskReadContext = {}) => {
      contexts.push(context);
      return recordCompletion(f.service.result(id, context));
    },
    observe: async (
      request: typeof selection,
      context: CodexTaskReadContext = {},
    ) => {
      contexts.push(context);
      return recordCompletion(f.service.observe(request, context));
    },
  };
  const route = new AdmittedCodexTaskRoute(
    delegate,
    {
      workspaceId: "writer",
      projectId: "saved-project",
      ...taskGrantPolicy(),
      observeThreadId: threadId,
      expiresAt: 2000,
    },
    f.now,
  );
  const fence = options.release
    ? {
        admits: async () => ({ admitted: true as const }),
        acquireAdmission: async () => ({
          admitted: true as const,
          release: options.release!,
        }),
        reserveShell: async () => {
          throw Error("NO_SHELL");
        },
        clearShell: async () => {
          throw Error("NO_SHELL");
        },
        quarantineShell: () => {
          throw Error("NO_SHELL");
        },
      }
    : undefined;
  const server = createReadonlyComputerMcpServer(
    {
      execute: async () => {
        throw Error("NO_FILESYSTEM");
      },
    },
    binding,
    undefined,
    undefined,
    undefined,
    fence,
    undefined,
    route,
  );
  const client = new Client({
    name: "task-read-admission-fixture",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const argumentsFor = (kind: "status" | "result" | "observe") =>
    kind === "observe" ? selection : { dispatchId };
  const close = async () => {
    const results = await Promise.allSettled([client.close(), server.close()]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  return { f, client, contexts, argumentsFor, close, completed };
}

describe("real in-memory MCP read lifetime wiring", () => {
  it("still publishes one exact admitted final result without private IDs", async () => {
    const m = await mcpFixture();
    m.f.setCompleted();
    try {
      const response = await m.client.callTool({
        name: "codex_task_result",
        arguments: { dispatchId },
      });
      expect(response.structuredContent).toEqual({
        status: "completed",
        dispatchId,
        text: "EXACT_FIXTURE_RESULT",
      });
      expect(await m.completed).toMatchObject({
        status: "completed",
        text: "EXACT_FIXTURE_RESULT",
      });
      expect(m.f.calls.map((call) => call.method)).toEqual([
        "thread/read",
        "thread/turns/list",
        "thread/items/list",
      ]);
      expect(m.f.calls.every((call) => call.deadlineAt === 2000)).toBe(true);
    } finally {
      await m.close();
    }
  });

  it.each(["status", "result", "observe"] as const)(
    "forwards %s signal and host deadline without enabling controls",
    async (kind) => {
      const m = await mcpFixture();
      try {
        const response = await m.client.callTool({
          name: `codex_task_${kind}`,
          arguments: m.argumentsFor(kind),
        });
        expect(response.structuredContent).toMatchObject({
          status:
            kind === "status"
              ? "known"
              : kind === "result"
                ? "running"
                : "observed",
        });
        expect(m.contexts).toHaveLength(1);
        expect(m.contexts[0]?.signal).toBeInstanceOf(AbortSignal);
        expect(m.contexts[0]?.deadlineAt).toBe(2000);
        expect(m.f.calls.every((call) => call.deadlineAt === 2000)).toBe(true);
        const names = (await m.client.listTools()).tools.map(
          (tool) => tool.name,
        );
        for (const name of [
          "codex_task_message",
          "codex_task_continue",
          "codex_task_title",
        ])
          expect(names).not.toContain(name);
      } finally {
        await m.close();
      }
    },
  );

  it.each(["status", "result", "observe"] as const)(
    "stops %s after actual MCP cancellation without another provider read",
    async (kind) => {
      const m = await mcpFixture();
      const controller = new AbortController();
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      m.f.onResponse(async () => {
        entered();
        await waiting;
      });
      const outcome = m.client
        .callTool(
          { name: `codex_task_${kind}`, arguments: m.argumentsFor(kind) },
          { signal: controller.signal },
        )
        .then(
          (value) => ({ kind: "reply" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        );
      try {
        await started;
        const signal = m.contexts[0]?.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        if (!signal) throw Error("MCP_SIGNAL_MISSING");
        const observedAbort = signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
        controller.abort();
        await observedAbort;
        release();
        expect((await outcome).kind).toBe("error");
        // Await the actual service terminal outcome, not a guessed microtask
        // count or signal delivery, before asserting no next provider read.
        expect(await m.completed).toMatchObject({
          status: kind === "observe" ? "refused" : "outcome_unknown",
        });
        expect(m.f.calls).toHaveLength(1);
        expect(signal.aborted).toBe(true);
      } finally {
        release();
        controller.abort();
        await outcome;
        await m.close();
      }
    },
  );

  it.each(["status", "result", "observe"] as const)(
    "rejects caller-supplied %s lifetime extensions before provider reads",
    async (kind) => {
      const m = await mcpFixture();
      try {
        const outcome = await m.client
          .callTool({
            name: `codex_task_${kind}`,
            arguments: {
              ...m.argumentsFor(kind),
              deadlineAt: Number.MAX_SAFE_INTEGER,
            },
          })
          .catch((error) => ({ error }));
        expect(outcome).not.toHaveProperty("structuredContent");
        expect(m.f.calls).toEqual([]);
        expect(m.contexts).toEqual([]);
      } finally {
        await m.close();
      }
    },
  );
});

describe("final MCP read publication after admission release", () => {
  it.each(["status", "result", "observe"] as const)(
    "discards %s after expiry during awaited release without provider re-read",
    async (kind) => {
      let released: () => void = () => {};
      const releaseEntered = new Promise<void>((resolve) => {
        released = resolve;
      });
      let allowRelease: () => void = () => {};
      const releaseGate = new Promise<void>((resolve) => {
        allowRelease = resolve;
      });
      let releases = 0;
      const m = await mcpFixture({
        release: async () => {
          releases++;
          released();
          await releaseGate;
        },
      });
      m.f.setCompleted();
      const outcome = m.client.callTool({
        name: `codex_task_${kind}`,
        arguments: m.argumentsFor(kind),
      });
      try {
        await releaseEntered;
        const reads = m.f.calls.length;
        expect(reads).toBeGreaterThan(0);
        m.f.expire();
        allowRelease();
        const reply = await outcome;
        expect(reply.structuredContent).toEqual(
          kind === "observe"
            ? { status: "refused", code: "HANDOFF_TASK_ADMISSION_DENIED" }
            : { status: "outcome_unknown", dispatchId },
        );
        expect(JSON.stringify(reply)).not.toContain("EXACT_FIXTURE_RESULT");
        expect(m.f.calls).toHaveLength(reads);
        expect(releases).toBe(1);
      } finally {
        allowRelease();
        await outcome.catch(() => {});
        await m.close();
      }
    },
  );
});

describe("merged model catalogue read lifetime", () => {
  const read = (
    f: ReturnType<typeof fixture>,
    fresh = true,
    context: CodexTaskReadContext = f.context,
  ) => f.service.readModels("writer", fresh, context);

  it.each(["abort", "expiry"] as const)(
    "starts no model read after %s",
    async (reason) => {
      const f = fixture();
      if (reason === "abort") f.controller.abort();
      else f.expire();
      expect(await read(f)).toMatchObject({ status: "unavailable" });
      expect(f.calls).toEqual([]);
    },
  );

  it.each(["abort", "expiry"] as const)(
    "stops model pagination after %s",
    async (reason) => {
      const f = fixture();
      f.setItemPages();
      f.onResponse(() => {
        if (reason === "abort") f.controller.abort();
        else f.expire();
      });
      expect(await read(f)).toMatchObject({ status: "unavailable" });
      expect(f.calls).toEqual([{ method: "model/list", deadlineAt: 2000 }]);
    },
  );

  it("does not disclose the display cache after caller cancellation", async () => {
    const f = fixture();
    expect(await read(f)).toMatchObject({ status: "ready" });
    f.controller.abort();
    expect(await read(f, false)).toMatchObject({ status: "unavailable" });
    expect(f.calls).toEqual([{ method: "model/list", deadlineAt: 2000 }]);
  });

  it.each([NaN, -1, 0, 1.5])(
    "rejects invalid/expired model read deadline %s before provider reads",
    async (deadlineAt) => {
      const f = fixture();
      expect(await read(f, true, { deadlineAt })).toMatchObject({
        status: "unavailable",
      });
      expect(f.calls).toEqual([]);
    },
  );

  it("forwards the real MCP models signal and bounded provider deadline", async () => {
    const m = await mcpFixture();
    try {
      const reply = await m.client.callTool({
        name: "codex_task_models",
        arguments: { fresh: true },
      });
      expect(reply.structuredContent).toMatchObject({
        catalogue: { status: "ready" },
      });
      expect(m.contexts).toHaveLength(1);
      expect(m.contexts[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(m.contexts[0]?.deadlineAt).toBe(2000);
      expect(m.f.calls).toEqual([{ method: "model/list", deadlineAt: 2000 }]);
    } finally {
      await m.close();
    }
  });

  it("discards a model view after expiry during the awaited Computer fence release", async () => {
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const m = await mcpFixture({
      release: async () => {
        entered();
        await barrier;
      },
    });
    const outcome = m.client.callTool({
      name: "codex_task_models",
      arguments: { fresh: true },
    });
    try {
      await started;
      m.f.expire();
      release();
      const reply = await outcome;
      expect(reply.isError).toBe(true);
      expect(reply.structuredContent).toMatchObject({
        status: "unavailable",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
      expect(reply.structuredContent).not.toHaveProperty("configured");
      expect(m.f.calls).toHaveLength(1);
    } finally {
      release();
      await outcome.catch(() => {});
      await m.close();
    }
  });

  it("stops models after actual MCP cancellation without a next page", async () => {
    const m = await mcpFixture();
    m.f.setItemPages();
    const controller = new AbortController();
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    m.f.onResponse(async () => {
      entered();
      await barrier;
    });
    const outcome = m.client
      .callTool(
        { name: "codex_task_models", arguments: { fresh: true } },
        { signal: controller.signal },
      )
      .then(
        (value) => ({ kind: "reply", value }),
        (error) => ({ kind: "error", error }),
      );
    try {
      await started;
      const signal = m.contexts[0]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      if (!signal) throw Error("MCP_MODEL_SIGNAL_MISSING");
      const observed = signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
      controller.abort();
      await observed;
      release();
      expect((await outcome).kind).toBe("error");
      expect(await m.completed).toMatchObject({ status: "unavailable" });
      expect(m.f.calls).toHaveLength(1);
    } finally {
      release();
      controller.abort();
      await outcome;
      await m.close();
    }
  });

  it("rejects a caller-supplied models deadline before any provider read", async () => {
    const m = await mcpFixture();
    try {
      const reply = await m.client
        .callTool({
          name: "codex_task_models",
          arguments: { deadlineAt: Number.MAX_SAFE_INTEGER },
        })
        .catch((error) => ({ error }));
      expect(reply).not.toHaveProperty("structuredContent");
      expect(m.f.calls).toEqual([]);
    } finally {
      await m.close();
    }
  });
});
