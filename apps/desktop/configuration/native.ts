import type { z } from "zod";
import {
  pendingAgentReadiness,
  withoutRecovery,
} from "../../../src/apps/desktop/settings/rules";
import type {
  CodexAgentVerificationFieldsSchema,
  CodexTaskSelection,
  ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type {
  chatGptObservationSchema,
  codexAgentFailureSchema,
  codexHostFailureSchema,
  codexHostInputSchema,
  codexHostLiveFailureSchema,
  codexHostLiveInputSchema,
} from "./input";

// The pure settings transforms for the ChatGPT observation and the Codex host,
// its live and Agent verification and the task route. Each maps the current
// settings to the next value from a validated input and the clock; none reads
// or writes a store, a lease or Go authority. The service keeps its single
// serialized writer: it runs these inside `commit`, which owns revision
// admission, invalidation, authority withdrawal and persistence.

export type ChatGptObservation = z.infer<typeof chatGptObservationSchema>;
export type CodexHostInput = z.infer<typeof codexHostInputSchema>;
export type CodexHostFailure = z.infer<typeof codexHostFailureSchema>;
export type CodexHostLiveInput = z.infer<typeof codexHostLiveInputSchema>;
export type CodexHostLiveFailure = z.infer<typeof codexHostLiveFailureSchema>;
export type CodexAgentFailure = z.infer<typeof codexAgentFailureSchema>;
export type CodexAgentVerificationFields = z.infer<
  typeof CodexAgentVerificationFieldsSchema
>;

// A live verification can only name the host that is currently selected.
export function codexHostMatchesLiveInput(
  settings: ProductSettings,
  live: CodexHostLiveInput,
): boolean {
  const selected = settings.nativeHosts.codex;
  return (
    !!selected &&
    selected.executableSha256 === live.executableSha256 &&
    selected.schemaSha256 === live.schemaSha256
  );
}

// An Agent verification must agree with the selected host, its live check, the
// verified Computer workspace and a reachable, settled Computer step.
export function codexAgentVerificationAdmitted(
  settings: ProductSettings,
  verification: CodexAgentVerificationFields,
): boolean {
  const host = settings.nativeHosts.codex;
  const liveVerification = host?.liveVerification;
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === verification.workspaceId,
  );
  const computerVerification = settings.setup.computer.verified;
  return !(
    !host ||
    !liveVerification ||
    host.executableSha256 !== verification.executableSha256 ||
    host.schemaSha256 !== verification.schemaSha256 ||
    liveVerification.executableSha256 !== verification.executableSha256 ||
    liveVerification.schemaSha256 !== verification.schemaSha256 ||
    liveVerification.buildId !== verification.buildId ||
    verification.computerGeneration !== settings.computer.generation ||
    !workspace ||
    computerVerification?.workspaceId !== verification.workspaceId ||
    computerVerification.configRevision !== verification.computerGeneration ||
    computerVerification.buildId !== verification.buildId ||
    settings.setup.computer.reachable !== "reachable" ||
    settings.setup.computer.outcomeUnknown
  );
}

