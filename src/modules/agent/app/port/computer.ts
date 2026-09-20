import type { AssignmentIdentity } from "../../domain/assignment";
import type { DelegatedAgentAuthority } from "./execution-authority";

export type AgentComputerOperation =
  | Readonly<{
      kind: "workspace.read";
      relativePath: string;
      range?: Readonly<{ offset: number; length: number }> | undefined;
    }>
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
      page?: Readonly<{
        offset: number;
        size: number;
        nextOffset: number | null;
      }>;
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
      coverage: "tracked-files-only" | "head-commit";
      layout: "primary" | "linked-worktree";
    }>;

export type AgentComputerRequest = Readonly<{
  identity: AssignmentIdentity;
  authority: DelegatedAgentAuthority;
  workspaceId: string;
  operation: AgentComputerOperation;
  threadId: string;
  turnId: string;
  callId: string;
  signal?: AbortSignal;
}>;

export type AgentComputerReceipt =
  | Readonly<{ status: "completed"; output: AgentComputerOutput }>
  | Readonly<{
      status: "failed";
      code: string;
      // "unverified-provenance": denied by a restriction whose provenance
      // could not be verified — see `AgentAuthorityFailureSource`.
      source:
        | "computer-approval"
        | "task-admission"
        | "task-grant"
        | "owner-restriction"
        | "unverified-provenance"
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
