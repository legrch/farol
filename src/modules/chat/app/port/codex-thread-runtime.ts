/** A thread-wide read snapshot, never approval authority for one issued turn. */
export type CodexThreadRuntime = Readonly<{
  scope: "thread";
  source: "thread/read";
  snapshot: "non-atomic";
}> &
  (
    | Readonly<{ state: "unavailable" | "notLoaded" | "idle" | "systemError" }>
    | Readonly<{
        state: "active";
        activeFlags: readonly ("waitingOnApproval" | "waitingOnUserInput")[];
      }>
  );
