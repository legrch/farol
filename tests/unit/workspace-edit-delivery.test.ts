import { describe, expect, it } from "vitest";
import type { ConfigurationOutcome } from "../../src/ui/configuration-outcome";
import { workspaceEditToAcknowledge } from "../../src/ui/workspace-edit-delivery";

const operationId = "00000000-0000-4000-8000-000000000002";
const workspaceId = "00000000-0000-4000-8000-000000000001";

function snapshot(pendingOperationId: string | null) {
  return {
    status: "ready" as const,
    settings: {
      computer: {
        pendingEdit:
          pendingOperationId === null
            ? null
            : {
                operationId: pendingOperationId,
                workspaceId,
                relativePath: "README.md",
                computerGeneration: 2,
                submittedAt: "2026-09-18T09:00:00.000Z",
              },
      },
    },
  };
}

function applied(pending: string | null): ConfigurationOutcome {
  return {
    kind: "applied",
    result: {
      ok: true,
      snapshot: snapshot(pending),
      evidence: { kind: "computer.workspace-mutation", operationId },
    },
  } as unknown as ConfigurationOutcome;
}

function refused(error: string, pending: string | null): ConfigurationOutcome {
  return {
    kind: "refused",
    result: { ok: false, error, snapshot: snapshot(pending) },
  } as unknown as ConfigurationOutcome;
}

const apply = {
  kind: "computer.apply-workspace-edit" as const,
  operationId,
  oldText: "a",
  newText: "b",
};
const observe = {
  kind: "computer.observe-workspace-edit" as const,
  operationId,
};

describe("guarded edit delivery acknowledgement", () => {
  it("acknowledges a delivered result of the pending operation", () => {
    expect(workspaceEditToAcknowledge(apply, applied(operationId))).toBe(
      operationId,
    );
    expect(workspaceEditToAcknowledge(observe, applied(operationId))).toBe(
      operationId,
    );
    for (const code of [
      "WORKSPACE_MUTATION_CONFLICT",
      "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
      "WORKSPACE_MUTATION_NOT_ADMITTED",
    ]) {
      expect(
        workspaceEditToAcknowledge(observe, refused(code, operationId)),
      ).toBe(operationId);
    }
  });

  it("keeps the record when the reply is lost, unrelated or not about the edit", () => {
    expect(
      workspaceEditToAcknowledge(apply, {
        kind: "unconfirmed",
        reason: "transport-rejected",
      }),
    ).toBeNull();
    expect(
      workspaceEditToAcknowledge(
        apply,
        refused("WORKSPACE_MUTATION_IN_PROGRESS", operationId),
      ),
    ).toBeNull();
    expect(
      workspaceEditToAcknowledge(
        apply,
        applied("00000000-0000-4000-8000-000000000009"),
      ),
    ).toBeNull();
    expect(workspaceEditToAcknowledge(apply, applied(null))).toBeNull();
    expect(
      workspaceEditToAcknowledge(
        { kind: "computer.cancel-workspace-edit", operationId },
        applied(operationId),
      ),
    ).toBeNull();
  });
});
