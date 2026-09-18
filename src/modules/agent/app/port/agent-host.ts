import type {
  AssignmentIdentity,
  ChildCorrelation,
} from "../../domain/assignment";
import type { DelegatedAgentAuthority } from "./execution-authority";

export type AgentAssignmentIntent =
  | Readonly<{ kind: "compatibility" }>
  | Readonly<{ kind: "product"; objective: string }>;

export type AgentSpawnRequest = Readonly<{
  identity: AssignmentIdentity;
  authority: DelegatedAgentAuthority;
  focus: Readonly<{ initialPaths: readonly string[] }>;
  intent: AgentAssignmentIntent;
}>;

export type AgentSpawnReceipt =
  | Readonly<{
      status: "started";
      correlation: ChildCorrelation;
      // The per-assignment proof the parent must echo when it confirms the
      // authority.  It is retained with the assignment so a host started
      // later can still accept that confirmation from the same parent.
      authorityProof?: string;
    }>
  | Readonly<{ status: "failed"; code: "AGENT_SPAWN_REJECTED" }>
  | Readonly<{ status: "outcome_unknown"; code: "AGENT_SPAWN_ACK_LOST" }>;

export type AgentWaitReceipt =
  | Readonly<{
      status: "running";
      correlation: ChildCorrelation;
    }>
  | Readonly<{
      status: "completed";
      correlation: ChildCorrelation;
      resultRef: string;
      workspaceEnforcement: "verified";
    }>
  | Readonly<{
      status: "failed";
      correlation: ChildCorrelation;
      code: "AGENT_CHILD_FAILED";
    }>
  | Readonly<{
      status: "outcome_unknown";
      correlation: ChildCorrelation;
      code: "AGENT_WAIT_ACK_LOST";
    }>
  // The child could not be observed this time (for example the host did not
  // answer); nothing about it is known, and it may be observed again.
  | Readonly<{
      status: "unobserved";
      correlation: ChildCorrelation;
    }>;

// What a host that did not spawn the child needs to observe it and to serve
// its calls: the current delegated request, which must reproduce the recorded
// delegation, and the retained authority proof.
export type AgentRejoin = Readonly<{
  request: AgentSpawnRequest;
  authorityProof: string;
}>;

export type AgentCancelReceipt =
  | Exclude<
      AgentWaitReceipt,
      Readonly<{ status: "running" }> | Readonly<{ status: "unobserved" }>
    >
  | Readonly<{
      status: "cancelled";
      correlation: ChildCorrelation;
    }>;

export interface AgentHost {
  spawn(request: AgentSpawnRequest): Promise<AgentSpawnReceipt>;
  wait(
    correlation: ChildCorrelation,
    rejoin?: AgentRejoin,
  ): Promise<AgentWaitReceipt>;
  cancel(correlation: ChildCorrelation): Promise<AgentCancelReceipt>;
}
