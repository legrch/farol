import { describe, expect, it } from "vitest";
import type { ProductAgentInput } from "../../../src/apps/desktop/product-agent-store";
import {
  productAgentAssignmentBinding,
  productAgentAssignmentMatches,
  productAgentIdentity,
  productAgentRecordSummary,
  productAgentSummary,
  productAgentUnknownSummary,
  productAgentUnknownSummaryFromTask,
  type ProductTaskAgent,
} from "./summary";

const input = {
  taskId: "task-1",
  sessionId: "session-1",
  assignmentId: "assignment-1",
  taskEpoch: 3,
  generation: 7,
  workspaceId: "workspace-1",
} as unknown as ProductAgentInput;

type Receipt = Parameters<typeof productAgentSummary>[1];
function receipt(phase: string, extra: Record<string, unknown> = {}): Receipt {
  return {
    assignment: { phase },
    parentDelivery: "pending",
    resultRef: null,
    workspaceEnforcement: "enforced",
    ...extra,
  } as unknown as Receipt;
}

describe("product agent summaries", () => {
  it("binds the task, session and assignment identifiers", () => {
    const binding = productAgentAssignmentBinding(input);
    expect(binding).toMatch(/^[0-9a-f]{64}$/);
    expect(productAgentAssignmentBinding({ ...input })).toBe(binding);
    expect(
      productAgentAssignmentBinding({ ...input, assignmentId: "other" }),
    ).not.toBe(binding);
    expect(productAgentAssignmentBinding({ ...input, generation: 8 })).toBe(
      binding,
    );
  });

  it("matches only a task carrying the same binding", () => {
    const agent = {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
    } as ProductTaskAgent;
    expect(productAgentAssignmentMatches(agent, input)).toBe(true);
    expect(productAgentAssignmentMatches({} as ProductTaskAgent, input)).toBe(
      false,
    );
    expect(
      productAgentAssignmentMatches(
        { assignmentBindingSha256: "0".repeat(64) } as ProductTaskAgent,
        input,
      ),
    ).toBe(false);
  });

  it("derives the store identity from the input", () => {
    expect(productAgentIdentity(input)).toEqual({
      assignmentId: "assignment-1",
      ownerId: "owner-desktop",
      sessionId: "session-1",
      taskId: "task-1",
      taskEpoch: 3,
      generation: 7,
    });
  });

  it("summarises a receipt and refuses a prepared one", () => {
    expect(() => productAgentSummary(input, receipt("prepared"))).toThrow(
      "PRODUCT_AGENT_STATE_INVALID",
    );
    expect(productAgentSummary(input, receipt("completed"))).toEqual({
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      phase: "completed",
      workspaceId: "workspace-1",
      parentDelivery: "pending",
      workspaceEnforcement: "enforced",
      resultAvailable: false,
    });
    expect(
      productAgentSummary(input, receipt("completed", { resultRef: "ref" }))
        .resultAvailable,
    ).toBe(true);
  });

  it("defaults the enforcement and keeps observation only while running", () => {
    expect(
      productAgentSummary(
        input,
        receipt("running", {
          workspaceEnforcement: undefined,
          observation: "unavailable",
        }),
      ),
    ).toMatchObject({
      workspaceEnforcement: "not_applicable",
      observation: "unavailable",
    });
    expect(
      productAgentSummary(
        input,
        receipt("failed", { observation: "unavailable" }),
      ),
    ).not.toHaveProperty("observation");
  });

  it("builds the bare record and unknown summaries", () => {
    const bare = {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      workspaceId: "workspace-1",
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    };
    expect(productAgentRecordSummary(input, "failed")).toEqual({
      ...bare,
      phase: "failed",
    });
    expect(productAgentUnknownSummary(input)).toEqual({
      ...bare,
      phase: "outcome_unknown",
    });
  });

  it("keeps a task's own binding, and omits it when absent", () => {
    const agent = {
      assignmentBindingSha256: "a".repeat(64),
      phase: "running",
      workspaceId: "workspace-1",
    } as ProductTaskAgent;
    expect(productAgentUnknownSummaryFromTask(agent)).toEqual({
      assignmentBindingSha256: "a".repeat(64),
      phase: "outcome_unknown",
      workspaceId: "workspace-1",
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    });
    expect(
      productAgentUnknownSummaryFromTask({
        ...agent,
        assignmentBindingSha256: undefined,
      }),
    ).not.toHaveProperty("assignmentBindingSha256");
  });
});
