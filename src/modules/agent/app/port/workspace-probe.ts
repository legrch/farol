import type { AssignmentIdentity } from "../../domain/assignment";
import type { DelegatedAgentAuthority } from "./execution-authority";

export type AgentWorkspaceProbeRequest = Readonly<{
  identity: AssignmentIdentity;
  authority: DelegatedAgentAuthority;
  focusPath: string;
  threadId: string;
  turnId: string;
  callId: string;
}>;

export type AgentWorkspaceProbeReceipt =
  | Readonly<{ status: "verified" }>
  | Readonly<{
      status: "failed";
      code:
        | "AGENT_WORKSPACE_BINDING_INVALID"
        | "AGENT_WORKSPACE_ALLOWED_PROBE_FAILED"
        | "AGENT_WORKSPACE_OUTSIDE_GRANT_ALLOWED"
        | "AGENT_WORKSPACE_EXCLUSION_ALLOWED";
    }>;

export interface AgentWorkspaceProbe {
  verify(
    request: AgentWorkspaceProbeRequest,
  ): Promise<AgentWorkspaceProbeReceipt>;
}
