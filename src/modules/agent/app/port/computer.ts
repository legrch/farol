import type { AssignmentIdentity } from "../../domain/assignment";
import type { DelegatedAgentAuthority } from "./execution-authority";

export type AgentComputerOperation =
  | Readonly<{ kind: "workspace.read"; relativePath: string }>
  | Readonly<{ kind: "workspace.list"; relativePath: string }>
  | Readonly<{
      kind: "workspace.search";
      relativePath: string;
      pattern: string;
    }>
  | Readonly<{
      kind: "verification.run";
      command: "git.status" | "git.head";
      relativePath: ".";
    }>;

export type AgentComputerOutput =
  | Readonly<{
      kind: "workspace.text";
      text: string;
      bytes: number;
    }>
  | Readonly<{
      kind: "workspace.entries";
      entries: readonly string[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "workspace.matches";
      matches: readonly Readonly<{
        path: string;
        line: number;
        text: string;
        truncated: boolean;
      }>[];
      resultLimited: boolean;
      scanLimited: boolean;
    }>
  | Readonly<{
      kind: "workspace.command";
      command: "git.status" | "git.head";
      relativePath: ".";
      exitCode: 0;
      stdout: string;
      stderr: "";
      outputBytes: number;
      network: "none";
    }>;

export type AgentComputerRequest = Readonly<{
  identity: AssignmentIdentity;
  authority: DelegatedAgentAuthority;
  workspaceId: string;
  operation: AgentComputerOperation;
  threadId: string;
  turnId: string;
  callId: string;
}>;

export type AgentComputerReceipt =
  | Readonly<{ status: "completed"; output: AgentComputerOutput }>
  | Readonly<{
      status: "failed";
      code: string;
      source:
        | "computer-approval"
        | "task-admission"
        | "task-grant"
        | "owner-restriction"
        | "role"
        | "computer-policy"
        | "native-host"
        | "authority-store"
        | "native-workspace";
      retry: "never";
    }>;

export interface AgentComputer {
  execute(request: AgentComputerRequest): Promise<AgentComputerReceipt>;
}
