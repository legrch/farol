import type { ComputerApproval } from "../../domain/execution-authority";

export interface ComputerApprovalRepository {
  get(computerId: string): Promise<ComputerApproval | null>;
}
