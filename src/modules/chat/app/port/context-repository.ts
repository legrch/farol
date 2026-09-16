import type {
  CompactionRequest,
  ContextBinding,
  ContextSession,
} from "../../domain/context-continuity";

export type ContextAdmission = Readonly<{
  binding: ContextBinding;
  sourceEpoch: number;
  request: CompactionRequest;
}>;

export type ContextAdmissionLease = Readonly<{
  sessionKey: string;
  token: string;
}>;

export type ContextAdmissionResult =
  | Readonly<{
      status: "acquired";
      admission: ContextAdmission;
      lease: ContextAdmissionLease;
    }>
  | Readonly<{ status: "busy" }>
  | Readonly<{
      status: "conflict";
      reason: "binding" | "epoch" | "request";
    }>;

export interface ContextRepository {
  load(binding: ContextBinding): Promise<ContextSession | null>;
  save(session: ContextSession): Promise<void>;
  acquireCompactionAdmission(
    binding: ContextBinding,
    sourceEpoch: number,
    request: CompactionRequest,
  ): Promise<ContextAdmissionResult>;
  releaseCompactionAdmission(lease: ContextAdmissionLease): Promise<void>;
}
