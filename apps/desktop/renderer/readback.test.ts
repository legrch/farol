import { describe, expect, it, vi } from "vitest";
import { ConfigurationRequestOrder } from "../../../src/ui/configuration-request-order";
import {
  workspaceReadbackBinding,
  type WorkspaceReadbackBinding,
} from "../../../src/ui/guided-workspace-access";
import type {
  ActivityEntry,
  Intent,
  NativeRefreshResult,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import {
  bootstrap,
  deferred,
  settings,
  task as fixtureTask,
} from "../../../tests/renderer/fixture";
import { createReadback } from "./readback";
import { initial } from "./snapshot";

// Parsed adapter fixtures with a fake bridge; no native host or live provider.
const buildId = "3".repeat(64);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const checkId = "44444444-4444-4444-8444-444444444444";
const id = `settings:computer.verify-workspace:${workspaceId}`;
const command = {
  kind: "computer.verify-workspace",
  workspaceId,
  checkId,
} as const;

function workspace(checked: boolean) {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "write",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
    },
  ];
  if (checked) {
    value.computer.workspaces[0]!.accessCheck = {
      checkId,
      rootIdentity: { device: "1", inode: "2" },
      buildId,
      computerGeneration: value.computer.generation,
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
    value.setup.computer.reachable = "reachable";
    value.setup.computer.verified = {
      profile: "farol",
      configRevision: value.computer.generation,
      workspaceId,
      runtimeGeneration: "a".repeat(64),
      buildId,
      protocol: "secure-mcp",
      verifiedAt: "2026-10-02T20:00:00.000Z",
    };
  }
  return value;
}
const task = (taskId?: string) =>
  fixtureTask(taskId) as unknown as WindowSnapshot["tasks"]["tasks"][number];
const reply = (overrides: Record<string, unknown> = {}) => ({
  ...bootstrap(),
  ...overrides,
});
const ready = (revision: number) => ({
  status: "ready" as const,
  settings: settings(revision),
});
const entry = (taskId: string, ordinal = 1): ActivityEntry => ({
  id: `${taskId}:${ordinal}`,
  taskId,
  turnId: taskId,
  generation: 0,
  label: "Task",
  kind: "phase",
  at: 1,
  phase: null,
  operation: null,
  code: null,
});

function harness(start: Partial<WindowSnapshot> = {}) {
  const world = {
    state: {
      ...initial,
      status: "current",
      runtime: "ready",
      buildId,
      configuration: { status: "ready", settings: workspace(false) },
      ...start,
    } as WindowSnapshot,
    runtime: 0,
    route: 0,
    stale: 0,
    disposed: false,
    staled: 0,
    invalidated: 0,
    reconciled: 0,
    contexts: [] as unknown[],
    reads: [] as unknown[],
    commands: new Map<string, WorkspaceReadbackBinding>(),
    consumed: [] as string[],
    patches: [] as Partial<WindowSnapshot>[],
    bootstraps: [] as ReturnType<typeof deferred<unknown>>[],
    answers: [] as unknown[],
  };
  const order = new ConfigurationRequestOrder();
  const readback = createReadback({
    api: {
      bootstrap: vi.fn(() => {
        if (world.answers.length > 0)
          return Promise.resolve(world.answers.shift());
        const held = deferred<unknown>();
        world.bootstraps.push(held);
        return held.promise;
      }),
    },
    snapshot: () => world.state,
    patch: (value) => {
      world.patches.push(value);
      world.state = { ...world.state, ...value };
    },
    counters: {
      order,
      runtime: () => world.runtime,
      browserRoute: () => world.route,
      stale: () => world.stale,
    },
    disposed: () => world.disposed,
    effects: {
      stale: () => {
        world.staled++;
        world.stale++;
      },
      invalidateHistory: () => {
        world.invalidated++;
      },
      adoptHistoryContext: (context) => {
        world.contexts.push(context);
      },
      reconcileSignIn: () => {
        world.reconciled++;
      },
      connection: {
        begin: () => {
          const read = { clockEpoch: 0 } as never;
          world.reads.push(read);
          return read;
        },
        adopt: () => {},
      },
      workspaceCommand: (key) => world.commands.get(key),
      consumeWorkspaceCommand: (key) => {
        world.consumed.push(key);
        world.commands.delete(key);
      },
    },
  });
  return { world, readback, order };
}

