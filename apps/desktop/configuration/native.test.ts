import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  CodexAgentVerificationFieldsSchema,
  CodexHostSelectionSchema,
  CodexTaskSelectionSchema,
  CodexTaskSourceSchema,
  ProductSettingsSchema,
  type CodexTaskSource,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  chatGptObservationSchema,
  codexAgentFailureSchema,
  codexHostFailureSchema,
  codexHostInputSchema,
  codexHostLiveFailureSchema,
  codexHostLiveInputSchema,
} from "./input";
import {
  codexAgentVerificationAdmitted,
  codexHostMatchesLiveInput,
  withChatGptObservation,
  withCodexAgentFailure,
  withCodexAgentVerification,
  withCodexHost,
  withCodexHostFailure,
  withCodexHostLiveFailure,
  withCodexHostLiveVerification,
  withCodexTaskRoute,
  withoutCodexHost,
  withoutCodexTaskRoute,
} from "./native";

const uuid = "12345678-1234-4234-8234-123456789abc";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";
const LATER = "2026-11-26T11:00:00.000Z";
const NOW_MILLIS = Date.parse(NOW);
const HOURS_12 = 12 * 60 * 60 * 1_000;

const clock = (value = NOW) => vi.fn(() => value);

type Host = NonNullable<ProductSettings["nativeHosts"]["codex"]>;
type Verify = ProductSettings["setup"]["verify"];

function base(): ProductSettings {
  return defaultSettings(() => uuid);
}

const hostFields = {
  executablePath: "/fixture/bin/codex",
  executableSha256: sha("a"),
  version: "0.153.4",
  protocol: "codex-app-server/v2",
  schemaSha256: sha("b"),
  buildId: sha("c"),
} as const;

function taskSource(): CodexTaskSource {
  const binding = {
    executablePath: hostFields.executablePath,
    executableSha256: hostFields.executableSha256,
    baseSchemaSha256: hostFields.schemaSha256,
  };
  return CodexTaskSourceSchema.parse({
    handoff: {
      ...binding,
      status: "supported",
      contract: {
        version: hostFields.version,
        protocol: hostFields.protocol,
        schemaSha256: sha("d"),
        projectBoundCreateStatus: true,
      },
    },
    followup: {
      ...binding,
      status: "unavailable",
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    },
  });
}

const hostInput = (overrides: Record<string, unknown> = {}) =>
  codexHostInputSchema.parse({ ...hostFields, ...overrides });

const localVerification = {
  executableSha256: hostFields.executableSha256,
  schemaSha256: hostFields.schemaSha256,
  buildId: hostFields.buildId,
  verifiedAt: NOW,
};

const liveVerification = {
  model: "gpt-6-astra",
  executableSha256: hostFields.executableSha256,
  schemaSha256: hostFields.schemaSha256,
  buildId: hostFields.buildId,
  dynamicTool: "farol_ping",
  verifiedAt: NOW,
} as const;

const agentFields = {
  model: "gpt-6-astra",
  executableSha256: hostFields.executableSha256,
  schemaSha256: hostFields.schemaSha256,
  buildId: hostFields.buildId,
  workspaceId: uuid,
  computerGeneration: 1,
  transport: "codex-native-agent/spawn-prompt-sha256-v1",
  authorityRole: "agent",
  hostRole: null,
  delegationDigest: sha("1"),
  parentThreadSha256: sha("2"),
  childThreadSha256: sha("3"),
  boundedRunning: true,
  modelTurnsSubmitted: 1,
  fallbackAllowed: false,
  descendantCount: 0,
  resultRefProtocol: "codex-app-server",
  resultRetention: "durable",
  parentDelivery: "acknowledged",
  workspaceEnforcement: "verified",
} as const;

function hostRecord(overrides: Record<string, unknown> = {}): Host {
  return CodexHostSelectionSchema.parse({
    executablePath: hostFields.executablePath,
    executableSha256: hostFields.executableSha256,
    version: hostFields.version,
    protocol: hostFields.protocol,
    schemaSha256: hostFields.schemaSha256,
    verifiedAt: NOW,
    localVerification,
    ...overrides,
  });
}

function withHost(
  settings: ProductSettings,
  codex: Host | null,
  extra: Partial<ProductSettings["nativeHosts"]> = {},
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    nativeHosts: { ...settings.nativeHosts, codex, ...extra },
  });
}

