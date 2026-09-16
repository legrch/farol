export type MutableWorkspaceDescriptor = Readonly<{
  workspaceId: string;
  root: string;
  deniedPaths: readonly string[];
  writeDeniedPaths: readonly string[];
}>;

export type WorkspaceTextEdit = Readonly<{
  oldText: string;
  newText: string;
}>;

export type WorkspaceMutationOperation =
  | Readonly<{
      kind: "workspace.write";
      relativePath: string;
      content: string;
      expectedSha256: string | null;
    }>
  | Readonly<{
      kind: "workspace.edit";
      relativePath: string;
      edits: readonly WorkspaceTextEdit[];
      expectedSha256: string;
    }>;

export type WorkspaceMutationRequest = Readonly<{
  workspace: MutableWorkspaceDescriptor;
  operation: WorkspaceMutationOperation;
}>;

export type WorkspaceMutationReceipt = Readonly<{
  kind: "workspace.mutation";
  operation: "edit" | "write";
  relativePath: string;
  bytes: number;
  replacements: number;
  beforeSha256: string | null;
  afterSha256: string;
}>;

export type WorkspaceMutationErrorCode =
  | "WORKSPACE_INVALID_REQUEST"
  | "WORKSPACE_HELPER_UNTRUSTED"
  | "WORKSPACE_INTERPRETER_UNTRUSTED"
  | "WORKSPACE_PATH_REFUSED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_NOT_A_FILE"
  | "WORKSPACE_FILE_TOO_LARGE"
  | "WORKSPACE_MUTATION_CONFLICT"
  | "WORKSPACE_NOT_TEXT"
  | "WORKSPACE_EDIT_NO_MATCH"
  | "WORKSPACE_EDIT_NOT_UNIQUE"
  | "WORKSPACE_EDIT_OVERLAP"
  | "WORKSPACE_HELPER_FAILED"
  | "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";

export type WorkspaceMutationResult =
  | Readonly<{ ok: true; value: WorkspaceMutationReceipt }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: WorkspaceMutationErrorCode;
        retry: "never";
      }>;
    }>;

export interface MutableWorkspace {
  mutate(request: WorkspaceMutationRequest): Promise<WorkspaceMutationResult>;
}
