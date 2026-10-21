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
import {
  productAgentContext,
  productAgentHostContext,
  productAgentInputMatchesContext,
} from "../../src/apps/desktop/product-agent-context";
import {
  productAgentSessionExpiryVerdict,
  persistedProductAgentExpiryVerdict,
  productAgentExpiryRecoveryVerdict,
} from "../../src/apps/desktop/product-agent-expiry";

// `product-agent-context.test.ts` and `product-agent-expiry.test.ts` each
// prove their module answers correctly for ONE state, taken in isolation.
// Neither proves the OPERATION is safe as the world moves through a
// SEQUENCE of states: a restart, a gap between two decisions, concurrent
// entry, an absent previous state, and precedence among simultaneously-true
// refusal conditions. This file is that missing layer.
//
// SCOPE ACTUALLY COVERED HERE, AND WHY: at this worktree's pinned base
// (42e8420a1e8302f922cfd4a2c414322b16be908a), `product-agent-expiry.ts` and
// its test file do not exist in the source tree at all — they land one
// commit later, on `stage-35-track-a` (41f82093) and on
// `stage-35-track-a-expiry` (c68ef0ae). `vnext/src/**` is read-only for
// this task and this branch must not be rebased, merged, or cherry-picked
// to pull them in. So:
//
//   - Sequence 1 (restart) and Sequence 2 (the world moves between two
//     decisions) are implemented IN FULL using only
//     `product-agent-context.ts` — both fit entirely inside that module's
//     own two-call contract (`productAgentContext` at "start",
//     `productAgentInputMatchesContext` immediately before "resume/run").
//   - Sequence 3 (cancellation / absent previous state) and Sequence 4
//     (concurrent entry) are inherently about
//     `productAgentExpiryRecoveryVerdict` and
//     `productAgentSessionExpiryVerdict`, which do not exist here. They are
//     left as explicit `describe.skip` blocks below, naming exactly what
//     each `it` would assert, rather than silently missing.
//   - Sequence 5 (precedence) is likewise skipped: `productAgentContext`
//     and `productAgentHostContext` fold every failing condition into the
//     same closed `null` with no distinguishable reason, so there is no
//     "which reason wins" question to ask of them — that question only
//     exists once a verdict carries a `reason` field, which only
//     `product-agent-expiry.ts` does.
//
// None of the missing coverage is faked with a local reimplementation of
// the expiry decision. Both extraction commits' own docstrings record that
// an independent review already rejected exactly that shape of test — a
// replica proves only that the replica agrees with itself, not that the
// production function is correct.

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/approved";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";

const EXECUTABLE_SHA = "1".repeat(64);
const SWAPPED_EXECUTABLE_SHA = "2".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const DELEGATION_DIGEST = "7".repeat(64);
const PARENT_THREAD_SHA = "8".repeat(64);
const CHILD_THREAD_SHA = "9".repeat(64);

/** A fixed instant used by sequences 3-5's expiry-decision tables below. */
const NOW = 1_000_000;

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

type LiveOverrides = Readonly<{
  executableSha256?: string;
  schemaSha256?: string;
  buildId?: string;
}>;

type AgentOverrides = Readonly<{
  executableSha256?: string;
  schemaSha256?: string;
  buildId?: string;
  workspaceId?: string;
  computerGeneration?: number;
  workspaceEnforcement?: "verified" | "not_verified";
}>;

/** A real, schema-validated Codex host selection. */
function codexHostOf(
  options: Readonly<{
    executableSha256?: string;
    schemaSha256?: string;
    live?: LiveOverrides | null;
    agent?: AgentOverrides | null;
  }> = {},
) {
  return {
    executablePath: "/usr/local/bin/codex",
    executableSha256: options.executableSha256 ?? EXECUTABLE_SHA,
    version: "1.0.0",
    protocol: "codex-app-server/v2" as const,
    schemaSha256: options.schemaSha256 ?? SCHEMA_SHA,
    verifiedAt: TIMESTAMP,
    liveVerification:
      options.live === null
        ? null
        : {
            model: "gpt-6-astra" as const,
            executableSha256: options.executableSha256 ?? EXECUTABLE_SHA,
            schemaSha256: options.schemaSha256 ?? SCHEMA_SHA,
            buildId: BUILD_ID,
            dynamicTool: "farol_ping" as const,
            verifiedAt: TIMESTAMP,
            ...options.live,
          },
    agentVerification:
      options.agent === null
        ? null
        : {
            model: "gpt-6-astra" as const,
            executableSha256: options.executableSha256 ?? EXECUTABLE_SHA,
            schemaSha256: options.schemaSha256 ?? SCHEMA_SHA,
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
            ...options.agent,
          },
  };
}