function withVerify(
  settings: ProductSettings,
  verify: Partial<Verify>,
): ProductSettings {
  return {
    ...settings,
    setup: {
      ...settings.setup,
      verify: { ...settings.setup.verify, ...verify },
    },
  };
}

const workspaceRecord = (
  access: "read" | "write" = "write",
): ProductSettings["computer"]["workspaces"][number] => ({
  workspaceId: uuid,
  root: "/fixture/project",
  label: "Project",
  access,
  excludedPaths: [],
  rootIdentity: { device: "1", inode: "2" },
  gitMetadata: {
    gitDirectory: "/fixture/project/.git",
    commonDirectory: "/fixture/project/.git",
  },
});

// Settings that satisfy every Computer-side admission clause: one verified
// workspace at the current generation, reachable and settled.
function computerReady(
  settings: ProductSettings,
  access: "read" | "write" = "write",
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    computer: { ...settings.computer, workspaces: [workspaceRecord(access)] },
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        reachable: "reachable",
        verified: {
          profile: "computer/1",
          configRevision: settings.computer.generation,
          workspaceId: uuid,
          runtimeGeneration: "runtime-1",
          buildId: hostFields.buildId,
          protocol: "computer/v1",
          verifiedAt: NOW,
        },
      },
    },
  });
}

function liveHostSettings(): ProductSettings {
  return computerReady(
    withHost(base(), hostRecord({ liveVerification }), { generation: 3 }),
  );
}

const routeSelection = (
  overrides: Record<string, unknown> = {},
  settings: ProductSettings = liveHostSettings(),
) =>
  CodexTaskSelectionSchema.parse({
    transport: "codex-shared-proxy/v1",
    socketPath: "/fixture/private/codex.sock",
    expectedCodexHome: "/fixture/home",
    workspaceId: uuid,
    projectId: "22345678-1234-4234-8234-123456789abc",
    projectRoot: "/fixture/project",
    projectIdentity: { device: "1", inode: "2" },
    gitCommonDirectory: "/fixture/project/.git",
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    harness: "codex",
    computerGeneration: settings.computer.generation,
    hostGeneration: settings.nativeHosts.generation,
    approvedAt: NOW,
    expiresAt: NOW_MILLIS + 60_000,
    ...overrides,
  });

