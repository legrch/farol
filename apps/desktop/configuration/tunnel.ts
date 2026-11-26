import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  connectorConfigured,
  pendingConnectorReadiness,
} from "../../../src/apps/desktop/settings/rules";
import { connectorWorkspaceSelection } from "../../../src/pkg/product-settings/connector-workspace-selection";
import type {
  ProductSettings,
  SecureMcpAppSelectionSchema,
} from "../../../src/pkg/product-settings/contract";
import type {
  secureMcpAttachmentInputSchema,
  secureMcpChallengeInputSchema,
  secureMcpRuntimeInputSchema,
  secureMcpTunnelClientInputSchema,
  secureMcpTunnelInputSchema,
} from "./input";

// The pure settings transforms for the secure MCP connector: the tunnel client,
// tunnel, credential, runtime, challenge, attachment, ChatGPT app selection,
// stopped publication and the pending app check. Each maps the current
// settings to the next value from a validated input and the clock, and each
// predicate decides admission from settings alone; none reads or writes a
// store, a lease or Go authority. The service keeps its single serialized
// writer: it runs these inside `mutate`, `mutateConnector` or `commit`, which
// own revision admission, the outcome-unknown fence and persistence.
//
// Outcome-unknown is preserved, never settled here: the begin transform sets
// the fence, every other transform carries the setup-level fence and a pending
// app check forward (through `pendingConnectorReadiness`, or its own
// `previous.outcomeUnknown` term), and only the exact, proven settlements
// (`withSecureMcpCredentialChangeCompleted`,
// `withSecureMcpCredentialChangeReleased`, `withSecureMcpAttachment`,
// `withoutSecureMcpAppPending`) clear it. The service guards the same fence
// again before and after these run; that is defense in depth, not the owner.

type SecureMcp = ProductSettings["connectors"]["secureMcp"];

export type SecureMcpTunnelClientInput = z.infer<
  typeof secureMcpTunnelClientInputSchema
>;
export type SecureMcpTunnelInput = z.infer<typeof secureMcpTunnelInputSchema>;
export type SecureMcpRuntimeInput = z.infer<typeof secureMcpRuntimeInputSchema>;
export type SecureMcpChallengeInput = z.infer<
  typeof secureMcpChallengeInputSchema
>;
export type SecureMcpAttachmentInput = z.infer<
  typeof secureMcpAttachmentInputSchema
>;
export type SecureMcpAppSelection = z.infer<typeof SecureMcpAppSelectionSchema>;
export type SecureMcpResumeRefusal =
  "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE" | "TUNNEL_CLIENT_EXECUTABLE_UNSAFE";
export type SecureMcpStopPurpose = "stop" | "update";
export type SecureMcpAppPendingExpectation = Readonly<{
  tunnelId: string;
  connectorGeneration: number;
  computerGeneration: number;
  runtimeGeneration: string;
  challengeSha256: string;
  buildId: string;
  workspaceId: string | null;
}>;

export function withSecureMcpTunnelClient(
  settings: ProductSettings,
  input: SecureMcpTunnelClientInput,
  now: () => string,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  const selected = connector.tunnelClient;
  if (
    selected?.executablePath === input.executablePath &&
    selected.executableSha256 === input.executableSha256 &&
    selected.version === input.version &&
    selected.protocol === input.protocol
  ) {
    return settings;
  }
  const next = {
    ...connector,
    generation: connector.generation + 1,
    tunnelClient: { ...input, verifiedAt: now() },
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      connect: pendingConnectorReadiness(settings.setup.connect, next),
    },
  };
}

export function withSecureMcpTunnel(
  settings: ProductSettings,
  input: SecureMcpTunnelInput,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  if (connector.tunnelId === input.tunnelId) return settings;
  const next = {
    ...connector,
    generation: connector.generation + 1,
    tunnelId: input.tunnelId,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      connect: pendingConnectorReadiness(settings.setup.connect, next),
    },
  };
}

// A credential change cannot begin over an unknown outcome: not an unknown
// setup flag, and not an unknown runtime.
export function secureMcpCredentialChangeBlocked(
  settings: ProductSettings,
): boolean {
  return (
    settings.setup.connect.outcomeUnknown ||
    settings.connectors.secureMcp.runtime?.state === "outcome_unknown"
  );
}

