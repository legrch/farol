import {
  ProductSettingsSchema,
  type ProductConfigurationSnapshot,
  type ProductSettings,
  type SetupStepId,
} from "../../../pkg/product-settings/contract";

// Pure invalidation and readiness rules over ProductSettings: no IO, no clock,
// no store. Moved verbatim from product-configuration.ts.

export function settingsError(error: unknown): ProductConfigurationSnapshot {
  const message = error instanceof Error ? error.message : "";
  if (message === "CONFIG_RENAME_REQUIRED") {
    return { status: "error", error: "CONFIG_RENAME_REQUIRED" };
  }
  if (message === "SETTINGS_CORRUPT") {
    return { status: "error", error: "SETTINGS_CORRUPT" };
  }
  if (message === "SETTINGS_UNSAFE") {
    return { status: "error", error: "SETTINGS_UNSAFE" };
  }
  return { status: "error", error: "SETTINGS_READ_FAILED" };
}

export function readiness(
  needsAction: string,
): ProductSettings["setup"][SetupStepId] {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

export function withoutRecovery(
  readiness: ProductSettings["setup"]["verify"],
): ProductSettings["setup"]["verify"] {
  const { recovery: _recovery, ...rest } = readiness;
  return rest;
}

export function pendingAgentReadiness(
  previous: ProductSettings["setup"]["verify"],
  needsAction: string,
  configured: boolean,
): ProductSettings["setup"]["verify"] {
  return {
    ...withoutRecovery(previous),
    configured,
    reachable: "unknown",
    verified: null,
    needsAction,
    unavailable: null,
    outcomeUnknown: false,
  };
}

// A Computer verification stands only for a workspace that carries the folder
// identity it bound. Settings written before identities existed name workspaces
// without one; their verification is withdrawn at load and at every commit, so
// no consumer can treat that pathname as the folder the owner approved. Only a
// new explicit verification measures and records the identity.
export function invalidateUnboundComputerVerification(
  settings: ProductSettings,
): ProductSettings {
  const verification = settings.setup.computer.verified;
  if (!verification) return settings;
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === verification.workspaceId,
  );
  if (workspace?.rootIdentity) return settings;
  return {
    ...settings,
    setup: {
      ...settings.setup,
      computer: {
        ...settings.setup.computer,
        reachable: "unknown",
        verified: null,
        needsAction: workspace
          ? `Verify ${workspace.label} again so Farol binds it to the folder you approved.`
          : "Verify a folder.",
      },
    },
  };
}

export function advanceComputerApprovalGeneration(
  previous: ProductSettings,
  candidate: ProductSettings,
  // The owner policy these settings approve, with a fixed expiry. Supplied by
  // the caller so these rules import no Computer module internals.
  approvedPolicy: (settings: ProductSettings) => unknown,
): ProductSettings {
  // Compare the actual owner policy with a fixed expiry, so evidence renewal
  // alone does not invalidate existing approvals.
  if (
    JSON.stringify(approvedPolicy(previous)) ===
    JSON.stringify(approvedPolicy(candidate))
  )
    return candidate;

  const previousGeneration = previous.computer.generation;
  const generation = previousGeneration + 1;
  const verification = candidate.setup.computer.verified;
  return {
    ...candidate,
    computer: {
      ...candidate.computer,
      generation,
      // Preserve the candidate's effective policy when advancing its seal.
      // Evidence already stale in the previous generation stays stale.
      workspaces: candidate.computer.workspaces.map((workspace) =>
        workspace.accessCheck?.computerGeneration === previousGeneration
          ? {
              ...workspace,
              accessCheck: {
                ...workspace.accessCheck,
                computerGeneration: generation,
              },
            }
          : workspace,
      ),
    },
    setup: {
      ...candidate.setup,
      computer: {
        ...candidate.setup.computer,
        verified:
          verification?.configRevision === previousGeneration
            ? { ...verification, configRevision: generation }
            : verification,
      },
    },
  };
}

export function invalidateStaleAgentVerification(
  settings: ProductSettings,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  const verification = host?.agentVerification;
  if (!host || !verification) return settings;

  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === verification.workspaceId,
  );
  const computerVerification = settings.setup.computer.verified;
  const liveVerification = host.liveVerification;
  const current =
    host.executableSha256 === verification.executableSha256 &&
    host.schemaSha256 === verification.schemaSha256 &&
    liveVerification?.executableSha256 === verification.executableSha256 &&
    liveVerification.schemaSha256 === verification.schemaSha256 &&
    liveVerification.buildId === verification.buildId &&
    settings.computer.generation === verification.computerGeneration &&
    workspace !== undefined &&
    computerVerification?.workspaceId === verification.workspaceId &&
    computerVerification.configRevision === verification.computerGeneration &&
    computerVerification.buildId === verification.buildId &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown;
  if (current) return settings;

  return {
    ...settings,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: { ...host, agentVerification: null },
    },
    setup: {
      ...settings.setup,
      verify: pendingAgentReadiness(
        settings.setup.verify,
        liveVerification
          ? "Run the native Agent lineage check."
          : "Run the live Codex host check first.",
        liveVerification !== null,
      ),
    },
  };
}