describe("ChatGPT observation transform", () => {
  const observe = (
    state: Record<string, unknown>,
    settings = base(),
    preserve = false,
    now = clock(),
  ) =>
    withChatGptObservation(
      settings,
      chatGptObservationSchema.parse(state),
      now,
      preserve,
    );

  it("records an authenticated observation with the clock's time", () => {
    const now = clock(LATER);
    const next = observe(
      {
        state: "authenticated",
        profile: "chatgpt.web/1",
        runtimeGeneration: "runtime-9",
        buildId: sha("e"),
        protocol: "chatgpt-web/v1",
      },
      base(),
      false,
      now,
    );
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(base().revision + 1);
    expect(next.setup.chatgpt).toEqual({
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "chatgpt.web/1",
        configRevision: 1,
        workspaceId: null,
        runtimeGeneration: "runtime-9",
        buildId: sha("e"),
        protocol: "chatgpt-web/v1",
        verifiedAt: LATER,
      },
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
    expect(next.setup.computer).toEqual(base().setup.computer);
  });

  it.each([
    [
      "signed_out",
      {
        configured: false,
        reachable: "reachable",
        needsAction: "Sign in to ChatGPT in the isolated Farol window.",
        unavailable: null,
        outcomeUnknown: false,
      },
    ],
    [
      "unreachable",
      {
        configured: false,
        reachable: "unreachable",
        needsAction:
          "Open the isolated ChatGPT window and check network access.",
        unavailable: null,
        outcomeUnknown: false,
      },
    ],
    [
      "unsupported",
      {
        configured: false,
        reachable: "reachable",
        needsAction: null,
        unavailable:
          "The ChatGPT page loaded, but this build could not verify its composer.",
        outcomeUnknown: false,
      },
    ],
    [
      "outcome_unknown",
      {
        configured: true,
        reachable: "unknown",
        needsAction:
          "Inspect the isolated ChatGPT window before starting another task.",
        unavailable: null,
        outcomeUnknown: true,
      },
    ],
  ])("records %s without reading the clock", (state, expected) => {
    const now = clock();
    const next = observe({ state }, base(), false, now);
    expect(now).not.toHaveBeenCalled();
    expect(next.setup.chatgpt).toMatchObject({
      ...expected,
      visited: true,
      skipped: false,
      verified: null,
    });
    expect(next.revision).toBe(base().revision + 1);
  });

  it("keeps a pending unknown outcome only when asked to preserve it", () => {
    const pending: ProductSettings = {
      ...base(),
      setup: {
        ...base().setup,
        chatgpt: { ...base().setup.chatgpt, outcomeUnknown: true },
      },
    };
    expect(
      observe({ state: "signed_out" }, pending, true).setup.chatgpt
        .outcomeUnknown,
    ).toBe(true);
    expect(
      observe({ state: "signed_out" }, pending, false).setup.chatgpt
        .outcomeUnknown,
    ).toBe(false);
    expect(
      observe({ state: "outcome_unknown" }, base(), false).setup.chatgpt
        .outcomeUnknown,
    ).toBe(true);
  });

  it("does not mutate its input", () => {
    const before = base();
    const snapshot = structuredClone(before);
    observe({ state: "signed_out" }, before);
    expect(before).toEqual(snapshot);
  });
});

describe("Codex host transform", () => {
  it("records a first host as a new generation with checks still pending", () => {
    const now = clock();
    const next = withCodexHost(base(), hostInput(), now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(base().revision + 1);
    expect(next.nativeHosts.generation).toBe(base().nativeHosts.generation + 1);
    expect(next.nativeHosts.taskRoute).toBeNull();
    expect(next.nativeHosts.codex).toEqual({
      executablePath: hostFields.executablePath,
      executableSha256: hostFields.executableSha256,
      version: hostFields.version,
      protocol: hostFields.protocol,
      schemaSha256: hostFields.schemaSha256,
      verifiedAt: NOW,
      localVerification,
      taskSource: null,
      liveVerification: null,
      agentVerification: null,
    });
    expect(next.setup.hosts).toMatchObject({
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: null,
      needsAction: "Run the live Codex host check.",
      outcomeUnknown: false,
    });
    expect(next.setup.verify).toMatchObject({
      configured: false,
      needsAction: "Run the live Codex host check first.",
    });
  });

  it("keeps the generation and live proof for an unchanged contract", () => {
    const settings = liveHostSettings();
    const next = withCodexHost(settings, hostInput(), clock(LATER));
    expect(next.nativeHosts.generation).toBe(3);
    expect(next.nativeHosts.codex?.verifiedAt).toBe(LATER);
    expect(next.nativeHosts.codex?.localVerification?.verifiedAt).toBe(LATER);
    expect(next.nativeHosts.codex?.liveVerification).toEqual(liveVerification);
    expect(next.setup.hosts.verified).toEqual({
      profile: "codex.app-server.live/1",
      configRevision: 3,
      workspaceId: null,
      runtimeGeneration: hostFields.executableSha256,
      buildId: hostFields.buildId,
      protocol: hostFields.protocol,
      verifiedAt: NOW,
    });
    expect(next.setup.hosts.needsAction).toBeNull();
    expect(next.setup.verify).toMatchObject({
      configured: true,
      needsAction: "Run the native Agent lineage check.",
    });
  });

  it("keeps the Agent proof and the verify readiness when both survive", () => {
    const settings = withVerify(
      computerReady(
        withHost(
          base(),
          hostRecord({
            liveVerification,
            agentVerification: { ...agentFields, verifiedAt: NOW },
          }),
        ),
      ),
      { needsAction: "kept as it was" },
    );
    const next = withCodexHost(settings, hostInput(), clock());
    expect(next.nativeHosts.codex?.agentVerification).not.toBeNull();
    expect(next.setup.verify).toEqual(settings.setup.verify);
  });

  it.each([
    ["executable", { executableSha256: sha("9") }],
    ["schema", { schemaSha256: sha("8") }],
    ["version", { version: "0.153.5" }],
  ])(
    "starts a new generation and drops proof when the %s changes",
    (_n, change) => {
      const settings = liveHostSettings();
      const next = withCodexHost(settings, hostInput(change), clock());
      expect(next.nativeHosts.generation).toBe(4);
      expect(next.nativeHosts.codex?.liveVerification).toBeNull();
      expect(next.nativeHosts.codex?.agentVerification).toBeNull();
      expect(next.setup.hosts.verified).toBeNull();
    },
  );

  it("drops proof when only the build changes, keeping the generation", () => {
    const next = withCodexHost(
      liveHostSettings(),
      hostInput({ buildId: sha("7") }),
      clock(),
    );
    expect(next.nativeHosts.generation).toBe(3);
    expect(next.nativeHosts.codex?.liveVerification).toBeNull();
  });

  it("binds a supplied task source to the new generation and keeps its route", () => {
    const source = taskSource();
    const first = withCodexHost(
      base(),
      hostInput({ taskSource: source }),
      clock(),
    );
    expect(first.nativeHosts.codex?.taskSource).toEqual({
      hostGeneration: first.nativeHosts.generation,
      localVerification,
      evidence: source,
    });

    const routed = withHost(computerReady(first), first.nativeHosts.codex, {
      taskRoute: routeSelection({}, computerReady(first)),
    });
    const same = withCodexHost(
      routed,
      hostInput({ taskSource: source }),
      clock(),
    );
    expect(same.nativeHosts.generation).toBe(routed.nativeHosts.generation);
    expect(same.nativeHosts.taskRoute).toEqual(routed.nativeHosts.taskRoute);
  });

  it("withdraws the route and bumps the generation when the source is no longer supported", () => {
    const source = taskSource();
    const first = withCodexHost(
      base(),
      hostInput({ taskSource: source }),
      clock(),
    );
    const routed = withHost(computerReady(first), first.nativeHosts.codex, {
      taskRoute: routeSelection({}, computerReady(first)),
    });
    const next = withCodexHost(routed, hostInput(), clock());
    expect(next.nativeHosts.taskRoute).toBeNull();
    expect(next.nativeHosts.generation).toBe(routed.nativeHosts.generation + 1);
    expect(next.nativeHosts.codex?.taskSource).toBeNull();
  });

  it("starts a new generation when the build behind the task source changes", () => {
    const source = taskSource();
    const first = withCodexHost(
      base(),
      hostInput({ taskSource: source }),
      clock(),
    );
    const next = withCodexHost(
      first,
      hostInput({ taskSource: source, buildId: sha("6") }),
      clock(),
    );
    expect(next.nativeHosts.generation).toBe(first.nativeHosts.generation + 1);
    expect(next.nativeHosts.codex?.taskSource?.hostGeneration).toBe(
      next.nativeHosts.generation,
    );
  });
});

describe("Codex live verification", () => {
  const live = codexHostLiveInputSchema.parse({
    model: "gpt-6-astra",
    executableSha256: hostFields.executableSha256,
    schemaSha256: hostFields.schemaSha256,
    buildId: hostFields.buildId,
  });

  it("matches only the selected host's executable and schema", () => {
    const settings = withHost(base(), hostRecord());
    expect(codexHostMatchesLiveInput(settings, live)).toBe(true);
    expect(codexHostMatchesLiveInput(base(), live)).toBe(false);
    expect(
      codexHostMatchesLiveInput(settings, {
        ...live,
        executableSha256: sha("0"),
      }),
    ).toBe(false);
    expect(
      codexHostMatchesLiveInput(settings, { ...live, schemaSha256: sha("0") }),
    ).toBe(false);
  });

  it("leaves settings untouched without a host and never reads the clock", () => {
    const settings = base();
    const now = clock();
    expect(withCodexHostLiveVerification(settings, live, now)).toBe(settings);
    expect(now).not.toHaveBeenCalled();
  });

  it("records the live proof and asks for the Agent check next", () => {
    const settings = withHost(base(), hostRecord(), { generation: 2 });
    const now = clock(LATER);
    const next = withCodexHostLiveVerification(settings, live, now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts.codex?.liveVerification).toEqual({
      ...live,
      dynamicTool: "farol_ping",
      verifiedAt: LATER,
    });
    expect(next.setup.hosts).toEqual({
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "codex.app-server.live/1",
        configRevision: 2,
        workspaceId: null,
        runtimeGeneration: hostFields.executableSha256,
        buildId: hostFields.buildId,
        protocol: hostFields.protocol,
        verifiedAt: LATER,
      },
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
    expect(next.setup.verify).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Run the native Agent lineage check.",
    });
  });

  it("keeps the verify readiness when an Agent proof already exists", () => {
    const settings = computerReady(
      withHost(
        base(),
        hostRecord({
          agentVerification: { ...agentFields, verifiedAt: NOW },
        }),
      ),
    );
    const next = withCodexHostLiveVerification(settings, live, clock());
    expect(next.setup.verify).toEqual(settings.setup.verify);
  });
});

describe("Codex Agent verification", () => {
  const verification = CodexAgentVerificationFieldsSchema.parse(agentFields);

  it("admits a verification that agrees with host, live check and Computer", () => {
    expect(
      codexAgentVerificationAdmitted(liveHostSettings(), verification),
    ).toBe(true);
  });

  const mutations: [string, (settings: ProductSettings) => ProductSettings][] =
    [
      [
        "no host",
        (s) => ({ ...s, nativeHosts: { ...s.nativeHosts, codex: null } }),
      ],
      [
        "no live proof",
        (s) => withHost(s, hostRecord({ liveVerification: null })),
      ],
      [
        "other host executable",
        (s) =>
          withHost(
            s,
            hostRecord({
              executableSha256: sha("5"),
              localVerification: null,
              liveVerification: {
                ...liveVerification,
                executableSha256: sha("5"),
              },
            }),
          ),
      ],
      [
        "other host schema",
        (s) =>
          withHost(
            s,
            hostRecord({
              schemaSha256: sha("5"),
              localVerification: null,
              liveVerification: { ...liveVerification, schemaSha256: sha("5") },
            }),
          ),
      ],
      [
        "live proof for another executable",
        (s) =>
          withHost(
            s,
            hostRecord({
              liveVerification: {
                ...liveVerification,
                executableSha256: sha("5"),
              },
            }),
          ),
      ],
      [
        "live proof for another schema",
        (s) =>
          withHost(
            s,
            hostRecord({
              liveVerification: { ...liveVerification, schemaSha256: sha("5") },
            }),
          ),
      ],
      [
        "live proof for another build",
        (s) =>
          withHost(
            s,
            hostRecord({
              liveVerification: { ...liveVerification, buildId: sha("5") },
            }),
          ),
      ],
      [
        "other computer generation",
        (s) => ({ ...s, computer: { ...s.computer, generation: 2 } }),
      ],
      [
        "unknown workspace",
        (s) => ({ ...s, computer: { ...s.computer, workspaces: [] } }),
      ],
      [
        "computer verified for another workspace",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: {
              ...s.setup.computer,
              verified: s.setup.computer.verified && {
                ...s.setup.computer.verified,
                workspaceId: "32345678-1234-4234-8234-123456789abc",
              },
            },
          },
        }),
      ],
      [
        "computer verified for another generation",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: {
              ...s.setup.computer,
              verified: s.setup.computer.verified && {
                ...s.setup.computer.verified,
                configRevision: 2,
              },
            },
          },
        }),
      ],
      [
        "computer verified for another build",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: {
              ...s.setup.computer,
              verified: s.setup.computer.verified && {
                ...s.setup.computer.verified,
                buildId: sha("5"),
              },
            },
          },
        }),
      ],
      [
        "no computer verification",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: { ...s.setup.computer, verified: null },
          },
        }),
      ],
      [
        "computer unreachable",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: { ...s.setup.computer, reachable: "unreachable" },
          },
        }),
      ],
      [
        "computer outcome unknown",
        (s) => ({
          ...s,
          setup: {
            ...s.setup,
            computer: { ...s.setup.computer, outcomeUnknown: true },
          },
        }),
      ],
    ];

  it.each(mutations)("refuses with %s", (_name, mutate) => {
    expect(
      codexAgentVerificationAdmitted(mutate(liveHostSettings()), verification),
    ).toBe(false);
  });

  it("leaves settings untouched without a host and never reads the clock", () => {
    const settings = base();
    const now = clock();
    expect(withCodexAgentVerification(settings, verification, now)).toBe(
      settings,
    );
    expect(now).not.toHaveBeenCalled();
  });

  it("records the proof, clears a recovery and points verify at it", () => {
    const settings = withVerify(liveHostSettings(), {
      recovery: "rejoin_agent",
      outcomeUnknown: true,
      needsAction: "Rejoin.",
    });
    const now = clock(LATER);
    const next = withCodexAgentVerification(settings, verification, now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts.codex?.agentVerification).toEqual({
      ...agentFields,
      verifiedAt: LATER,
    });
    expect(next.setup.verify).toEqual({
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "codex.native-agent.lineage/1",
        configRevision: settings.revision + 1,
        workspaceId: uuid,
        runtimeGeneration: hostFields.executableSha256,
        buildId: hostFields.buildId,
        protocol: "codex-native-agent/spawn-prompt-sha256-v1",
        verifiedAt: LATER,
      },
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
    expect("recovery" in next.setup.verify).toBe(false);
  });
});

