export type ChatComputerOperation =
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

export type ChatComputerRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  operation: ChatComputerOperation;
}>;

export type ChatComputerOutputValue =
  | Readonly<{
      kind: "workspace.text";
      text: string;
      bytes: number;
      sha256: string;
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

export type ChatComputerOutput = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  relativePath: string;
  operation: ChatComputerOperation;
  output: ChatComputerOutputValue;
}>;

export type ChatComputerFailureSource =
  | "computer-approval"
  | "task-admission"
  | "task-grant"
  | "owner-restriction"
  | "unverified-provenance"
  | "role"
  | "computer-policy"
  | "native-host"
  | "authority-store"
  | "native-workspace"
  | "contract"
  | "contract-transport";

export type ChatComputerResult =
  | Readonly<{ ok: true; value: ChatComputerOutput }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: string;
        source: ChatComputerFailureSource;
        classification: "refused" | "outcome_unknown";
        retry: "never";
      }>;
    }>;

export interface ComputerCapability {
  execute(request: ChatComputerRequest): Promise<ChatComputerResult>;
}
