import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import {
  PrivateProductAgentStore,
  ProductAgentInputSchema,
  type ProductAgentInput,
} from "../../src/apps/desktop/product-agent-store";
import type { ProductTaskAgent } from "../../src/modules/chat/contract/product-task";
import { admitProductAgentRejoin } from "../../src/apps/desktop/product-agent-rejoin";

// S35-TA-11. Rejoining a native Product Agent reads two things: the durable
// input (awaited) and the configuration (synchronous). WHICH ORDER is the
// entire security content of this branch, and until this module existed it
// could not be tested, because the branch lived in `main.ts`.
//
// The contract: the settings are read AFTER the load resolves. If the world
// moves while the load is in flight, the rejoin is refused. Sampling before
// the await would compare a stored input against a world that still matched
// it and admit the rejoin into a configuration that has since changed.
//
// `readSettings` is a thunk precisely so a test can change what it returns
// while the load is pending — the interleaving below is real, not simulated:
// `loadInput` does not resolve until the test has already moved the world.

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/approved";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";
const EXECUTABLE_SHA = "1".repeat(64);
const ROTATED_EXECUTABLE_SHA = "2".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const DELEGATION_DIGEST = "7".repeat(64);
const PARENT_THREAD_SHA = "8".repeat(64);
const CHILD_THREAD_SHA = "9".repeat(64);

const STORE = new PrivateProductAgentStore({
  root: "/tmp/product-agent-rejoin-test-fixture",
});

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

