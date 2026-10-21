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
  type ProductAgentContext,
} from "../../src/apps/desktop/product-agent-context";

// S35-TA-6. The native Product Agent's freshness gate: whether a workspace
// and its saved input may still be trusted to start, rejoin, cancel, or run
// an Agent turn right now. This sits on the local trust boundary — a wrong
// `null` merely blocks a turn, but a wrong non-null lets a native Agent run
// against a host binary or a workspace the owner's verification no longer
// covers. `main.ts` used to compute this inline, where no test could reach
// it; every case below drives the production functions the five call sites
// actually call, with the states enumerated rather than sampled.
//
// Two fixtures are the reason this file exists: the verified executable's
// sha256 changing after it was verified (rows tagged DECISIVE-1), and the
// Computer generation advancing past the generation an Agent verification
// was recorded against (rows tagged DECISIVE-2). Both must produce `null`.

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const ROOT = "/workspace/approved";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";

const EXECUTABLE_SHA = "1".repeat(64);
const SWAPPED_EXECUTABLE_SHA = "2".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const SWAPPED_SCHEMA_SHA = "4".repeat(64);
const BUILD_ID = "5".repeat(64);
const OTHER_BUILD_ID = "6".repeat(64);
const DELEGATION_DIGEST = "7".repeat(64);
const PARENT_THREAD_SHA = "8".repeat(64);
const CHILD_THREAD_SHA = "9".repeat(64);

