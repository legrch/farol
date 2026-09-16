import type { CheckpointEnvelope } from "../../domain/checkpoint";

export type HostContextReceipt =
  | Readonly<{ status: "confirmed"; hostContextRef: string }>
  | Readonly<{ status: "awaiting_confirmation" }>
  | Readonly<{ status: "not_offered" }>
  | Readonly<{ status: "blocked"; code: string }>
  | Readonly<{ status: "outcome_unknown"; code: string }>;

export interface HostContextBridge {
  offer(checkpoint: CheckpointEnvelope): Promise<HostContextReceipt>;
  reconcile(checkpoint: CheckpointEnvelope): Promise<HostContextReceipt>;
}
