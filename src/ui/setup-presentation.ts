import type {
  ProductConfigurationEvidence,
  ProductSettings,
} from "../pkg/product-settings/contract";

type Readiness = ProductSettings["setup"]["verify"];
type Workspace = ProductSettings["computer"]["workspaces"][number];
type DevProofEvidence = Extract<
  ProductConfigurationEvidence,
  { kind: "dev-proof.prepared" | "dev-proof.verified" }
>;

export function devProofEvidenceCurrent(
  evidence: DevProofEvidence,
  current: Readonly<{
    buildId: string;
    computerGeneration: number;
    workspaceIds: readonly string[];
    runtime: Readonly<{
      state: "ready" | "unreachable" | "outcome_unknown";
      runtimeGeneration: string;
      computerGeneration: number;
      buildId: string;
    }> | null;
    attachment: Readonly<{
      workspaceId: string | null;
      runtimeGeneration: string;
      computerGeneration: number;
      buildId: string;
    }> | null;
  }>,
): boolean {
  if (
    evidence.buildId !== current.buildId ||
    evidence.computerGeneration !== current.computerGeneration ||
    !current.workspaceIds.includes(evidence.workspaceId)
  ) {
    return false;
  }
  if (evidence.kind === "dev-proof.prepared") return true;
  const runtime = current.runtime;
  const attachment = current.attachment;
  return (
    runtime?.state === "ready" &&
    runtime.runtimeGeneration === evidence.runtimeGeneration &&
    runtime.computerGeneration === evidence.computerGeneration &&
    runtime.buildId === evidence.buildId &&
    attachment !== null &&
    attachment.workspaceId === evidence.workspaceId &&
    attachment.runtimeGeneration === evidence.runtimeGeneration &&
    attachment.computerGeneration === evidence.computerGeneration &&
    attachment.buildId === evidence.buildId
  );
}

// The Agent step waits for a rejoin of the same assignment when its typed
// recovery says so; the wording in needsAction can change freely.
export function waitsForAgentRejoin(readiness: Readiness): boolean {
  return readiness.recovery === "rejoin_agent";
}

// One source of truth for whether a route can be used right now. Before this
// existed, the header, the New task control, the Setup checklist and
// Settings each inlined their own predicate over `SetupReadiness`, and they
// drifted out of agreement (UX34-03/04: header said "ready for a new task"
// while Setup said "Complete Setup" and the sidebar still read its unrelated
// default text). Every caller that answers "can the owner use this route
// right now" must go through this function instead of re-deriving it.
export type RouteReadinessState =
  | "not-configured"
  | "action-required"
  | "checking"
  | "ready"
  | "failed"
  | "outcome-unknown";

export type SetupRouteId = "chatgpt" | "computer" | "connect" | "agent";

// `checking` cannot be derived from a settings snapshot alone — it names an
// operation in flight, which is caller-owned UI state (e.g. the in-progress
// text shown while `configureProduct` awaits its IPC round trip). Every
// other state is a pure function of the persisted readiness record.
export function routeReadiness(
  readiness: Readiness,
  options: Readonly<{ checking?: boolean; stale?: boolean }> = {},
): RouteReadinessState {
  if (options.checking) return "checking";
  if (readiness.outcomeUnknown) return "outcome-unknown";
  if (readiness.verified !== null && !options.stale) return "ready";
  if (readiness.unavailable !== null) return "failed";
  if (readiness.reachable === "unreachable") return "failed";
  if (readiness.needsAction !== null) return "action-required";
  // A stale verification (the owner's earlier success no longer matches the
  // current build/workspace/config generation) still needs an explicit
  // recheck, exactly like an unconfirmed `needsAction` — never silently
  // "ready", and never demoted all the way back to "not-configured".
  if (readiness.verified !== null) return "action-required";
  if (readiness.reachable === "reachable" || readiness.configured) {
    return "action-required";
  }
  return "not-configured";
}

// DEV's owned App Server contract is a complete local readiness check. The
// separately persisted `setup.hosts` verification is intentionally stricter:
// it records the premium-model host/tool turn that remains an Agent
// prerequisite. Basic onboarding must not relabel that advanced turn as the
// local host check or require it to call the installed host ready.
export function localHostRouteReadiness(
  contractVerified: boolean,
  advancedReadiness: Readiness,
): RouteReadinessState {
  return contractVerified ? "ready" : routeReadiness(advancedReadiness);
}

