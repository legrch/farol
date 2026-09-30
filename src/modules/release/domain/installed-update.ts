export type InstalledUpdateView =
  | Readonly<{ phase: "unavailable"; code: string }>
  | Readonly<{ phase: "idle"; checkedAt: number | null }>
  | Readonly<{ phase: "checking" | "downloading" }>
  | Readonly<{
      phase: "ready";
      version: string;
      deferred: boolean;
      blockedBy: string | null;
    }>
  | Readonly<{ phase: "applying"; version: string }>
  | Readonly<{ phase: "failed"; code: string; recoveryRequired: boolean }>;