describe("ordering of readbacks", () => {
  it("drops an older reply that arrives after a newer one", async () => {
    const { world, readback } = harness();
    const older = readback.refresh();
    const newer = readback.refresh();
    world.bootstraps[1]!.resolve(
      reply({ configuration: ready(5), taskRevision: 2, tasks: [task()] }),
    );
    const adopted = await newer;
    expect(adopted.status).toBe("adopted");
    const settled = world.state.configuration;
    world.bootstraps[0]!.resolve(
      reply({ configuration: ready(9), taskRevision: 8, tasks: [] }),
    );
    expect(await older).toEqual({
      status: "unqualified",
      reason: "superseded",
    });
    // The late reply changed nothing: no configuration, tasks or status.
    expect(world.state.configuration).toBe(settled);
    expect(world.state.tasks.revision).toBe(2);
    expect(world.patches.some((p) => p.status === "incompatible")).toBe(false);
  });

  it("does not adopt an older configuration or task revision", async () => {
    const { world, readback, order } = harness({
      configuration: ready(5),
      tasks: { revision: 4, tasks: [] },
    });
    const old = order.begin();
    const newest = order.begin();
    readback.adoptConfiguration(ready(9), old);
    expect(world.state.configuration).toMatchObject({
      settings: { revision: 5 },
    });
    readback.adoptConfiguration(ready(3), newest);
    expect(world.state.configuration).toMatchObject({
      settings: { revision: 5 },
    });
    expect(readback.adoptTasks({ revision: 3, tasks: [task()] })).toBe(true);
    expect(world.state.tasks.revision).toBe(4);
    readback.adoptConfiguration(ready(6), newest);
    expect(world.state.configuration).toMatchObject({
      settings: { revision: 6 },
    });
  });

  it("strips task settings and drops a delivery that no pending edit owns", () => {
    const { world, readback, order } = harness({
      workspaceEditDelivery: "op-1" as never,
    });
    const current = order.begin();
    const withTasks = settings(2) as ReturnType<typeof settings> & {
      tasks?: unknown;
    };
    withTasks.tasks = { enabled: true };
    readback.adoptConfiguration(
      { status: "ready", settings: withTasks } as never,
      current,
    );
    const adopted = world.state.configuration;
    expect(adopted?.status === "ready" && "tasks" in adopted.settings).toBe(
      false,
    );
    expect(world.state.workspaceEditDelivery).toBeNull();
    expect(world.state.evidence).toBeNull();
  });

  it("treats a contradictory task revision as stale once initialized", () => {
    const { world, readback } = harness({
      tasks: { revision: 2, tasks: [task("a")] },
    });
    expect(readback.tasksInitialized()).toBe(false);
    // Same revision, other bytes, first sight: adopted and initialized.
    expect(readback.adoptTasks({ revision: 2, tasks: [task("b")] })).toBe(true);
    expect(readback.tasksInitialized()).toBe(true);
    expect(world.staled).toBe(0);
    expect(readback.adoptTasks({ revision: 2, tasks: [task("c")] })).toBe(
      false,
    );
    expect(world.staled).toBe(1);
    expect(world.state.tasks.tasks[0]!.taskId).toBe("b");
  });
});

