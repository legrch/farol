import type { ProductSettings } from "../pkg/product-settings/contract";

type Readiness = ProductSettings["setup"]["verify"];
type Workspace = ProductSettings["computer"]["workspaces"][number];

// The Agent step waits for a rejoin of the same assignment when its typed
// recovery says so; the wording in needsAction can change freely.
export function waitsForAgentRejoin(readiness: Readiness): boolean {
  return readiness.recovery === "rejoin_agent";
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