type LocalHostContract = Pick<
  NonNullable<ProductSettings["nativeHosts"]["codex"]>,
  "localVerification"
>;

type LocalHostSummary = Pick<
  NonNullable<ProductSettings["nativeHosts"]["codex"]>,
  "localVerification" | "protocol" | "version"
>;

export function localHostContractVerified(
  host: LocalHostContract | null,
): boolean {
  return host !== null && host.localVerification !== null;
}

export function devHostSetupSummary(
  host: LocalHostSummary,
  readiness: Readiness,
): string {
  if (localHostContractVerified(host)) {
    return `Local host ready. Codex ${host.version} and ${host.protocol} were verified without a model turn. Test model is a separate disclosed send; Agent keeps its advanced gate.`;
  }
  const failure = readiness.unavailable ?? readiness.needsAction;
  return `Codex ${host.version} remains selected, but its local App Server contract is not verified. Recheck local host without a model turn.${failure ? ` ${failure}` : ""} Test model and Agent qualification remain separate owner-triggered steps.`;
}

// Whether the Computer verification on record still describes the workspace
// and config generation in front of the owner.
//
// One definition, because three surfaces must not disagree about it: the
// Settings row computed it, the Setup step did not, and the Setup progress
// dot did not either — so a verification the setup had outgrown showed an
// amber row in Settings and "Verified", with a completed dot, in Setup.
export function computerVerificationStale(
  computer: Readiness,
  workspaces: readonly Workspace[],
  generation: number,
): boolean {
  const verified = computer.verified;
  if (verified === null) return false;
  return (
    verified.configRevision !== generation ||
    !workspaces.some(
      (workspace) => workspace.workspaceId === verified.workspaceId,
    )
  );
}

// The staleness that applies to a given setup step. Steps with no staleness
// concept answer false rather than undefined, so a caller cannot silently
// forget to ask.
export function setupStepStale(
  settings: ProductSettings,
  stepId: string,
): boolean {
  return stepId === "computer"
    ? computerVerificationStale(
        settings.setup.computer,
        settings.computer.workspaces,
        settings.computer.generation,
      )
    : false;
}

// What the owner reads for a route, in the same order `routeReadiness`
// decides it.
//
// These two used to live in shell.ts and answered a different question from
// the state beside them. Both began `if (readiness.verified) return
// "Verified"`, so a route carrying an earlier proof read "Verified" while
// its own state was `outcome-unknown` — the one thing this product must
// never do — and a stale proof read "Verified" beside the amber border that
// `routeReadiness(..., { stale })` had already decided. The label and the
// state must come from the same order, so the order lives here once.
export function readinessLabel(
  readiness: Readiness,
  options: Readonly<{ stale?: boolean }> = {},
): string {
  if (readiness.outcomeUnknown) return "Outcome unknown";
  if (readiness.verified !== null && !options.stale) return "Verified";
  if (readiness.unavailable) return "Unavailable";
  if (readiness.reachable === "unreachable") return "Unreachable";
  if (readiness.needsAction) return "Needs action";
  // An earlier success that no longer matches the current workspace or
  // config generation. It is not a failure and not a fresh verification.
  if (readiness.verified !== null) return "Verify again";
  if (readiness.reachable === "reachable") return "Reachable · verify";
  if (readiness.configured) return "Configured · verify";
  return "Needs action";
}

export function readinessDetail(
  readiness: Readiness,
  options: Readonly<{ stale?: boolean }> = {},
): string {
  const verifiedAt = (verified: NonNullable<Readiness["verified"]>): string =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(verified.verifiedAt));
  if (readiness.outcomeUnknown) {
    return readiness.verified !== null
      ? `The last attempt ended with an unknown outcome. The earlier verification of ${verifiedAt(readiness.verified)} does not describe it.`
      : "The last attempt ended with an unknown outcome.";
  }
  if (readiness.verified !== null && !options.stale) {
    return `Verified ${verifiedAt(readiness.verified)}`;
  }
  if (readiness.verified !== null) {
    return `Verified ${verifiedAt(readiness.verified)}, and that verification no longer matches the current setup. Verify it again.`;
  }
  return (
    readiness.needsAction ??
    readiness.unavailable ??
    (readiness.reachable === "unreachable"
      ? "The configured route could not be reached."
      : "No verification has been recorded.")
  );
}

