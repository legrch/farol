import type {
  HandoffModelBinding,
  HandoffWorkspace,
} from "../service/persistent-codex-handoff";
export type ClaudeRequest = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
  message: string;
  modelBinding: HandoffModelBinding;
}>;
export type ClaudeIntent = Readonly<{
  sessionId: string;
  requestDigest: string;
  workspaceId: string;
  projectId: string;
  workspace: HandoffWorkspace;
  modelBinding: HandoffModelBinding;
}>;
export type ClaudeTerminal = Readonly<{
  lifecycle: "completed" | "failed" | "needs_input";
  sessionId: string;
  actualModel: string;
  exitCode: number;
  text: string;
}>;
export type ClaudeSnapshot = Readonly<{
  state: "running" | "exited";
  stdout: string;
  exitCode: number | null;
  exitSignal: string | null;
  groupCleanup: "pending" | "confirmed" | "unverified";
  truncated: boolean;
  interrupted: boolean;
}>;
export interface ClaudeProcessHost {
  supports(binding: HandoffModelBinding): Promise<boolean>;
  start(request: ClaudeRequest, workspace: HandoffWorkspace): Promise<string>;
  read(handle: string): Promise<ClaudeSnapshot>;
}
export interface ClaudeJournal {
  read(key: string): Promise<ClaudeIntent | null>;
  claim(key: string, value: ClaudeIntent): Promise<boolean>;
  terminal(key: string): Promise<ClaudeTerminal | null>;
  finish(key: string, value: ClaudeTerminal): Promise<ClaudeTerminal>;
}
export type ClaudeCreate =
  | Readonly<{
      status: "dispatched";
      dispatchId: string;
      sessionId: string;
      evidence: "local-process-start";
      nativeVisibility: "not-qualified";
    }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>;
export type ClaudeStatus =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  | Readonly<{ status: "refused"; code: string }>
  | Readonly<{
      status: "known";
      dispatchId: string;
      sessionId: string;
      lifecycle: "running" | ClaudeTerminal["lifecycle"];
      actualModel: string;
      configuredModel: string;
      proof: "local-process" | "recorded-terminal";
      nativeVisibility: "not-qualified";
      text: string;
      exitCode: number | null;
    }>;

export interface ClaudeCommandRunner {
  start(
    request: Readonly<{
      key: string;
      workspaceId: string;
      command: string;
      stdin: string;
      deadlineAt: number;
    }>,
  ): Promise<string>;
  read(handle: string): Promise<ClaudeSnapshot>;
}
