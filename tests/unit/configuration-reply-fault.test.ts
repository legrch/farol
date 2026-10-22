import { describe, expect, it } from "vitest";

import {
  WORKSPACE_EDIT_ACK_HOLD_ENV,
  WORKSPACE_EDIT_ACK_HOLD_INVALID,
  WORKSPACE_EDIT_REPLY_DELIVERIES_ENV,
  WORKSPACE_EDIT_REPLY_FAULT_INVALID,
  createConfigurationReplyFault,
  e2eBudget,
} from "../../src/apps/desktop/configuration-reply-fault";
import type { ProductConfigurationResult } from "../../src/pkg/product-settings/contract";

const APPLY = "computer.apply-workspace-edit";

// A settings snapshot the decision never looks at. Only the reply's `ok`,
// its command kind and its evidence discriminant reach the decision, so the
// cheapest valid snapshot keeps these fixtures the product's real type
// rather than a cast that would hide a contract change.
const snapshot = {
  status: "error",
  error: "SETTINGS_READ_FAILED",
} as const;

/** A successful guarded-edit reply, shaped as the handler returns it. */
function appliedReply(operationId = "op-1"): ProductConfigurationResult {
  return {
    ok: true,
    snapshot,
    evidence: {
      kind: "computer.workspace-mutation",
      operationId,
      workspaceId: "workspace-1",
      relativePath: "README.md",
      operation: "edit",
      bytes: 42,
      replacements: 1,
      beforeSha256: "a".repeat(64),
      afterSha256: "b".repeat(64),
      resultRetention: "durable",
      redelivered: false,
    },
  };
}

function failedReply(): ProductConfigurationResult {
  return { ok: false, error: "WORKSPACE_MUTATION_FAILED", snapshot };
}

function armed(deliveries: string): Record<string, string | undefined> {
  return {
    FAROL_E2E: "1",
    [WORKSPACE_EDIT_REPLY_DELIVERIES_ENV]: deliveries,
  };
}

describe("the guarded-edit reply fault", () => {
  it("delivers every reply when the lane is not armed", () => {
    for (const env of [
      {},
      { FAROL_E2E: "1" },
      { [WORKSPACE_EDIT_REPLY_DELIVERIES_ENV]: "0" },
      { FAROL_E2E: "0", [WORKSPACE_EDIT_REPLY_DELIVERIES_ENV]: "0" },
    ]) {
      const decide = createConfigurationReplyFault(env);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(decide(APPLY, appliedReply())).toBe("deliver");
      }
    }
  });

  it("refuses a budget that is not a count", () => {
    for (const deliveries of ["-1", "1.5", "one", "NaN", "1e400", "1 2"]) {
      const decide = createConfigurationReplyFault(armed(deliveries));
      expect(() => decide(APPLY, appliedReply())).toThrow(
        WORKSPACE_EDIT_REPLY_FAULT_INVALID,
      );
    }
  });

  it("does not refuse a bad budget on a reply it would never drop", () => {
    const decide = createConfigurationReplyFault(armed("-1"));
    expect(decide("computer.observe-workspace-edit", appliedReply())).toBe(
      "deliver",
    );
    expect(decide(APPLY, failedReply())).toBe("deliver");
  });

  it("drops every guarded-edit reply after the budgeted ones", () => {
    const decide = createConfigurationReplyFault(armed("2"));
    expect(decide(APPLY, appliedReply("op-1"))).toBe("deliver");
    expect(decide(APPLY, appliedReply("op-2"))).toBe("deliver");
    expect(decide(APPLY, appliedReply("op-3"))).toBe("drop");
    expect(decide(APPLY, appliedReply("op-4"))).toBe("drop");
  });

  it("drops the first reply on a budget of zero", () => {
    // An empty value is a budget of zero rather than an unset lane, exactly
    // as the live-task save fault reads its own count.
    for (const deliveries of ["0", ""]) {
      const decide = createConfigurationReplyFault(armed(deliveries));
      expect(decide(APPLY, appliedReply())).toBe("drop");
    }
  });

  it("counts one process only, so a second fault starts its own budget", () => {
    const env = armed("1");
    const first = createConfigurationReplyFault(env);
    expect(first(APPLY, appliedReply())).toBe("deliver");
    expect(first(APPLY, appliedReply())).toBe("drop");
    const second = createConfigurationReplyFault(env);
    expect(second(APPLY, appliedReply())).toBe("deliver");
  });

  it("never drops a failed guarded edit, and never counts one", () => {
    const decide = createConfigurationReplyFault(armed("1"));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(decide(APPLY, failedReply())).toBe("deliver");
    }
    expect(decide(APPLY, appliedReply())).toBe("deliver");
    expect(decide(APPLY, appliedReply())).toBe("drop");
  });

  it("never drops another command's reply, and never counts one", () => {
    const decide = createConfigurationReplyFault(armed("1"));
    for (const kind of [
      "computer.observe-workspace-edit",
      "computer.ack-workspace-edit",
      "computer.cancel-workspace-edit",
      "computer.verify-workspace",
      "setup.progress",
    ]) {
      expect(decide(kind, appliedReply())).toBe("deliver");
    }
    expect(decide(APPLY, appliedReply())).toBe("deliver");
    expect(decide(APPLY, appliedReply())).toBe("drop");
  });

  it("never drops a successful apply that carries other evidence", () => {
    const decide = createConfigurationReplyFault(armed("0"));
    expect(decide(APPLY, { ok: true, snapshot })).toBe("deliver");
    expect(
      decide(APPLY, {
        ok: true,
        snapshot,
        evidence: {
          kind: "computer.workspace-read",
          relativePath: "README.md",
          bytes: 42,
          sha256: "c".repeat(64),
          truncated: false,
        },
      } as unknown as ProductConfigurationResult),
    ).toBe("deliver");
  });
});