export function invalidateStaleCodexTaskSource(
  settings: ProductSettings,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  const source = host?.taskSource;
  // Older settings remain readable without inventing source support or migrating
  // unrelated host/Computer evidence. Root treats missing Task evidence as absent.
  if (!host || !source) return settings;
  const local = host.localVerification;
  const bound =
    source.hostGeneration === settings.nativeHosts.generation &&
    local !== null &&
    local.executableSha256 === host.executableSha256 &&
    local.schemaSha256 === host.schemaSha256 &&
    source.localVerification.executableSha256 === local.executableSha256 &&
    source.localVerification.schemaSha256 === local.schemaSha256 &&
    source.localVerification.buildId === local.buildId &&
    source.localVerification.verifiedAt === local.verifiedAt &&
    [source.evidence.handoff, source.evidence.followup].every(
      (witness) =>
        witness.executablePath === host.executablePath &&
        witness.executableSha256 === host.executableSha256 &&
        witness.baseSchemaSha256 === host.schemaSha256,
    ) &&
    (source.evidence.handoff.status !== "supported" ||
      source.evidence.handoff.contract.version === host.version);
  if (bound) return settings;
  return {
    ...settings,
    nativeHosts: {
      ...settings.nativeHosts,
      generation:
        source.hostGeneration === settings.nativeHosts.generation
          ? settings.nativeHosts.generation + 1
          : settings.nativeHosts.generation,
      codex: { ...host, taskSource: null },
      taskRoute: null,
    },
  };
}

export function connectorConfigured(
  connector: ProductSettings["connectors"]["secureMcp"],
): boolean {
  return (
    connector.tunnelClient !== null &&
    connector.tunnelId !== null &&
    connector.credential === "stored"
  );
}

export function pendingConnectorReadiness(
  previous: ProductSettings["setup"]["connect"],
  connector: ProductSettings["connectors"]["secureMcp"],
  needsAction?: string,
): ProductSettings["setup"]["connect"] {
  const configured = connectorConfigured(connector);
  const nextAction =
    needsAction ??
    (connector.tunnelClient === null
      ? "Choose the verified tunnel-client executable."
      : connector.tunnelId === null
        ? "Enter the OpenAI tunnel ID."
        : connector.credential === "missing"
          ? "Store the tunnel runtime key in the private connector store."
          : "Start the connector and check readiness.");
  return {
    ...previous,
    configured,
    reachable: "unknown",
    verified: null,
    needsAction: nextAction,
    unavailable: null,
    outcomeUnknown: connector.appVerificationPending === true,
  };
}

export function invalidateStaleConnectorRuntime(
  settings: ProductSettings,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
  const attachment = connector.attachment;
  const runtimeCurrent =
    runtime === null ||
    (runtime.connectorGeneration === connector.generation &&
      runtime.computerGeneration === settings.computer.generation);
  const challengeCurrent =
    challenge === null ||
    (runtime?.state === "ready" &&
      challenge.runtimeGeneration === runtime.runtimeGeneration &&
      challenge.computerGeneration === settings.computer.generation &&
      challenge.buildId === runtime.buildId);
  const attachmentCurrent =
    attachment === null ||
    (runtime?.state === "ready" &&
      attachment.connectorGeneration === connector.generation &&
      attachment.runtimeGeneration === runtime.runtimeGeneration &&
      attachment.computerGeneration === settings.computer.generation &&
      attachment.buildId === runtime.buildId &&
      attachment.tunnelId === connector.tunnelId);
  if (runtimeCurrent && challengeCurrent && attachmentCurrent) return settings;

  const invalidated = {
    ...connector,
    generation: connector.generation + 1,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    connectors: { ...settings.connectors, secureMcp: invalidated },
    setup: {
      ...settings.setup,
      connect: pendingConnectorReadiness(
        settings.setup.connect,
        invalidated,
        "Restart the connector after changing Computer authority.",
      ),
    },
  };
}

export function defaultSettings(id: () => string): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "home",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: id(),
      generation: 1,
      name: "This Mac",
      commands: "none",
      workspaces: [],
      pendingEdit: null,
    },
    nativeHosts: { generation: 1, codex: null },
    connectors: {
      secureMcp: {
        generation: 1,
        profile: "farol",
        tunnelId: null,
        tunnelClient: null,
        credential: "missing",
        runtime: null,
        challenge: null,
        attachment: null,
      },
    },
    setup: {
      journey: { currentStep: "chatgpt", dismissed: false },
      chatgpt: readiness("Sign in to the isolated Farol browser."),
      computer: readiness("Add a read-only workspace."),
      connect: readiness("Configure the Farol-only Computer connection."),
      hosts: readiness("Review one scoped native host integration."),
      verify: readiness("Run each configured capability check."),
    },
  });
}
