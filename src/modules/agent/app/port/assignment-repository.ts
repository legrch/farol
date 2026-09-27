import type {
  Assignment,
  AssignmentIdentity,
  ChildCorrelation,
} from "../../domain/assignment";

export type StoredAssignment = Readonly<{
  assignment: Assignment;
  resultRef: string | null;
  parentDelivery: "not_applicable" | "pending" | "acknowledged";
  workspaceEnforcement?: "not_applicable" | "verified";
}>;

export type AssignmentAdmission =
  | Readonly<{ status: "admitted"; record: StoredAssignment }>
  | Readonly<{ status: "existing"; record: StoredAssignment }>;

export interface AssignmentRepository {
  admit(record: StoredAssignment): Promise<AssignmentAdmission>;
  load(identity: AssignmentIdentity): Promise<StoredAssignment | null>;
  save(record: StoredAssignment): Promise<void>;
  /** Persist one cancellation intent before any host effect. Never reclaim it. */
  claimCancellation?(
    identity: AssignmentIdentity,
    correlation: ChildCorrelation,
  ): Promise<boolean>;
}
