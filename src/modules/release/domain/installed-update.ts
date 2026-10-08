export type InstalledUpdateView =
  | Readonly<{ phase: "unavailable"; code: string }>
  | Readonly<{
      phase: "idle";
      checkedAt: number | null;
      rollbackVersion?: string;
      blockedBy?: string;
    }>
  | Readonly<{ phase: "recovery"; version: string; blockedBy: string | null }>
  | Readonly<{ phase: "checking" | "downloading" }>
  | Readonly<{
      phase: "available";
      version: string;
      deferred: boolean;
      notes?: string;
    }>
  | Readonly<{
      phase: "ready";
      version: string;
      deferred: boolean;
      blockedBy: string | null;
      notes?: string;
    }>
  | Readonly<{ phase: "applying"; version: string }>
  | Readonly<{
      phase: "failed";
      code: string;
      recoveryRequired: boolean;
      rollbackVersion?: string;
    }>;
