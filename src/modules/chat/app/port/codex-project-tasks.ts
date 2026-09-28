export type ProjectTaskScope =
  "selected-writer" | "canonical-and-selected-writer";

export type ProjectTasksRequest = Readonly<{
  projectId: string;
  writerRoot: string;
  canonicalRoot?: string | undefined;
  scope?: ProjectTaskScope | undefined;
  cursor?: string | undefined;
}>;
export type ProjectTaskMetadata = Readonly<{
  id: string;
  title: string | null;
  configuredModel: string | null;
  updatedAt: number;
}>;
export type ProjectTasksResult =
  | Readonly<{
      status: "tasks";
      source: "stored";
      snapshot: "non-atomic";
      scope: ProjectTaskScope;
      coverage: "single-page-metadata";
      controlGranted: false;
      tasks: readonly ProjectTaskMetadata[];
      nextCursor: string | null;
      complete: boolean;
    }>
  | Readonly<{ status: "unavailable"; code: string }>;
export interface CodexProjectTasksHost {
  request(
    method: "thread/list",
    params: Readonly<{
      projectId: string;
      cwd: string | readonly string[];
      cursor: string | null;
      limit: 50;
      sortKey: "updated_at";
      sortDirection: "desc";
      archived: false;
      useStateDbOnly: true;
    }>,
    deadlineAt: number,
  ): Promise<unknown>;
}

export type ProjectTaskDiscoveryRequest = Readonly<{
  workspaceId: string;
  projectId: string;
  scope?: ProjectTaskScope | undefined;
  cursor?: string | undefined;
}>;
export type ProjectTaskDiscoveryResult = (
  ProjectTasksResult | Readonly<{ status: "refused"; code: string }>
) &
  Readonly<{ workspaceId: string; projectId: string }>;