// Fences connector use before the credential file is replaced. The pending
// fence is recorded as outcome-unknown so a crash cannot leave an old
// admission pointing at new secret bytes.
export function withSecureMcpCredentialChangeBegun(
  settings: ProductSettings,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...connector,
        generation: connector.generation + 1,
        runtime: null,
        challenge: null,
        attachment: null,
      },
    },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        reachable: "unknown",
        verified: null,
        needsAction: "Inspect the credential change before reconnecting.",
        unavailable: null,
        outcomeUnknown: true,
      },
    },
  };
}

// Only the exact pending credential write may be completed: the fence must be
// set, the generation the one the begin step produced, and the runtime not
// itself unknown.
export function secureMcpCredentialChangeCompletable(
  settings: ProductSettings,
  expectedGeneration: number,
  expectedRevision?: number,
): boolean {
  return (
    settings.setup.connect.outcomeUnknown &&
    settings.connectors.secureMcp.generation === expectedGeneration &&
    (expectedRevision === undefined ||
      settings.revision === expectedRevision) &&
    settings.connectors.secureMcp.runtime?.state !== "outcome_unknown"
  );
}

export function withSecureMcpCredentialChangeCompleted(
  settings: ProductSettings,
  input: SecureMcpTunnelInput,
): ProductSettings {
  const next = {
    ...settings.connectors.secureMcp,
    tunnelId: input.tunnelId,
    credential: "stored" as const,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      // This settlement owns the credential fence, so it alone releases it;
      // an unconfirmed pending app check still holds the flag.
      connect: {
        ...pendingConnectorReadiness(settings.setup.connect, next),
        outcomeUnknown: next.appVerificationPending === true,
      },
    },
  };
}

// The credential owner knows the key write never replaced the key (the store
// failed before its rename, or never ran), so the fence it set may go back.
// It is bound to the exact fenced document: the generation the begin step
// produced and the revision it published. Any other write moves the revision,
// so a fence that something else touched is never released here.
export function secureMcpCredentialChangeReleasable(
  settings: ProductSettings,
  expected: Readonly<{ generation: number; revision: number }>,
): boolean {
  return (
    settings.setup.connect.outcomeUnknown &&
    settings.connectors.secureMcp.appVerificationPending !== true &&
    settings.connectors.secureMcp.generation === expected.generation &&
    settings.revision === expected.revision &&
    settings.connectors.secureMcp.runtime?.state !== "outcome_unknown"
  );
}

// Releases the credential fence and nothing else. The begin step already
// invalidated the runtime, challenge and attachment, and bumped the
// generation, so those stay invalid; the credential is untouched because the
// old key is still the one on disk.
export function withSecureMcpCredentialChangeReleased(
  settings: ProductSettings,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  return {
    ...settings,
    revision: settings.revision + 1,
    setup: {
      ...settings.setup,
      connect: {
        ...pendingConnectorReadiness(settings.setup.connect, connector),
        outcomeUnknown: connector.appVerificationPending === true,
      },
    },
  };
}

// The selection is refused over an unknown outcome, and when the tunnel or
// connector generation it was made for has moved.
export function secureMcpAppSelectionRefusal(
  settings: ProductSettings,
  selection: SecureMcpAppSelection,
):
  | "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
  | "CONNECTOR_APP_VERIFICATION_STATE_CHANGED"
  | null {
  const connector = settings.connectors.secureMcp;
  if (
    settings.setup.connect.outcomeUnknown ||
    connector.runtime?.state === "outcome_unknown"
  )
    return "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN";
  if (
    connector.tunnelId !== selection.tunnelId ||
    connector.generation !== selection.connectorGeneration
  )
    return "CONNECTOR_APP_VERIFICATION_STATE_CHANGED";
  return null;
}

// `decided` is the connector the selection was admitted against; the pending
// readiness message is derived from it, not from the committed value.
export function withSecureMcpChatGptApp(
  settings: ProductSettings,
  selection: SecureMcpAppSelection,
  decided: SecureMcp,
): ProductSettings {
  const changed = decided.chatgptApp?.name !== selection.name;
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...settings.connectors.secureMcp,
        chatgptApp: selection,
        ...(changed ? { attachment: null, lastVerifiedAttachment: null } : {}),
      },
    },
    ...(changed
      ? {
          setup: {
            ...settings.setup,
            connect: pendingConnectorReadiness(
              settings.setup.connect,
              decided,
              "Check the selected app in ChatGPT.",
            ),
          },
        }
      : {}),
  };
}