type ComputerVerifiedOverrides = Readonly<{
  workspaceId: string | null;
  configRevision: number;
  buildId?: string;
}> | null;

/**
 * Settings parsed by the real schema. Every option defaults to a fully
 * fresh, matching state, so a test only names the one thing it moves.
 */
function settingsOf(
  options: Readonly<{
    workspaces?: readonly Record<string, unknown>[];
    generation?: number;
    codex?: ReturnType<typeof codexHostOf> | null;
    computerVerified?: ComputerVerifiedOverrides;
    reachable?: "unknown" | "reachable" | "unreachable";
    outcomeUnknown?: boolean;
  }> = {},
): ProductSettings {
  const generation = options.generation ?? GENERATION;
  const computerVerified: ComputerVerifiedOverrides =
    "computerVerified" in options
      ? (options.computerVerified as ComputerVerifiedOverrides)
      : { workspaceId: WORKSPACE_ID, configRevision: generation };
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
      workspaces: options.workspaces ?? [
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
      codex: "codex" in options ? options.codex : codexHostOf(),
    },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: {
        ...readiness(),
        reachable: options.reachable ?? "reachable",
        outcomeUnknown: options.outcomeUnknown ?? false,
        verified:
          computerVerified === null
            ? null
            : {
                profile: "farol",
                configRevision: computerVerified.configRevision,
                workspaceId: computerVerified.workspaceId,
                runtimeGeneration: "next-1",
                buildId: computerVerified.buildId ?? BUILD_ID,
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

/** A real, schema-validated Product Agent input, matching `settingsOf()`. */
function productAgentInputOf(
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

/**
 * Round-trips a value through JSON, then the real schema, so the result has
 * no object identity in common with its input — "values re-read from what
 * would have been persisted", not merely a second reference to the same
 * fixture.
 */
function restartedSettings(settings: ProductSettings): ProductSettings {
  return ProductSettingsSchema.parse(
    JSON.parse(JSON.stringify(settings)) as Record<string, unknown>,
  );
}

function restartedInput(input: ProductAgentInput): ProductAgentInput {
  return ProductAgentInputSchema.parse(
    JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
  );
}

/** A fresh store instance per call, standing in for "new objects" after a restart. */
function freshStore(label: string): PrivateProductAgentStore {
  return new PrivateProductAgentStore({
    root: `/tmp/product-agent-lifecycle-test-fixture-${label}`,
  });
}

describe("sequence 1: a restart rebuilds the same state and must reach the same verdict", () => {
  // Freshness-gate half of the pair only (see header comment for why): this
  // proves restart stability for all three `product-agent-context.ts`
  // exports, not the full cross-module pair the sequence is named for.

  const rows = [
    {
      name: "a fresh, matching workspace",
      settings: () => settingsOf(),
      expectNonNull: true,
    },
    {
      name: "a swapped executable (live verification stale)",
      settings: () =>
        settingsOf({
          codex: codexHostOf({
            live: { executableSha256: SWAPPED_EXECUTABLE_SHA },
          }),
        }),
      expectNonNull: false,
    },
    {
      name: "the Computer generation advanced past the agent verification",
      settings: () =>
        settingsOf({
          codex: codexHostOf({
            agent: { computerGeneration: GENERATION - 1 },
          }),
        }),
      expectNonNull: false,
    },
  ] as const;

  for (const row of rows) {
    it(`productAgentContext: ${row.name} -> the same verdict before and after a restart`, () => {
      const preQuit = row.settings();
      const rebuilt = restartedSettings(preQuit);

      const before = productAgentContext(
        WORKSPACE_ID,
        preQuit,
        freshStore(`${row.name}-pre`),
        BUILD_ID,
      );
      const after = productAgentContext(
        WORKSPACE_ID,
        rebuilt,
        freshStore(`${row.name}-post`),
        BUILD_ID,
      );

      if (row.expectNonNull) {
        expect(before).not.toBeNull();
      } else {
        expect(before).toBeNull();
      }
      expect(after).toEqual(before);
    });
  }

  it("productAgentHostContext reaches the same host context before and after a restart", () => {
    const preQuitSettings = settingsOf();
    const rebuiltSettings = restartedSettings(preQuitSettings);
    const preQuitInput = productAgentInputOf();
    const rebuiltInput = restartedInput(preQuitInput);

    const before = productAgentHostContext(
      preQuitInput,
      preQuitSettings,
      BUILD_ID,
    );
    const after = productAgentHostContext(
      rebuiltInput,
      rebuiltSettings,
      BUILD_ID,
    );

    expect(before).not.toBeNull();
    expect(after).toEqual(before);
  });

  it("productAgentInputMatchesContext agrees before and after a restart when the input still matches", () => {
    const preQuitSettings = settingsOf();
    const rebuiltSettings = restartedSettings(preQuitSettings);
    const preQuitContext = productAgentContext(
      WORKSPACE_ID,
      preQuitSettings,
      freshStore("match-pre"),
      BUILD_ID,
    );
    const rebuiltContext = productAgentContext(
      WORKSPACE_ID,
      rebuiltSettings,
      freshStore("match-post"),
      BUILD_ID,
    );
    if (!preQuitContext || !rebuiltContext) {
      throw new Error("test fixture invalid: expected a fresh context");
    }

    const preQuitInput = productAgentInputOf();
    const rebuiltInput = restartedInput(preQuitInput);

    expect(
      productAgentInputMatchesContext(preQuitInput, preQuitContext, BUILD_ID),
    ).toBe(true);
    expect(
      productAgentInputMatchesContext(rebuiltInput, rebuiltContext, BUILD_ID),
    ).toBe(true);
  });

  it("productAgentInputMatchesContext agrees before and after a restart when the input is stale", () => {
    const preQuitSettings = settingsOf();
    const rebuiltSettings = restartedSettings(preQuitSettings);
    const preQuitContext = productAgentContext(
      WORKSPACE_ID,
      preQuitSettings,
      freshStore("stale-pre"),
      BUILD_ID,
    );
    const rebuiltContext = productAgentContext(
      WORKSPACE_ID,
      rebuiltSettings,
      freshStore("stale-post"),
      BUILD_ID,
    );
    if (!preQuitContext || !rebuiltContext) {
      throw new Error("test fixture invalid: expected a fresh context");
    }

    const preQuitInput = productAgentInputOf({
      executableSha256: SWAPPED_EXECUTABLE_SHA,
    });
    const rebuiltInput = restartedInput(preQuitInput);

    expect(
      productAgentInputMatchesContext(preQuitInput, preQuitContext, BUILD_ID),
    ).toBe(false);
    expect(
      productAgentInputMatchesContext(rebuiltInput, rebuiltContext, BUILD_ID),
    ).toBe(false);
  });
});

describe("sequence 2: the world moves between the two decisions", () => {
  // Each case takes the shape a real call site uses: `productAgentContext`
  // at "start" (decision A), then — immediately before resuming or running
  // a turn, once the world may have moved — `productAgentContext` again
  // against the CURRENT settings, followed by `productAgentInputMatchesContext`
  // checking the SAVED input against that current context (decision B).
  // Both calls are individually correct against their own moment; the point
  // of this sequence is that the input crossing the gap must be refused
  // even when the post-move settings are, on their own, fresh again.

  const ROTATED_EXECUTABLE_SHA = "a".repeat(64);
  const ADVANCED_GENERATION = GENERATION + 1;

  /** The second decision a real caller takes: context, then input-match. */
  function secondDecisionRefuses(
    settingsAfterMove: ProductSettings,
    input: ProductAgentInput,
  ): boolean {
    const contextAfterMove = productAgentContext(
      WORKSPACE_ID,
      settingsAfterMove,
      freshStore("second-decision"),
      BUILD_ID,
    );
    return contextAfterMove
      ? !productAgentInputMatchesContext(input, contextAfterMove, BUILD_ID)
      : true;
  }

  it("the Computer generation advances -> the second decision refuses the input saved before the move", () => {
    const settingsAtStart = settingsOf();
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAtStart,
        freshStore("gen-start"),
        BUILD_ID,
      ),
    ).not.toBeNull(); // decision A: the gate said fresh

    const input = productAgentInputOf(); // saved while settingsAtStart was current

    // the owner reconfigures the Computer and it is re-verified at the new
    // generation: the post-move settings are internally fresh on their own.
    const settingsAfterMove = settingsOf({
      generation: ADVANCED_GENERATION,
      codex: codexHostOf({
        agent: { computerGeneration: ADVANCED_GENERATION },
      }),
      computerVerified: {
        workspaceId: WORKSPACE_ID,
        configRevision: ADVANCED_GENERATION,
      },
    });
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAfterMove,
        freshStore("gen-after"),
        BUILD_ID,
      ),
    ).not.toBeNull(); // not refused-at-the-gate -- refused because of the stale input

    expect(secondDecisionRefuses(settingsAfterMove, input)).toBe(true);
  });

  it("the selected host's executable changes -> the second decision refuses the input saved before the move", () => {
    const settingsAtStart = settingsOf();
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAtStart,
        freshStore("exec-start"),
        BUILD_ID,
      ),
    ).not.toBeNull();

    const input = productAgentInputOf();

    // the owner rotates the Codex binary and it is fully re-verified against
    // the new executable: the post-move settings are internally fresh.
    const settingsAfterMove = settingsOf({
      codex: codexHostOf({
        executableSha256: ROTATED_EXECUTABLE_SHA,
        live: { executableSha256: ROTATED_EXECUTABLE_SHA },
        agent: { executableSha256: ROTATED_EXECUTABLE_SHA },
      }),
    });
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAfterMove,
        freshStore("exec-after"),
        BUILD_ID,
      ),
    ).not.toBeNull();

    expect(secondDecisionRefuses(settingsAfterMove, input)).toBe(true);
  });

  it("the workspace leaves settings -> the second decision has no fresh context left to check the input against", () => {
    const settingsAtStart = settingsOf();
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAtStart,
        freshStore("ws-start"),
        BUILD_ID,
      ),
    ).not.toBeNull();

    const input = productAgentInputOf();

    const settingsAfterMove = settingsOf({ workspaces: [] });
    expect(
      productAgentContext(
        WORKSPACE_ID,
        settingsAfterMove,
        freshStore("ws-after"),
        BUILD_ID,
      ),
    ).toBeNull(); // refused at the gate itself, not at the input-match step

    expect(secondDecisionRefuses(settingsAfterMove, input)).toBe(true);
  });
});

