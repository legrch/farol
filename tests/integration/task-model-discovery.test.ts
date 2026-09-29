import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CodexTaskReadContext } from "../../src/modules/chat/contract/codex-task-route";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PersistentCodexHandoff } from "../../src/modules/chat/app/service/persistent-codex-handoff";
import { AdmittedCodexTaskRoute } from "../../src/modules/chat/infra/native/admitted-codex-task-route";
import { PrivateCodexHandoffJournal } from "../../src/modules/chat/infra/repo/private-codex-handoff-journal";
import { Sha256HandoffRequestDigester } from "../../src/modules/chat/infra/native/sha256-handoff-request-digester";
import { taskGrantPolicy } from "../fixtures/task-policy";
import { catalogueModel } from "../fixtures/codex-model-catalogue";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-discovery-"));
  roots.push(root);
  const journal = new PrivateCodexHandoffJournal(path.join(root, "journal"));
  const workspace = {
    root: "/fixture/writer",
    device: "1",
    inode: "2",
    gitCommonDirectory: "/fixture/repo/.git",
    project: {
      root: "/fixture/repo",
      device: "1",
      inode: "3",
      gitCommonDirectory: "/fixture/repo/.git",
    },
    execution: {
      sandbox: "read-only" as const,
      approvalPolicy: "on-request" as const,
    },
  };
  let time = Date.now();
  const now = () => time;
  const policy = taskGrantPolicy();
  policy.tasks.harnesses.codex!.models.luna = { model: "fixture-selected" };
  const threads = new Map<
    string,
    { model: string; turns: Array<{ id: string; status: string }> }
  >();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let catalogue = [catalogueModel("fixture-selected", ["high", "low"])];
  let unavailable = false;
  let approved = true;
  let epoch = "test-client-1";
  let onCatalogue: (() => void | Promise<void>) | undefined;
  let beforeEffect: (() => void | Promise<void>) | undefined;
  const host = {
    modelCatalogueScope: () => epoch,
    async request(method: string, raw: unknown) {
      const params = raw as Record<string, unknown>;
      calls.push({ method, params });
      if (method === "model/list") {
        await onCatalogue?.();
        if (unavailable) throw new Error("offline");
        return { data: catalogue, nextCursor: null };
      }
      if (method === "project/list")
        return {
          data: [{ id: "project", roots: [{ path: workspace.project.root }] }],
          nextCursor: null,
        };
      if (method === "thread/start") {
        const id = randomUUID();
        threads.set(id, { model: params.model as string, turns: [] });
        return {
          thread: { id, projectId: "project" },
          model: params.model,
          cwd: workspace.root,
          approvalPolicy: "on-request",
          sandbox: { type: "readOnly" },
        };
      }
      const thread = threads.get(params.threadId as string);
      if (!thread) throw new Error("unknown thread");
      if (method === "thread/read")
        return {
          thread: {
            id: params.threadId,
            projectId: "project",
            cwd: workspace.root,
            model: thread.model,
          },
        };
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      if (method === "turn/start") {
        const turn = { id: randomUUID(), status: "completed" };
        thread.turns.unshift(turn);
        return { turn };
      }
      if (method === "thread/turns/list")
        return {
          data: thread.turns.slice(0, params.limit as number),
          nextCursor: null,
        };
      throw new Error("unexpected method " + method);
    },
  };
  const service = new PersistentCodexHandoff(
    { resolve: async () => (approved ? structuredClone(workspace) : null) },
    host,
    journal,
    new Sha256HandoffRequestDigester(),
    now() + 60_000,
    {
      run: async (preflight, effect) => {
        await preflight();
        await beforeEffect?.();
        return effect();
      },
    },
    now,
  );
  const route = () =>
    new AdmittedCodexTaskRoute(
      service,
      {
        ...taskGrantPolicy(policy.tasks),
        workspaceId: "workspace",
        projectId: "project",
        expiresAt: time + 60_000,
      },
      now,
      { message: true, continue: true },
    );
  const request = () => ({
    key: randomUUID(),
    workspaceId: "workspace",
    projectId: "project",
    message: "Fixture only",
  });
  return {
    service,
    journal,
    activate: async (dispatchId: string) => {
      const record = await journal.read(dispatchId);
      if (!record?.threadId) throw Error("DISPATCH_MISSING");
      const thread = threads.get(record.threadId);
      if (!thread?.turns[0]) throw Error("TURN_MISSING");
      thread.turns[0].status = "inProgress";
    },
    calls,
    policy,
    route,
    request,
    set catalogue(value: typeof catalogue) {
      catalogue = value;
    },
    set unavailable(value: boolean) {
      unavailable = value;
    },
    set onCatalogue(value: () => void | Promise<void>) {
      onCatalogue = value;
    },
    set beforeEffect(value: () => void | Promise<void>) {
      beforeEffect = value;
    },
    revoke() {
      approved = false;
    },
    replaceRoot() {
      workspace.inode = "replacement";
    },
    restoreAuthority() {
      approved = true;
      workspace.inode = "2";
    },
    expire() {
      time += 60_000;
    },
    switchAccount() {
      epoch = "test-client-2";
    },
    effects() {
      return calls.filter((c) =>
        ["thread/start", "turn/start", "turn/steer"].includes(c.method),
      );
    },
  };
}

