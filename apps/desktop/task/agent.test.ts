import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import { productAgentContext } from "../../../src/apps/desktop/product-agent-context";
import {
  PrivateProductAgentStore,
  ProductAgentInputSchema,
  type ProductAgentInput,
} from "../../../src/apps/desktop/product-agent-store";
import { TaskMutationGate } from "../../../src/apps/desktop/task-mutation-gate";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type { ProductTask } from "../../../src/modules/chat/contract/product-task";
import {
  createProductAgentHost,
  type ProductAgentError,
  type ProductAgentHostPorts,
  type ProductAgentSession,
} from "./agent";

// The native Product Agent host over a real registry, a real private Agent
// store in a temporary root, the real transition reservation and the real task
// gate. Main's owners are scripted: each `let` is a field the ports read afresh
// and write through the setters, the clock and the two timers are driven by the
// test, and every effect appends to one ordered log. No process, App Server,
// window or installed profile runs, and no real time passes.
type Result =
  | Readonly<{ ok: true; taskId: string | null }>
  | Readonly<{ ok: false; error: ProductAgentError }>;
type Ports = ProductAgentHostPorts<Result>;
type Session = ProductAgentSession<Result>;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-agent-"));
  roots.push(root);
  return root;
}

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/approved";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";
const EXECUTABLE_SHA = "1".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const RUNTIME_ROOT = "/runtime/codex";
const PROBE_SCRATCH = "/state/codex-host-probe";
const ASSIGNMENTS_ROOT = "/state/codex-agent-assignments";

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

function settingsOf(revision = 1): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: COMPUTER_ID,
      generation: GENERATION,
      name: "This Mac",
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          root: ROOT,
          label: "Primary",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    nativeHosts: {
      generation: 1,
      codex: {
        executablePath: "/usr/local/bin/codex",
        executableSha256: EXECUTABLE_SHA,
        version: "1.0.0",
        protocol: "codex-app-server/v2" as const,
        schemaSha256: SCHEMA_SHA,
        verifiedAt: TIMESTAMP,
        liveVerification: {
          model: "gpt-6-astra" as const,
          executableSha256: EXECUTABLE_SHA,
          schemaSha256: SCHEMA_SHA,
          buildId: BUILD_ID,
          dynamicTool: "farol_ping" as const,
          verifiedAt: TIMESTAMP,
        },
        agentVerification: {
          model: "gpt-6-astra" as const,
          executableSha256: EXECUTABLE_SHA,
          schemaSha256: SCHEMA_SHA,
          buildId: BUILD_ID,
          workspaceId: WORKSPACE_ID,
          computerGeneration: GENERATION,
          transport: "codex-native-agent/spawn-prompt-sha256-v1" as const,
          authorityRole: "agent" as const,
          hostRole: null,
          delegationDigest: "7".repeat(64),
          parentThreadSha256: "8".repeat(64),
          childThreadSha256: "9".repeat(64),
          boundedRunning: true as const,
          modelTurnsSubmitted: 1 as const,
          fallbackAllowed: false as const,
          descendantCount: 0 as const,
          resultRefProtocol: "codex-app-server" as const,
          resultRetention: "durable" as const,
          parentDelivery: "acknowledged" as const,
          workspaceEnforcement: "verified" as const,
          verifiedAt: TIMESTAMP,
        },
      },
    },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: {
        ...readiness(),
        reachable: "reachable",
        outcomeUnknown: false,
        verified: {
          profile: "farol",
          configRevision: GENERATION,
          workspaceId: WORKSPACE_ID,
          runtimeGeneration: "next-1",
          buildId: BUILD_ID,
          protocol: "next-1",
          verifiedAt: TIMESTAMP,
        },
      },
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

function task(index: number): ProductTask {
  return {
    taskId: randomUUID(),
    sessionId: randomUUID(),
    turnId: randomUUID(),
    label: `ChatGPT task ${index}`,
    provider: "chatgpt",
    requestedModel: "Account default",
    observedModel: null,
    requestedMode: "Account default",
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
  };
}

function inputOf(
  source: ProductTask,
  overrides: Partial<ProductAgentInput> = {},
): ProductAgentInput {
  return ProductAgentInputSchema.parse({
    taskId: source.taskId,
    sessionId: source.sessionId,
    assignmentId: "assignment-1",
    authorityId: "authority-1",
    parentParticipantId: "main-1",
    agentParticipantId: "agent-1",
    taskEpoch: GENERATION,
    generation: 1,
    workspaceId: WORKSPACE_ID,
    scope: { mode: "subtree", root: ROOT },
    excludedPaths: [],
    objective: "Find the marker.",
    computerGeneration: GENERATION,
    executableSha256: EXECUTABLE_SHA,
    schemaSha256: SCHEMA_SHA,
    buildId: BUILD_ID,
    expiresAt: NOW + 60_000,
    createdAt: TIMESTAMP,
    ...overrides,
  });
}

function assignmentOf(
  input: ProductAgentInput,
  phase: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    identity: {
      assignmentId: input.assignmentId,
      ownerId: "owner-desktop",
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskEpoch: input.taskEpoch,
      generation: input.generation,
    },
    authority: {
      authorityId: input.authorityId,
      participantId: input.agentParticipantId,
      parentParticipantId: input.parentParticipantId,
      role: "agent",
      mutationOwnership: "none",
    },
    commandFingerprint: null,
    phase,
    parentThreadId: "parent-thread",
    childId: "child-thread",
    parentTurnId: "parent-turn",
    childTurnId: "child-turn",
    hostRole: "worker",
    delegationDigest: "d".repeat(64),
    authorityProof: null,
    terminal: phase !== "running",
    terminalReason: null,
    ...overrides,
  };
}

function receiptOf(
  input: ProductAgentInput,
  phase: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    assignment: assignmentOf(input, phase),
    resultRef: null,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "verified",
    resultRetention: "not_applicable",
    observation: "current",
    ...overrides,
  };
}