describe("Codex Agent failure", () => {
  const failure = (value: string) => codexAgentFailureSchema.parse(value);

  it("leaves settings untouched without a host", () => {
    const settings = base();
    expect(withCodexAgentFailure(settings, failure("failed"))).toBe(settings);
  });

  it.each([
    [
      "failed",
      {
        reachable: "unreachable",
        needsAction:
          "Recheck the native Agent contract before running it again.",
        outcomeUnknown: false,
        recovery: undefined,
      },
    ],
    [
      "running",
      {
        reachable: "unknown",
        needsAction:
          "Rejoin the same native Agent assignment to collect its result.",
        outcomeUnknown: false,
        recovery: "rejoin_agent",
      },
    ],
    [
      "outcome_unknown",
      {
        reachable: "unknown",
        needsAction:
          "Inspect and explicitly rejoin the same native Agent assignment before another launch.",
        outcomeUnknown: true,
        recovery: "rejoin_agent",
      },
    ],
    [
      "workspace_not_verified",
      {
        reachable: "unknown",
        needsAction: "Verify read access to one workspace first.",
        outcomeUnknown: false,
        recovery: undefined,
      },
    ],
  ])("records %s", (value, expected) => {
    const settings = liveHostSettings();
    const next = withCodexAgentFailure(settings, failure(value));
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts.codex?.agentVerification).toBeNull();
    expect(next.nativeHosts.codex?.liveVerification).toEqual(liveVerification);
    expect(next.setup.verify).toMatchObject({
      visited: true,
      skipped: false,
      configured: true,
      verified: null,
      unavailable: null,
      reachable: expected.reachable,
      needsAction: expected.needsAction,
      outcomeUnknown: expected.outcomeUnknown,
    });
    expect(next.setup.verify.recovery).toBe(expected.recovery);
  });

  it("marks verify unconfigured when no live proof backs it", () => {
    const settings = withHost(base(), hostRecord());
    expect(
      withCodexAgentFailure(settings, failure("failed")).setup.verify
        .configured,
    ).toBe(false);
  });

  it("drops a previous recovery when the failure needs none", () => {
    const settings = withVerify(liveHostSettings(), {
      recovery: "rejoin_agent",
    });
    expect(
      "recovery" in
        withCodexAgentFailure(settings, failure("failed")).setup.verify,
    ).toBe(false);
  });
});

