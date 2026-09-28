export type ProjectPreferenceRecord = Readonly<{
  projectId: string;
  project: Readonly<{
    root: string;
    device: string;
    inode: string;
    gitCommonDirectory: string;
  }>;
}>;
export type ProjectPreferenceRequest = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
  operation: "remember" | "read";
}>;
export type ProjectPreferenceResult = Readonly<{
  key: string;
  workspaceId: string;
  projectId: string;
}> &
  (
    | Readonly<{
        status: "remembered" | "resolved";
        persistence: "immutable-local-receipt";
        catalogue: "current-non-atomic";
        controlGranted: false;
      }>
    | Readonly<{
        status:
          "refused" | "unavailable" | "stale_preference" | "outcome_unknown";
        code: string;
      }>
  );