describe("sequence 3: cancellation and absent previous state", () => {
  // A cancelled, or never-persisted, reservation must never be re-armed.
  // Each row removes one thing recovery needs (a running task, a store, a
  // loaded input, or a matching binding) and asserts both the exact verdict
  // and that the action is never "reschedule" -- re-arming a timer nobody
  // is tracking, or against an input that no longer describes the running
  // assignment, is the failure mode this guards against.

  it("productAgentExpiryRecoveryVerdict: no stored input at all -> unknown/input_unavailable, never reschedule", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: true,
      input: null,
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({ action: "unknown", reason: "input_unavailable" });
    expect(verdict.action).not.toBe("reschedule");
  });

  it("productAgentExpiryRecoveryVerdict: a stored input whose assignment binding does not match the running task -> unknown/assignment_mismatch, never reschedule", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: true,
      input: productAgentInputOf(),
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({
      action: "unknown",
      reason: "assignment_mismatch",
    });
    expect(verdict.action).not.toBe("reschedule");
  });

  it("productAgentExpiryRecoveryVerdict: no running task -> noop/no_running_task, never reschedule", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: false,
      storeAvailable: true,
      input: null,
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({ action: "noop", reason: "no_running_task" });
    expect(verdict.action).not.toBe("reschedule");
  });

  it("productAgentExpiryRecoveryVerdict: no store -> noop/store_unavailable, never reschedule", () => {
    const verdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: false,
      input: null,
      assignmentMatches: false,
      now: NOW,
    });
    expect(verdict).toEqual({ action: "noop", reason: "store_unavailable" });
    expect(verdict.action).not.toBe("reschedule");
  });
});

