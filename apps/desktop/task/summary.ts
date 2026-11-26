import { createHash } from "node:crypto";
import type { LiveTaskRegistry } from "../../../src/apps/desktop/live-task-registry";
import type { runProductAgentAssignment } from "../../../src/apps/desktop/product-agent-assignment";
import type { ProductAgentInput } from "../../../src/apps/desktop/product-agent-store";

// Pure builders for the summary a task carries about its Product Agent, the
// assignment binding digest and the identity handed to the assignment store.
// Nothing here reads a clock, a store or a host.

export type ProductTask = Parameters<LiveTaskRegistry["admitDurable"]>[0];
export type ProductTaskAgent = NonNullable<ProductTask["agent"]>;
type RunDependencies = Parameters<typeof runProductAgentAssignment>[3];
export type AgentHostPort = RunDependencies["host"];
export type Assignments = RunDependencies["assignments"];
export type RunReceipt = Extract<
  Awaited<ReturnType<typeof runProductAgentAssignment>>,
  { ok: true }
>["value"];
export type Assignment = RunReceipt["assignment"];
export type CancelReceipt = Pick<
  RunReceipt,
  "assignment" | "parentDelivery" | "resultRef" | "workspaceEnforcement"
> &
  Readonly<{ assignmentRetention: "durable" | "memory_only" }>;

export function productAgentAssignmentBinding(
  input: ProductAgentInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "farol-product-agent-binding-v1",
        input.taskId,
        input.sessionId,
        input.assignmentId,
      ]),
    )
    .digest("hex");
}

export function productAgentAssignmentMatches(
  agent: ProductTaskAgent,
  input: ProductAgentInput,
): boolean {
  return (
    agent.assignmentBindingSha256 !== undefined &&
    agent.assignmentBindingSha256 === productAgentAssignmentBinding(input)
  );
}

export function productAgentIdentity(input: ProductAgentInput) {
  return {
    assignmentId: input.assignmentId,
    ownerId: "owner-desktop",
    sessionId: input.sessionId,
    taskId: input.taskId,
    taskEpoch: input.taskEpoch,
    generation: input.generation,
  };
}

export function productAgentSummary(
  input: ProductAgentInput,
  receipt: Pick<
    RunReceipt,
    "assignment" | "parentDelivery" | "resultRef" | "workspaceEnforcement"
  > &
    Partial<Pick<RunReceipt, "observation">>,
): ProductTaskAgent {
  const phase = receipt.assignment.phase;
  if (phase === "prepared") {
    throw new Error("PRODUCT_AGENT_STATE_INVALID");
  }
  return {
    assignmentBindingSha256: productAgentAssignmentBinding(input),
    phase,
    workspaceId: input.workspaceId,
    parentDelivery: receipt.parentDelivery,
    workspaceEnforcement: receipt.workspaceEnforcement ?? "not_applicable",
    resultAvailable: receipt.resultRef !== null,
    ...(phase === "running" && receipt.observation === "unavailable"
      ? { observation: "unavailable" as const }
      : {}),
  };
}

// A record with no delivery, enforcement or result: the shape written when
// an open is refused, a run throws or fails, or the outcome is unknown.
export function productAgentRecordSummary(
  input: ProductAgentInput,
  phase: ProductTaskAgent["phase"],
): ProductTaskAgent {
  return {
    assignmentBindingSha256: productAgentAssignmentBinding(input),
    phase,
    workspaceId: input.workspaceId,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
  };
}

export function productAgentUnknownSummary(
  input: ProductAgentInput,
): ProductTaskAgent {
  return productAgentRecordSummary(input, "outcome_unknown");
}

export function productAgentUnknownSummaryFromTask(
  agent: ProductTaskAgent,
): ProductTaskAgent {
  return {
    ...(agent.assignmentBindingSha256
      ? { assignmentBindingSha256: agent.assignmentBindingSha256 }
      : {}),
    phase: "outcome_unknown",
    workspaceId: agent.workspaceId,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
  };
}
