import type { ProductSettings } from "../pkg/product-settings/contract";

type Readiness = ProductSettings["setup"]["verify"];
type Workspace = ProductSettings["computer"]["workspaces"][number];

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
  const workspace = workspaces[0];
  if (workspace === undefined) return false;
  return (
    computer.verified?.workspaceId !== workspace.workspaceId ||
    computer.verified.configRevision !== generation
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

// Why the connection's "Start & check" cannot be pressed yet, or null when
// it can.
//
// The button is disabled by five conditions and used to name none of them.
// Four are visible in the row beside it — the client, the tunnel, the key,
// and a runtime that is already running — but the fifth is not mentioned
// anywhere on the surface: starting the connector needs an approved
// workspace, which lives in Computer. An owner who had correctly chosen a
// client, pasted a tunnel id and stored a key saw a dead primary action with
// every requirement it named already satisfied.
//
// The button's disabled state is derived from this function rather than
// re-deriving the same predicate beside it, so the reason and the state
// cannot drift apart the way the readiness label and its state once did.
export function connectorStartPrerequisite(
  connector: Readonly<{
    tunnelClient: unknown | null;
    tunnelId: string | null;
    credential: "missing" | "stored";
    runtime: Readonly<{ state: string }> | null;
  }>,
  workspaceCount: number,
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
  if (workspaceCount === 0) {
    return "Approve at least one workspace in Computer first. The connector serves that workspace, so it cannot start without one.";
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