describe("sequence 4: concurrent entry", () => {
  // These are pure functions: "concurrent" means the same input evaluated
  // twice must agree with itself, and the two call sites that can observe
  // one task's state at the same instant -- a live timer firing, and
  // startup recovery for that same running task -- must never hand back
  // contradictory actions for it.

  it("two productAgentSessionExpiryVerdict calls for the same task from the same state agree with each other", () => {
    // Two independently-built object literals with identical field values
    // (not two references to one object), so agreement cannot be an
    // artifact of shared identity.
    const first = productAgentSessionExpiryVerdict({
      sessionIsActive: true,
      taskPhase: "running",
      mutationInFlight: true,
      now: NOW,
    });
    const second = productAgentSessionExpiryVerdict({
      sessionIsActive: true,
      taskPhase: "running",
      mutationInFlight: true,
      now: NOW,
    });
    expect(first).toEqual(second);
    // Pinned, not just mutually equal: both must land on the one verdict
    // this state actually produces.
    expect(first).toEqual({ action: "reschedule", atMs: NOW + 100 });
  });

  it("a timer firing while recovery runs on the same state never lets one path say expire while the other says reschedule", () => {
    // A mutation already in flight is the shared signal that must make
    // every path retreat rather than race a cancellation: the live timer's
    // own fire verdict already reschedules instead of expiring
    // (DECISIVE-1, pinned in product-agent-expiry.test.ts). This proves
    // recovery, asked about the identical running task with a still-valid
    // binding, agrees rather than independently deciding "unknown" and
    // dropping the reservation the busy fire path is about to retry.
    const input = productAgentInputOf();

    const fireVerdict = persistedProductAgentExpiryVerdict({
      taskPhase: "running",
      mutationInFlight: true,
      now: NOW,
    });
    const recoveryVerdict = productAgentExpiryRecoveryVerdict({
      hasRunningTask: true,
      storeAvailable: true,
      input,
      assignmentMatches: true,
      now: NOW,
    });

    expect(fireVerdict).toEqual({ action: "reschedule", atMs: NOW + 100 });
    expect(recoveryVerdict).toEqual({
      action: "reschedule",
      atMs: Math.max(NOW, input.expiresAt),
    });
    // Neither call resolves the shared, contended task by cancelling it.
    expect(fireVerdict.action).not.toBe("expire");
    expect(recoveryVerdict.action).not.toBe("unknown");
  });
});

