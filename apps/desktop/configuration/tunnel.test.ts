import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import {
  ProductSettingsSchema,
  SecureMcpAppSelectionSchema,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import {
  secureMcpAttachmentInputSchema,
  secureMcpChallengeInputSchema,
  secureMcpRuntimeInputSchema,
  secureMcpTunnelClientInputSchema,
  secureMcpTunnelInputSchema,
} from "./input";
import {
  secureMcpAppPendingAdmitted,
  secureMcpAppPendingClearable,
  secureMcpAppSelectionRefusal,
  secureMcpAttachmentAdmitted,
  secureMcpChallengeAdmitted,
  secureMcpCredentialChangeBlocked,
  secureMcpCredentialChangeCompletable,
  secureMcpRuntimeAdmitted,
  withoutSecureMcpAppPending,
  withSecureMcpAppPending,
  withSecureMcpAttachment,
  withSecureMcpChallenge,
  withSecureMcpChatGptApp,
  withSecureMcpCredential,
  withSecureMcpCredentialChangeBegun,
  withSecureMcpCredentialChangeCompleted,
  withSecureMcpRuntime,
  withSecureMcpStopped,
  withSecureMcpTunnel,
  withSecureMcpTunnelClient,
  type SecureMcpAppPendingExpectation,
} from "./tunnel";

const uuid = "12345678-1234-4234-8234-123456789abc";
const challengeValue = "22345678-1234-4234-8234-123456789abc";
const sha = (character: string) => character.repeat(64);
const NOW = "2026-11-26T10:00:00.000Z";
const LATER = "2026-11-26T11:00:00.000Z";

const clock = (value = NOW) => vi.fn(() => value);

type Connector = ProductSettings["connectors"]["secureMcp"];
type Connect = ProductSettings["setup"]["connect"];

function base(): ProductSettings {
  return defaultSettings(() => uuid);
}

const clientFields = {
  executablePath: "/fixture/bin/tunnel-client",
  executableSha256: sha("a"),
  version: "1.2.3",
  protocol: "openai-tunnel-client/v1",
} as const;
const clientInput = () => secureMcpTunnelClientInputSchema.parse(clientFields);
const tunnelInput = (tunnelId = "tunnel-1") =>
  secureMcpTunnelInputSchema.parse({ tunnelId });

const challengeHash = createHash("sha256").update(challengeValue).digest("hex");

function withConnector(
  settings: ProductSettings,
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    connectors: {
      ...settings.connectors,
      secureMcp: { ...settings.connectors.secureMcp, ...connector },
    },
    setup: {
      ...settings.setup,
      connect: { ...settings.setup.connect, ...connect },
    },
  });
}

const runtimeRecord = (overrides: Record<string, unknown> = {}) => ({
  state: "ready" as const,
  connectorGeneration: 2,
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  observedAt: NOW,
  ...overrides,
});

const challengeRecord = (overrides: Record<string, unknown> = {}) => ({
  value: challengeValue,
  challengeSha256: challengeHash,
  runtimeGeneration: sha("1"),
  computerGeneration: 1,
  buildId: sha("2"),
  preparedAt: NOW,
  ...overrides,
});

// Configured at generation 2: client, tunnel and a stored credential.
function configured(
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return withConnector(
    base(),
    {
      generation: 2,
      tunnelId: "tunnel-1",
      tunnelClient: { ...clientFields, verifiedAt: NOW },
      credential: "stored",
      ...connector,
    },
    connect,
  );
}

function withRuntimeReady(
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return configured({ runtime: runtimeRecord(), ...connector }, connect);
}

function withChallengePrepared(
  connector: Partial<Connector> = {},
  connect: Partial<Connect> = {},
): ProductSettings {
  return withRuntimeReady(
    { challenge: challengeRecord(), ...connector },
    connect,
  );
}

const workspaceRecord =
  (): ProductSettings["computer"]["workspaces"][number] => ({
    workspaceId: uuid,
    root: "/fixture/project",
    label: "Project",
    access: "write",
    excludedPaths: [],
    rootIdentity: { device: "1", inode: "2" },
    gitMetadata: {
      gitDirectory: "/fixture/project/.git",
      commonDirectory: "/fixture/project/.git",
    },
  });