function fakeSession(input: ProductAgentInput): ProductAgentSession<Result> {
  return {
    taskId: input.taskId,
    key: "other",
    input,
    assignments: {},
    client: { close: vi.fn(async () => undefined) },
    host: { dispose: vi.fn() },
    expiryTimer: null,
    cancellation: null,
  } as never;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

type FakeTimer = NodeJS.Timeout &
  Readonly<{
    callback: () => void;
    delay: number;
    unref: ReturnType<typeof vi.fn>;
  }> & { cleared: boolean };

async function build(
  options: Readonly<{
    settings?: ProductSettings | null;
    withStore?: boolean;
    route?: Ports["farolBackedProductAgentRoute"];
    overrides?: Partial<Ports>;
  }> = {},
) {
  const events: string[] = [];
  const log = (event: string) => events.push(event);
  const registry = new LiveTaskRegistry(5);
  const store = new PrivateProductAgentStore({
    root: path.join(await temporaryRoot(), "agent"),
  });
  const gate = new TaskMutationGate();
  const reservation = new AuthorityTransitionReservation();
  const timers: FakeTimer[] = [];
  const clients: { close: ReturnType<typeof vi.fn> }[] = [];
  const hosts: {
    client: unknown;
    options: Record<string, unknown>;
    probe: unknown;
    computer: unknown;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const probes: unknown[][] = [];
  const stores: { root: string }[] = [];
  const cancelHosts: unknown[] = [];
  const state = {
    now: NOW,
    session: null as Session | null,
    expiry: null as Readonly<{ taskId: string; timer: NodeJS.Timeout }> | null,
    settings: (options.settings === undefined
      ? settingsOf()
      : options.settings) as ProductSettings | null,
    store: (options.withStore === false
      ? null
      : store) as PrivateProductAgentStore | null,
    persistFails: false,
    probe: {
      executableSha256: EXECUTABLE_SHA,
      schemaSha256: SCHEMA_SHA,
      version: "1.0.0",
      protocol: "codex-app-server/v2",
    } as Record<string, unknown>,
    launchFails: false,
    hostFails: false,
    clientCloseFails: false,
    cancel: null as null | ((identity: unknown) => unknown),
    acknowledge: null as null | ((command: unknown) => unknown),
    run: null as null | ((...args: unknown[]) => unknown),
    launched: [] as unknown[],
    acknowledged: [] as unknown[],
    cancelled: [] as unknown[],
    enabled: true,
    onPersist: null as null | (() => void),
  };
  const ports: Ports = {
    taskFailure: (error) => {
      log(`failure:${error}`);
      return { ok: false, error };
    },
    taskSuccess: (taskId) => ({ ok: true, taskId }),
    productAgentEnabled: state.enabled,
    farolBackedProductAgentRoute:
      options.route ??
      (() => ({ model: "gpt-6-chatgpt", effort: "low" }) as never),
    buildIdentity: { buildId: BUILD_ID, version: "9.9.9" },
    configuration: () => ({
      snapshot: () => {
        log("snapshot");
        return state.settings
          ? { status: "ready", settings: state.settings }
          : { status: "error", error: "SETTINGS_READ_FAILED" };
      },
    }),
    productAgentStore: () => state.store,
    liveTaskRegistry: registry,
    taskMutations: gate,
    authorityTransitions: reservation,
    activeProductAgentSession: () => state.session,
    setActiveProductAgentSession: (value) => {
      log(`session:${value ? "set" : "null"}`);
      state.session = value;
    },
    persistedProductAgentExpiry: () => state.expiry,
    setPersistedProductAgentExpiry: (value) => {
      log(`expiry:${value ? "set" : "null"}`);
      state.expiry = value;
    },
    persistLiveTaskState: async () => {
      log("persist");
      state.onPersist?.();
      if (state.persistFails) throw new Error("PERSIST_FAILED");
    },
    publishTasksState: () => log("publish"),
    statePaths: () => ({
      codexHostProbe: PROBE_SCRATCH,
      codexAgentAssignments: ASSIGNMENTS_ROOT,
    }),
    nativeWorkspace: { marker: "workspace" } as never,
    tempPath: () => "/tmp/farol",
    codexHostRuntimeRoot: async () => RUNTIME_ROOT,
    codexHostProcessHomePath: async () => "/home/process",
    codexHostHomeOption: async () => ({ codexHomePath: "/home/codex" }),
    probeCodexHost: (async (input: unknown) => {
      log("probe");
      probes.push([input]);
      return state.probe;
    }) as never,
    launchCodexAppServer: (async (input: unknown) => {
      log("launch");
      state.launched.push(input);
      if (state.launchFails) throw new Error("LAUNCH_FAILED");
      const client = {
        close: vi.fn(async () => {
          log("client-close");
          if (state.clientCloseFails) throw new Error("CLOSE_FAILED");
        }),
      };
      clients.push(client);
      return client;
    }) as never,
    runProductAgentAssignment: (async (...args: unknown[]) => {
      log("run");
      if (!state.run) throw new Error("RUN_NOT_SCRIPTED");
      return state.run(...args);
    }) as never,
    CodexNativeAgentHost: class {
      readonly dispose = vi.fn(() => log("dispose"));
      constructor(
        client: unknown,
        hostOptions: Record<string, unknown>,
        probe: unknown,
        computer: unknown,
      ) {
        if (state.hostFails) throw new Error("HOST_REJECTED");
        hosts.push({
          client,
          options: hostOptions,
          probe,
          computer,
          dispose: this.dispose,
        });
      }
      async spawn() {
        return {} as never;
      }
      async wait() {
        return {} as never;
      }
      async cancel() {
        return {} as never;
      }
    } as never,
    CodexAgentWorkspaceProbe: class {
      constructor(...args: unknown[]) {
        probes.push(["workspace-probe", ...args]);
      }
    } as never,
    PrivateAssignmentStore: class {
      constructor(input: { root: string }) {
        stores.push(input);
      }
    } as never,
    CancelAgentAssignment: class {
      constructor(host: unknown) {
        cancelHosts.push(host);
      }
      async execute(identity: unknown) {
        log("cancel-execute");
        state.cancelled.push(identity);
        if (!state.cancel) throw new Error("CANCEL_NOT_SCRIPTED");
        return state.cancel(identity);
      }
    } as never,
    AcknowledgeAgentResult: class {
      async execute(command: unknown) {
        log("acknowledge");
        state.acknowledged.push(command);
        if (!state.acknowledge) throw new Error("ACK_NOT_SCRIPTED");
        return state.acknowledge(command);
      }
    } as never,
    randomUUID,
    clock: () => state.now,
    setTimer: (callback, delay) => {
      const timer = {
        callback,
        delay,
        unref: vi.fn(),
        cleared: false,
      } as unknown as FakeTimer;
      timers.push(timer);
      log(`timer:${delay}`);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as FakeTimer).cleared = true;
      log("clear");
    },
    ...options.overrides,
  };
  const host = createProductAgentHost<Result>(ports);
  const failure = (error: ProductAgentError) => ({ ok: false, error });
  const context = () => {
    const resolved = productAgentContext(
      WORKSPACE_ID,
      state.settings,
      store,
      BUILD_ID,
    );
    if (!resolved) throw new Error("CONTEXT_REFUSED");
    return resolved;
  };
  /** A task whose durable summary says the Agent is running. */
  const running = (index = 1, input?: Partial<ProductAgentInput>) => {
    const source = task(index);
    expect(registry.admit(source).status).toBe("admitted");
    const saved = inputOf(source, input);
    expect(
      registry.setAgent(source.taskId, {
        assignmentBindingSha256: host.productAgentAssignmentBinding(saved),
        phase: "running",
        workspaceId: WORKSPACE_ID,
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
        resultAvailable: false,
      }),
    ).toBe(true);
    return { source, input: saved };
  };
  const live = (source: ProductTask) => {
    const current = registry.get(source.taskId);
    if (!current) throw new Error("TASK_MISSING");
    return current;
  };
  return {
    host,
    ports,
    events,
    registry,
    store,
    gate,
    reservation,
    timers,
    clients,
    hosts,
    probes,
    stores,
    cancelHosts,
    state,
    failure,
    context,
    running,
    live,
    log,
  };
}

const NOT_APPLICABLE = {
  parentDelivery: "not_applicable",
  workspaceEnforcement: "not_applicable",
  resultAvailable: false,
} as const;

describe("capability", () => {
  it("is false while the feature gate is off, without reading anything", async () => {
    const h = await build({ overrides: { productAgentEnabled: false } });
    expect(h.host.productAgentCapabilityAvailable()).toBe(false);
    expect(h.events).toEqual([]);
  });

  it("is false for an unreadable configuration or an unverified workspace", async () => {
    expect(
      (await build({ settings: null })).host.productAgentCapabilityAvailable(),
    ).toBe(false);
    const unverified = settingsOf();
    const h = await build({
      settings: ProductSettingsSchema.parse({
        ...unverified,
        setup: {
          ...unverified.setup,
          computer: { ...unverified.setup.computer, verified: null },
        },
      }),
    });
    expect(h.host.productAgentCapabilityAvailable()).toBe(false);
  });

  it("is true only when the stored context still matches this build and the store exists", async () => {
    const h = await build();
    expect(h.host.productAgentCapabilityAvailable()).toBe(true);
    h.state.store = null;
    expect(h.host.productAgentCapabilityAvailable()).toBe(false);
    h.state.store = h.store;
    expect(h.host.productAgentCapabilityAvailable()).toBe(true);
    const foreign = await build({
      overrides: { buildIdentity: { buildId: "6".repeat(64), version: "1" } },
    });
    expect(foreign.host.productAgentCapabilityAvailable()).toBe(false);
  });
});

describe("opening a session", () => {
  it("probes, launches and builds the host with the route, then arms the expiry", async () => {
    const h = await build();
    const source = task(1);
    const input = inputOf(source);
    const route = { model: "gpt-6-chatgpt", effort: "low" } as never;
    const session = await h.host.openProductAgentSession(
      input,
      h.context(),
      route,
    );
    expect(h.probes[0]).toEqual([
      { executablePath: "/usr/local/bin/codex", scratchRoot: PROBE_SCRATCH },
    ]);
    expect(h.state.launched).toEqual([
      {
        executablePath: "/usr/local/bin/codex",
        cwd: RUNTIME_ROOT,
        homePath: "/home/process",
        tempPath: "/tmp/farol",
        clientVersion: "9.9.9",
        toolProfile: "native-agent",
        codexHomePath: "/home/codex",
      },
    ]);
    const built = h.hosts[0]!;
    expect(built.options).toMatchObject({
      model: "gpt-6-chatgpt",
      effort: "low",
      runtimeRoot: RUNTIME_ROOT,
      spawnTimeoutMs: 120_000,
      waitTimeoutMs: 250,
      pollIntervalMs: 25,
      nonce: randomUUID,
    });
    expect((built.options.now as () => number)()).toBe(NOW);
    expect(built.probe).toBe(built.computer);
    expect(built.client).toBe(h.clients[0]);
    expect(h.probes[1]).toEqual([
      "workspace-probe",
      h.state.settings,
      h.ports.nativeWorkspace,
      expect.any(Function),
    ]);
    expect(h.stores).toEqual([{ root: ASSIGNMENTS_ROOT }]);
    expect(session).toMatchObject({
      taskId: input.taskId,
      input,
      cancellation: null,
    });
    expect(h.state.session).toBe(session);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.delay).toBe(60_000);
    expect(h.timers[0]!.unref).toHaveBeenCalledTimes(1);
    expect(session.expiryTimer).toBe(h.timers[0]);
    expect(h.reservation.current()).toBeNull();
  });

  it("arms no expiry when told not to", async () => {
    const h = await build();
    const session = await h.host.openProductAgentSession(
      inputOf(task(1)),
      h.context(),
      { model: "gpt-6-astra" },
      false,
    );
    expect(session.expiryTimer).toBeNull();
    expect(h.timers).toEqual([]);
  });

  it("hands back the live session for the same request and refuses any other", async () => {
    const h = await build();
    const source = task(1);
    const input = inputOf(source);
    const route = { model: "gpt-6-astra" } as const;
    const session = await h.host.openProductAgentSession(
      input,
      h.context(),
      route,
    );
    h.events.length = 0;
    await expect(
      h.host.openProductAgentSession(input, h.context(), route),
    ).resolves.toBe(session);
    // A different expiry request is a different key, so it is a different one.
    await expect(
      h.host.openProductAgentSession(input, h.context(), route, false),
    ).rejects.toThrow("PRODUCT_AGENT_SESSION_BUSY");
    await expect(
      h.host.openProductAgentSession(inputOf(task(2)), h.context(), route),
    ).rejects.toThrow("PRODUCT_AGENT_SESSION_BUSY");
    expect(h.events).toEqual([]);
  });

  it("refuses while another authority transition holds the reservation", async () => {
    const h = await build();
    const held = h.reservation.tryReserve("authority-change")!;
    await expect(
      h.host.openProductAgentSession(inputOf(task(1)), h.context(), {
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow("AUTHORITY_CHANGE_IN_PROGRESS");
    expect(h.events).toEqual([]);
    held.release();
    await h.host.openProductAgentSession(inputOf(task(1)), h.context(), {
      model: "gpt-6-astra",
    });
    expect(h.reservation.current()).toBeNull();
  });

  it("refuses settings that moved on after the context was read", async () => {
    const h = await build();
    const context = h.context();
    h.state.settings = settingsOf(2);
    await expect(
      h.host.openProductAgentSession(inputOf(task(1)), context, {
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow("AUTHORITY_CHANGE_IN_PROGRESS");
    h.state.settings = null;
    await expect(
      h.host.openProductAgentSession(inputOf(task(1)), context, {
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow("AUTHORITY_CHANGE_IN_PROGRESS");
    expect(h.state.launched).toEqual([]);
    expect(h.reservation.current()).toBeNull();
  });

  it.each([
    ["executableSha256", "2".repeat(64)],
    ["schemaSha256", "4".repeat(64)],
    ["version", "2.0.0"],
    ["protocol", "codex-app-server/v3"],
  ])(
    "refuses a probe whose %s changed, before launching",
    async (key, value) => {
      const h = await build();
      h.state.probe = { ...h.state.probe, [key]: value };
      await expect(
        h.host.openProductAgentSession(inputOf(task(1)), h.context(), {
          model: "gpt-6-astra",
        }),
      ).rejects.toThrow("PRODUCT_AGENT_HOST_CHANGED");
      expect(h.state.launched).toEqual([]);
      expect(h.state.session).toBeNull();
      expect(h.reservation.current()).toBeNull();
    },
  );

  it("closes the client it launched when the host cannot be built", async () => {
    const h = await build();
    h.state.hostFails = true;
    await expect(
      h.host.openProductAgentSession(inputOf(task(1)), h.context(), {
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow("HOST_REJECTED");
    expect(h.clients[0]!.close).toHaveBeenCalledTimes(1);
    expect(h.state.session).toBeNull();
    expect(h.timers).toEqual([]);
    expect(h.reservation.current()).toBeNull();
  });

  it("surfaces a failed launch and leaves nothing active", async () => {
    const h = await build();
    h.state.launchFails = true;
    await expect(
      h.host.openProductAgentSession(inputOf(task(1)), h.context(), {
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow("LAUNCH_FAILED");
    expect(h.state.session).toBeNull();
  });

  it("shares one open between two identical requests in flight", async () => {
    const gate = deferred();
    const probe = vi.fn(async () => {
      await gate.promise;
      return {
        executableSha256: EXECUTABLE_SHA,
        schemaSha256: SCHEMA_SHA,
        version: "1.0.0",
        protocol: "codex-app-server/v2",
      };
    });
    const h = await build({ overrides: { probeCodexHost: probe as never } });
    const input = inputOf(task(1));
    const route = { model: "gpt-6-astra" } as const;
    const first = h.host.openProductAgentSession(input, h.context(), route);
    const second = h.host.openProductAgentSession(input, h.context(), route);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(h.state.launched).toHaveLength(1);
  });
});

describe("closing a session", () => {
  async function opened() {
    const h = await build();
    const session = await h.host.openProductAgentSession(
      inputOf(task(1)),
      h.context(),
      { model: "gpt-6-astra" },
    );
    h.events.length = 0;
    return { h, session };
  }

  it("clears the timer, disposes the host, closes the client and clears the slot, in that order", async () => {
    const { h, session } = await opened();
    const timer = session.expiryTimer as unknown as FakeTimer;
    await expect(h.host.closeProductAgentSession(session)).resolves.toBe(true);
    expect(timer.cleared).toBe(true);
    expect(session.expiryTimer).toBeNull();
    expect(h.events).toEqual([
      "clear",
      "dispose",
      "client-close",
      "session:null",
    ]);
    expect(h.state.session).toBeNull();
  });

  it("reports a client that would not close, and still frees the slot", async () => {
    const { h, session } = await opened();
    h.state.clientCloseFails = true;
    await expect(h.host.closeProductAgentSession(session)).resolves.toBe(false);
    expect(h.state.session).toBeNull();
  });

  it("leaves a different active session alone", async () => {
    const { h, session } = await opened();
    const other = { ...session } as Session;
    h.state.session = other;
    await h.host.closeProductAgentSession(session);
    expect(h.state.session).toBe(other);
  });
});

describe("the summary a task carries", () => {
  it("binds the assignment by a stable digest of task, session and assignment", async () => {
    const h = await build();
    const source = task(1);
    const input = inputOf(source);
    const binding = h.host.productAgentAssignmentBinding(input);
    expect(binding).toMatch(/^[a-f0-9]{64}$/u);
    expect(h.host.productAgentAssignmentBinding(inputOf(source))).toBe(binding);
    expect(
      h.host.productAgentAssignmentBinding(
        inputOf(source, { assignmentId: "assignment-2" }),
      ),
    ).not.toBe(binding);
    expect(h.host.productAgentAssignmentBinding(inputOf(task(2)))).not.toBe(
      binding,
    );
  });

  it("matches only the agent that carries the same binding", async () => {
    const h = await build();
    const source = task(1);
    const input = inputOf(source);
    const agent = {
      assignmentBindingSha256: h.host.productAgentAssignmentBinding(input),
      phase: "running" as const,
      workspaceId: WORKSPACE_ID,
      ...NOT_APPLICABLE,
    };
    expect(h.host.productAgentAssignmentMatches(agent, input)).toBe(true);
    expect(
      h.host.productAgentAssignmentMatches(
        agent,
        inputOf(source, { assignmentId: "assignment-2" }),
      ),
    ).toBe(false);
    expect(
      h.host.productAgentAssignmentMatches(
        { ...agent, assignmentBindingSha256: undefined },
        input,
      ),
    ).toBe(false);
  });

  it("summarizes a receipt, defaulting the enforcement and reporting an unobserved child", async () => {
    const h = await build();
    const input = inputOf(task(1));
    const binding = h.host.productAgentAssignmentBinding(input);
    expect(
      h.host.productAgentSummary(input, {
        assignment: assignmentOf(input, "running"),
        parentDelivery: "not_applicable",
        resultRef: null,
        workspaceEnforcement: undefined,
        observation: "unavailable",
      } as never),
    ).toEqual({
      assignmentBindingSha256: binding,
      phase: "running",
      workspaceId: WORKSPACE_ID,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
      observation: "unavailable",
    });
    expect(
      h.host.productAgentSummary(input, {
        assignment: assignmentOf(input, "completed"),
        parentDelivery: "pending",
        resultRef: "result-1",
        workspaceEnforcement: "verified",
        observation: "unavailable",
      } as never),
    ).toEqual({
      assignmentBindingSha256: binding,
      phase: "completed",
      workspaceId: WORKSPACE_ID,
      parentDelivery: "pending",
      workspaceEnforcement: "verified",
      resultAvailable: true,
    });
  });

  it("refuses to summarize a prepared assignment", async () => {
    const h = await build();
    const input = inputOf(task(1));
    expect(() =>
      h.host.productAgentSummary(input, {
        assignment: assignmentOf(input, "prepared"),
        parentDelivery: "not_applicable",
        resultRef: null,
        workspaceEnforcement: "not_applicable",
      } as never),
    ).toThrow("PRODUCT_AGENT_STATE_INVALID");
  });

  it("builds the unknown summary from the input or from the task's own agent", async () => {
    const h = await build();
    const input = inputOf(task(1));
    expect(h.host.productAgentUnknownSummary(input)).toEqual({
      assignmentBindingSha256: h.host.productAgentAssignmentBinding(input),
      phase: "outcome_unknown",
      workspaceId: WORKSPACE_ID,
      ...NOT_APPLICABLE,
    });
    const agent = {
      assignmentBindingSha256: "a".repeat(64),
      phase: "running" as const,
      workspaceId: WORKSPACE_ID,
      parentDelivery: "pending" as const,
      workspaceEnforcement: "verified" as const,
      resultAvailable: true,
    };
    expect(h.host.productAgentUnknownSummaryFromTask(agent)).toEqual({
      assignmentBindingSha256: "a".repeat(64),
      phase: "outcome_unknown",
      workspaceId: WORKSPACE_ID,
      ...NOT_APPLICABLE,
    });
    expect(
      h.host.productAgentUnknownSummaryFromTask({
        ...agent,
        assignmentBindingSha256: undefined,
      }),
    ).toEqual({
      phase: "outcome_unknown",
      workspaceId: WORKSPACE_ID,
      ...NOT_APPLICABLE,
    });
  });

  it("persists, then publishes, and refuses a task that is gone", async () => {
    const h = await build();
    const { source, input } = h.running();
    const summary = h.host.productAgentUnknownSummary(input);
    await expect(
      h.host.persistProductAgentSummary(source.taskId, summary),
    ).resolves.toBe(true);
    expect(h.events).toEqual(["persist", "publish"]);
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    h.events.length = 0;
    await expect(
      h.host.persistProductAgentSummary(randomUUID(), summary),
    ).resolves.toBe(false);
    expect(h.events).toEqual([]);
  });

  it("returns a failed save without publishing it", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.state.persistFails = true;
    await expect(
      h.host.persistProductAgentSummary(
        source.taskId,
        h.host.productAgentUnknownSummary(input),
      ),
    ).rejects.toThrow("PERSIST_FAILED");
    expect(h.events).toEqual(["persist"]);
  });
});

describe("the expiry of a live session", () => {
  async function armed(options: Parameters<typeof build>[0] = {}) {
    const h = await build(options);
    const { source, input } = h.running();
    const session = await h.host.openProductAgentSession(input, h.context(), {
      model: "gpt-6-astra",
    });
    h.events.length = 0;
    const timer = () => h.timers[h.timers.length - 1]!;
    return { h, source, input, session, timer };
  }

  it("arms a timer for the time left, and clears its predecessor", async () => {
    const { h, session, timer } = await armed();
    const first = timer();
    expect(first.delay).toBe(60_000);
    h.state.now = NOW + 20_000;
    h.host.armProductAgentExpiry(session);
    expect(first.cleared).toBe(true);
    expect(timer().delay).toBe(40_000);
    h.host.armProductAgentExpiry(session, 5);
    expect(timer().delay).toBe(5);
    h.state.now = NOW + 90_000;
    h.host.armProductAgentExpiry(session);
    expect(timer().delay).toBe(0);
  });

  it("drops a persisted expiry for the same task only", async () => {
    const { h, source, session } = await armed();
    const stale = { unref: vi.fn(), cleared: false } as unknown as FakeTimer;
    h.state.expiry = { taskId: randomUUID(), timer: stale };
    h.host.armProductAgentExpiry(session);
    expect(stale.cleared).toBe(false);
    expect(h.state.expiry).not.toBeNull();
    h.state.expiry = { taskId: source.taskId, timer: stale };
    h.host.armProductAgentExpiry(session);
    expect(stale.cleared).toBe(true);
    expect(h.state.expiry).toBeNull();
  });

  it("stands down when the session has been replaced", async () => {
    const { h, session, timer } = await armed();
    h.state.session = null;
    timer().callback();
    expect(session.expiryTimer).toBeNull();
    expect(h.timers).toHaveLength(1);
    expect(h.state.cancelled).toEqual([]);
  });

  it("stands down when the task is no longer running", async () => {
    const { h, source, input, session, timer } = await armed();
    h.registry.setAgent(
      source.taskId,
      h.host.productAgentUnknownSummary(input),
    );
    timer().callback();
    expect(h.timers).toHaveLength(1);
    expect(h.state.cancelled).toEqual([]);
    expect(session.expiryTimer).toBeNull();
  });

  it("retries shortly while another mutation is in flight", async () => {
    const { h, timer } = await armed();
    const other = h.gate.tryEnter()!;
    h.state.now = NOW + 1_000;
    timer().callback();
    expect(h.timers).toHaveLength(2);
    expect(timer().delay).toBe(100);
    expect(h.state.cancelled).toEqual([]);
    other.release();
  });

  it("retries at once when the gate is taken between the verdict and the entry", async () => {
    const { h, timer } = await armed();
    vi.spyOn(h.gate, "inFlight").mockReturnValue(false);
    const other = h.gate.tryEnter()!;
    timer().callback();
    expect(timer().delay).toBe(0);
    expect(h.state.cancelled).toEqual([]);
    other.release();
  });

  it("cancels under the gate once it fires, and releases the gate afterwards", async () => {
    const { h, source, input, session, timer } = await armed();
    h.state.cancel = () => ({
      ok: true,
      value: {
        ...receiptOf(input, "cancelled"),
        assignmentRetention: "durable",
      },
    });
    timer().callback();
    expect(h.gate.inFlight()).toBe(true);
    await vi.waitFor(() => expect(h.gate.inFlight()).toBe(false));
    expect(h.state.cancelled).toHaveLength(1);
    expect(h.state.session).toBeNull();
    expect(h.live(source).agent?.phase).toBe("cancelled");
    expect(session.cancellation).toBeNull();
  });
});

describe("the expiry of a persisted assignment", () => {
  it("replaces its own predecessor and records the new timer", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input);
    const first = h.timers[0]!;
    expect(first.delay).toBe(60_000);
    expect(first.unref).toHaveBeenCalledTimes(1);
    expect(h.state.expiry).toEqual({ taskId: source.taskId, timer: first });
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input, 7);
    expect(first.cleared).toBe(true);
    expect(h.timers[1]!.delay).toBe(7);
    expect(h.state.expiry?.timer).toBe(h.timers[1]);
  });

  it("forgets itself when it fires, then cancels the running task under the gate", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.state.settings = null;
    h.state.cancel = () => ({ ok: false });
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input);
    h.state.store = h.store;
    await h.store.save(input);
    h.timers[0]!.callback();
    expect(h.state.expiry).toBeNull();
    expect(h.gate.inFlight()).toBe(true);
    await vi.waitFor(() => expect(h.gate.inFlight()).toBe(false));
    // No host context any more: the assignment is tombstoned, not cancelled.
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("stands down for a task that stopped running", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input);
    h.registry.setAgent(
      source.taskId,
      h.host.productAgentUnknownSummary(input),
    );
    h.timers[0]!.callback();
    expect(h.timers).toHaveLength(1);
    expect(h.gate.inFlight()).toBe(false);
  });

  it("reschedules shortly while a mutation is in flight and at once when the gate is lost", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input);
    const other = h.gate.tryEnter()!;
    h.state.now = NOW + 500;
    h.timers[0]!.callback();
    expect(h.timers[1]!.delay).toBe(100);
    vi.spyOn(h.gate, "inFlight").mockReturnValue(false);
    h.timers[1]!.callback();
    expect(h.timers[2]!.delay).toBe(0);
    other.release();
  });

  it("stands down when the task vanished before it fired", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.host.schedulePersistedProductAgentExpiry(source.taskId, input);
    h.registry.remove(source.taskId);
    h.timers[0]!.callback();
    expect(h.timers).toHaveLength(1);
  });
});

describe("recovering the expiry at startup", () => {
  it("does nothing without a running task or without a store", async () => {
    const none = await build();
    await none.host.recoverProductAgentExpiry();
    expect(none.timers).toEqual([]);
    const h = await build({ withStore: false });
    h.running();
    await h.host.recoverProductAgentExpiry();
    expect(h.timers).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("re-arms a saved input that still describes the running assignment", async () => {
    const h = await build();
    const { source, input } = h.running();
    await h.store.save(input);
    h.state.now = NOW + 10_000;
    await h.host.recoverProductAgentExpiry();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.delay).toBe(50_000);
    expect(h.state.expiry?.taskId).toBe(source.taskId);
  });

  it("re-arms an already expired input without delay", async () => {
    const h = await build();
    const { input } = h.running();
    await h.store.save(input);
    h.state.now = NOW + 120_000;
    await h.host.recoverProductAgentExpiry();
    expect(h.timers[0]!.delay).toBe(0);
  });

  it("marks the assignment unknown for a missing input, and stops there", async () => {
    const h = await build();
    const { source } = h.running();
    await h.host.recoverProductAgentExpiry();
    expect(h.timers).toEqual([]);
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    expect(h.events).toEqual(["persist", "publish"]);
  });

  it("marks the assignment unknown for an input of another assignment", async () => {
    const h = await build();
    const { source, input } = h.running();
    await h.store.save({ ...input, assignmentId: "assignment-2" });
    await h.host.recoverProductAgentExpiry();
    expect(h.timers).toEqual([]);
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("treats a store that cannot be read as a missing input", async () => {
    const h = await build();
    const { source } = h.running();
    vi.spyOn(h.store, "load").mockRejectedValueOnce(new Error("LOAD"));
    await h.host.recoverProductAgentExpiry();
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("swallows a failed save of the unknown summary", async () => {
    const h = await build();
    h.running();
    h.state.persistFails = true;
    await expect(h.host.recoverProductAgentExpiry()).resolves.toBeUndefined();
  });

  it("reads the store again after the awaited load", async () => {
    const h = await build();
    const { input } = h.running();
    await h.store.save(input);
    vi.spyOn(h.store, "load").mockImplementationOnce(async () => {
      h.state.store = null;
      return input;
    });
    await h.host.recoverProductAgentExpiry();
    // The store vanished while the load was pending: nothing is re-armed.
    expect(h.timers).toEqual([]);
    expect(h.live(h.registry.snapshot().tasks[0]!).agent?.phase).toBe(
      "running",
    );
  });
});

describe("cancelling a live session", () => {
  async function live() {
    const h = await build();
    const { source, input } = h.running();
    const session = await h.host.openProductAgentSession(input, h.context(), {
      model: "gpt-6-astra",
    });
    h.events.length = 0;
    return { h, source, input, session };
  }
  const durable = (input: ProductAgentInput, phase: string) => ({
    ok: true,
    value: { ...receiptOf(input, phase), assignmentRetention: "durable" },
  });

  it("cancels, closes and records the cancelled summary", async () => {
    const { h, source, input, session } = await live();
    h.state.cancel = () => durable(input, "cancelled");
    await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual({
      ok: true,
      taskId: source.taskId,
    });
    expect(h.state.cancelled).toEqual([
      {
        assignmentId: input.assignmentId,
        ownerId: "owner-desktop",
        sessionId: input.sessionId,
        taskId: input.taskId,
        taskEpoch: input.taskEpoch,
        generation: input.generation,
      },
    ]);
    expect(h.events).toEqual([
      "cancel-execute",
      "clear",
      "dispose",
      "client-close",
      "session:null",
      "persist",
      "publish",
    ]);
    expect(h.live(source).agent).toMatchObject({ phase: "cancelled" });
    expect(session.cancellation).toBeNull();
  });

  it("shares one cancellation between callers", async () => {
    const { h, input, session } = await live();
    const gate = deferred<void>();
    h.state.cancel = async () => {
      await gate.promise;
      return durable(input, "cancelled");
    };
    const first = h.host.cancelProductAgentSession(session);
    const second = h.host.cancelProductAgentSession(session);
    expect(second).toBe(first);
    gate.resolve();
    await first;
    expect(h.state.cancelled).toHaveLength(1);
  });

  it.each([
    ["completed", "AGENT_CANCEL_RACED_COMPLETION"],
    ["failed", "AGENT_ASSIGNMENT_FAILED"],
    ["running", "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"],
    ["outcome_unknown", "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"],
  ] as const)(
    "reports a cancellation that ended %s as %s",
    async (phase, code) => {
      const { h, source, input, session } = await live();
      h.state.cancel = () => durable(input, phase);
      await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual({
        ok: false,
        error: code,
      });
      expect(h.live(source).agent?.phase).toBe(phase);
    },
  );

  it("records an unknown outcome when the retention was not durable", async () => {
    const { h, source, input, session } = await live();
    h.state.cancel = () => ({
      ok: true,
      value: {
        ...receiptOf(input, "cancelled"),
        assignmentRetention: "memory_only",
      },
    });
    await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"),
    );
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("records an unknown outcome when the host refused to cancel", async () => {
    const { h, source, session } = await live();
    h.state.cancel = () => ({ ok: false });
    await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"),
    );
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    expect(h.state.session).toBeNull();
  });

  it("records an unknown outcome when the client would not close", async () => {
    const { h, source, input, session } = await live();
    h.state.cancel = () => durable(input, "cancelled");
    h.state.clientCloseFails = true;
    await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"),
    );
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("reports a task that is gone and a save that failed", async () => {
    const { h, source, input, session } = await live();
    h.state.cancel = () => durable(input, "cancelled");
    h.registry.remove(source.taskId);
    await expect(h.host.cancelProductAgentSession(session)).resolves.toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
    const again = await live();
    again.h.state.cancel = () => durable(again.input, "cancelled");
    again.h.state.persistFails = true;
    await expect(
      again.h.host.cancelProductAgentSession(again.session),
    ).resolves.toEqual(again.h.failure("TASK_STATE_UNAVAILABLE"));
  });
});

describe("cancelling a task", () => {
  const durable = (input: ProductAgentInput, phase: string) => ({
    ok: true,
    value: { ...receiptOf(input, phase), assignmentRetention: "durable" },
  });

  it("refuses a task that is not running", async () => {
    const h = await build();
    const idle = task(1);
    h.registry.admit(idle);
    await expect(h.host.cancelProductAgentTask(idle)).resolves.toEqual(
      h.failure("TASK_NOT_RUNNING"),
    );
    expect(h.events).toEqual(["failure:TASK_NOT_RUNNING"]);
  });

  it("drops the persisted expiry of this task before anything else", async () => {
    const h = await build();
    const { source, input } = h.running();
    await h.store.save(input);
    const timer = { unref: vi.fn(), cleared: false } as unknown as FakeTimer;
    h.state.expiry = { taskId: source.taskId, timer };
    h.state.settings = null;
    h.state.cancel = () => ({ ok: false });
    await h.host.cancelProductAgentTask(h.live(source));
    expect(timer.cleared).toBe(true);
    expect(h.state.expiry).toBeNull();
    expect(h.events.slice(0, 2)).toEqual(["clear", "expiry:null"]);
  });

  it("refuses while a session of another task is live", async () => {
    const h = await build();
    const { source } = h.running(1);
    const other = h.running(2);
    h.state.session = fakeSession(other.input);
    await expect(
      h.host.cancelProductAgentTask(h.live(source)),
    ).resolves.toEqual(h.failure("AGENT_ALREADY_RUNNING"));
    expect(h.state.cancelled).toEqual([]);
  });

  it("cancels the live session of this task", async () => {
    const h = await build();
    const { source, input } = h.running();
    await h.host.openProductAgentSession(input, h.context(), {
      model: "gpt-6-astra",
    });
    h.state.cancel = () => durable(input, "cancelled");
    await expect(
      h.host.cancelProductAgentTask(h.live(source)),
    ).resolves.toEqual({ ok: true, taskId: source.taskId });
    expect(h.live(source).agent?.phase).toBe("cancelled");
  });

  it("closes the live session of another assignment and records it unknown", async () => {
    const h = await build();
    const { source } = h.running();
    const session = await h.host.openProductAgentSession(
      inputOf(source, { assignmentId: "assignment-2" }),
      h.context(),
      { model: "gpt-6-astra" },
    );
    await expect(
      h.host.cancelProductAgentTask(h.live(source)),
    ).resolves.toEqual(h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    expect(session.host.dispose).toHaveBeenCalledTimes(1);
    expect(h.state.session).toBeNull();
    expect(h.state.cancelled).toEqual([]);
  });

  it("reads the live session again after the awaited save", async () => {
    const h = await build();
    const { source } = h.running();
    await h.host.openProductAgentSession(
      inputOf(source, { assignmentId: "assignment-2" }),
      h.context(),
      { model: "gpt-6-astra" },
    );
    const replacement = fakeSession(inputOf(source, { assignmentId: "x" }));
    h.state.onPersist = () => {
      h.state.session = replacement;
    };
    await h.host.cancelProductAgentTask(h.live(source));
    // The slot changed hands while the save was pending: the one read
    // afterwards is the one that is closed.
    expect(replacement.host.dispose).toHaveBeenCalledTimes(1);
    expect(replacement.client.close).toHaveBeenCalledTimes(1);
  });

  describe("without a live session", () => {
    it("records an unknown outcome when the saved input cannot be loaded", async () => {
      const h = await build();
      const { source } = h.running();
      vi.spyOn(h.store, "load").mockRejectedValueOnce(new Error("LOAD"));
      await expect(
        h.host.cancelProductAgentTask(h.live(source)),
      ).resolves.toEqual(h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
      expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    });

    it("records an unknown outcome for a missing input, an absent store or another assignment", async () => {
      const missing = await build();
      const a = missing.running();
      await expect(
        missing.host.cancelProductAgentTask(missing.live(a.source)),
      ).resolves.toEqual(missing.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
      expect(missing.live(a.source).agent?.phase).toBe("outcome_unknown");

      const bare = await build({ withStore: false });
      const b = bare.running();
      await expect(
        bare.host.cancelProductAgentTask(bare.live(b.source)),
      ).resolves.toEqual(bare.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));

      const other = await build();
      const c = other.running();
      await other.store.save({ ...c.input, assignmentId: "assignment-2" });
      await expect(
        other.host.cancelProductAgentTask(other.live(c.source)),
      ).resolves.toEqual(other.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
      expect(other.live(c.source).agent?.phase).toBe("outcome_unknown");
    });

    it("tombstones the assignment through a host that refuses everything when no context is left", async () => {
      const h = await build();
      const { source, input } = h.running();
      await h.store.save(input);
      h.state.settings = null;
      h.state.cancel = () => ({ ok: false });
      await expect(
        h.host.cancelProductAgentTask(h.live(source)),
      ).resolves.toEqual(h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
      expect(h.state.cancelled).toHaveLength(1);
      expect(h.stores).toEqual([{ root: ASSIGNMENTS_ROOT }]);
      const refusing = h.cancelHosts[0] as {
        spawn(): Promise<never>;
        wait(): Promise<never>;
        cancel(): Promise<never>;
      };
      for (const call of [refusing.spawn, refusing.wait, refusing.cancel])
        await expect(call()).rejects.toThrow("PRODUCT_AGENT_HOST_UNAVAILABLE");
      expect(h.live(source).agent?.phase).toBe("outcome_unknown");
      expect(h.state.launched).toEqual([]);
    });

    it("tombstones it too when the session cannot be opened", async () => {
      const h = await build();
      const { source, input } = h.running();
      await h.store.save(input);
      h.state.probe = { ...h.state.probe, version: "2.0.0" };
      h.state.cancel = () => ({ ok: false });
      await expect(
        h.host.cancelProductAgentTask(h.live(source)),
      ).resolves.toEqual(h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"));
      expect(h.state.launched).toEqual([]);
      expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    });

    it("opens the legacy cleanup route without an expiry, then cancels", async () => {
      const h = await build();
      const { source, input } = h.running();
      await h.store.save(input);
      h.state.cancel = () => durable(input, "cancelled");
      await expect(
        h.host.cancelProductAgentTask(h.live(source)),
      ).resolves.toEqual({ ok: true, taskId: source.taskId });
      expect(h.hosts[0]!.options).toMatchObject({ model: "gpt-6-astra" });
      expect(h.hosts[0]!.options).not.toHaveProperty("effort");
      expect(h.timers).toEqual([]);
      expect(h.live(source).agent?.phase).toBe("cancelled");
    });
  });
});

describe("running an assignment", () => {
  const completed = (input: ProductAgentInput) =>
    receiptOf(input, "completed", {
      resultRef: "result-1",
      parentDelivery: "pending",
    });
  async function ready() {
    const h = await build();
    const { source, input } = h.running();
    h.state.run = () => ({ ok: true, value: receiptOf(input, "running") });
    return { h, source, input };
  }
  const execute = (
    h: Awaited<ReturnType<typeof build>>,
    source: ProductTask,
    input: ProductAgentInput,
    admission: "new" | "rejoin" = "new",
  ) =>
    h.host.executeProductAgent(h.live(source), input, h.context(), admission);

  it("refuses without a qualified route or against a context the input no longer matches", async () => {
    const none = await build({ route: () => null });
    const a = none.running();
    await expect(execute(none, a.source, a.input)).resolves.toEqual(
      none.failure("AGENT_NOT_READY"),
    );
    expect(none.events.filter((event) => event === "probe")).toEqual([]);

    const stale = await build();
    const b = stale.running();
    await expect(
      execute(stale, b.source, inputOf(b.source, { computerGeneration: 99 })),
    ).resolves.toEqual(stale.failure("AGENT_NOT_READY"));
    expect(stale.state.launched).toEqual([]);
  });

  it("keeps a running assignment open and records its summary", async () => {
    const { h, source, input } = await ready();
    await expect(execute(h, source, input)).resolves.toEqual({
      ok: true,
      taskId: source.taskId,
    });
    expect(h.live(source).agent).toMatchObject({ phase: "running" });
    expect(h.state.session).not.toBeNull();
    expect(h.state.acknowledged).toEqual([]);
    expect(h.hosts[0]!.options).toMatchObject({
      model: "gpt-6-chatgpt",
      effort: "low",
    });
  });

  it("runs the assignment with the settings, the host, the assignments, the clock and the admission", async () => {
    const { h, source, input } = await ready();
    const run = vi.fn(h.state.run!);
    h.state.run = run;
    await execute(h, source, input, "rejoin");
    const [settings, target, given, dependencies, admission] = run.mock
      .calls[0] as unknown[] as [
      ProductSettings,
      ProductTask,
      ProductAgentInput,
      { host: unknown; assignments: unknown; now: () => number },
      string,
    ];
    expect(settings).toBe(h.state.settings);
    expect(target.taskId).toBe(source.taskId);
    expect(given).toBe(input);
    expect(dependencies.host).toBe(h.state.session?.host);
    expect(dependencies.assignments).toBe(h.state.session?.assignments);
    expect(dependencies.now()).toBe(NOW);
    expect(admission).toBe("rejoin");
  });

  it("records a busy open of a new start as failed", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.state.session = fakeSession(inputOf(task(9)));
    await expect(execute(h, source, input, "new")).resolves.toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
    expect(h.live(source).agent?.phase).toBe("failed");
  });

  it("records a busy open of a rejoin as nothing at all", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.state.session = fakeSession(inputOf(task(9)));
    await expect(execute(h, source, input, "rejoin")).resolves.toEqual(
      h.failure("AGENT_ALREADY_RUNNING"),
    );
    expect(h.live(source).agent?.phase).toBe("running");
    expect(h.events).not.toContain("persist");
  });

  it("records a rejoin whose host changed as an unknown outcome", async () => {
    const h = await build();
    const { source, input } = h.running();
    h.state.probe = { ...h.state.probe, version: "2.0.0" };
    await expect(execute(h, source, input, "rejoin")).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"),
    );
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
  });

  it("records a run that threw as an unknown outcome and closes the session", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => {
      throw new Error("RUN_THREW");
    };
    await expect(execute(h, source, input)).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"),
    );
    expect(h.live(source).agent?.phase).toBe("outcome_unknown");
    expect(h.hosts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.state.session).toBeNull();
  });

  it("records a refused start as failed and a refused rejoin as unknown", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => ({
      ok: false,
      error: { code: "AGENT_AUTHORITY_DENIED" },
    });
    await expect(execute(h, source, input)).resolves.toEqual(
      h.failure("AGENT_ASSIGNMENT_FAILED"),
    );
    expect(h.live(source).agent?.phase).toBe("failed");
    expect(h.state.session).toBeNull();

    const again = await ready();
    again.h.state.run = () => ({ ok: false });
    await expect(
      execute(again.h, again.source, again.input, "rejoin"),
    ).resolves.toEqual(again.h.failure("AGENT_REJOIN_UNAVAILABLE"));
    expect(again.h.live(again.source).agent?.phase).toBe("outcome_unknown");
  });

  it("closes the session and reports a task that disappeared", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => {
      h.registry.remove(source.taskId);
      return { ok: true, value: receiptOf(input, "running") };
    };
    await expect(execute(h, source, input)).resolves.toEqual(
      h.failure("TASK_NOT_FOUND"),
    );
    expect(h.hosts[0]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports an unsaved summary without closing the session", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => {
      h.state.persistFails = true;
      return { ok: true, value: receiptOf(input, "running") };
    };
    await expect(execute(h, source, input)).resolves.toEqual(
      h.failure("TASK_STATE_UNAVAILABLE"),
    );
    expect(h.hosts[0]!.dispose).not.toHaveBeenCalled();
    expect(h.state.session).not.toBeNull();
  });

  it.each([
    ["outcome_unknown", null, "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN"],
    ["failed", "result-1", "AGENT_ASSIGNMENT_FAILED"],
    ["completed", null, "AGENT_ASSIGNMENT_FAILED"],
  ] as const)(
    "closes the session for a %s receipt with result %s and reports %s",
    async (phase, resultRef, code) => {
      const { h, source, input } = await ready();
      h.state.run = () => ({
        ok: true,
        value: receiptOf(input, phase, { resultRef }),
      });
      await expect(execute(h, source, input)).resolves.toEqual(h.failure(code));
      expect(h.hosts[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(h.state.acknowledged).toEqual([]);
    },
  );

  it("acknowledges a completed result with the exact correlation and records the delivery", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => ({ ok: true, value: completed(input) });
    h.state.acknowledge = () => ({
      ok: true,
      value: { parentDelivery: "acknowledged" },
    });
    await expect(execute(h, source, input)).resolves.toEqual({
      ok: true,
      taskId: source.taskId,
    });
    expect(h.state.acknowledged).toEqual([
      {
        correlation: {
          assignmentId: input.assignmentId,
          ownerId: "owner-desktop",
          sessionId: input.sessionId,
          taskId: input.taskId,
          taskEpoch: input.taskEpoch,
          generation: input.generation,
          authorityId: input.authorityId,
          participantId: input.agentParticipantId,
          role: "agent",
          parentThreadId: "parent-thread",
          childId: "child-thread",
          parentTurnId: "parent-turn",
          childTurnId: "child-turn",
          hostRole: "worker",
          delegationDigest: "d".repeat(64),
        },
        parentParticipantId: input.parentParticipantId,
        resultRef: "result-1",
      },
    ]);
    expect(h.live(source).agent).toMatchObject({
      phase: "completed",
      parentDelivery: "acknowledged",
      resultAvailable: true,
    });
    expect(h.hosts[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf("dispose")).toBeLessThan(
      h.events.indexOf("acknowledge"),
    );
  });

  it("reports a refused acknowledgement and a delivery that could not be saved", async () => {
    const { h, source, input } = await ready();
    h.state.run = () => ({ ok: true, value: completed(input) });
    h.state.acknowledge = () => ({ ok: false });
    await expect(execute(h, source, input)).resolves.toEqual(
      h.failure("AGENT_DELIVERY_FAILED"),
    );
    expect(h.live(source).agent).toMatchObject({ parentDelivery: "pending" });

    const saved = await ready();
    saved.h.state.run = () => ({ ok: true, value: completed(saved.input) });
    saved.h.state.acknowledge = () => {
      saved.h.state.persistFails = true;
      return { ok: true, value: { parentDelivery: "acknowledged" } };
    };
    await expect(execute(saved.h, saved.source, saved.input)).resolves.toEqual(
      saved.h.failure("AGENT_DELIVERY_FAILED"),
    );
  });
});
