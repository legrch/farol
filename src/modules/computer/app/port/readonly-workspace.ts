export type ReadonlyWorkspaceDescriptor = Readonly<{
  workspaceId: string;
  root: string;
  deniedPaths: readonly string[];
}>;

export type ReadonlyWorkspaceOperation =
  | Readonly<{ kind: "workspace.read"; relativePath: string }>
  | Readonly<{ kind: "workspace.list"; relativePath: string }>
  | Readonly<{
      kind: "workspace.search";
      relativePath: string;
      pattern: string;
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

export type ReadonlyWorkspaceOutput =
  WorkspaceText | WorkspaceEntries | WorkspaceMatches;

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

export interface ReadonlyWorkspace {
  execute(request: ReadonlyWorkspaceRequest): Promise<ReadonlyWorkspaceResult>;
}
