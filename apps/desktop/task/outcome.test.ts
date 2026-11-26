import { describe, expect, it } from "vitest";
import {
  acknowledgementCommand,
  cancelReceiptFailure,
  runRefusalFailure,
  settledReceiptFailure,
} from "./outcome";
import type { Assignment, CancelReceipt, RunReceipt } from "./summary";

function cancel(
  phase: string,
  assignmentRetention: "durable" | "memory_only" = "durable",
): CancelReceipt {
  return {
    assignment: { phase },
    assignmentRetention,
  } as unknown as CancelReceipt;
}

describe("cancel receipt failure", () => {
  it("is null only for a durable cancelled assignment", () => {
    expect(cancelReceiptFailure(cancel("cancelled"))).toBeNull();
  });

  it("never reports success for memory-only retention", () => {
    expect(cancelReceiptFailure(cancel("cancelled", "memory_only"))).toBe(
      "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    );
    expect(cancelReceiptFailure(cancel("completed", "memory_only"))).toBe(
      "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    );
  });

  it("classifies the settled phases", () => {
    expect(cancelReceiptFailure(cancel("completed"))).toBe(
      "AGENT_CANCEL_RACED_COMPLETION",
    );
    expect(cancelReceiptFailure(cancel("failed"))).toBe(
      "AGENT_ASSIGNMENT_FAILED",
    );
  });

  it("treats every other phase as outcome unknown", () => {
    for (const phase of ["running", "outcome_unknown", "prepared"]) {
      expect(cancelReceiptFailure(cancel(phase))).toBe(
        "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
      );
    }
  });
});

describe("settled receipt failure", () => {
  const settled = (phase: string, resultRef: string | null) =>
    ({ assignment: { phase }, resultRef }) as unknown as RunReceipt;

  it("reports unknown before failed", () => {
    expect(settledReceiptFailure(settled("outcome_unknown", null))).toBe(
      "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    );
  });

  it("fails a failed phase or a missing result", () => {
    expect(settledReceiptFailure(settled("failed", "ref"))).toBe(
      "AGENT_ASSIGNMENT_FAILED",
    );
    expect(settledReceiptFailure(settled("completed", null))).toBe(
      "AGENT_ASSIGNMENT_FAILED",
    );
  });

  it("lets a completed result with a reference through", () => {
    expect(settledReceiptFailure(settled("completed", "ref"))).toBeNull();
  });
});

describe("run refusal failure", () => {
  it("separates a rejoin from a new admission", () => {
    expect(runRefusalFailure("rejoin")).toBe("AGENT_REJOIN_UNAVAILABLE");
    expect(runRefusalFailure("new")).toBe("AGENT_ASSIGNMENT_FAILED");
  });
});

describe("acknowledgement command", () => {
  it("copies the correlation from the assignment", () => {
    const assignment = {
      identity: { assignmentId: "assignment-1" },
      authority: {
        authorityId: "authority-1",
        participantId: "participant-1",
        parentParticipantId: "parent-1",
        role: "worker",
      },
      parentThreadId: "thread-1",
      childId: "child-1",
      parentTurnId: "turn-1",
      childTurnId: "turn-2",
      hostRole: "agent",
      delegationDigest: "digest-1",
    } as unknown as Assignment;
    expect(acknowledgementCommand(assignment, "ref-1")).toEqual({
      correlation: {
        assignmentId: "assignment-1",
        authorityId: "authority-1",
        participantId: "participant-1",
        role: "worker",
        parentThreadId: "thread-1",
        childId: "child-1",
        parentTurnId: "turn-1",
        childTurnId: "turn-2",
        hostRole: "agent",
        delegationDigest: "digest-1",
      },
      parentParticipantId: "parent-1",
      resultRef: "ref-1",
    });
  });
});
