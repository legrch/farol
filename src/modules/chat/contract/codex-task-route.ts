/** Published task route; a folder-read grant does not construct this port. */
export interface CodexTaskRoute {
  readonly observeEnabled?: boolean;
  /** Inspect only the exact owner-selected thread in the approved project. */
  observe?(
    request: Readonly<{
      threadId: string;
      workspaceId: string;
      projectId: string;
    }>,
  ): Promise<
    | Readonly<{
        status: "observed";
        threadId: string;
        title: string | null;
        model: string | null;
        turns: ReadonlyArray<Readonly<{ id: string; status: string }>>;
        hasMoreTurns: boolean;
      }>
    | Readonly<{ status: "refused"; code: string }>
    | Readonly<{ status: "outcome_unknown"; threadId: string }>
  >;
  /** Persist a read-only handle for one verified turn of the selected thread. */
  adopt?(
    request: Readonly<{
      threadId: string;
      turnId: string;
      workspaceId: string;
      projectId: string;
    }>,
  ): Promise<
    | Readonly<{ status: "adopted"; dispatchId: string }>
    | Readonly<{ status: "refused"; code: string }>
    | Readonly<{ status: "outcome_unknown"; dispatchId: string }>
  >;
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