describe("Codex live failure", () => {
  const failure = (value: string) => codexHostLiveFailureSchema.parse(value);

  it("leaves settings untouched without a host", () => {
    const settings = base();
    expect(withCodexHostLiveFailure(settings, failure("failed"))).toBe(
      settings,
    );
  });

  it.each([
    [
      "failed",
      {
        reachable: "unreachable",
        needsAction:
          "Recheck the selected Codex executable, then run the live check again.",
        unavailable: null,
        outcomeUnknown: false,
        verifyNeeds: "Run the live Codex host check first.",
      },
    ],
    [
      "model_unavailable",
      {
        reachable: "reachable",
        needsAction: null,
        unavailable:
          "The selected host does not offer gpt-6-astra without provider fallback.",
        outcomeUnknown: false,
        verifyNeeds: "Run the live Codex host check first.",
      },
    ],
    [
      "outcome_unknown",
      {
        reachable: "unknown",
        needsAction:
          "Inspect the Codex host before deliberately running another live check.",
        unavailable: null,
        outcomeUnknown: true,
        verifyNeeds:
          "Resolve the live Codex host outcome before checking Agent lineage.",
      },
    ],
  ])("records %s", (value, expected) => {
    const settings = liveHostSettings();
    const next = withCodexHostLiveFailure(settings, failure(value));
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts.codex?.liveVerification).toBeNull();
    expect(next.nativeHosts.codex?.agentVerification).toBeNull();
    expect(next.nativeHosts.generation).toBe(settings.nativeHosts.generation);
    expect(next.setup.hosts).toEqual({
      visited: true,
      skipped: false,
      configured: true,
      reachable: expected.reachable,
      verified: null,
      needsAction: expected.needsAction,
      unavailable: expected.unavailable,
      outcomeUnknown: expected.outcomeUnknown,
    });
    expect(next.setup.verify).toMatchObject({
      configured: false,
      needsAction: expected.verifyNeeds,
    });
  });
});