// One prerequisite projection keeps the Start button and its explanation aligned.
// A configured connection can serve an empty catalogue without file access.
export function connectorStartPrerequisite(
  connector: Readonly<{
    tunnelClient: unknown | null;
    tunnelId: string | null;
    credential: "missing" | "stored";
    runtime: Readonly<{ state: string }> | null;
  }>,
  attachmentCheckPending: boolean,
): string | null {
  if (connector.tunnelClient === null) {
    return "Choose the tunnel client first.";
  }
  if (connector.tunnelId === null) {
    return "Enter the tunnel ID and save the route first.";
  }
  if (connector.credential !== "stored") {
    return "Save the runtime key for this tunnel first.";
  }
  if (connector.runtime?.state === "ready" && !attachmentCheckPending) {
    return "The connector is already running.";
  }
  return null;
}

// Codex/Agent is two setup steps — the host selection/contract and the
// native Agent lineage check — presented to the owner as one route. It is
// "ready" only once the Agent lineage check itself has a verified record; a
// verified host with no Agent check yet is "action-required", and a hosts
// failure or unknown outcome always wins over a stale-but-present verify
// record.
export function agentRouteReadiness(
  hosts: Readiness,
  verify: Readiness,
  options: Readonly<{ checking?: boolean }> = {},
): RouteReadinessState {
  if (options.checking) return "checking";
  if (hosts.outcomeUnknown || verify.outcomeUnknown) return "outcome-unknown";
  if (verify.verified !== null) return "ready";
  if (hosts.unavailable !== null || verify.unavailable !== null) {
    return "failed";
  }
  if (hosts.reachable === "unreachable") return "failed";
  if (hosts.verified === null) {
    return hosts.needsAction !== null ||
      hosts.reachable === "reachable" ||
      hosts.configured
      ? "action-required"
      : "not-configured";
  }
  // The host is verified; the Agent lineage check itself is still pending.
  return "action-required";
}

// The header reports whether a task route exists, not how many tasks are
// open: a verified ChatGPT route with no tasks is ready for a new one.
export function windowModeLabel(
  state: Readonly<{
    demoMode: boolean;
    taskCount: number;
    chatGptReady: boolean;
  }>,
): string {
  if (state.demoMode) return "Explicit demo · synthetic provider";
  if (state.taskCount > 0) return "Local preview · isolated ChatGPT tasks";
  return state.chatGptReady
    ? "Local preview · ready for a new task"
    : "Local preview · no task route configured";
}

// What a workspace actually allows: its own access, plus the fixed Git
// verification commands when the Computer approves them.
export function workspaceAccessLabel(
  workspace: Pick<Workspace, "access">,
  commands: ProductSettings["computer"]["commands"],
): string {
  const access = workspace.access === "write" ? "guarded edits" : "read-only";
  return commands === "verification" ? `${access} · fixed Git checks` : access;
}

/**
 * Why the connector's client cannot be replaced right now, or null.
 *
 * Replacing the client under a running connector is refused, and the button
 * said so only by being grey.
 */
export function connectorChoosePrerequisite(running: boolean): string | null {
  return running ? "Stop the connector before replacing its client." : null;
}

/** Why the connector cannot be stopped, or null when it can. */
export function connectorStopPrerequisite(hasRuntime: boolean): string | null {
  return hasRuntime ? null : "The connector is not running.";
}

/**
 * Why a native-host action needs a host first, or null when one is selected.
 *
 * `action` is the verb this control performs, so one function serves the
 * row's several buttons without any of them re-deriving the condition.
 */
export function nativeHostActionPrerequisite(
  hostSelected: boolean,
  action: string,
): string | null {
  return hostSelected
    ? null
    : `Choose a Codex executable before you ${action} it.`;
}

export type SetupConnectPrimary = Readonly<{
  hidden: boolean;
  label: string;
  disabled: boolean;
  /** Why it is disabled, or null when it is not. */
  reason: string | null;
}>;

/** Setup and Settings share the same connection prerequisites. */
export function setupConnectPrimary(
  connector: Readonly<{
    tunnelClient: unknown | null;
    tunnelId: string | null;
    credential: "missing" | "stored";
    runtime: Readonly<{ state: string }> | null;
    challenge: unknown | null;
  }>,
): SetupConnectPrimary {
  if (connector.tunnelClient === null) {
    return { hidden: true, label: "", disabled: true, reason: null };
  }
  if (connector.tunnelId === null || connector.credential === "missing") {
    return {
      hidden: false,
      label: "Save connector",
      disabled: false,
      reason: null,
    };
  }
  const attachmentCheckPending =
    connector.runtime?.state === "ready" && connector.challenge !== null;
  const label =
    connector.runtime?.state === "outcome_unknown"
      ? "Repair explicitly"
      : connector.runtime?.state === "ready"
        ? attachmentCheckPending
          ? "Check attachment"
          : "Connection verified"
        : "Start & check";
  const reason = connectorStartPrerequisite(connector, attachmentCheckPending);
  return { hidden: false, label, disabled: reason !== null, reason };
}

