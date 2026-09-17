import type { CheckpointEnvelope } from "../../domain/checkpoint";

export type HostContextReceipt =
  | Readonly<{ status: "confirmed"; hostContextRef: string }>
  | Readonly<{ status: "awaiting_confirmation" }>
  | Readonly<{ status: "not_offered" }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "outcome_unknown"; code: string }>;

export type HostContextPreflightReceipt =
  Readonly<{ status: "ready" }> | Readonly<{ status: "blocked"; code: string }>;

export interface HostContextBridge {
  preflight(
    checkpoint: CheckpointEnvelope,
  ): Promise<HostContextPreflightReceipt>;
  offer(checkpoint: CheckpointEnvelope): Promise<HostContextReceipt>;
  reconcile(checkpoint: CheckpointEnvelope): Promise<HostContextReceipt>;
}
