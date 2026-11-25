import { describe, expect, it, vi } from "vitest";
import { createContextFixture, type ContextFixturePorts } from "./fixture";

// The E2E context fixture over scripted owners. The task registry, the context
// controller and the hand-off codec are fakes that record what they were given;
// the one ordered log shows which owner each refusal reached and which it did
// not. No context store, Codex host or ChatGPT page runs.

function fake<T>(value: unknown): T {
  return value as T;
}

type Task = {
  provider: string;
  turnId: string;
  context?: { phase: string; epoch: number };
};

type Build = Readonly<{
  env?: Record<string, string | undefined>;
  demoMode?: boolean;
  task?: Task | null;
  controller?: boolean;
  compact?: () => Promise<unknown>;
  session?: unknown;
  checkpoint?: unknown;
  source?: unknown;
  handoff?: unknown;
  prepare?: () => Promise<unknown>;
}>;

const e2e = { FAROL_E2E: "1" };
const model = "gpt-test-model";

function build(options: Build = {}) {
  const log: string[] = [];
  let task: Task | null | undefined =
    "task" in options
      ? options.task
      : { provider: "chatgpt", turnId: "turn-1" };
  const compact = vi.fn(
    options.compact ?? (async () => ({ ok: true, value: {} })),
  );
  const prepareTurn = vi.fn(
    options.prepare ?? (async () => ({ ok: true, value: {} })),
  );
  const load = vi.fn(async (binding: unknown) => {
    log.push(`load:${JSON.stringify(binding)}`);
    return "session" in options ? options.session : undefined;
  });
  const get = vi.fn(async (_binding: unknown, checkpointId: string) => {
    log.push(`get:${checkpointId}`);
    return "checkpoint" in options ? options.checkpoint : { id: "checkpoint" };
  });
  const getSource = vi.fn(async (_binding: unknown, operationId: string) => {
    log.push(`getSource:${operationId}`);
    return "source" in options
      ? options.source
      : {
          variant: "unary_replacement_history",
          sourceBoundary: "boundary-1",
          history: ["h1"],
        };
  });
  const controller = {
    store: { load, get, getSource },
    continuity: { compact, prepareTurn },
  };
  const state = {
    controller: options.controller === false ? null : controller,
  };
  const buildHandoff = vi.fn((..._args: unknown[]) =>
    "handoff" in options
      ? options.handoff
      : {
          ok: true,
          value: {
            variant: "unary_replacement_history",
            response: { output: ["replacement"] },
          },
        },
  );
  const registryGet = vi.fn((taskId: string) => {
    log.push(`registry:${taskId}`);
    return task ?? undefined;
  });
  const controllerGet = vi.fn(() => {
    log.push("controller");
    return state.controller;
  });
  const contextBinding = vi.fn((taskId: string) => {
    log.push(`binding:${taskId}`);
    return { taskId, binding: true };
  });
  const ports = {
    env: options.env ?? e2e,
    demoMode: options.demoMode ?? false,
    liveTaskRegistry: fake<ContextFixturePorts["liveTaskRegistry"]>({
      get: registryGet,
    }),
    contextHost: {
      controller: fake<ContextFixturePorts["contextHost"]["controller"]>({
        get: controllerGet,
      }),
    },
    contextBinding: fake<ContextFixturePorts["contextBinding"]>(contextBinding),
    contextModel: fake<ContextFixturePorts["contextModel"]>(model),
    buildHostCompactionHandoff:
      fake<ContextFixturePorts["buildHostCompactionHandoff"]>(buildHandoff),
  } satisfies ContextFixturePorts;
  return {
    fixture: createContextFixture(ports),
    log,
    compact,
    prepareTurn,
    load,
    get,
    getSource,
    buildHandoff,
    setTask: (next: Task | null) => {
      task = next;
    },
  };
}

describe("fixture history", () => {
  it("carries the epoch in each receipt and keeps the four items in order", () => {
    const { fixture } = build();
    for (const epoch of [1, 2, 7]) {
      const history = fixture.contextFixtureHistory(epoch);
      expect(history).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Keep every change local until owner review.",
            },
          ],
        },
        {
          type: "function_call_output",
          call_id: `context-receipt-${epoch}`,
          output: `receipt-context-epoch-${epoch}`,
        },
        {
          type: "function_call_output",
          call_id: `context-unknown-${epoch}`,
          output: "outcome_unknown",
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Use report-v2.md; report-v1.md is obsolete. Never publish, push, sign, or release.",
            },
          ],
        },
      ]);
    }
  });
});