/**
 * The words on a Settings connections row, for a route whose tone comes from
 * the merged route state.
 *
 * The row's colour came from routeStateForLabel — the merged, stale-aware
 * state, where agentRouteReadiness checks outcome-unknown first and the
 * Computer route knows whether its verification has been outgrown. The words
 * came from readinessLabel on the raw per-field record, which knows neither.
 * So "Native Agent · Verified" appeared beside a route-unknown tone, and
 * "Computer · Verified" beside a stale one.
 *
 * The record still supplies the nuance the state cannot express — Unreachable
 * against Unavailable, Reachable · verify against Configured · verify — but
 * it can no longer say Verified for a route that is not.
 */
export function routeRowLabel(
  state: RouteReadinessState,
  readiness: Readiness,
): string {
  if (state === "outcome-unknown") return "Outcome unknown";
  if (state === "ready") return "Verified";
  return readinessLabel(readiness, { stale: true });
}

export function routeRowDetail(
  state: RouteReadinessState,
  readiness: Readiness,
): string {
  if (state === "outcome-unknown") {
    return readinessDetail({ ...readiness, outcomeUnknown: true });
  }
  if (state === "ready") return readinessDetail(readiness);
  return readinessDetail(readiness, { stale: true });
}

export type AgentVerifyStepPresentation = Readonly<{
  summary: string;
  label: string;
  disabled: boolean;
}>;

/**
 * Setup's verify step: the sentence, the button's caption and whether it can
 * be pressed.
 *
 * The sentence tested outcomeUnknown; the caption did not test it at all. So
 * with an unknown outcome and a child still running, the sentence said to
 * inspect the existing Codex task before deliberate recovery while the button
 * directly beneath it offered "Rejoin Agent".
 *
 * Outcome-unknown comes first here, ahead of any earlier proof, for the same
 * reason agentRouteReadiness puts it first: an earlier verification does not
 * describe the attempt that ended unknown.
 */
export function agentVerifyStepPresentation(
  state: Readonly<{
    outcomeUnknown: boolean;
    proof: Readonly<{ model: string; workspaceEnforcement: string }> | null;
    needsRejoin: boolean;
    prerequisitesReady: boolean;
  }>,
): AgentVerifyStepPresentation {
  if (state.outcomeUnknown) {
    return {
      summary:
        "The native Agent outcome is unknown. Inspect the existing Codex task before deliberate recovery.",
      label: "Agent outcome unknown",
      disabled: true,
    };
  }
  if (state.proof !== null) {
    return {
      summary:
        state.proof.workspaceEnforcement === "verified"
          ? `Main → Agent → Critic completed with one ${state.proof.model} turn, verified native workspace enforcement, and durable acknowledged delivery.`
          : `Main → Agent → Critic completed with one ${state.proof.model} turn and durable acknowledged delivery. Native workspace enforcement remains not verified.`,
      label: "Agent verified",
      disabled: true,
    };
  }
  if (state.needsRejoin) {
    return {
      summary:
        "The same native child is still running. Rejoin it without creating another child or model turn.",
      label: "Rejoin Agent",
      disabled: !state.prerequisitesReady,
    };
  }
  return state.prerequisitesReady
    ? {
        summary:
          "Ready to verify lineage, unchanged TaskGrant transport, bounded same-child rejoin and durable parent delivery.",
        label: "Verify Agent",
        disabled: false,
      }
    : {
        summary:
          "Run the live Codex host check and verify one workspace first.",
        label: "Verify Agent",
        disabled: true,
      };
}

/**
 * Why the connector's route cannot be edited or saved, or null when it can.
 *
 * The tunnel field, the key field and Save route are all disabled while the
 * connector runs, beside a Replace-client button that now says so. These
 * three said nothing.
 */
export function connectorRoutePrerequisite(
  running: boolean,
  hasClient: boolean,
): string | null {
  if (running) return "Stop the connector before changing its route.";
  if (!hasClient) return "Choose the tunnel client first.";
  return null;
}