describe("the shared E2E budget", () => {
  it("is unarmed unless both gates are set", () => {
    for (const env of [
      {},
      { FAROL_E2E: "1" },
      { [WORKSPACE_EDIT_ACK_HOLD_ENV]: "0" },
      { FAROL_E2E: "0", [WORKSPACE_EDIT_ACK_HOLD_ENV]: "0" },
      { FAROL_E2E: "true", [WORKSPACE_EDIT_ACK_HOLD_ENV]: "0" },
    ]) {
      expect(e2eBudget(env, WORKSPACE_EDIT_ACK_HOLD_ENV, "NEVER")).toBeNull();
    }
  });

  it("reads a count when both gates are set", () => {
    for (const [raw, expected] of [
      ["0", 0],
      ["", 0],
      ["3", 3],
    ] as const) {
      expect(
        e2eBudget(
          { FAROL_E2E: "1", [WORKSPACE_EDIT_ACK_HOLD_ENV]: raw },
          WORKSPACE_EDIT_ACK_HOLD_ENV,
          "NEVER",
        ),
      ).toBe(expected);
    }
  });

  it("refuses a value that is not a count, with the caller's own code", () => {
    for (const raw of ["-1", "1.5", "one", "NaN", "1e400", "1 2"]) {
      expect(() =>
        e2eBudget(
          { FAROL_E2E: "1", [WORKSPACE_EDIT_ACK_HOLD_ENV]: raw },
          WORKSPACE_EDIT_ACK_HOLD_ENV,
          WORKSPACE_EDIT_ACK_HOLD_INVALID,
        ),
      ).toThrow(WORKSPACE_EDIT_ACK_HOLD_INVALID);
    }
  });

  it("reads each seam's own variable, never another's", () => {
    const env = {
      FAROL_E2E: "1",
      [WORKSPACE_EDIT_REPLY_DELIVERIES_ENV]: "7",
    };
    expect(
      e2eBudget(
        env,
        WORKSPACE_EDIT_ACK_HOLD_ENV,
        WORKSPACE_EDIT_ACK_HOLD_INVALID,
      ),
    ).toBeNull();
    expect(
      e2eBudget(
        env,
        WORKSPACE_EDIT_REPLY_DELIVERIES_ENV,
        WORKSPACE_EDIT_REPLY_FAULT_INVALID,
      ),
    ).toBe(7);
  });
});