describe("Codex host failure", () => {
  const failure = (value: string) => codexHostFailureSchema.parse(value);

  it.each([
    [
      "unreachable",
      {
        reachable: "unreachable",
        needsAction:
          "Choose the Codex executable again or restore it, then recheck.",
        unavailable: null,
      },
    ],
    [
      "unsupported",
      {
        reachable: "reachable",
        needsAction: null,
        unavailable:
          "This Codex build does not expose the required bounded App Server contract.",
      },
    ],
  ])(
    "withdraws every proof for %s and bumps the generation",
    (value, expected) => {
      const settings = liveHostSettings();
      const next = withCodexHostFailure(settings, failure(value));
      expect(next.revision).toBe(settings.revision + 1);
      expect(next.nativeHosts.generation).toBe(4);
      expect(next.nativeHosts.taskRoute).toBeNull();
      expect(next.nativeHosts.codex).toMatchObject({
        localVerification: null,
        liveVerification: null,
        agentVerification: null,
        executablePath: hostFields.executablePath,
      });
      expect(next.setup.hosts).toEqual({
        visited: true,
        skipped: false,
        configured: true,
        reachable: expected.reachable,
        verified: null,
        needsAction: expected.needsAction,
        unavailable: expected.unavailable,
        outcomeUnknown: false,
      });
      expect(next.setup.verify).toMatchObject({
        configured: false,
        needsAction: "Run the live Codex host check first.",
      });
    },
  );

  it("keeps the host graph and marks the step unconfigured with no host", () => {
    const settings = base();
    const next = withCodexHostFailure(settings, failure("unreachable"));
    expect(next.nativeHosts).toEqual(settings.nativeHosts);
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.setup.hosts.configured).toBe(false);
  });
});