describe("refusals before any owner is read", () => {
  it.each([
    ["outside an E2E run", { env: {} }],
    ["with the E2E flag set to something else", { env: { FAROL_E2E: "0" } }],
    ["in demo mode", { demoMode: true }],
  ] as const)("refuses %s", async (_name, options) => {
    for (const action of [
      "compact-context-fixture",
      "confirm-context-fixture",
    ] as const) {
      const built = build(options);
      await expect(
        built.fixture.runContextFixtureControl("task-1", action),
      ).resolves.toEqual({ error: "IPC_CONTROL_INVALID" });
      expect(built.log).toEqual([]);
      expect(built.compact).not.toHaveBeenCalled();
      expect(built.prepareTurn).not.toHaveBeenCalled();
    }
  });

  it("reads the environment at the call", async () => {
    const env: Record<string, string | undefined> = {};
    const built = build({ env });
    await expect(
      built.fixture.runContextFixtureControl("t", "compact-context-fixture"),
    ).resolves.toEqual({ error: "IPC_CONTROL_INVALID" });
    env.FAROL_E2E = "1";
    await expect(
      built.fixture.runContextFixtureControl("t", "compact-context-fixture"),
    ).resolves.toEqual({ ok: true, phase: null });
  });
});

describe("unavailable fixture", () => {
  it.each([
    ["no task", { task: null }],
    [
      "a task of another provider",
      { task: { provider: "codex", turnId: "t" } },
    ],
    ["no controller", { controller: false }],
  ] as const)("answers unavailable for %s", async (_name, options) => {
    for (const action of [
      "compact-context-fixture",
      "confirm-context-fixture",
    ] as const) {
      const built = build(options);
      await expect(
        built.fixture.runContextFixtureControl("task-1", action),
      ).resolves.toEqual({ error: "CONTEXT_FIXTURE_UNAVAILABLE" });
      expect(built.compact).not.toHaveBeenCalled();
      expect(built.load).not.toHaveBeenCalled();
    }
  });
});

describe("compact-context-fixture", () => {
  it("compacts the history of epoch 1 for a task with no active context", async () => {
    const built = build({ task: { provider: "chatgpt", turnId: "turn-5" } });
    await expect(
      built.fixture.runContextFixtureControl(
        "task-1",
        "compact-context-fixture",
      ),
    ).resolves.toEqual({ ok: true, phase: null });
    expect(built.compact).toHaveBeenCalledTimes(1);
    expect(built.compact).toHaveBeenCalledWith({
      endpoint: "responses_compact",
      body: { model, input: built.fixture.contextFixtureHistory(1) },
      metadataHeader: JSON.stringify({
        thread_id: "task-1",
        turn_id: "turn-5-context-compact-1",
      }),
    });
    expect(built.log).toEqual([
      "registry:task-1",
      "controller",
      "binding:task-1",
      "registry:task-1",
    ]);
  });

  it("uses the epoch of an active context and reports the phase read afterwards", async () => {
    const built = build({
      task: {
        provider: "chatgpt",
        turnId: "turn-6",
        context: { phase: "active", epoch: 4 },
      },
      compact: async () => {
        built.setTask({
          provider: "chatgpt",
          turnId: "turn-6",
          context: { phase: "handoff_offered", epoch: 4 },
        });
        return { ok: true, value: {} };
      },
    });
    await expect(
      built.fixture.runContextFixtureControl(
        "task-2",
        "compact-context-fixture",
      ),
    ).resolves.toEqual({ ok: true, phase: "handoff_offered" });
    expect(built.compact).toHaveBeenCalledWith({
      endpoint: "responses_compact",
      body: { model, input: built.fixture.contextFixtureHistory(4) },
      metadataHeader: JSON.stringify({
        thread_id: "task-2",
        turn_id: "turn-6-context-compact-4",
      }),
    });
  });

  it("falls back to epoch 1 when the context is not active", async () => {
    const built = build({
      task: {
        provider: "chatgpt",
        turnId: "turn-7",
        context: { phase: "handoff_offered", epoch: 9 },
      },
    });
    await built.fixture.runContextFixtureControl(
      "task-3",
      "compact-context-fixture",
    );
    expect(built.compact).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { model, input: built.fixture.contextFixtureHistory(1) },
      }),
    );
  });

  it("reports the continuity's error code", async () => {
    const built = build({
      compact: async () => ({
        ok: false,
        error: { code: "COMPACTION_FAILED" },
      }),
    });
    await expect(
      built.fixture.runContextFixtureControl(
        "task-1",
        "compact-context-fixture",
      ),
    ).resolves.toEqual({ error: "COMPACTION_FAILED" });
  });
});