describe("refresh", () => {
  it.each([
    ["a malformed reply", { bogus: true }, "malformed", "incompatible"],
    [
      "another build",
      reply({ build: { ...bootstrap().build, buildId: "9".repeat(64) } }),
      "incompatible",
      "incompatible",
    ],
  ] as const)("refuses %s", async (_name, answer, reason, status) => {
    const { world, readback } = harness();
    world.answers.push(answer);
    expect(await readback.refresh()).toEqual({
      status: "unqualified",
      reason,
    });
    expect(world.state.status).toBe(status);
    expect(world.invalidated).toBe(1);
    expect(world.reconciled).toBe(0);
  });

  it("marks the window stale when the bridge rejects", async () => {
    const { world, readback } = harness();
    const pending = readback.refresh();
    world.bootstraps[0]!.reject(new Error("reply lost"));
    expect(await pending).toEqual({
      status: "unqualified",
      reason: "transport-unknown",
    });
    expect(world.staled).toBe(1);
  });

  it("does not touch a disposed window", async () => {
    const { world, readback } = harness();
    const pending = readback.refresh();
    world.disposed = true;
    world.bootstraps[0]!.resolve(reply({ configuration: ready(7) }));
    expect(await pending).toEqual({
      status: "unqualified",
      reason: "disposed",
    });
    expect(world.patches).toEqual([]);
    expect(await readback.refresh()).toEqual({
      status: "unqualified",
      reason: "disposed",
    });
  });

  it("keeps the newer runtime and refuses a receipt when it moved mid-read", async () => {
    const { world, readback } = harness({ runtime: "ready" });
    const pending = readback.refresh();
    world.runtime++;
    world.state = { ...world.state, runtime: "offline" };
    world.bootstraps[0]!.resolve(reply({ configuration: ready(4) }));
    expect(await pending).toEqual({
      status: "unqualified",
      reason: "not-current",
    });
    expect(world.state.runtime).toBe("offline");
    expect(world.state.status).toBe("stale");
    expect(world.invalidated).toBe(1);
  });

  it("does not adopt a stale revision as a current readback", async () => {
    const { world, readback } = harness({ configuration: ready(5) });
    world.answers.push(reply({ configuration: ready(2) }));
    const result = await readback.refresh();
    // The snapshot object stayed: nothing was adopted.
    expect(result).toEqual({ status: "unqualified", reason: "not-adopted" });
    expect(world.state.configuration).toMatchObject({
      settings: { revision: 5 },
    });
  });

  it("goes stale when a stale event fenced the read", async () => {
    const { world, readback } = harness();
    const pending = readback.refresh();
    world.stale++;
    world.bootstraps[0]!.resolve(reply({ configuration: ready(3) }));
    expect((await pending).status).toBe("unqualified");
    expect(world.state.status).toBe("stale");
  });
});

describe("buffering before the first read", () => {
  it("keeps the newest task state and adopts it once", () => {
    const { world, readback } = harness({ tasks: { revision: 0, tasks: [] } });
    expect(readback.adoptBufferedTasks()).toBe(true);
    expect(world.patches).toEqual([]);
    readback.bufferTasks({ revision: 3, tasks: [task("new")] });
    readback.bufferTasks({ revision: 2, tasks: [task("old")] });
    expect(readback.adoptBufferedTasks()).toBe(true);
    expect(world.state.tasks.tasks[0]!.taskId).toBe("new");
    // Equal revisions replace: the last arrival of the newest revision wins.
    readback.bufferTasks({ revision: 3, tasks: [task("same")] });
    expect(readback.adoptBufferedTasks()).toBe(false);
    expect(world.staled).toBe(1);
  });

  it("replays buffered events once, for known turns only", () => {
    const { readback } = harness();
    expect(readback.bufferEvent(entry("a"))).toBe(true);
    expect(readback.bufferEvent(entry("gone", 2))).toBe(true);
    const known = new Set(["a:a"]);
    expect(readback.bufferedEvents(known).map((e) => e.taskId)).toEqual(["a"]);
    readback.discardBuffered();
    expect(readback.bufferedEvents(known)).toEqual([]);
  });

  it("refuses an event past the buffer limit and drops buffered tasks on discard", () => {
    const { world, readback } = harness();
    for (let i = 0; i < 256; i++)
      expect(readback.bufferEvent(entry("a", i))).toBe(true);
    expect(readback.bufferEvent(entry("a", 256))).toBe(false);
    readback.bufferTasks({ revision: 4, tasks: [task("late")] });
    readback.discardBuffered();
    expect(readback.adoptBufferedTasks()).toBe(true);
    expect(world.state.tasks.revision).toBe(0);
    expect(readback.bufferedEvents(new Set(["a:a"]))).toEqual([]);
  });
});

