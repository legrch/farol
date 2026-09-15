import type { Assignment } from "../../domain/assignment";

export type StoredAssignment = Readonly<{
  assignment: Assignment;
  resultRef: string | null;
}>;

export type AssignmentAdmission =
  | Readonly<{ status: "admitted"; record: StoredAssignment }>
  | Readonly<{ status: "existing"; record: StoredAssignment }>;

export interface AssignmentRepository {
  admit(record: StoredAssignment): Promise<AssignmentAdmission>;
  save(record: StoredAssignment): Promise<void>;
}
