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