describe("native workspace reconciliation", () => {
  const unknown: Intent = {
    id,
    state: "unknown",
    code: "CONFIGURATION_OUTCOME_UNKNOWN",
  };
  async function adopted(
    options: { start?: Partial<WindowSnapshot>; checked?: boolean } = {},
  ) {
    const start = harness({
      configuration: { status: "ready", settings: workspace(false) },
      intents: { [id]: unknown },
      ...options.start,
    });
    const pending = workspaceReadbackBinding(
      workspace(false),
      buildId,
      command,
    );
    start.world.commands.set(id, pending);
    start.world.answers.push(
      reply({
        configuration: {
          status: "ready",
          settings: workspace(options.checked ?? true),
        },
      }),
    );
    const receipt = await start.readback.refresh();
    expect(receipt.status).toBe("adopted");
    return { ...start, receipt, pending };
  }

  it("settles an unknown check from its own native witness, once", async () => {
    const { world, readback, receipt, pending } = await adopted();
    const resolved = readback.reconcileWorkspace(receipt, id, pending);
    expect(resolved).toMatchObject({
      id,
      state: "applied",
      code: "WORKSPACE_READBACK_CONFIRMED",
      workspaceReadback: { originalCode: unknown.code },
    });
    expect(world.state.intents[id]).toBe(resolved);
    expect(world.consumed).toEqual([id]);
    // The receipt and the retained command are both spent.
    expect(readback.reconcileWorkspace(receipt, id, pending)).toBeNull();
    expect(world.consumed).toEqual([id]);
  });

  it.each([
    ["a forged receipt", (r: NativeRefreshResult) => ({ ...r })],
    [
      "another build",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        buildId: "f".repeat(64),
      }),
    ],
    [
      "another generation",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        generation: p.generation + 1,
      }),
    ],
    [
      "another scope",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        scope: "elsewhere",
      }),
    ],
    [
      "another previous check",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        previousCheckId: "66666666-6666-4666-8666-666666666666",
      }),
    ],
    [
      "another connection",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        connectionIdentity: "elsewhere",
      }),
    ],
    [
      "another command",
      (_r: NativeRefreshResult, p: WorkspaceReadbackBinding) => ({
        ...p,
        command: {
          ...command,
          checkId: "77777777-7777-4777-8777-777777777777",
        },
      }),
    ],
  ] as const)("refuses %s", async (_name, change) => {
    const { world, readback, receipt, pending } = await adopted();
    const args = change as (
      r: NativeRefreshResult,
      p: WorkspaceReadbackBinding,
    ) => unknown;
    const changed = args(receipt, pending);
    const isReceipt =
      typeof changed === "object" && changed !== null && "requestId" in changed;
    expect(
      readback.reconcileWorkspace(
        (isReceipt ? changed : receipt) as NativeRefreshResult,
        id,
        (isReceipt ? pending : changed) as WorkspaceReadbackBinding,
      ),
    ).toBeNull();
    expect(world.state.intents[id]).toBe(unknown);
    expect(world.consumed).toEqual([]);
  });

  it("refuses when the readback was fenced after adoption", async () => {
    for (const fence of [
      (w: ReturnType<typeof harness>) => (w.world.runtime = 1),
      (w: ReturnType<typeof harness>) => (w.world.stale = 1),
      (w: ReturnType<typeof harness>) => w.order.begin(),
      (w: ReturnType<typeof harness>) => {
        w.world.state = { ...w.world.state, intents: { [id]: unknown } };
      },
      (w: ReturnType<typeof harness>) => {
        w.world.state = {
          ...w.world.state,
          configuration: { status: "ready", settings: workspace(true) },
        };
      },
      (w: ReturnType<typeof harness>) => {
        w.world.state = { ...w.world.state, status: "stale" };
      },
      (w: ReturnType<typeof harness>) => {
        w.world.state = { ...w.world.state, evidence: {} as never };
      },
      (w: ReturnType<typeof harness>) => {
        w.world.state = {
          ...w.world.state,
          intents: { [id]: { id, state: "unknown", code: "OTHER" } },
        };
      },
      (w: ReturnType<typeof harness>) => (w.world.disposed = true),
    ]) {
      const h = await adopted();
      fence(h);
      expect(
        h.readback.reconcileWorkspace(h.receipt, id, h.pending),
      ).toBeNull();
      expect(h.world.consumed).toEqual([]);
    }
  });

  it("refuses when the command is no longer retained or the check is not visible", async () => {
    const lost = await adopted();
    lost.world.commands.delete(id);
    expect(
      lost.readback.reconcileWorkspace(lost.receipt, id, lost.pending),
    ).toBeNull();
    const unchecked = await adopted({ checked: false });
    expect(
      unchecked.readback.reconcileWorkspace(
        unchecked.receipt,
        id,
        unchecked.pending,
      ),
    ).toBeNull();
  });
});