export function withSecureMcpCredential(
  settings: ProductSettings,
  credential: SecureMcp["credential"],
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  if (connector.credential === credential) return settings;
  const next = {
    ...connector,
    generation: connector.generation + 1,
    credential,
    runtime: null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      connect: pendingConnectorReadiness(settings.setup.connect, next),
    },
  };
}

// A runtime observation needs a configured connector and the current Computer
// generation.
export function secureMcpRuntimeAdmitted(
  settings: ProductSettings,
  input: SecureMcpRuntimeInput,
): boolean {
  return (
    connectorConfigured(settings.connectors.secureMcp) &&
    input.computerGeneration === settings.computer.generation
  );
}

export function withSecureMcpRuntime(
  settings: ProductSettings,
  input: SecureMcpRuntimeInput,
  now: () => string,
): ProductSettings {
  const current = settings.connectors.secureMcp;
  const observedAt = now();
  const runtime = {
    ...input,
    connectorGeneration: current.generation,
    observedAt,
  };
  const ready = input.state === "ready";
  const outcomeUnknown = input.state === "outcome_unknown";
  const next = { ...current, runtime, challenge: null, attachment: null };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        visited: true,
        skipped: false,
        configured: true,
        reachable: ready
          ? "reachable"
          : outcomeUnknown
            ? "unknown"
            : "unreachable",
        verified: null,
        needsAction: ready
          ? "Verify the ChatGPT attachment with a one-time challenge."
          : outcomeUnknown
            ? "Inspect the connector before deliberately starting it again."
            : "Run connector repair, then check readiness again.",
        unavailable: null,
        outcomeUnknown:
          outcomeUnknown ||
          settings.setup.connect.outcomeUnknown ||
          current.appVerificationPending === true,
      },
    },
  };
}

// A challenge needs a ready runtime of the current connector generation that
// matches its runtime, Computer generation and build.
export function secureMcpChallengeAdmitted(
  settings: ProductSettings,
  input: SecureMcpChallengeInput,
): boolean {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  return !(
    runtime?.state !== "ready" ||
    runtime.connectorGeneration !== connector.generation ||
    runtime.runtimeGeneration !== input.runtimeGeneration ||
    runtime.computerGeneration !== input.computerGeneration ||
    runtime.buildId !== input.buildId ||
    input.computerGeneration !== settings.computer.generation
  );
}

export function withSecureMcpChallenge(
  settings: ProductSettings,
  input: SecureMcpChallengeInput,
  now: () => string,
): ProductSettings {
  const current = settings.connectors.secureMcp;
  const { challenge: value, ...proof } = input;
  const challenge = {
    ...proof,
    value,
    challengeSha256: createHash("sha256").update(value).digest("hex"),
    preparedAt: now(),
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: { ...current, challenge, attachment: null },
    },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction:
          "Attach this connector in ChatGPT, run the one-time challenge, then check its receipt.",
        unavailable: null,
        outcomeUnknown:
          settings.setup.connect.outcomeUnknown ||
          current.appVerificationPending === true,
      },
    },
  };
}

// An attachment must name the exact tunnel, client, ready runtime, prepared
// challenge, Computer generation and (when present) a known workspace.
export function secureMcpAttachmentAdmitted(
  settings: ProductSettings,
  input: SecureMcpAttachmentInput,
): boolean {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
  return !(
    connector.tunnelId === null ||
    connector.tunnelClient === null ||
    runtime?.state !== "ready" ||
    runtime.connectorGeneration !== connector.generation ||
    runtime.runtimeGeneration !== input.runtimeGeneration ||
    runtime.computerGeneration !== input.computerGeneration ||
    runtime.buildId !== input.buildId ||
    challenge?.challengeSha256 !== input.challengeSha256 ||
    challenge.runtimeGeneration !== input.runtimeGeneration ||
    challenge.computerGeneration !== input.computerGeneration ||
    challenge.buildId !== input.buildId ||
    !(input.workspaceId === null
      ? settings.computer.workspaces.length === 0
      : settings.computer.workspaces.some(
          (workspace) => workspace.workspaceId === input.workspaceId,
        )) ||
    input.computerGeneration !== settings.computer.generation
  );
}

