import type {
  AssignmentIdentity,
  ChildCorrelation,
} from "../../domain/assignment";
import type { DelegatedAgentAuthority } from "./execution-authority";

export type AgentSpawnRequest = Readonly<{
  identity: AssignmentIdentity;
  authority: DelegatedAgentAuthority;
  focus: Readonly<{ initialPaths: readonly string[] }>;
}>;

export type AgentSpawnReceipt =
  | Readonly<{ status: "started"; correlation: ChildCorrelation }>
  | Readonly<{ status: "failed"; code: "AGENT_SPAWN_REJECTED" }>
  | Readonly<{ status: "outcome_unknown"; code: "AGENT_SPAWN_ACK_LOST" }>;

export type AgentWaitReceipt =
  | Readonly<{
      status: "completed";
      correlation: ChildCorrelation;
      resultRef: string;
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
    }>;

export interface AgentHost {
  spawn(request: AgentSpawnRequest): Promise<AgentSpawnReceipt>;
  wait(correlation: ChildCorrelation): Promise<AgentWaitReceipt>;
}