it("unavailable model and effort refuse before any journal or provider effect", async () => {
  const f = await fixture();
  f.catalogue = [catalogueModel("other")];
  const request = f.request();
  expect(await f.route().create(request)).toMatchObject({
    status: "refused",
    code: "TASK_MODEL_UNAVAILABLE",
    modelAvailability: { configuredModel: "fixture-selected", available: "no" },
  });
  expect(await f.journal.read(request.key)).toBeNull();
  expect(f.effects()).toEqual([]);
  f.catalogue = [catalogueModel("fixture-selected", ["low"])];
  expect(
    await f.route().create({ ...f.request(), effort: "high" }),
  ).toMatchObject({ code: "TASK_EFFORT_UNAVAILABLE" });
  expect(f.effects()).toEqual([]);
});
it("warm UI catalogue cannot authorize a later dispatch", async () => {
  const f = await fixture();
  expect((await f.route().models()).configured[0]).toMatchObject({
    available: "yes",
  });
  f.catalogue = [];
  expect(await f.route().create(f.request())).toMatchObject({
    code: "TASK_MODEL_UNAVAILABLE",
  });
  expect(f.calls.filter((c) => c.method === "model/list")).toHaveLength(2);
  expect(f.effects()).toEqual([]);
});
it("binds an omitted effort once and continues the original binding after config edits", async () => {
  const f = await fixture();
  const request = f.request();
  expect((await f.route().create(request)).status).toBe("dispatched");
  const original = await f.journal.read(request.key);
  expect(original).toMatchObject({
    model: "fixture-selected",
    reasoningEffort: "high",
    modelCatalogue: { modelId: "picker-fixture-selected" },
    modelBinding: { selection: { effort: "high" } },
  });
  f.policy.tasks.harnesses.codex!.models.luna = {
    model: "replacement",
    defaultEffort: "low",
  };
  f.catalogue = [
    catalogueModel("fixture-selected", ["low", "high"]),
    catalogueModel("replacement", ["low"]),
  ];
  expect((await f.route().create(f.request())).status).toBe("dispatched");
  const continued = await f.route().continue({
    key: randomUUID(),
    dispatchId: request.key,
    message: "Same task",
  });
  expect(continued.status).toBe("dispatched");
  const last = f.effects().at(-1)!;
  expect(last.params).toMatchObject({
    threadId: original?.threadId,
    model: "fixture-selected",
    effort: "high",
  });
});
it("removed original model blocks continuation without reserving a new operation", async () => {
  const f = await fixture();
  const request = f.request();
  await f.route().create(request);
  const effects = f.effects().length;
  f.catalogue = [catalogueModel("replacement")];
  const key = randomUUID();
  expect(
    await f
      .route()
      .continue({ key, dispatchId: request.key, message: "Continue" }),
  ).toMatchObject({ code: "TASK_MODEL_UNAVAILABLE" });
  expect(await f.journal.read(key)).toBeNull();
  expect(f.effects()).toHaveLength(effects);
});
it("completed replay does not require discovery or another inference", async () => {
  const f = await fixture();
  const request = f.request();
  const result = await f.route().create(request);
  const count = f.calls.filter((c) => c.method === "model/list").length;
  f.unavailable = true;
  expect(await f.route().create(request)).toEqual(result);
  expect(f.calls.filter((c) => c.method === "model/list")).toHaveLength(count);
  expect(f.effects()).toHaveLength(2);
});
it("concurrent runtime defaults cannot change the journal winner's binding", async () => {
  const f = await fixture();
  let reads = 0;
  f.onCatalogue = () => {
    f.catalogue = [
      catalogueModel(
        "fixture-selected",
        ++reads === 1 ? ["high", "low"] : ["low", "high"],
      ),
    ];
  };
  const reserve = f.journal.reserve.bind(f.journal);
  let releaseBoth!: () => void;
  let releaseWinner!: () => void;
  const both = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  const winner = new Promise<void>((resolve) => {
    releaseWinner = resolve;
  });
  let arrivals = 0;
  f.journal.reserve = async (key, record) => {
    if (++arrivals === 1) {
      await both;
      const saved = await reserve(key, record);
      releaseWinner();
      return saved;
    }
    releaseBoth();
    await winner;
    return reserve(key, record);
  };
  const request = f.request();
  const results = await Promise.all([
    f.route().create(request),
    f.route().create(request),
  ]);
  expect(
    results.filter((result) => result.status === "dispatched"),
  ).toHaveLength(1);
  expect(f.effects()).toHaveLength(2);
  const saved = await f.journal.read(request.key);
  expect(f.effects().at(-1)?.params.effort).toBe(saved?.reasoningEffort);
  expect(reads).toBe(2);
});