function codexHostOf(executableSha256 = EXECUTABLE_SHA) {
  return {
    executablePath: "/usr/local/bin/codex",
    executableSha256,
    version: "1.0.0",
    protocol: "codex-app-server/v2" as const,
    schemaSha256: SCHEMA_SHA,
    verifiedAt: TIMESTAMP,
    liveVerification: {
      model: "gpt-6-astra" as const,
      executableSha256,
      schemaSha256: SCHEMA_SHA,
      buildId: BUILD_ID,
      dynamicTool: "farol_ping" as const,
      verifiedAt: TIMESTAMP,
    },
    agentVerification: {
      model: "gpt-6-astra" as const,
      executableSha256,
      schemaSha256: SCHEMA_SHA,
      buildId: BUILD_ID,
      workspaceId: WORKSPACE_ID,
      computerGeneration: GENERATION,
      transport: "codex-native-agent/spawn-prompt-sha256-v1" as const,
      authorityRole: "agent" as const,
      hostRole: null,
      delegationDigest: DELEGATION_DIGEST,
      parentThreadSha256: PARENT_THREAD_SHA,
      childThreadSha256: CHILD_THREAD_SHA,
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
  };
}

/** Settings that match the stored input below in every respect. */
function settingsOf(
  options: Readonly<{
    generation?: number;
    executableSha256?: string;
    workspaceId?: string;
  }> = {},
): ProductSettings {
  const generation = options.generation ?? GENERATION;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: COMPUTER_ID,
      generation,
      name: "This Mac",
      workspaces: [
        {
          workspaceId,
          root: ROOT,
          label: "Primary",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    nativeHosts: {
      generation: 1,
      codex: codexHostOf(options.executableSha256),
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
          configRevision: generation,
          workspaceId,
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

function inputOf(
  overrides: Partial<ProductAgentInput> = {},
): ProductAgentInput {
  return ProductAgentInputSchema.parse({
    taskId: "task-1",
    sessionId: "session-1",
    assignmentId: "assignment-1",
    authorityId: "authority-1",
    parentParticipantId: "main-1",
    agentParticipantId: "agent-1",
    taskEpoch: 0,
    generation: 1,
    workspaceId: WORKSPACE_ID,
    scope: { mode: "subtree", root: ROOT },
    excludedPaths: [],
    objective: "Find the delegated continuity marker and report its path.",
    computerGeneration: GENERATION,
    executableSha256: EXECUTABLE_SHA,
    schemaSha256: SCHEMA_SHA,
    buildId: BUILD_ID,
    expiresAt: 10_000_000,
    createdAt: TIMESTAMP,
    ...overrides,
  });
}

function runningAgent(): ProductTaskAgent {
  return {
    assignmentBindingSha256: "a".repeat(64),
    phase: "running",
    workspaceId: WORKSPACE_ID,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "verified",
    resultAvailable: false,
  } as ProductTaskAgent;
}

/**
 * A load that stays pending until the test releases it, so the world can be
 * moved while it is in flight. This is what makes the ordering observable
 * rather than asserted.
 */
function pendingLoad(input: ProductAgentInput) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    loadInput: async () => {
      await gate;
      return input;
    },
  };
}

function request(
  overrides: Partial<Parameters<typeof admitProductAgentRejoin>[0]> = {},
) {
  return {
    agent: runningAgent(),
    loadInput: async () => inputOf(),
    readSettings: () => settingsOf(),
    store: STORE,
    buildId: BUILD_ID,
    assignmentMatches: () => true,
    ...overrides,
  };
}

describe("product agent rejoin admission", () => {
  it("S35-TA-11 reads the settings AFTER the load resolves, not before", async () => {
    // The order is recorded, not inferred: `readSettings` must not have run
    // while the load was still pending.
    const order: string[] = [];
    const { release, loadInput } = pendingLoad(inputOf());
    const pending = admitProductAgentRejoin(
      request({
        loadInput: async () => {
          order.push("load-start");
          const value = await loadInput();
          order.push("load-end");
          return value;
        },
        readSettings: () => {
          order.push("read-settings");
          return settingsOf();
        },
      }),
    );
    await Promise.resolve();
    expect(order).toEqual(["load-start"]);
    release();
    await pending;
    expect(order).toEqual(["load-start", "load-end", "read-settings"]);
  });

  // The world moves while the load is in flight. Each row is a real
  // interleaving: the load resolves only after `readSettings` has begun
  // returning the moved world, so a pre-await sample would have used the
  // old one and admitted the rejoin.
  const moved: ReadonlyArray<
    Readonly<{ name: string; after: () => ProductSettings }>
  > = [
    {
      name: "the Computer generation advances",
      after: () => settingsOf({ generation: GENERATION + 1 }),
    },
    {
      name: "the verified host's executable is rotated",
      after: () => settingsOf({ executableSha256: ROTATED_EXECUTABLE_SHA }),
    },
    {
      name: "the workspace leaves settings",
      after: () => settingsOf({ workspaceId: OTHER_WORKSPACE_ID }),
    },
  ];

  for (const row of moved) {
    it(`S35-TA-11 refuses with AGENT_NOT_READY when ${row.name} while the input is loading`, async () => {
      const { release, loadInput } = pendingLoad(inputOf());
      let world = settingsOf();
      const outcome = admitProductAgentRejoin(
        request({ loadInput, readSettings: () => world }),
      );
      // The move happens while the load is still pending.
      world = row.after();
      release();
      await expect(outcome).resolves.toEqual({
        ok: false,
        refusal: "AGENT_NOT_READY",
      });
    });
  }

  it("S35-TA-11 control: an unchanged world admits the rejoin with the loaded input", async () => {
    const { release, loadInput } = pendingLoad(inputOf());
    const outcome = admitProductAgentRejoin(request({ loadInput }));
    release();
    const admitted = await outcome;
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.input.taskId).toBe("task-1");
    expect(admitted.context.settings.computer.generation).toBe(GENERATION);
  });

  it("S35-TA-11 a world that moves and moves back still admits, because the check is on the final state", async () => {
    // Guards against a test that would pass for the wrong reason: the
    // refusal must come from what the settings SAY at the read, not from
    // the mere fact that something changed.
    const { release, loadInput } = pendingLoad(inputOf());
    let world = settingsOf();
    const outcome = admitProductAgentRejoin(
      request({ loadInput, readSettings: () => world }),
    );
    world = settingsOf({ generation: GENERATION + 1 });
    world = settingsOf();
    release();
    expect((await outcome).ok).toBe(true);
  });

  const refusals: ReadonlyArray<
    Readonly<{
      name: string;
      overrides: Partial<Parameters<typeof admitProductAgentRejoin>[0]>;
      refusal: string;
      unknownSummary?: true;
    }>
  > = [
    {
      name: "the task has no agent at all",
      overrides: { agent: undefined },
      refusal: "AGENT_REJOIN_UNAVAILABLE",
    },
    {
      name: "the agent is cancelled, so there is nothing to rejoin",
      overrides: { agent: { ...runningAgent(), phase: "cancelled" } },
      refusal: "AGENT_REJOIN_UNAVAILABLE",
    },
    {
      name: "the agent completed and the parent already took the result",
      overrides: {
        agent: {
          ...runningAgent(),
          phase: "completed",
          parentDelivery: "acknowledged",
          resultAvailable: false,
        },
      },
      refusal: "AGENT_REJOIN_UNAVAILABLE",
    },
    {
      name: "no stored input exists",
      overrides: { loadInput: async () => null },
      refusal: "AGENT_REJOIN_UNAVAILABLE",
    },
    {
      name: "the store throws",
      overrides: {
        loadInput: async () => {
          throw new Error("EIO");
        },
      },
      refusal: "AGENT_INPUT_STATE_UNAVAILABLE",
    },
    {
      name: "the stored input is not the one this agent was started with",
      overrides: { assignmentMatches: () => false },
      refusal: "AGENT_REJOIN_UNAVAILABLE",
      unknownSummary: true,
    },
    {
      name: "the configuration is not ready",
      overrides: { readSettings: () => null },
      refusal: "AGENT_NOT_READY",
    },
    {
      name: "no durable input store exists",
      overrides: { store: null },
      refusal: "AGENT_NOT_READY",
    },
  ];

  for (const row of refusals) {
    it(`S35-TA-11 refuses when ${row.name}`, async () => {
      const outcome = await admitProductAgentRejoin(request(row.overrides));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toBe(row.refusal);
      // Only the binding mismatch makes the caller record an unknown
      // summary; a refusal that never reached the input must not.
      expect(outcome.recordUnknownSummary).toBe(row.unknownSummary);
    });
  }

  // The start branch's OPPOSITE ordering, pinned so the two cannot be
  // "made consistent" by someone who reads only one of them. It samples
  // BEFORE its await, and that is correct: there the context CONSTRUCTS the
  // input (`productAgentInput(task, context, …)` cannot run without it), so
  // it must precede. Here the input already exists and the context
  // VALIDATES it, so it is read as late as possible. A constructor reads
  // before it builds; a validator reads the freshest world it can.
  //
  // This has to read `main.ts` as source: the start branch is still inline
  // in a file that exports nothing and that no test loads — the same reason
  // the rejoin branch moved out. It guards the ordering's presence, not its
  // runtime behaviour, which the cases above cover for the extracted half.
  it("S35-TA-11 the start branch still samples its snapshot before its own await", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../../src/apps/desktop/main.ts"),
      "utf8",
    );
    const sample = source.indexOf("const startAgentSnapshot = configuration");
    const save = source.indexOf("await productAgentStore!.save(input)");
    expect(sample).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(-1);
    expect(sample).toBeLessThan(save);

    // And the rejoin branch no longer samples inline at all: it hands
    // `readSettings` to the module, which decides when to call it.
    expect(source).toContain("admitProductAgentRejoin({");
    expect(source).not.toContain("const rejoinAgentSnapshot");
  });

  it("S35-TA-11 a completed agent whose result the parent has not taken is still rejoinable", async () => {
    const outcome = await admitProductAgentRejoin(
      request({
        agent: {
          ...runningAgent(),
          phase: "completed",
          parentDelivery: "pending",
          resultAvailable: true,
        },
      }),
    );
    expect(outcome.ok).toBe(true);
  });
});
