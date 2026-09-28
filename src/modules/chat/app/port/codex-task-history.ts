export type TaskHistoryRequest = Readonly<{
  threadId: string;
  turnId: string;
  workspaceId: string;
  projectId: string;
  cursor?: string | undefined;
  tail?: boolean | undefined;
}>;
export interface TaskHistoryHost {
  request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown>;
}
export type TaskHistoryItem =
  | Readonly<{
      id: string;
      kind: "user_message";
      parts: readonly string[];
      omittedContent: number;
    }>
  | Readonly<{
      id: string;
      kind: "agent_message";
      text: string;
      phase: "commentary" | "final_answer" | null;
    }>
  | Readonly<{ id: string; kind: "omitted"; type: string }>;
export type TaskHistoryResult =
  | Readonly<{
      status: "history";
      source: "stored";
      snapshot: "non-atomic";
      coverage: "single-page-text-only";
      threadId: string;
      turnId: string;
      turnStatus: "inProgress" | "completed" | "failed" | "interrupted";
      sortDirection: "asc" | "desc";
      items: readonly TaskHistoryItem[];
      nextCursor: string | null;
      complete: boolean;
    }>
  | Readonly<{
      status: "refused" | "unavailable";
      threadId: string;
      turnId: string;
      code: string;
    }>;