export function withChatGptObservation(
  settings: ProductSettings,
  observation: ChatGptObservation,
  now: () => string,
  preserveOutcomeUnknown: boolean,
): ProductSettings {
  const revision = settings.revision + 1;
  const common = {
    ...settings.setup.chatgpt,
    visited: true,
    skipped: false,
    // A sign-in window returning cannot settle an unrelated task/write.
    // Read the flag inside the existing serialized writer, not before it.
    outcomeUnknown: preserveOutcomeUnknown
      ? settings.setup.chatgpt.outcomeUnknown
      : false,
  };
  let chatgpt: ProductSettings["setup"]["chatgpt"];
  switch (observation.state) {
    case "authenticated":
      chatgpt = {
        ...common,
        configured: true,
        reachable: "reachable",
        verified: {
          profile: observation.profile,
          configRevision: 1,
          workspaceId: null,
          runtimeGeneration: observation.runtimeGeneration,
          buildId: observation.buildId,
          protocol: observation.protocol,
          verifiedAt: now(),
        },
        needsAction: null,
        unavailable: null,
      };
      break;
    case "signed_out":
      chatgpt = {
        ...common,
        configured: false,
        reachable: "reachable",
        verified: null,
        needsAction: "Sign in to ChatGPT in the isolated Farol window.",
        unavailable: null,
      };
      break;
    case "unreachable":
      chatgpt = {
        ...common,
        configured: false,
        reachable: "unreachable",
        verified: null,
        needsAction:
          "Open the isolated ChatGPT window and check network access.",
        unavailable: null,
      };
      break;
    case "unsupported":
      chatgpt = {
        ...common,
        configured: false,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable:
          "The ChatGPT page loaded, but this build could not verify its composer.",
      };
      break;
    case "outcome_unknown":
      chatgpt = {
        ...common,
        configured: true,
        reachable: "unknown",
        verified: null,
        needsAction:
          "Inspect the isolated ChatGPT window before starting another task.",
        unavailable: null,
        outcomeUnknown: true,
      };
      break;
  }
  return {
    ...settings,
    revision,
    setup: { ...settings.setup, chatgpt },
  };
}

export function withCodexHost(
  settings: ProductSettings,
  host: CodexHostInput,
  now: () => string,
): ProductSettings {
  const previous = settings.nativeHosts.codex;
  const sameContract =
    previous?.executablePath === host.executablePath &&
    previous.executableSha256 === host.executableSha256 &&
    previous.version === host.version &&
    previous.protocol === host.protocol &&
    previous.schemaSha256 === host.schemaSha256;
  const sameTaskSource =
    JSON.stringify(previous?.taskSource?.evidence ?? null) ===
      JSON.stringify(host.taskSource) &&
    (previous?.taskSource == null ||
      previous.taskSource.localVerification.buildId === host.buildId);
  const withdrawRoute =
    settings.nativeHosts.taskRoute !== null &&
    host.taskSource?.handoff.status !== "supported";
  const generation =
    sameContract && sameTaskSource && !withdrawRoute
      ? settings.nativeHosts.generation
      : settings.nativeHosts.generation + 1;
  const verifiedAt = now();
  const localVerification = {
    executableSha256: host.executableSha256,
    schemaSha256: host.schemaSha256,
    buildId: host.buildId,
    verifiedAt,
  };
  const taskSource =
    host.taskSource === null
      ? null
      : {
          hostGeneration: generation,
          localVerification,
          evidence: host.taskSource,
        };
  const liveVerification =
    sameContract && previous.liveVerification?.buildId === host.buildId
      ? previous.liveVerification
      : null;
  const agentVerification =
    sameContract && previous.agentVerification?.buildId === host.buildId
      ? previous.agentVerification
      : null;
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      generation,
      taskRoute:
        sameContract &&
        sameTaskSource &&
        host.taskSource?.handoff.status === "supported"
          ? settings.nativeHosts.taskRoute
          : null,
      codex: {
        executablePath: host.executablePath,
        executableSha256: host.executableSha256,
        version: host.version,
        protocol: host.protocol,
        schemaSha256: host.schemaSha256,
        verifiedAt,
        localVerification,
        taskSource,
        liveVerification,
        agentVerification,
      },
    },
    setup: {
      ...settings.setup,
      hosts: {
        ...settings.setup.hosts,
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: liveVerification
          ? {
              profile: "codex.app-server.live/1",
              configRevision: generation,
              workspaceId: null,
              runtimeGeneration: host.executableSha256,
              buildId: liveVerification.buildId,
              protocol: host.protocol,
              verifiedAt: liveVerification.verifiedAt,
            }
          : null,
        needsAction: liveVerification ? null : "Run the live Codex host check.",
        unavailable: null,
        outcomeUnknown: false,
      },
      verify: agentVerification
        ? settings.setup.verify
        : pendingAgentReadiness(
            settings.setup.verify,
            liveVerification
              ? "Run the native Agent lineage check."
              : "Run the live Codex host check first.",
            liveVerification !== null,
          ),
    },
  };
}