describe("confirm-context-fixture", () => {
  const session = {
    phase: "handoff_offered",
    epoch: 3,
    operation: { checkpointId: "cp-1", operationId: "op-1" },
  };

  async function confirm(options: Build) {
    const built = build({
      task: { provider: "chatgpt", turnId: "turn-8" },
      ...options,
    });
    const result = await built.fixture.runContextFixtureControl(
      "task-1",
      "confirm-context-fixture",
    );
    return { built, result };
  }

  it.each([
    ["no stored session", { session: null }],
    [
      "a session not offering a handoff",
      { session: { ...session, phase: "active" } },
    ],
    [
      "an operation without a checkpoint",
      { session: { ...session, operation: {} } },
    ],
    ["no operation", { session: { phase: "handoff_offered", epoch: 1 } }],
  ] as const)("is unavailable with %s", async (_name, options) => {
    const { built, result } = await confirm(options);
    expect(result).toEqual({
      error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE",
    });
    expect(built.get).not.toHaveBeenCalled();
    expect(built.getSource).not.toHaveBeenCalled();
    expect(built.prepareTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["no checkpoint", { session, checkpoint: null }],
    ["no source", { session, source: null }],
  ] as const)("is unavailable with %s", async (_name, options) => {
    const { built, result } = await confirm(options);
    expect(result).toEqual({
      error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE",
    });
    expect(built.buildHandoff).not.toHaveBeenCalled();
    expect(built.prepareTurn).not.toHaveBeenCalled();
  });

  it("reports the codec's error code and sends nothing", async () => {
    const { built, result } = await confirm({
      session,
      handoff: { ok: false, error: { code: "HOST_CHECKPOINT_INVALID" } },
    });
    expect(result).toEqual({ error: "HOST_CHECKPOINT_INVALID" });
    expect(built.prepareTurn).not.toHaveBeenCalled();
  });

  it("builds the hand-off from the stored source and prepares a turn from a unary replacement", async () => {
    const { built, result } = await confirm({ session });
    expect(result).toEqual({ ok: true, phase: null });
    expect(built.log).toEqual([
      "registry:task-1",
      "controller",
      "binding:task-1",
      'load:{"taskId":"task-1","binding":true}',
      "get:cp-1",
      "getSource:op-1",
      "registry:task-1",
    ]);
    expect(built.buildHandoff).toHaveBeenCalledWith(
      {
        variant: "unary_replacement_history",
        identity: {
          threadId: "task-1",
          turnId: "turn-8-context-compact-3",
          modelId: model,
        },
        sourceBoundary: "boundary-1",
        history: ["h1"],
      },
      { id: "checkpoint" },
      {
        maximumCheckpointContentBytes: 256 * 1_024,
        retainedTailMaximumBytes: 64 * 1_024,
        maximumHandoffBytes: 128 * 1_024,
      },
    );
    expect(built.prepareTurn).toHaveBeenCalledWith({
      body: {
        model,
        input: ["replacement"],
        client_metadata: {
          session_id: "task-1",
          thread_id: "task-1",
          turn_id: "turn-8-context-confirm-3",
        },
      },
    });
  });

  it("sends the single compaction item of a streamed hand-off", async () => {
    const item = { id: "i", type: "compaction", encrypted_content: "c" };
    const { built } = await confirm({
      session,
      handoff: {
        ok: true,
        value: { variant: "streamed_compaction_item", item },
      },
    });
    expect(built.prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ input: [item] }),
      }),
    );
  });

  it("reports the phase read after the turn, or the turn's error code", async () => {
    const accepted = await confirm({
      session,
      prepare: async () => ({ ok: true, value: {} }),
    });
    expect(accepted.result).toEqual({ ok: true, phase: null });
    const refused = await confirm({
      session,
      prepare: async () => ({ ok: false, error: { code: "TURN_REFUSED" } }),
    });
    expect(refused.result).toEqual({ error: "TURN_REFUSED" });
  });
});