describe("Codex host removal", () => {
  it("is a no-op without a host", () => {
    const settings = base();
    expect(withoutCodexHost(settings)).toBe(settings);
  });

  it("clears the host and route and asks for a new choice", () => {
    const settings = liveHostSettings();
    const next = withoutCodexHost(settings);
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts).toEqual({
      generation: 4,
      codex: null,
      taskRoute: null,
    });
    expect(next.setup.hosts).toEqual({
      visited: true,
      skipped: false,
      configured: false,
      reachable: "unknown",
      verified: null,
      needsAction: "Choose a Codex executable to verify.",
      unavailable: null,
      outcomeUnknown: false,
    });
    expect(next.setup.verify).toMatchObject({
      configured: false,
      needsAction: "Choose and verify a Codex host first.",
    });
  });
});

describe("Codex task route", () => {
  const settings = liveHostSettings();
  const nowFn = (value = NOW) => clock(value);

  it("records the selected route and advances the revision", () => {
    const selected = routeSelection();
    const now = nowFn();
    const next = withCodexTaskRoute(settings, selected, settings.revision, now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(settings.revision + 1);
    expect(next.nativeHosts.taskRoute).toBe(selected);
    expect(next.nativeHosts.codex).toBe(settings.nativeHosts.codex);
  });

  const refuse =
    (
      selected: ReturnType<typeof routeSelection>,
      current: ProductSettings = settings,
      revision: number | undefined = current.revision,
      now = nowFn(),
    ) =>
    () =>
      withCodexTaskRoute(current, selected, revision, now);

  it("refuses a stale or missing expected revision", () => {
    expect(refuse(routeSelection(), settings, settings.revision + 1)).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
    expect(() =>
      withCodexTaskRoute(settings, routeSelection(), undefined, nowFn()),
    ).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("refuses a host without local verification", () => {
    const current = withHost(
      settings,
      hostRecord({ localVerification: null }),
      {
        generation: 3,
      },
    );
    expect(refuse(routeSelection({}, current), current)).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
  });

  it("refuses another host or computer generation", () => {
    expect(refuse(routeSelection({ hostGeneration: 2 }))).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
    expect(refuse(routeSelection({ computerGeneration: 2 }))).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
  });

  it("refuses a workspace the Computer step has not verified", () => {
    const other = "42345678-1234-4234-8234-123456789abc";
    expect(refuse(routeSelection({ workspaceId: other }))).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
    const stale: ProductSettings = {
      ...settings,
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          verified: settings.setup.computer.verified && {
            ...settings.setup.computer.verified,
            configRevision: 2,
          },
        },
      },
    };
    expect(refuse(routeSelection(), stale)).toThrow("CODEX_TASK_ROUTE_STALE");
    const none: ProductSettings = {
      ...settings,
      setup: {
        ...settings.setup,
        computer: { ...settings.setup.computer, verified: null },
      },
    };
    expect(refuse(routeSelection(), none)).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("refuses a workspace without a bound folder identity", () => {
    const { rootIdentity: _identity, ...unbound } = workspaceRecord();
    const current: ProductSettings = {
      ...settings,
      computer: { ...settings.computer, workspaces: [unbound] },
    };
    expect(refuse(routeSelection(), current)).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("refuses another git common directory or missing git metadata", () => {
    expect(
      refuse(routeSelection({ gitCommonDirectory: "/fixture/other/.git" })),
    ).toThrow("CODEX_TASK_ROUTE_STALE");
    const { gitMetadata: _git, ...ungit } = workspaceRecord();
    const current: ProductSettings = {
      ...settings,
      computer: { ...settings.computer, workspaces: [ungit] },
    };
    expect(refuse(routeSelection(), current)).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("allows a workspace-write sandbox only on a write workspace", () => {
    const write = routeSelection({
      execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
    });
    expect(
      withCodexTaskRoute(settings, write, settings.revision, nowFn())
        .nativeHosts.taskRoute,
    ).toBe(write);
    const readOnly = computerReady(
      withHost(base(), hostRecord({ liveVerification }), { generation: 3 }),
      "read",
    );
    expect(refuse(write, readOnly)).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("bounds the expiry between now and twelve hours", () => {
    const accept = (expiresAt: number) =>
      withCodexTaskRoute(
        settings,
        routeSelection({ expiresAt }),
        settings.revision,
        nowFn(),
      ).nativeHosts.taskRoute?.expiresAt;
    expect(accept(NOW_MILLIS + 1)).toBe(NOW_MILLIS + 1);
    expect(accept(NOW_MILLIS + HOURS_12)).toBe(NOW_MILLIS + HOURS_12);
    expect(refuse(routeSelection({ expiresAt: NOW_MILLIS }))).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
    expect(refuse(routeSelection({ expiresAt: NOW_MILLIS - 1 }))).toThrow(
      "CODEX_TASK_ROUTE_STALE",
    );
    expect(
      refuse(routeSelection({ expiresAt: NOW_MILLIS + HOURS_12 + 1 })),
    ).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("measures the expiry against the clock it is given", () => {
    const selected = routeSelection({ expiresAt: NOW_MILLIS + 60_000 });
    expect(() =>
      withCodexTaskRoute(settings, selected, settings.revision, nowFn(LATER)),
    ).toThrow("CODEX_TASK_ROUTE_STALE");
  });

  it("clears a route, and leaves an absent one untouched", () => {
    expect(withoutCodexTaskRoute(settings)).toBe(settings);
    const routed = withCodexTaskRoute(
      settings,
      routeSelection(),
      settings.revision,
      nowFn(),
    );
    const cleared = withoutCodexTaskRoute(routed);
    expect(cleared.revision).toBe(routed.revision + 1);
    expect(cleared.nativeHosts.taskRoute).toBeNull();
    expect(cleared.nativeHosts.generation).toBe(routed.nativeHosts.generation);
    expect(cleared.nativeHosts.codex).toBe(routed.nativeHosts.codex);
  });
});
