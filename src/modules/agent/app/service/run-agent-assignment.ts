import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { AgentHost } from "../port/agent-host";
import {
  completeAssignment,
  createAssignment,
  failChildAssignment,
  failPreparedAssignment,
  markChildOutcomeUnknown,
  markSpawnOutcomeUnknown,
  startAssignment,
  type Assignment,
  type AssignmentErrorCode,
  type AssignmentIdentity,
} from "../../domain/assignment";

export type AgentRunReceipt = Readonly<{
  assignment: Assignment;
  resultRef: string | null;
}>;

export class RunAgentAssignment {
  constructor(private readonly host: AgentHost) {}

  async execute(
    identity: AssignmentIdentity,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const prepared = createAssignment(identity);
    let spawned: Awaited<ReturnType<AgentHost["spawn"]>>;
    try {
      spawned = await this.host.spawn(identity);
    } catch {
      return this.terminal(markSpawnOutcomeUnknown(prepared));
    }

    if (spawned.status === "outcome_unknown") {
      return this.terminal(markSpawnOutcomeUnknown(prepared));
    }
    if (spawned.status === "failed") {
      return this.terminal(failPreparedAssignment(prepared));
    }

    const started = startAssignment(prepared, spawned.correlation);
    if (!started.ok) return failure(started.error.code);

    let waited: Awaited<ReturnType<AgentHost["wait"]>>;
    try {
      waited = await this.host.wait(spawned.correlation);
    } catch {
      return this.terminal(
        markChildOutcomeUnknown(started.value, spawned.correlation),
      );
    }

    if (waited.status === "completed") {
      const completed = completeAssignment(started.value, waited.correlation);
      if (!completed.ok) return failure(completed.error.code);
      return success({
        assignment: completed.value,
        resultRef: waited.resultRef,
      });
    }
    if (waited.status === "outcome_unknown") {
      return this.terminal(
        markChildOutcomeUnknown(started.value, waited.correlation),
      );
    }
    return this.terminal(
      failChildAssignment(started.value, waited.correlation),
    );
  }

  private terminal(
    result: Result<Assignment, AssignmentErrorCode>,
  ): Result<AgentRunReceipt, AssignmentErrorCode> {
    return result.ok
      ? success({ assignment: result.value, resultRef: null })
      : failure(result.error.code);
  }
}
