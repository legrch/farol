/** Published task route; a folder-read grant does not construct this port. */
export interface CodexTaskRoute {
  /** Control is advertised only after the serving host is qualified. */
  readonly controlCapabilities?: Readonly<{
    message: boolean;
    continue?: boolean;
  }>;
  message(
    request: Readonly<{
      key: string;
      dispatchId: string;
      workspaceId: string;
      projectId: string;
      message: string;
      model: string;
      reasoningEffort?: string | undefined;
    }>,
  ): Promise<
    | Readonly<{ status: "steered"; dispatchId: string; turnId: string }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
  >;
  /** A new dispatch in the same verified thread; not a second task. */
  continue?(
    request: Readonly<{
      key: string;
      dispatchId: string;
      message: string;
    }>,
  ): ReturnType<CodexTaskRoute["create"]>;
  create(
    request: Readonly<{
      key: string;
      workspaceId: string;
      projectId: string;
      message: string;
      harness?: string | undefined;
      /** Configured alias, not a provider model identifier. */
      model?: string | undefined;
      effort?: string | undefined;
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
