export type ReadonlyWorkspaceDescriptor = Readonly<{
  workspaceId: string;
  root: string;
  deniedPaths: readonly string[];
  exactFilePaths?: readonly string[];
}>;

export type WorkspaceVerificationCommand = "git.status" | "git.head";

export type ReadonlyWorkspaceOperation =
  | Readonly<{ kind: "workspace.read"; relativePath: string }>
  | Readonly<{ kind: "workspace.list"; relativePath: string }>
  | Readonly<{
      kind: "workspace.search";
      relativePath: string;
      pattern: string;
    }>
  | Readonly<{
      kind: "verification.run";
      command: WorkspaceVerificationCommand;
      relativePath: ".";
    }>;

export type ReadonlyWorkspaceRequest = Readonly<{
  workspace: ReadonlyWorkspaceDescriptor;
  operation: ReadonlyWorkspaceOperation;
}>;

export type WorkspaceText = Readonly<{
  kind: "workspace.text";
  text: string;
  bytes: number;
}>;

export type WorkspaceEntries = Readonly<{
  kind: "workspace.entries";
  entries: readonly string[];
  truncated: boolean;
}>;

export type WorkspaceMatch = Readonly<{
  path: string;
  line: number;
  text: string;
  truncated: boolean;
}>;

export type WorkspaceMatches = Readonly<{
  kind: "workspace.matches";
  matches: readonly WorkspaceMatch[];
  resultLimited: boolean;
  scanLimited: boolean;
}>;

export type WorkspaceCommandOutput = Readonly<{
  kind: "workspace.command";
  command: WorkspaceVerificationCommand;
  relativePath: ".";
  exitCode: 0;
  stdout: string;
  stderr: "";
  outputBytes: number;
  network: "none";
}>;

export type ReadonlyWorkspaceOutput =
  WorkspaceText | WorkspaceEntries | WorkspaceMatches | WorkspaceCommandOutput;

export type ReadonlyWorkspaceErrorCode =
  | "WORKSPACE_INVALID_REQUEST"
  | "WORKSPACE_HELPER_UNTRUSTED"
  | "WORKSPACE_INTERPRETER_UNTRUSTED"
  | "WORKSPACE_PATH_REFUSED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_A_FILE"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_RACE_DETECTED"
  | "WORKSPACE_SEARCH_TIMEOUT"
  | "WORKSPACE_NOT_TEXT"
  | "WORKSPACE_COMMAND_UNSUPPORTED"
  | "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE"
  | "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED"
  | "WORKSPACE_COMMAND_CANCELLED"
  | "WORKSPACE_COMMAND_TIMEOUT"
  | "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE"
  | "WORKSPACE_COMMAND_FAILED"
  | "WORKSPACE_HELPER_FAILED";

export type ReadonlyWorkspaceResult =
  | Readonly<{ ok: true; value: ReadonlyWorkspaceOutput }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: ReadonlyWorkspaceErrorCode;
        retry: "never";
      }>;
    }>;

export type ReadonlyWorkspaceExecutionContext = Readonly<{
  signal?: AbortSignal;
}>;

export interface ReadonlyWorkspace {
  execute(
    request: ReadonlyWorkspaceRequest,
    context?: ReadonlyWorkspaceExecutionContext,
  ): Promise<ReadonlyWorkspaceResult>;
}
