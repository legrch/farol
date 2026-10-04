import { describe, expect, it } from "vitest";
import type { ConfigurationOutcome } from "../../src/ui/configuration-outcome";
import {
  workspaceEditRefusalMessage,
  workspaceEditToAcknowledge,
} from "../../src/ui/workspace-edit-delivery";

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
      evidence: {
        kind: "computer.workspace-mutation",
        operationId,
        workspaceId,
      },
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
  it("does not acknowledge evidence from another edit or workspace", () => {
    const result = applied(operationId);
    if (
      result.kind !== "applied" ||
      result.result.evidence?.kind !== "computer.workspace-mutation"
    )
      throw new Error("FIXTURE_INVALID");
    result.result.evidence.operationId = "00000000-0000-4000-8000-000000000009";
    expect(workspaceEditToAcknowledge(observe, result)).toBeNull();
    result.result.evidence.operationId = operationId;
    result.result.evidence.workspaceId = "00000000-0000-4000-8000-000000000009";
    expect(workspaceEditToAcknowledge(observe, result)).toBeNull();
  });

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

describe("A6 unknown guarded-edit outcome message", () => {
  it("never calls an unknown edit outcome not applied and says what was kept", () => {
    const message = workspaceEditRefusalMessage(
      "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
    );
    expect(message).not.toBeNull();
    expect(message).not.toMatch(/not applied/iu);
    expect(message).toMatch(/may already be in the file/u);
    expect(message).toMatch(/will not repeat it/u);
    expect(message).toMatch(/deleted nothing/u);
    expect(message).toMatch(/\.farol-stage/u);
    // Content-free: no path of the owner's machine and no file content.
    expect(message).not.toMatch(/\/Users\/|~\/|README/u);
  });

  it("leaves every other refusal to its own sentence", () => {
    expect(
      workspaceEditRefusalMessage("WORKSPACE_MUTATION_CONFLICT"),
    ).toBeNull();
    expect(workspaceEditRefusalMessage("WORKSPACE_PATH_REFUSED")).toBeNull();
  });
});
