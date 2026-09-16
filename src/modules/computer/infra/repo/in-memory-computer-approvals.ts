import type { ComputerApprovalRepository } from "../../app/port/computer-approval-repository";
import type { ComputerApproval } from "../../domain/execution-authority";

export class InMemoryComputerApprovalRepository implements ComputerApprovalRepository {
  private readonly approvals = new Map<string, ComputerApproval>();

  constructor(initial: readonly ComputerApproval[] = []) {
    for (const approval of initial) {
      this.approvals.set(approval.computerId, structuredClone(approval));
    }
  }

  async get(computerId: string): Promise<ComputerApproval | null> {
    const approval = this.approvals.get(computerId);
    return approval ? structuredClone(approval) : null;
  }
}