it("fresh discovery failure remains unknown availability, not model absence", async () => {
  const f = await fixture();
  f.unavailable = true;
  expect(await f.route().create(f.request())).toMatchObject({
    code: "TASK_MODEL_CATALOG_UNAVAILABLE",
    modelAvailability: { available: "unknown" },
  });
  expect(f.effects()).toEqual([]);
});
it.each(["revocation", "account"])(
  "%s during discovery prevents dispatch",
  async (change) => {
    const f = await fixture();
    f.onCatalogue = () =>
      change === "revocation" ? f.revoke() : f.switchAccount();
    const request = f.request();
    expect((await f.route().create(request)).status).toBe("refused");
    expect(await f.journal.read(request.key)).toBeNull();
    expect(f.effects()).toEqual([]);
  },
);

it("message uses the issued effective effort when the caller originally omitted it", async () => {
  const f = await fixture();
  const request = f.request();
  expect((await f.route().create(request)).status).toBe("dispatched");
  expect(await f.journal.read(request.key)).toMatchObject({
    reasoningEffort: "high",
  });
  await f.activate(request.key);
  f.catalogue = [catalogueModel("fixture-selected", ["low"])];
  const before = f.calls.filter((c) => c.method === "model/list").length;
  const message = {
    ...request,
    key: randomUUID(),
    dispatchId: request.key,
    model: "fixture-selected",
    message: "Same active turn only",
  };
  expect(await f.route().message(message)).toMatchObject({
    status: "steered",
    dispatchId: request.key,
  });
  expect(await f.route().message(message)).toMatchObject({
    status: "steered",
    dispatchId: request.key,
  });
  expect(
    await f.route().message({ ...message, reasoningEffort: "high" }),
  ).toMatchObject({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
  expect(f.calls.filter((c) => c.method === "model/list")).toHaveLength(before);
  expect(f.effects().filter((c) => c.method === "turn/steer")).toHaveLength(1);
});

it("message still refuses an explicit effort that conflicts with the issued binding", async () => {
  const f = await fixture();
  const request = f.request();
  expect((await f.route().create(request)).status).toBe("dispatched");
  await f.activate(request.key);
  const before = f.effects().length;
  expect(
    await f.route().message({
      ...request,
      key: randomUUID(),
      dispatchId: request.key,
      model: "fixture-selected",
      reasoningEffort: "low",
    }),
  ).toMatchObject({
    status: "refused",
    code: "HANDOFF_DISPATCH_BINDING_CHANGED",
  });
  expect(f.effects()).toHaveLength(before);
});

it.each(["create", "continue"] as const)(
  "MCP cancellation during discovery prevents %s reservation and dispatch",
  async (kind) => {
    const f = await fixture();
    const parent = f.request();
    if (kind === "continue") await f.route().create(parent);
    const baseline = f.effects().length;
    const request =
      kind === "create"
        ? f.request()
        : {
            key: randomUUID(),
            dispatchId: parent.key,
            message: "Continue fixture",
          };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.onCatalogue = async () => {
      entered();
      await barrier;
    };
    const route = f.route();
    const contexts: CodexTaskReadContext[] = [];
    let finished!: (value: unknown) => void;
    const completed = new Promise<unknown>((resolve) => {
      finished = resolve;
    });
    const capture = async (operation: Promise<unknown>) => {
      try {
        const value = await operation;
        finished(value);
        return value;
      } catch (error) {
        finished(error);
        throw error;
      }
    };
    const delegated = Object.create(route) as typeof route;
    delegated.create = async (input, context?: CodexTaskReadContext) => {
      contexts.push(context ?? {});
      return capture(route.create(input, context)) as ReturnType<
        typeof route.create
      >;
    };
    delegated.continue = async (input, context?: CodexTaskReadContext) => {
      contexts.push(context ?? {});
      return capture(route.continue(input, context)) as ReturnType<
        typeof route.continue
      >;
    };
    const server = createReadonlyComputerMcpServer(
      {
        execute: async () => {
          throw Error("NO_FILESYSTEM");
        },
      },
      {
        ownerId: "fixture-owner",
        sessionId: "fixture-session",
        taskId: "fixture-task",
        taskEpoch: 1,
        participantId: "fixture-participant",
        turnId: "fixture-turn",
        generation: 1,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      delegated,
    );
    const client = new Client({
      name: "dispatch-cancellation-fixture",
      version: "1",
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
    const controller = new AbortController();
    const outcome = client
      .callTool(
        { name: "codex_task_" + kind, arguments: request },
        { signal: controller.signal },
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      await started;
      controller.abort();
      await outcome;
      // Let the SDK deliver the cancellation notification to the server handler.
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      expect(await completed).toMatchObject({
        status: "refused",
        code: "HANDOFF_TASK_ADMISSION_DENIED",
      });
      expect(contexts[0]?.signal?.aborted).toBe(true);
      expect(await f.journal.read(request.key)).toBeNull();
      expect(f.effects()).toHaveLength(baseline);
    } finally {
      release();
      controller.abort();
      await outcome;
      await completed;
      await Promise.all([client.close(), server.close()]);
    }
  },
);

it.each([
  ["claimThread", "revoke"],
  ["claimTurn", "revoke"],
  ["claimThread", "replaceRoot"],
  ["claimTurn", "replaceRoot"],
] as const)(
  "%s / %s inside the durable claim prevents the next effect and consumes the intent",
  async (claim, change) => {
    const f = await fixture();
    const original = f.journal[claim].bind(f.journal);
    f.journal[claim] = async (key) => {
      const claimed = await original(key);
      f[change]();
      return claimed;
    };
    const request = f.request();
    expect(await f.route().create(request)).toMatchObject({
      status: "outcome_unknown",
      dispatchId: request.key,
    });
    expect(f.effects().map((call) => call.method)).toEqual(
      claim === "claimThread" ? [] : ["thread/start"],
    );
    const record = await f.journal.read(request.key);
    expect(
      record?.[claim === "claimThread" ? "threadIntent" : "turnIntent"],
    ).toBe(true);
    const count = f.effects().length;
    f.restoreAuthority();
    expect(await f.route().create(request)).toMatchObject({
      status: "outcome_unknown",
    });
    expect(f.effects()).toHaveLength(count);
  },
);

it.each(["create", "continue"] as const)(
  "an expired request after model discovery cannot reserve %s",
  async (kind) => {
    const f = await fixture();
    const route = f.route();
    const parent = f.request();
    if (kind === "continue") await route.create(parent);
    const count = f.effects().length;
    const request =
      kind === "create"
        ? f.request()
        : {
            key: randomUUID(),
            dispatchId: parent.key,
            message: "Continue fixture",
          };
    f.onCatalogue = () => f.expire();
    const result =
      kind === "create"
        ? await route.create(request as ReturnType<typeof f.request>)
        : await route.continue(
            request as { key: string; dispatchId: string; message: string },
          );
    expect(result).toMatchObject({
      status: "refused",
      code: "HANDOFF_TASK_ADMISSION_DENIED",
    });
    expect(await f.journal.read(request.key)).toBeNull();
    expect(f.effects()).toHaveLength(count);
  },
);

it("cancellation inside a continuation claim leaves an unknown consumed intent without a new turn", async () => {
  const f = await fixture();
  const parent = f.request();
  await f.route().create(parent);
  const count = f.effects().length;
  const controller = new AbortController();
  const original = f.journal.claimTurn.bind(f.journal);
  f.journal.claimTurn = async (key) => {
    const claimed = await original(key);
    controller.abort();
    return claimed;
  };
  const request = {
    key: randomUUID(),
    dispatchId: parent.key,
    message: "Continue fixture",
  };
  expect(
    await f.route().continue(request, { signal: controller.signal }),
  ).toMatchObject({ status: "outcome_unknown", dispatchId: request.key });
  expect((await f.journal.read(request.key))?.turnIntent).toBe(true);
  expect(f.effects()).toHaveLength(count);
  expect(await f.route().continue(request)).toMatchObject({
    status: "outcome_unknown",
  });
  expect(f.effects()).toHaveLength(count);
});

it.each(["create", "continue"] as const)(
  "cancellation after %s binding is durable cannot resume on same-key replay",
  async (kind) => {
    const f = await fixture();
    const route = f.route();
    const parent = f.request();
    if (kind === "continue") await route.create(parent);
    const controller = new AbortController();
    const key = randomUUID();
    if (kind === "create") {
      const original = f.journal.recordThread.bind(f.journal);
      f.journal.recordThread = async (id, thread) => {
        await original(id, thread);
        if (id === key) controller.abort();
      };
    } else {
      const original = f.journal.claimContinuation.bind(f.journal);
      f.journal.claimContinuation = async (...args) => {
        const claimed = await original(...args);
        if (args[2] === key && claimed) controller.abort();
        return claimed;
      };
    }
    const createdRequest = { ...f.request(), key };
    const continuedRequest = {
      key,
      dispatchId: parent.key,
      message: "Continue fixture",
    };
    const first =
      kind === "create"
        ? await route.create(createdRequest, { signal: controller.signal })
        : await route.continue(continuedRequest, { signal: controller.signal });
    expect(first).toMatchObject({ status: "outcome_unknown", dispatchId: key });
    const count = f.effects().length;
    const replay =
      kind === "create"
        ? await f.route().create(createdRequest)
        : await f.route().continue(continuedRequest);
    expect(replay).toMatchObject({
      status: "outcome_unknown",
      dispatchId: key,
    });
    expect(f.effects()).toHaveLength(count);
    expect((await f.journal.read(key))?.turnIntent).toBe(true);
  },
);

it("cancellation after continuation preflight consumes its intent without stranding ordinary fence recovery", async () => {
  const f = await fixture();
  const parent = f.request();
  await f.route().create(parent);
  const count = f.effects().length;
  const controller = new AbortController();
  f.beforeEffect = () => controller.abort();
  const request = {
    key: randomUUID(),
    dispatchId: parent.key,
    message: "Continue fixture",
  };
  expect(
    await f.route().continue(request, { signal: controller.signal }),
  ).toMatchObject({ status: "outcome_unknown", dispatchId: request.key });
  expect((await f.journal.read(request.key))?.turnIntent).toBe(true);
  expect(f.effects()).toHaveLength(count);
  f.beforeEffect = () => {};
  expect(await f.route().continue(request)).toMatchObject({
    status: "outcome_unknown",
  });
  expect(f.effects()).toHaveLength(count);
});
