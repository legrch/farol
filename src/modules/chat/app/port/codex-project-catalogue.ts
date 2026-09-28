export type ProjectMatch = Readonly<{ projectId: string; name: string | null }>;
export type ProjectCatalogueResult =
  | Readonly<{
      status: "resolved" | "missing" | "ambiguous" | "stale_preference";
      complete: true;
      pages: number;
      matches: readonly ProjectMatch[];
      selectedProjectId: string | null;
      selection: "unique-root" | "requested-id" | null;
    }>
  | Readonly<{ status: "unavailable"; complete: false; code: string }>;

export interface CodexProjectCatalogueHost {
  request(
    method: "project/list",
    params: Readonly<{ cursor: string | null; limit: 100 }>,
    deadlineAt?: number,
  ): Promise<unknown>;
}

export type ProjectResolutionResult =
  | (ProjectCatalogueResult &
      Readonly<{
        workspaceId: string;
        writerRoot: string;
        projectRoot: string;
      }>)
  | Readonly<{ status: "refused"; workspaceId: string; code: string }>;