function withVerifiedWorkspace(settings: ProductSettings): ProductSettings {
  return ProductSettingsSchema.parse({
    ...settings,
    computer: { ...settings.computer, workspaces: [workspaceRecord()] },
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
          buildId: sha("2"),
          protocol: "computer/v1",
          verifiedAt: NOW,
        },
      },
    },
  });
}

const connectorOf = (settings: ProductSettings) =>
  settings.connectors.secureMcp;

describe("secure MCP tunnel client transform", () => {
  it("records a new client, bumps the generation and drops runtime proofs", () => {
    const now = clock(LATER);
    const before = withChallengePrepared({
      attachment: {
        tunnelId: "tunnel-1",
        workspaceId: null,
        connectorGeneration: 2,
        runtimeGeneration: sha("1"),
        computerGeneration: 1,
        buildId: sha("2"),
        challengeSha256: challengeHash,
        receiptSha256: sha("3"),
        verifiedAt: NOW,
      },
    });
    const changed = withSecureMcpTunnelClient(
      before,
      secureMcpTunnelClientInputSchema.parse({
        ...clientFields,
        version: "1.2.4",
      }),
      now,
    );
    expect(now).toHaveBeenCalledTimes(1);
    expect(changed.revision).toBe(before.revision + 1);
    expect(connectorOf(changed)).toMatchObject({
      generation: 3,
      tunnelClient: { ...clientFields, version: "1.2.4", verifiedAt: LATER },
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(changed.setup.connect).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Start the connector and check readiness.",
      unavailable: null,
      outcomeUnknown: false,
    });
  });

  it("is a no-op for the same client without reading the clock", () => {
    const now = clock();
    const before = configured();
    expect(withSecureMcpTunnelClient(before, clientInput(), now)).toBe(before);
    expect(now).not.toHaveBeenCalled();
  });

  it.each([
    ["path", { executablePath: "/fixture/bin/other" }],
    ["digest", { executableSha256: sha("b") }],
    ["version", { version: "9.9.9" }],
  ])("treats a different %s as a new client", (_, override) => {
    const now = clock();
    const before = configured();
    const next = withSecureMcpTunnelClient(
      before,
      secureMcpTunnelClientInputSchema.parse({ ...clientFields, ...override }),
      now,
    );
    expect(connectorOf(next).generation).toBe(3);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("asks for the tunnel ID when none is set yet", () => {
    const next = withSecureMcpTunnelClient(base(), clientInput(), clock());
    expect(next.setup.connect).toMatchObject({
      configured: false,
      needsAction: "Enter the OpenAI tunnel ID.",
    });
  });

  it("keeps a pending app check unknown", () => {
    const before = configured(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    const next = withSecureMcpTunnelClient(
      before,
      secureMcpTunnelClientInputSchema.parse({
        ...clientFields,
        version: "1.2.4",
      }),
      clock(),
    );
    expect(connectorOf(next).appVerificationPending).toBe(true);
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP tunnel transform", () => {
  it("records a new tunnel, bumps the generation and drops runtime proofs", () => {
    const before = withChallengePrepared();
    const next = withSecureMcpTunnel(before, tunnelInput("tunnel-2"));
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      generation: 3,
      tunnelId: "tunnel-2",
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect.needsAction).toBe(
      "Start the connector and check readiness.",
    );
  });

  it("is a no-op for the same tunnel", () => {
    const before = configured();
    expect(withSecureMcpTunnel(before, tunnelInput("tunnel-1"))).toBe(before);
  });

  it("asks for the client when none is set", () => {
    const next = withSecureMcpTunnel(base(), tunnelInput());
    expect(next.setup.connect).toMatchObject({
      configured: false,
      needsAction: "Choose the verified tunnel-client executable.",
    });
  });

  it("keeps a pending app check unknown", () => {
    const before = configured(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    const next = withSecureMcpTunnel(before, tunnelInput("tunnel-2"));
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP credential change", () => {
  it("is blocked by an unknown setup flag or an unknown runtime", () => {
    expect(secureMcpCredentialChangeBlocked(configured())).toBe(false);
    expect(
      secureMcpCredentialChangeBlocked(
        configured({}, { outcomeUnknown: true }),
      ),
    ).toBe(true);
    expect(
      secureMcpCredentialChangeBlocked(
        configured({ runtime: runtimeRecord({ state: "outcome_unknown" }) }),
      ),
    ).toBe(true);
    expect(
      secureMcpCredentialChangeBlocked(
        configured({ runtime: runtimeRecord({ state: "unreachable" }) }),
      ),
    ).toBe(false);
  });

  it("begins by fencing the connector as outcome-unknown", () => {
    const before = withChallengePrepared();
    const next = withSecureMcpCredentialChangeBegun(before);
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      generation: 3,
      tunnelId: "tunnel-1",
      credential: "stored",
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      reachable: "unknown",
      verified: null,
      needsAction: "Inspect the credential change before reconnecting.",
      unavailable: null,
      outcomeUnknown: true,
    });
  });

  it("can be completed only for the exact pending generation", () => {
    const fenced = withSecureMcpCredentialChangeBegun(configured());
    expect(secureMcpCredentialChangeCompletable(fenced, 3)).toBe(true);
    expect(secureMcpCredentialChangeCompletable(fenced, 2)).toBe(false);
    expect(secureMcpCredentialChangeCompletable(fenced, 4)).toBe(false);
    expect(secureMcpCredentialChangeCompletable(configured(), 2)).toBe(false);
    expect(
      secureMcpCredentialChangeCompletable(
        withConnector(
          fenced,
          { runtime: runtimeRecord({ state: "outcome_unknown" }) },
          {},
        ),
        3,
      ),
    ).toBe(false);
  });

  it("completes by storing the credential and the tunnel", () => {
    const fenced = withSecureMcpCredentialChangeBegun(
      withConnector(base(), {
        tunnelClient: { ...clientFields, verifiedAt: NOW },
      }),
    );
    const next = withSecureMcpCredentialChangeCompleted(
      fenced,
      tunnelInput("tunnel-9"),
    );
    expect(next.revision).toBe(fenced.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      generation: connectorOf(fenced).generation,
      tunnelId: "tunnel-9",
      credential: "stored",
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      configured: true,
      reachable: "unknown",
      outcomeUnknown: false,
    });
  });

  it("completing keeps an unconfirmed pending app check unknown", () => {
    const fenced = withSecureMcpCredentialChangeBegun(
      configured({ appVerificationPending: true }),
    );
    const next = withSecureMcpCredentialChangeCompleted(fenced, tunnelInput());
    expect(connectorOf(next).appVerificationPending).toBe(true);
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP ChatGPT app selection", () => {
  const selection = (overrides: Record<string, unknown> = {}) =>
    SecureMcpAppSelectionSchema.parse({
      name: "Farol",
      tunnelId: "tunnel-1",
      connectorGeneration: 2,
      ...overrides,
    });

  it("is refused over an unknown outcome before anything else", () => {
    const stale = selection({ tunnelId: "other" });
    expect(
      secureMcpAppSelectionRefusal(
        configured({}, { outcomeUnknown: true }),
        stale,
      ),
    ).toBe("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
    expect(
      secureMcpAppSelectionRefusal(
        configured({ runtime: runtimeRecord({ state: "outcome_unknown" }) }),
        stale,
      ),
    ).toBe("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
  });

  it("is refused when the tunnel or generation moved", () => {
    expect(
      secureMcpAppSelectionRefusal(
        configured(),
        selection({ tunnelId: "other" }),
      ),
    ).toBe("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    expect(
      secureMcpAppSelectionRefusal(
        configured(),
        selection({ connectorGeneration: 3 }),
      ),
    ).toBe("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
  });

  it("is admitted for the exact tunnel and generation", () => {
    expect(secureMcpAppSelectionRefusal(configured(), selection())).toBeNull();
  });

  it("a new app name drops the attachments and asks for a new check", () => {
    const before = configured({
      chatgptApp: selection({ name: "Old" }),
      lastVerifiedAttachment: {
        tunnelId: "tunnel-1",
        workspaceId: null,
        connectorGeneration: 2,
        runtimeGeneration: sha("1"),
        computerGeneration: 1,
        buildId: sha("2"),
        challengeSha256: challengeHash,
        receiptSha256: sha("3"),
        verifiedAt: NOW,
      },
    });
    const next = withSecureMcpChatGptApp(
      before,
      selection(),
      connectorOf(before),
    );
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      chatgptApp: selection(),
      attachment: null,
      lastVerifiedAttachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      reachable: "unknown",
      needsAction: "Check the selected app in ChatGPT.",
      outcomeUnknown: false,
    });
  });

  it("the same app name changes nothing but the revision", () => {
    const before = configured(
      { chatgptApp: selection() },
      { reachable: "reachable" },
    );
    const next = withSecureMcpChatGptApp(
      before,
      selection(),
      connectorOf(before),
    );
    expect(next).toEqual({ ...before, revision: before.revision + 1 });
  });

  it("derives the readiness from the connector the selection was admitted against", () => {
    const before = configured();
    const decided: Connector = {
      ...connectorOf(before),
      credential: "missing",
    };
    const next = withSecureMcpChatGptApp(before, selection(), decided);
    expect(next.setup.connect.configured).toBe(false);
    expect(connectorOf(next).credential).toBe("stored");
  });

  it("keeps a pending app check unknown when the name changes", () => {
    const before = configured(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    const next = withSecureMcpChatGptApp(
      before,
      selection(),
      connectorOf(before),
    );
    expect(connectorOf(next).appVerificationPending).toBe(true);
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP credential transform", () => {
  it("records a changed credential and drops runtime proofs", () => {
    const before = withChallengePrepared();
    const next = withSecureMcpCredential(before, "missing");
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      generation: 3,
      credential: "missing",
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      configured: false,
      needsAction:
        "Store the tunnel runtime key in the private connector store.",
    });
  });

  it("is a no-op for the same credential", () => {
    const before = configured();
    expect(withSecureMcpCredential(before, "stored")).toBe(before);
  });

  it("keeps a pending app check unknown", () => {
    const before = configured(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    const next = withSecureMcpCredential(before, "missing");
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP runtime transform", () => {
  const runtimeInput = (overrides: Record<string, unknown> = {}) =>
    secureMcpRuntimeInputSchema.parse({
      state: "ready",
      runtimeGeneration: sha("1"),
      computerGeneration: 1,
      buildId: sha("2"),
      ...overrides,
    });

  it("is admitted only for a configured connector at the current Computer generation", () => {
    expect(secureMcpRuntimeAdmitted(configured(), runtimeInput())).toBe(true);
    expect(
      secureMcpRuntimeAdmitted(
        configured(),
        runtimeInput({ computerGeneration: 2 }),
      ),
    ).toBe(false);
    expect(secureMcpRuntimeAdmitted(base(), runtimeInput())).toBe(false);
    expect(
      secureMcpRuntimeAdmitted(
        configured({ credential: "missing" }),
        runtimeInput(),
      ),
    ).toBe(false);
    expect(
      secureMcpRuntimeAdmitted(configured({ tunnelId: null }), runtimeInput()),
    ).toBe(false);
    expect(
      secureMcpRuntimeAdmitted(
        configured({ tunnelClient: null }),
        runtimeInput(),
      ),
    ).toBe(false);
  });

  it("records a ready runtime at the connector generation and clears proofs", () => {
    const now = clock(LATER);
    const before = withChallengePrepared();
    const next = withSecureMcpRuntime(before, runtimeInput(), now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      runtime: {
        state: "ready",
        connectorGeneration: 2,
        runtimeGeneration: sha("1"),
        computerGeneration: 1,
        buildId: sha("2"),
        observedAt: LATER,
      },
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: null,
      needsAction: "Verify the ChatGPT attachment with a one-time challenge.",
      unavailable: null,
      outcomeUnknown: false,
    });
  });

  it("records an unreachable runtime as a repair step", () => {
    const next = withSecureMcpRuntime(
      configured(),
      runtimeInput({ state: "unreachable" }),
      clock(),
    );
    expect(next.setup.connect).toMatchObject({
      reachable: "unreachable",
      needsAction: "Run connector repair, then check readiness again.",
      outcomeUnknown: false,
    });
  });

  it("keeps an outcome-unknown runtime unknown", () => {
    const next = withSecureMcpRuntime(
      configured(),
      runtimeInput({ state: "outcome_unknown" }),
      clock(),
    );
    expect(connectorOf(next).runtime?.state).toBe("outcome_unknown");
    expect(next.setup.connect).toMatchObject({
      reachable: "unknown",
      needsAction:
        "Inspect the connector before deliberately starting it again.",
      outcomeUnknown: true,
    });
  });

  it.each(["ready", "unreachable"] as const)(
    "a %s runtime does not settle a pending app check",
    (state) => {
      const next = withSecureMcpRuntime(
        configured({ appVerificationPending: true }, { outcomeUnknown: true }),
        runtimeInput({ state }),
        clock(),
      );
      expect(connectorOf(next).appVerificationPending).toBe(true);
      expect(next.setup.connect.outcomeUnknown).toBe(true);
    },
  );
});

describe("secure MCP challenge transform", () => {
  const challengeInput = (overrides: Record<string, unknown> = {}) =>
    secureMcpChallengeInputSchema.parse({
      challenge: challengeValue,
      runtimeGeneration: sha("1"),
      computerGeneration: 1,
      buildId: sha("2"),
      ...overrides,
    });

  it("is admitted only for the ready runtime it names", () => {
    expect(
      secureMcpChallengeAdmitted(withRuntimeReady(), challengeInput()),
    ).toBe(true);
    expect(secureMcpChallengeAdmitted(configured(), challengeInput())).toBe(
      false,
    );
    for (const state of ["unreachable", "outcome_unknown"] as const)
      expect(
        secureMcpChallengeAdmitted(
          configured({ runtime: runtimeRecord({ state }) }),
          challengeInput(),
        ),
      ).toBe(false);
    expect(
      secureMcpChallengeAdmitted(
        configured({ runtime: runtimeRecord({ connectorGeneration: 1 }) }),
        challengeInput(),
      ),
    ).toBe(false);
    expect(
      secureMcpChallengeAdmitted(
        withRuntimeReady(),
        challengeInput({ runtimeGeneration: sha("9") }),
      ),
    ).toBe(false);
    expect(
      secureMcpChallengeAdmitted(
        withRuntimeReady(),
        challengeInput({ buildId: sha("9") }),
      ),
    ).toBe(false);
    expect(
      secureMcpChallengeAdmitted(
        withRuntimeReady(),
        challengeInput({ computerGeneration: 2 }),
      ),
    ).toBe(false);
  });

  it("prepares the challenge with its digest and the clock's time", () => {
    const now = clock(LATER);
    const before = withRuntimeReady({
      attachment: {
        tunnelId: "tunnel-1",
        workspaceId: null,
        connectorGeneration: 2,
        runtimeGeneration: sha("1"),
        computerGeneration: 1,
        buildId: sha("2"),
        challengeSha256: sha("8"),
        receiptSha256: sha("3"),
        verifiedAt: NOW,
      },
    });
    const next = withSecureMcpChallenge(before, challengeInput(), now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next).challenge).toEqual({
      value: challengeValue,
      challengeSha256: challengeHash,
      runtimeGeneration: sha("1"),
      computerGeneration: 1,
      buildId: sha("2"),
      preparedAt: LATER,
    });
    expect(connectorOf(next).attachment).toBeNull();
    expect(connectorOf(next).runtime).toEqual(connectorOf(before).runtime);
    expect(next.setup.connect).toMatchObject({
      reachable: "reachable",
      verified: null,
      needsAction:
        "Attach this connector in ChatGPT, run the one-time challenge, then check its receipt.",
      outcomeUnknown: false,
    });
  });

  it("keeps a pending app check unknown", () => {
    const next = withSecureMcpChallenge(
      withRuntimeReady(
        { appVerificationPending: true },
        { outcomeUnknown: true },
      ),
      challengeInput(),
      clock(),
    );
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP attachment transform", () => {
  const attachmentInput = (overrides: Record<string, unknown> = {}) =>
    secureMcpAttachmentInputSchema.parse({
      workspaceId: null,
      runtimeGeneration: sha("1"),
      computerGeneration: 1,
      buildId: sha("2"),
      challengeSha256: challengeHash,
      receiptSha256: sha("3"),
      ...overrides,
    });

  it("is admitted for the exact runtime, challenge and an empty workspace set", () => {
    expect(
      secureMcpAttachmentAdmitted(withChallengePrepared(), attachmentInput()),
    ).toBe(true);
  });

  it.each([
    ["no tunnel", { tunnelId: null }],
    ["no client", { tunnelClient: null }],
    ["no runtime", { runtime: null }],
    [
      "runtime unreachable",
      { runtime: runtimeRecord({ state: "unreachable" }) },
    ],
    [
      "runtime outcome unknown",
      { runtime: runtimeRecord({ state: "outcome_unknown" }) },
    ],
    [
      "runtime of an older connector",
      { runtime: runtimeRecord({ connectorGeneration: 1 }) },
    ],
    ["no challenge", { challenge: null }],
    [
      "another challenge digest",
      { challenge: challengeRecord({ challengeSha256: sha("7") }) },
    ],
    [
      "challenge from another runtime",
      { challenge: challengeRecord({ runtimeGeneration: sha("7") }) },
    ],
    [
      "challenge from another Computer generation",
      { challenge: challengeRecord({ computerGeneration: 5 }) },
    ],
    [
      "challenge from another build",
      { challenge: challengeRecord({ buildId: sha("7") }) },
    ],
  ])("is refused with %s", (_, connector) => {
    expect(
      secureMcpAttachmentAdmitted(
        withChallengePrepared(connector as Partial<Connector>),
        attachmentInput(),
      ),
    ).toBe(false);
  });

  it.each([
    ["runtime generation", { runtimeGeneration: sha("7") }],
    ["build", { buildId: sha("7") }],
    ["challenge digest", { challengeSha256: sha("7") }],
    ["Computer generation", { computerGeneration: 2 }],
  ])("is refused for another %s", (_, override) => {
    expect(
      secureMcpAttachmentAdmitted(
        withChallengePrepared(),
        attachmentInput(override),
      ),
    ).toBe(false);
  });

  it("is refused for a workspace the settings do not hold, or none when some are held", () => {
    expect(
      secureMcpAttachmentAdmitted(
        withChallengePrepared(),
        attachmentInput({ workspaceId: uuid }),
      ),
    ).toBe(false);
    const held = withVerifiedWorkspace(withChallengePrepared());
    expect(secureMcpAttachmentAdmitted(held, attachmentInput())).toBe(false);
    expect(
      secureMcpAttachmentAdmitted(held, attachmentInput({ workspaceId: uuid })),
    ).toBe(true);
    expect(
      secureMcpAttachmentAdmitted(
        held,
        attachmentInput({
          workspaceId: "32345678-1234-4234-8234-123456789abc",
        }),
      ),
    ).toBe(false);
  });

  it("settles the pending app check with a verified attachment", () => {
    const now = clock(LATER);
    const before = withChallengePrepared(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );
    const next = withSecureMcpAttachment(before, attachmentInput(), now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(next.revision).toBe(before.revision + 1);
    const attachment = {
      tunnelId: "tunnel-1",
      workspaceId: null,
      connectorGeneration: 2,
      runtimeGeneration: sha("1"),
      computerGeneration: 1,
      buildId: sha("2"),
      challengeSha256: challengeHash,
      receiptSha256: sha("3"),
      verifiedAt: LATER,
    };
    expect(connectorOf(next)).toMatchObject({
      challenge: null,
      attachment,
      lastVerifiedAttachment: attachment,
      appVerificationPending: false,
    });
    expect(next.setup.connect).toEqual({
      ...before.setup.connect,
      visited: true,
      skipped: false,
      configured: true,
      reachable: "reachable",
      verified: {
        profile: "farol",
        configRevision: 2,
        workspaceId: null,
        runtimeGeneration: sha("1"),
        buildId: sha("2"),
        protocol: "openai-tunnel-client/v1",
        verifiedAt: LATER,
      },
      needsAction: null,
      unavailable: null,
      outcomeUnknown: false,
    });
  });
});

describe("secure MCP stopped transform", () => {
  const stop = (
    settings: ProductSettings,
    refusal?:
      | "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
      | "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
    purpose: "stop" | "update" = "stop",
    now = clock(),
  ) => withSecureMcpStopped(settings, refusal, purpose, now);

  it("is a no-op when nothing is running and no refusal is given", () => {
    const now = clock();
    const before = configured();
    expect(stop(before, undefined, "update", now)).toBe(before);
    expect(now).not.toHaveBeenCalled();
  });

  it("a plain stop drops runtime, challenge and attachment", () => {
    const now = clock();
    const before = withChallengePrepared();
    const next = stop(before, undefined, "stop", now);
    expect(now).not.toHaveBeenCalled();
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toMatchObject({
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect).toMatchObject({
      reachable: "unknown",
      needsAction: "Start the connector and check readiness.",
      unavailable: null,
      outcomeUnknown: false,
    });
  });

  it("an update drain keeps only a stopped resume intent for a ready runtime", () => {
    const now = clock(LATER);
    const before = withChallengePrepared();
    const next = stop(before, undefined, "update", now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(connectorOf(next)).toMatchObject({
      runtime: {
        state: "unreachable",
        connectorGeneration: 2,
        runtimeGeneration: sha("1"),
        observedAt: LATER,
      },
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect.unavailable).toBe("CONNECTOR_UPDATE_DRAINED");
  });

  it.each([
    ["unreachable", { runtime: runtimeRecord({ state: "unreachable" }) }, {}],
    [
      "outcome unknown",
      { runtime: runtimeRecord({ state: "outcome_unknown" }) },
      {},
    ],
    [
      "of an older connector",
      { runtime: runtimeRecord({ connectorGeneration: 1 }) },
      {},
    ],
    [
      "of another Computer generation",
      { runtime: runtimeRecord({ computerGeneration: 5 }) },
      {},
    ],
    ["under an unknown setup outcome", {}, { outcomeUnknown: true }],
  ])(
    "an update drain keeps no resume intent for a runtime %s",
    (_, connector, connect) => {
      const now = clock();
      const next = stop(
        withRuntimeReady(connector as Partial<Connector>, connect),
        undefined,
        "update",
        now,
      );
      expect(connectorOf(next).runtime).toBeNull();
      expect(now).not.toHaveBeenCalled();
      expect(next.setup.connect.unavailable).toBeNull();
    },
  );

  it.each([
    "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
    "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
  ] as const)("a %s refusal publishes even an idle connector", (refusal) => {
    const before = configured();
    const next = stop(before, refusal, "update");
    expect(next.revision).toBe(before.revision + 1);
    expect(next.setup.connect).toMatchObject({
      needsAction:
        "Choose the tunnel-client executable again before reconnecting.",
      unavailable: refusal,
    });
  });

  it("a refusal never keeps a resume intent", () => {
    const next = stop(
      withRuntimeReady(),
      "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
      "update",
    );
    expect(connectorOf(next).runtime).toBeNull();
  });

  it("keeps a pending app check unknown", () => {
    const next = stop(
      withChallengePrepared(
        { appVerificationPending: true },
        { outcomeUnknown: true },
      ),
    );
    expect(connectorOf(next).appVerificationPending).toBe(true);
    expect(next.setup.connect.outcomeUnknown).toBe(true);
  });
});

describe("secure MCP pending app check", () => {
  it("is recorded only against the current runtime generation", () => {
    expect(secureMcpAppPendingAdmitted(withRuntimeReady(), sha("1"))).toBe(
      true,
    );
    expect(secureMcpAppPendingAdmitted(withRuntimeReady(), sha("9"))).toBe(
      false,
    );
    expect(secureMcpAppPendingAdmitted(configured(), sha("1"))).toBe(false);
    expect(
      secureMcpAppPendingAdmitted(
        configured({ runtime: runtimeRecord({ state: "unreachable" }) }),
        sha("1"),
      ),
    ).toBe(true);
  });

  it("records the uncertainty before the check is dispatched", () => {
    const before = withChallengePrepared();
    const next = withSecureMcpAppPending(before);
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next).appVerificationPending).toBe(true);
    expect(connectorOf(next).challenge).toEqual(connectorOf(before).challenge);
    expect(next.setup.connect).toEqual({
      ...before.setup.connect,
      outcomeUnknown: true,
      needsAction:
        "Check the pending ChatGPT connection result before sending another check.",
    });
  });

  const expectation = (
    overrides: Partial<SecureMcpAppPendingExpectation> = {},
  ): SecureMcpAppPendingExpectation => ({
    tunnelId: "tunnel-1",
    connectorGeneration: 2,
    computerGeneration: 1,
    runtimeGeneration: sha("1"),
    challengeSha256: challengeHash,
    buildId: sha("2"),
    workspaceId: null,
    ...overrides,
  });
  const pending = () =>
    withChallengePrepared(
      { appVerificationPending: true },
      { outcomeUnknown: true },
    );

  it("is clearable only for the exact original binding while unknown", () => {
    expect(secureMcpAppPendingClearable(pending(), expectation())).toBe(true);
    // The fence must actually be set.
    expect(
      secureMcpAppPendingClearable(withChallengePrepared(), expectation()),
    ).toBe(false);
  });

  it.each([
    ["tunnel", { tunnelId: "other" }],
    ["connector generation", { connectorGeneration: 3 }],
    ["Computer generation", { computerGeneration: 2 }],
    ["runtime generation", { runtimeGeneration: sha("9") }],
    ["challenge digest", { challengeSha256: sha("9") }],
    ["build", { buildId: sha("9") }],
    ["workspace", { workspaceId: uuid }],
  ])("is not clearable for another %s", (_, override) => {
    expect(secureMcpAppPendingClearable(pending(), expectation(override))).toBe(
      false,
    );
  });

  it.each([
    ["no runtime", { runtime: null }],
    [
      "an unreachable runtime",
      { runtime: runtimeRecord({ state: "unreachable" }) },
    ],
    [
      "an unknown runtime",
      { runtime: runtimeRecord({ state: "outcome_unknown" }) },
    ],
    ["no challenge", { challenge: null }],
    [
      "a challenge from another runtime",
      { challenge: challengeRecord({ runtimeGeneration: sha("9") }) },
    ],
  ])("is not clearable with %s", (_, connector) => {
    expect(
      secureMcpAppPendingClearable(
        withChallengePrepared(
          {
            appVerificationPending: true,
            ...(connector as Partial<Connector>),
          },
          { outcomeUnknown: true },
        ),
        expectation(),
      ),
    ).toBe(false);
  });

  it("matches the verified workspace selection, not an arbitrary one", () => {
    const held = withVerifiedWorkspace(pending());
    expect(
      secureMcpAppPendingClearable(held, expectation({ workspaceId: uuid })),
    ).toBe(true);
    expect(secureMcpAppPendingClearable(held, expectation())).toBe(false);
  });

  it("clears only the pending flag and the setup fence", () => {
    const before = pending();
    const next = withoutSecureMcpAppPending(before);
    expect(next.revision).toBe(before.revision + 1);
    expect(connectorOf(next)).toEqual({
      ...connectorOf(before),
      appVerificationPending: false,
    });
    expect(next.setup.connect).toEqual({
      ...before.setup.connect,
      outcomeUnknown: false,
      needsAction:
        "The app check stopped before sending. Reconnect to prepare a new challenge.",
    });
  });
});