describe("sequence 5: ordering within a decision", () => {
  // Every guard clause below is a real precedence choice: swapping the
  // order of an `if` changes which `reason` the owner is told without
  // changing whether the outcome is "noop" or "unknown". Nothing but this
  // table pins the order.

  it("productAgentExpiryRecoveryVerdict: !hasRunningTask AND !storeAvailable -> no_running_task wins over store_unavailable", () => {
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: false,
        storeAvailable: false,
        input: null,
        assignmentMatches: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "no_running_task" });
  });

  it("productAgentExpiryRecoveryVerdict: !input AND !assignmentMatches -> input_unavailable wins over assignment_mismatch", () => {
    expect(
      productAgentExpiryRecoveryVerdict({
        hasRunningTask: true,
        storeAvailable: true,
        input: null,
        assignmentMatches: false,
        now: NOW,
      }),
    ).toEqual({ action: "unknown", reason: "input_unavailable" });
  });

  it('productAgentSessionExpiryVerdict: !sessionIsActive AND taskPhase !== "running" -> session_superseded wins over task_not_running', () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: false,
        taskPhase: "completed",
        mutationInFlight: false,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "session_superseded" });
  });

  it('productAgentSessionExpiryVerdict/persistedProductAgentExpiryVerdict: taskPhase !== "running" AND mutationInFlight -> task_not_running wins over reschedule', () => {
    expect(
      productAgentSessionExpiryVerdict({
        sessionIsActive: true,
        taskPhase: "completed",
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
    expect(
      persistedProductAgentExpiryVerdict({
        taskPhase: "completed",
        mutationInFlight: true,
        now: NOW,
      }),
    ).toEqual({ action: "noop", reason: "task_not_running" });
  });
});