// A proven app-pending settlement, not a generic dismissal: the exact
// challenge, runtime, Computer and workspace were admitted beforehand.
export function withSecureMcpAttachment(
  settings: ProductSettings,
  input: SecureMcpAttachmentInput,
  now: () => string,
): ProductSettings {
  const current = settings.connectors.secureMcp;
  const verifiedAt = now();
  const attachment = {
    ...input,
    tunnelId: current.tunnelId as string,
    connectorGeneration: current.generation,
    verifiedAt,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...current,
        challenge: null,
        attachment,
        lastVerifiedAttachment: attachment,
        appVerificationPending: false,
      },
    },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: {
          profile: current.profile,
          configRevision: current.generation,
          workspaceId: input.workspaceId,
          runtimeGeneration: input.runtimeGeneration,
          buildId: input.buildId,
          protocol: current.tunnelClient?.protocol as string,
          verifiedAt,
        },
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

// Publishes a stopped connector. After a known update drain it keeps only a
// stopped, generation-bound resume intent: never live readiness, no new proof,
// and never carried over an unknown outcome.
export function withSecureMcpStopped(
  settings: ProductSettings,
  resumeRefusal: SecureMcpResumeRefusal | undefined,
  purpose: SecureMcpStopPurpose,
  now: () => string,
): ProductSettings {
  const connector = settings.connectors.secureMcp;
  if (
    connector.runtime === null &&
    connector.challenge === null &&
    connector.attachment === null &&
    resumeRefusal === undefined
  ) {
    return settings;
  }
  const next = {
    ...connector,
    runtime:
      purpose === "update" &&
      resumeRefusal === undefined &&
      connector.runtime?.state === "ready" &&
      connector.runtime.connectorGeneration === connector.generation &&
      connector.runtime.computerGeneration === settings.computer.generation &&
      !settings.setup.connect.outcomeUnknown
        ? {
            ...connector.runtime,
            state: "unreachable" as const,
            observedAt: now(),
          }
        : null,
    challenge: null,
    attachment: null,
  };
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: { ...settings.connectors, secureMcp: next },
    setup: {
      ...settings.setup,
      connect: {
        ...pendingConnectorReadiness(
          settings.setup.connect,
          next,
          resumeRefusal === undefined
            ? undefined
            : "Choose the tunnel-client executable again before reconnecting.",
        ),
        unavailable:
          next.runtime !== null
            ? "CONNECTOR_UPDATE_DRAINED"
            : (resumeRefusal ?? null),
      },
    },
  };
}

// The app check is recorded as pending before it is dispatched, so a lost
// reply or restart can never turn the attempt back into a retry. Only the
// current runtime may be marked.
export function secureMcpAppPendingAdmitted(
  settings: ProductSettings,
  runtimeGeneration: string,
): boolean {
  return (
    settings.connectors.secureMcp.runtime?.runtimeGeneration ===
    runtimeGeneration
  );
}

export function withSecureMcpAppPending(
  settings: ProductSettings,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...settings.connectors.secureMcp,
        appVerificationPending: true,
      },
    },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        outcomeUnknown: true,
        needsAction:
          "Check the pending ChatGPT connection result before sending another check.",
      },
    },
  };
}

// The route may report that no click occurred after dispatch intent was
// recorded. Only that exact attempt's uncertainty may be cleared: the fence
// must be set and every binding unchanged; anything else stays unknown.
export function secureMcpAppPendingClearable(
  settings: ProductSettings,
  expected: SecureMcpAppPendingExpectation,
): boolean {
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
  return !(
    !settings.setup.connect.outcomeUnknown ||
    settings.computer.generation !== expected.computerGeneration ||
    connectorWorkspaceSelection(settings) !== expected.workspaceId ||
    connector.tunnelId !== expected.tunnelId ||
    connector.generation !== expected.connectorGeneration ||
    runtime?.state !== "ready" ||
    runtime.runtimeGeneration !== expected.runtimeGeneration ||
    runtime.buildId !== expected.buildId ||
    challenge?.challengeSha256 !== expected.challengeSha256 ||
    challenge.runtimeGeneration !== expected.runtimeGeneration
  );
}

export function withoutSecureMcpAppPending(
  settings: ProductSettings,
): ProductSettings {
  return {
    ...settings,
    revision: settings.revision + 1,
    connectors: {
      ...settings.connectors,
      secureMcp: {
        ...settings.connectors.secureMcp,
        appVerificationPending: false,
      },
    },
    setup: {
      ...settings.setup,
      connect: {
        ...settings.setup.connect,
        outcomeUnknown: false,
        needsAction:
          "The app check stopped before sending. Reconnect to prepare a new challenge.",
      },
    },
  };
}
