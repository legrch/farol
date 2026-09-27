/** Published task route; a folder-read grant does not construct this port. */
export interface CodexTaskRoute {
  message(
    request: Readonly<{
      key: string;
      dispatchId: string;
      workspaceId: string;
      projectId: string;
      message: string;
      model: string;
      reasoningEffort: string;
    }>,
  ): Promise<
    | Readonly<{ status: "steered"; dispatchId: string; turnId: string }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
  >;
  create(
    request: Readonly<{
      key: string;
      workspaceId: string;
      projectId: string;
      message: string;
      model: string;
      reasoningEffort: string;
    }>,
  ): Promise<
    | Readonly<{
        status: "dispatched";
        dispatchId: string;
        threadId: string;
        turnId: string;
      }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
  >;
  status(dispatchId: string): Promise<
    | Readonly<{ status: "unknown" }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{
        status: "known";
        dispatchId: string;
        threadId: string;
        turnId: string;
        turnStatus: string;
      }>
  >;
  result(dispatchId: string): Promise<
    | Readonly<{ status: "unknown" }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{
        status: "running" | "failed" | "interrupted";
        dispatchId: string;
        threadId: string;
        turnId: string;
      }>
    | Readonly<{
        status: "completed";
        dispatchId: string;
        threadId: string;
        turnId: string;
        finalItemId: string;
        text: string;
      }>
  >;
}