export function withCodexHostLiveVerification(
  settings: ProductSettings,
  live: CodexHostLiveInput,
  now: () => string,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  if (!host) return settings;
  const verifiedAt = now();
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: {
        ...host,
        liveVerification: {
          ...live,
          dynamicTool: "farol_ping",
          verifiedAt,
        },
      },
    },
    setup: {
      ...settings.setup,
      hosts: {
        ...settings.setup.hosts,
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: {
          profile: "codex.app-server.live/1",
          configRevision: settings.nativeHosts.generation,
          workspaceId: null,
          runtimeGeneration: live.executableSha256,
          buildId: live.buildId,
          protocol: host.protocol,
          verifiedAt,
        },
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
      verify: host.agentVerification
        ? settings.setup.verify
        : pendingAgentReadiness(
            settings.setup.verify,
            "Run the native Agent lineage check.",
            true,
          ),
    },
  };
}

export function withCodexAgentVerification(
  settings: ProductSettings,
  verification: CodexAgentVerificationFields,
  now: () => string,
): ProductSettings {
  const selected = settings.nativeHosts.codex;
  if (!selected) return settings;
  const verifiedAt = now();
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: {
        ...selected,
        agentVerification: { ...verification, verifiedAt },
      },
    },
    setup: {
      ...settings.setup,
      verify: {
        ...withoutRecovery(settings.setup.verify),
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: {
          profile: "codex.native-agent.lineage/1",
          configRevision: settings.revision + 1,
          workspaceId: verification.workspaceId,
          runtimeGeneration: verification.executableSha256,
          buildId: verification.buildId,
          protocol: verification.transport,
          verifiedAt,
        },
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  };
}

export function withCodexAgentFailure(
  settings: ProductSettings,
  failure: CodexAgentFailure,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  if (!host) return settings;
  const outcomeUnknown = failure === "outcome_unknown";
  const running = failure === "running";
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: { ...host, agentVerification: null },
    },
    setup: {
      ...settings.setup,
      verify: {
        ...withoutRecovery(settings.setup.verify),
        ...(running || outcomeUnknown
          ? { recovery: "rejoin_agent" as const }
          : {}),
        visited: true,
        skipped: false,
        configured: host.liveVerification !== null,
        reachable:
          outcomeUnknown || running || failure === "workspace_not_verified"
            ? "unknown"
            : "unreachable",
        verified: null,
        needsAction:
          failure === "workspace_not_verified"
            ? "Verify read access to one workspace first."
            : running
              ? "Rejoin the same native Agent assignment to collect its result."
              : outcomeUnknown
                ? "Inspect and explicitly rejoin the same native Agent assignment before another launch."
                : "Recheck the native Agent contract before running it again.",
        unavailable: null,
        outcomeUnknown,
      },
    },
  };
}

export function withCodexHostLiveFailure(
  settings: ProductSettings,
  failure: CodexHostLiveFailure,
): ProductSettings {
  const host = settings.nativeHosts.codex;
  if (!host) return settings;
  const outcomeUnknown = failure === "outcome_unknown";
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      ...settings.nativeHosts,
      codex: {
        ...host,
        liveVerification: null,
        agentVerification: null,
      },
    },
    setup: {
      ...settings.setup,
      hosts: {
        ...settings.setup.hosts,
        visited: true,
        skipped: false,
        configured: true,
        reachable:
          failure === "model_unavailable"
            ? "reachable"
            : outcomeUnknown
              ? "unknown"
              : "unreachable",
        verified: null,
        needsAction: outcomeUnknown
          ? "Inspect the Codex host before deliberately running another live check."
          : failure === "failed"
            ? "Recheck the selected Codex executable, then run the live check again."
            : null,
        unavailable:
          failure === "model_unavailable"
            ? "The selected host does not offer gpt-6-astra without provider fallback."
            : null,
        outcomeUnknown,
      },
      verify: pendingAgentReadiness(
        settings.setup.verify,
        outcomeUnknown
          ? "Resolve the live Codex host outcome before checking Agent lineage."
          : "Run the live Codex host check first.",
        false,
      ),
    },
  };
}

