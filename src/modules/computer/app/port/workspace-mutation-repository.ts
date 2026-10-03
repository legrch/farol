import type {
  WorkspaceMutationErrorCode,
  WorkspaceMutationOperation,
  WorkspaceMutationReceipt,
} from "./mutable-workspace";
import type {
  AuthorityErrorCode,
  AuthorityFailureSource,
} from "../../domain/execution-authority";

export type StoredWorkspaceMutationFailureCode =
  | WorkspaceMutationErrorCode
  | AuthorityErrorCode
  | "COMPUTER_APPROVAL_STORE_UNAVAILABLE";

export type StoredWorkspaceMutationFailureSource =
  | "native-workspace"
  | "operation-store"
  | "authority-store"
  | AuthorityFailureSource;

export type WorkspaceMutationIdentity = Readonly<{
  operationId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
}>;

type StoredWorkspaceMutationCommon = Readonly<{
  identity: WorkspaceMutationIdentity;
  workspaceId: string;
  requestDigest: string;
}>;

export type StoredWorkspaceMutation =
  | (StoredWorkspaceMutationCommon &
      Readonly<{ phase: "prepared"; outcome: null }>)
  | (StoredWorkspaceMutationCommon &
      Readonly<{
        phase: "completed";
        outcome: Readonly<{ receipt: WorkspaceMutationReceipt }>;
      }>)
  | (StoredWorkspaceMutationCommon &
      Readonly<{
        phase: "failed" | "outcome_unknown";
        outcome: Readonly<{
          code: StoredWorkspaceMutationFailureCode;
          source: StoredWorkspaceMutationFailureSource;
        }>;
      }>);

export type WorkspaceMutationAdmission =
  | Readonly<{ status: "admitted"; record: StoredWorkspaceMutation }>
  | Readonly<{ status: "existing"; record: StoredWorkspaceMutation }>;

export interface WorkspaceMutationRepository {
  admit(record: StoredWorkspaceMutation): Promise<WorkspaceMutationAdmission>;
  load(
    identity: WorkspaceMutationIdentity,
  ): Promise<StoredWorkspaceMutation | null>;
  save(record: StoredWorkspaceMutation): Promise<void>;
}

export type WorkspaceMutationDigestInput = Readonly<{
  workspaceId: string;
  operation: WorkspaceMutationOperation;
}>;

export interface WorkspaceMutationDigester {
  digest(input: WorkspaceMutationDigestInput): string;
}