const STORE = new PrivateProductAgentStore({
  root: "/tmp/product-agent-context-test-fixture",
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
            executableSha256: EXECUTABLE_SHA,
            schemaSha256: SCHEMA_SHA,
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
            executableSha256: EXECUTABLE_SHA,
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
 * fresh, matching state, so a test only names the one thing it breaks.
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

function baseContext(): ProductAgentContext {
  const settings = settingsOf();
  const host = settings.nativeHosts.codex;
  const workspace = settings.computer.workspaces[0];
  if (!host || !workspace) throw new Error("test fixture invalid");
  return { settings, host, workspace };
}

describe("productAgentContext", () => {
  it("S35-TA-6 matches: live, agent, and Computer verification are all fresh against the current build and generation -> the context", () => {
    const settings = settingsOf();
    expect(
      productAgentContext(WORKSPACE_ID, settings, STORE, BUILD_ID),
    ).toEqual({
      settings,
      host: settings.nativeHosts.codex,
      workspace: settings.computer.workspaces[0],
    });
  });

  type NullRow = Readonly<{
    name: string;
    settings: ProductSettings | null;
    store?: PrivateProductAgentStore | null;
    buildId?: string;
  }>;

  const rows: readonly NullRow[] = [
    {
      name: "the configuration snapshot is not ready yet",
      settings: null,
    },
    {
      name: "the durable Product Agent input store has not been created yet",
      settings: settingsOf(),
      store: null,
    },
    {
      // Nothing about the host or the Computer has ever been verified, even
      // though the workspace itself is present in settings. Proves the test
      // would notice a guard that defaulted to "allow" when unconfigured
      // rather than failing closed.
      name: "control: a workspace exists but nothing about the host or the Computer has ever been verified",
      settings: settingsOf({
        codex: null,
        computerVerified: null,
        reachable: "unknown",
      }),
    },
    {
      name: "no Codex host has ever been selected",
      settings: settingsOf({ codex: null }),
    },
    {
      name: "the selected host has no live verification recorded",
      settings: settingsOf({ codex: codexHostOf({ live: null }) }),
    },
    {
      // DECISIVE-1: the binary the live verification checked no longer
      // matches the one now selected — exactly a swap after verification.
      name: "DECISIVE-1: the live verification's executable no longer matches the one now selected (swapped after verification)",
      settings: settingsOf({
        codex: codexHostOf({
          live: { executableSha256: SWAPPED_EXECUTABLE_SHA },
        }),
      }),
    },
    {
      name: "the live verification's schema no longer matches the one now selected",
      settings: settingsOf({
        codex: codexHostOf({ live: { schemaSha256: SWAPPED_SCHEMA_SHA } }),
      }),
    },
    {
      name: "the live verification was recorded on a different build",
      settings: settingsOf({
        codex: codexHostOf({ live: { buildId: OTHER_BUILD_ID } }),
      }),
    },
    {
      name: "the selected host has no agent verification recorded",
      settings: settingsOf({ codex: codexHostOf({ agent: null }) }),
    },
    {
      name: "the agent verification's executable no longer matches the one now selected (swapped after verification)",
      settings: settingsOf({
        codex: codexHostOf({
          agent: { executableSha256: SWAPPED_EXECUTABLE_SHA },
        }),
      }),
    },
    {
      name: "the agent verification's schema no longer matches the one now selected",
      settings: settingsOf({
        codex: codexHostOf({ agent: { schemaSha256: SWAPPED_SCHEMA_SHA } }),
      }),
    },
    {
      name: "the agent verification was recorded on a different build",
      settings: settingsOf({
        codex: codexHostOf({ agent: { buildId: OTHER_BUILD_ID } }),
      }),
    },
    {
      name: "the agent verification is bound to a different workspace than the one asked for",
      settings: settingsOf({
        codex: codexHostOf({ agent: { workspaceId: OTHER_WORKSPACE_ID } }),
      }),
    },
    {
      // DECISIVE-2: the owner changed the Computer configuration (the
      // generation advanced) since the agent verification was recorded.
      name: "DECISIVE-2: the Computer generation has advanced since the agent verification was recorded",
      settings: settingsOf({
        codex: codexHostOf({ agent: { computerGeneration: GENERATION - 1 } }),
      }),
    },
    {
      name: "the agent verification's own workspace enforcement was not actually verified",
      settings: settingsOf({
        codex: codexHostOf({ agent: { workspaceEnforcement: "not_verified" } }),
      }),
    },
    {
      name: "the workspace asked for is no longer in settings at all",
      settings: settingsOf({ workspaces: [] }),
    },
    {
      name: "the Computer has never been verified",
      settings: settingsOf({ computerVerified: null }),
    },
    {
      name: "the Computer verification names a different workspace",
      settings: settingsOf({
        computerVerified: {
          workspaceId: OTHER_WORKSPACE_ID,
          configRevision: GENERATION,
        },
      }),
    },
    {
      name: "the Computer verification predates the current Computer generation",
      settings: settingsOf({
        computerVerified: {
          workspaceId: WORKSPACE_ID,
          configRevision: GENERATION - 1,
        },
      }),
    },
    {
      name: "the Computer verification was recorded on a different build",
      settings: settingsOf({
        computerVerified: {
          workspaceId: WORKSPACE_ID,
          configRevision: GENERATION,
          buildId: OTHER_BUILD_ID,
        },
      }),
    },
    {
      name: "the Computer is not currently reachable",
      settings: settingsOf({ reachable: "unreachable" }),
    },
    {
      name: "the last Computer check had an unknown outcome",
      settings: settingsOf({ outcomeUnknown: true }),
    },
  ];

  for (const row of rows) {
    it(`S35-TA-6 ${row.name} -> null`, () => {
      expect(
        productAgentContext(
          WORKSPACE_ID,
          row.settings,
          row.store === undefined ? STORE : row.store,
          row.buildId ?? BUILD_ID,
        ),
      ).toBeNull();
    });
  }
});

describe("productAgentHostContext", () => {
  it("S35-TA-6 matches: the exact host the input was created against is still selected -> the host context", () => {
    const settings = settingsOf();
    const input = productAgentInputOf();
    expect(productAgentHostContext(input, settings, BUILD_ID)).toEqual({
      settings,
      host: settings.nativeHosts.codex,
    });
  });

  type Row = Readonly<{
    name: string;
    settings: ProductSettings | null;
    buildId?: string;
  }>;

  const input = productAgentInputOf();
  const rows: readonly Row[] = [
    { name: "the configuration snapshot is not ready yet", settings: null },
    {
      name: "no Codex host is currently selected",
      settings: settingsOf({ codex: null }),
    },
    {
      name: "the currently selected host's executable no longer matches the saved input's",
      settings: settingsOf({
        codex: codexHostOf({ executableSha256: SWAPPED_EXECUTABLE_SHA }),
      }),
    },
    {
      name: "the currently selected host's schema no longer matches the saved input's",
      settings: settingsOf({
        codex: codexHostOf({ schemaSha256: SWAPPED_SCHEMA_SHA }),
      }),
    },
    {
      name: "the saved input was created on a different build",
      settings: settingsOf(),
      buildId: OTHER_BUILD_ID,
    },
  ];

  for (const row of rows) {
    it(`S35-TA-6 ${row.name} -> null`, () => {
      expect(
        productAgentHostContext(input, row.settings, row.buildId ?? BUILD_ID),
      ).toBeNull();
    });
  }
});

describe("productAgentInputMatchesContext", () => {
  it("S35-TA-6 matches: same generation, workspace, scope, and host -> true", () => {
    expect(
      productAgentInputMatchesContext(
        productAgentInputOf(),
        baseContext(),
        BUILD_ID,
      ),
    ).toBe(true);
  });

  type Row = Readonly<{ name: string; input: ProductAgentInput }>;

  const rows: readonly Row[] = [
    {
      name: "the input's Computer generation predates the context's",
      input: productAgentInputOf({ computerGeneration: GENERATION - 1 }),
    },
    {
      name: "the input names a different workspace than the context",
      input: productAgentInputOf({ workspaceId: OTHER_WORKSPACE_ID }),
    },
    {
      name: "the input's scope no longer resolves against the workspace's current root",
      input: productAgentInputOf({
        scope: { mode: "subtree", root: "/somewhere/else" },
      }),
    },
    {
      name: "the input's executable no longer matches the context's host",
      input: productAgentInputOf({ executableSha256: SWAPPED_EXECUTABLE_SHA }),
    },
    {
      name: "the input's schema no longer matches the context's host",
      input: productAgentInputOf({ schemaSha256: SWAPPED_SCHEMA_SHA }),
    },
    {
      name: "the input was created on a different build",
      input: productAgentInputOf({ buildId: OTHER_BUILD_ID }),
    },
  ];

  for (const row of rows) {
    it(`S35-TA-6 ${row.name} -> false`, () => {
      expect(
        productAgentInputMatchesContext(row.input, baseContext(), BUILD_ID),
      ).toBe(false);
    });
  }
});