export function withCodexHostFailure(
  settings: ProductSettings,
  failure: CodexHostFailure,
): ProductSettings {
  const selected = settings.nativeHosts.codex;
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: selected
      ? {
          generation: settings.nativeHosts.generation + 1,
          taskRoute: null,
          codex: {
            ...selected,
            localVerification: null,
            liveVerification: null,
            agentVerification: null,
          },
        }
      : settings.nativeHosts,
    setup: {
      ...settings.setup,
      hosts: {
        ...settings.setup.hosts,
        visited: true,
        skipped: false,
        configured: selected !== null,
        reachable: failure === "unreachable" ? "unreachable" : "reachable",
        verified: null,
        needsAction:
          failure === "unreachable"
            ? "Choose the Codex executable again or restore it, then recheck."
            : null,
        unavailable:
          failure === "unsupported"
            ? "This Codex build does not expose the required bounded App Server contract."
            : null,
        outcomeUnknown: false,
      },
      verify: pendingAgentReadiness(
        settings.setup.verify,
        "Run the live Codex host check first.",
        false,
      ),
    },
  };
}

export function withoutCodexHost(settings: ProductSettings): ProductSettings {
  if (settings.nativeHosts.codex === null) return settings;
  return {
    ...settings,
    revision: settings.revision + 1,
    nativeHosts: {
      generation: settings.nativeHosts.generation + 1,
      codex: null,
      taskRoute: null,
    },
    setup: {
      ...settings.setup,
      hosts: {
        ...settings.setup.hosts,
        visited: true,
        skipped: false,
        configured: false,
        reachable: "unknown",
        verified: null,
        needsAction: "Choose a Codex executable to verify.",
        unavailable: null,
        outcomeUnknown: false,
      },
      verify: pendingAgentReadiness(
        settings.setup.verify,
        "Choose and verify a Codex host first.",
        false,
      ),
    },
  };
}

export function withCodexTaskRoute(
  current: ProductSettings,
  selected: CodexTaskSelection,
  expectedRevision: number | undefined,
  now: () => string,
): ProductSettings {
  if (current.revision !== expectedRevision)
    throw new Error("CODEX_TASK_ROUTE_STALE");
  const workspace = current.computer.workspaces.find(
    (entry) => entry.workspaceId === selected.workspaceId,
  );
  const nowMillis = Date.parse(now());
  if (
    !current.nativeHosts.codex?.localVerification ||
    selected.hostGeneration !== current.nativeHosts.generation ||
    selected.computerGeneration !== current.computer.generation ||
    current.setup.computer.verified?.workspaceId !== selected.workspaceId ||
    current.setup.computer.verified.configRevision !==
      current.computer.generation ||
    !workspace?.rootIdentity ||
    workspace.gitMetadata?.commonDirectory !== selected.gitCommonDirectory ||
    (selected.execution.sandbox === "workspace-write" &&
      workspace.access !== "write") ||
    selected.expiresAt <= nowMillis ||
    selected.expiresAt > nowMillis + 12 * 60 * 60 * 1_000
  ) {
    throw new Error("CODEX_TASK_ROUTE_STALE");
  }
  return {
    ...current,
    revision: current.revision + 1,
    nativeHosts: { ...current.nativeHosts, taskRoute: selected },
  };
}

export function withoutCodexTaskRoute(
  settings: ProductSettings,
): ProductSettings {
  return settings.nativeHosts.taskRoute === null
    ? settings
    : {
        ...settings,
        revision: settings.revision + 1,
        nativeHosts: { ...settings.nativeHosts, taskRoute: null },
      };
}
