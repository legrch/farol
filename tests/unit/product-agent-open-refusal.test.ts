import { describe, expect, it } from "vitest";

import { admitProductAgentRejoin } from "../../src/apps/desktop/product-agent-rejoin";
import {
  productAgentOpenRefusal,
  type ProductAgentAdmission,
} from "../../src/apps/desktop/product-agent-open-refusal";
import type { ProductTaskAgent } from "../../src/modules/chat/contract/product-task";

const admissionOnly = [
  "PRODUCT_AGENT_SESSION_BUSY",
  "AUTHORITY_CHANGE_IN_PROGRESS",
] as const;

// Failures that happened while the open was already under way.
const opening = [
  "PRODUCT_AGENT_HOST_CHANGED",
  "EACCES: permission denied",
  "",
] as const;

function refusal(admission: ProductAgentAdmission, message: string) {
  return productAgentOpenRefusal(admission, new Error(message));
}

function runningAgent(): ProductTaskAgent {
  return {
    assignmentBindingSha256: "a".repeat(64),
    phase: "running",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
  };
}

describe("S35-Q1 product agent session open refusal", () => {
  it("records a new start as failed however the open was refused", () => {
    for (const message of [...admissionOnly, ...opening]) {
      expect(refusal("new", message).record).toBe("failed");
    }
  });

  it("keeps the new start's own refusal codes", () => {
    expect(refusal("new", "PRODUCT_AGENT_SESSION_BUSY").failure).toBe(
      "AGENT_ALREADY_RUNNING",
    );
    for (const message of ["AUTHORITY_CHANGE_IN_PROGRESS", ...opening]) {
      expect(refusal("new", message).failure).toBe("AGENT_NOT_READY");
    }
  });

  it("leaves a rejoin's assignment untouched when admission alone refused it", () => {
    expect(refusal("rejoin", "PRODUCT_AGENT_SESSION_BUSY")).toEqual({
      record: "none",
      failure: "AGENT_ALREADY_RUNNING",
    });
    expect(refusal("rejoin", "AUTHORITY_CHANGE_IN_PROGRESS")).toEqual({
      record: "none",
      failure: "AGENT_NOT_READY",
    });
  });

  it("still marks a rejoin unknown when the open itself failed", () => {
    for (const message of opening) {
      expect(refusal("rejoin", message)).toEqual({
        record: "outcome_unknown",
        failure: "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
      });
    }
  });

  it("treats a non-Error rejection as an open that failed", () => {
    expect(
      productAgentOpenRefusal("rejoin", "PRODUCT_AGENT_SESSION_BUSY"),
    ).toEqual({
      record: "outcome_unknown",
      failure: "AGENT_ASSIGNMENT_OUTCOME_UNKNOWN",
    });
  });

  // Why `record: "none"` is the whole point: the phase the rejoin branch used
  // to write is terminal. `admitProductAgentRejoin` is the production
  // admission the next `task.rejoin-agent` runs through, and `rejoinable` is
  // the first thing it consults — so whether the durable input is even read
  // is the exact measure of whether the phase is still rejoinable.
  describe("what the recorded phase costs the next rejoin", () => {
    async function loadsInput(
      phase: ProductTaskAgent["phase"],
    ): Promise<boolean> {
      let loaded = false;
      await admitProductAgentRejoin({
        agent: { ...runningAgent(), phase },
        loadInput: async () => {
          loaded = true;
          return null;
        },
        readSettings: () => null,
        store: null,
        buildId: "5".repeat(64),
        assignmentMatches: () => true,
      });
      return loaded;
    }

    it("still admits the phase an admission-only refusal now leaves behind", async () => {
      await expect(loadsInput("running")).resolves.toBe(true);
    });

    it("refuses before reading anything once the old branch's phase is written", async () => {
      await expect(loadsInput("outcome_unknown")).resolves.toBe(false);
    });

    it("refuses a new start of that phase too", () => {
      // `runProductTaskCommand`'s own guard, quoted here so the two halves of
      // "terminal" sit together: `task.start-agent` refuses
      // `phase === "outcome_unknown"` with AGENT_ASSIGNMENT_OUTCOME_UNKNOWN,
      // and `rejoinable` above refuses the rejoin. Nothing clears it.
      expect(refusal("rejoin", "PRODUCT_AGENT_HOST_CHANGED").record).toBe(
        "outcome_unknown",
      );
      expect(refusal("rejoin", "AUTHORITY_CHANGE_IN_PROGRESS").record).toBe(
        "none",
      );
    });
  });
});
