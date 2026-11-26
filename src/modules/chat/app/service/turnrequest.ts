import type { HandoffWorkspace } from "../port/handoff";

type Execution = HandoffWorkspace["execution"];

/** Thread-level sandbox kind the provider echoes back from `thread/start`. */
export function sandboxType(
  execution: Execution,
): "readOnly" | "workspaceWrite" {
  return execution.sandbox === "read-only" ? "readOnly" : "workspaceWrite";
}

/** Per-turn sandbox policy derived from the approved workspace. */
export function sandboxPolicy(workspace: HandoffWorkspace) {
  return workspace.execution.sandbox === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : {
        type: "workspaceWrite",
        writableRoots: [workspace.root],
        networkAccess: false,
      };
}

export function threadReadParams(threadId: string | undefined) {
  return { threadId, includeTurns: false };
}

export function latestTurnsParams(threadId: string | undefined, limit: number) {
  return {
    threadId,
    cursor: null,
    limit,
    sortDirection: "desc",
    itemsView: "notLoaded",
  };
}

export function threadStartParams(
  projectId: string,
  workspace: HandoffWorkspace,
  model: string,
) {
  return {
    projectId,
    cwd: workspace.root,
    ephemeral: false,
    model,
    sandbox: workspace.execution.sandbox,
    approvalPolicy: workspace.execution.approvalPolicy,
    allowProviderModelFallback: false,
  };
}

export function turnStartParams(
  threadId: string | undefined,
  message: string,
  workspace: HandoffWorkspace,
  model: string | undefined,
  effort: string | undefined,
) {
  return {
    threadId,
    input: [{ type: "text", text: message }],
    cwd: workspace.root,
    model,
    ...(effort === undefined ? {} : { effort }),
    approvalPolicy: workspace.execution.approvalPolicy,
    sandboxPolicy: sandboxPolicy(workspace),
  };
}

export function steerParams(
  threadId: string | undefined,
  expectedTurnId: string,
  message: string,
  clientUserMessageId: string,
) {
  return {
    threadId,
    expectedTurnId,
    input: [{ type: "text", text: message }],
    clientUserMessageId,
  };
}
