import type { AssignmentIdentity } from "../../domain/assignment";

export type AgentAuthorityCapability =
  | "workspace.list"
  | "workspace.read"
  | "workspace.search"
  | "verification.run"
  | "workspace.write";

export type AgentWorkspaceScope =
  | Readonly<{
      workspaceId: string;
      mode: "subtree";
      root: string;
      access: "read" | "write";
    }>
  | Readonly<{
      workspaceId: string;
      mode: "exact";
      root: string;
      paths: readonly string[];
      access: "read" | "write";
    }>;

export type AgentAuthorityNarrowing = Readonly<{
  workspaces: readonly AgentWorkspaceScope[];
  capabilities: readonly AgentAuthorityCapability[];
  network: "none" | "approved";
  commands: "none" | "verification";
}>;

export type AgentDelegationRequest = Readonly<{
  identity: AssignmentIdentity;
  parentParticipantId: string;
  participantId: string;
  role: "agent" | "critic";
  mutationOwnership: "none" | "task";
  narrowing?: AgentAuthorityNarrowing;
}>;

export type DelegatedAgentAuthority = Readonly<{
  authorityId: string;
  participantId: string;
  parentParticipantId: string;
  role: "agent" | "critic";
  mutationOwnership: "none" | "task";
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  computerId: string;
  computerGeneration: number;
  workspaces: readonly AgentWorkspaceScope[];
  capabilities: readonly AgentAuthorityCapability[];
  network: "none" | "approved";
  commands: "none" | "verification";
  expiresAt: number;
}>;

export type AgentAuthorityFailureSource =
  | "computer-approval"
  | "task-admission"
  | "task-grant"
  | "owner-restriction"
  | "role"
  | "computer-policy"
  | "native-host"
  | "authority-store";

export type AgentAuthorityDecision =
  | Readonly<{ ok: true; value: DelegatedAgentAuthority }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: "AGENT_AUTHORITY_DENIED" | "AGENT_AUTHORITY_UNAVAILABLE";
        source: AgentAuthorityFailureSource;
        retry: "never";
      }>;
    }>;

export interface AgentAuthorityPort {
  delegate(request: AgentDelegationRequest): Promise<AgentAuthorityDecision>;
}
