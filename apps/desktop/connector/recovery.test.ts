import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attemptGeneration,
  closureAcknowledges,
  recoveryFailureCode,
} from "./recovery";

const binding = {
  buildId: "build",
  profileId: "profile",
  backendGeneration: "backend",
  runtimeId: "runtime",
  connectorGeneration: "9",
};

describe("attemptGeneration", () => {
  it("digests the NUL-joined coordinates in a fixed order", () => {
    const expected = createHash("sha256")
      .update(["9", "7", "build", "launch", "start"].join("\0"))
      .digest("hex");
    expect(
      attemptGeneration("build", {
        connectorGeneration: 9,
        computerGeneration: 7,
        launchContractSha256: "launch",
        phase: "start",
      }),
    ).toBe(expected);
  });
});

describe("closureAcknowledges", () => {
  it("needs a closed result for exactly the original binding", () => {
    expect(closureAcknowledges({ closed: true, binding }, binding)).toBe(true);
    expect(closureAcknowledges({ closed: false, binding }, binding)).toBe(
      false,
    );
    expect(
      closureAcknowledges(
        { closed: true, binding: { ...binding, runtimeId: "other" } },
        binding,
      ),
    ).toBe(false);
  });
});

describe("recoveryFailureCode", () => {
  it("maps each unsettled recovery to its own code", () => {
    expect(recoveryFailureCode("pending_operation")).toBe(
      "CONNECTOR_RECOVERY_PENDING_OPERATION",
    );
    expect(recoveryFailureCode("operation_unknown")).toBe(
      "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    );
    expect(recoveryFailureCode("authority_unknown")).toBe(
      "CONNECTOR_RECOVERY_AUTHORITY_UNAVAILABLE",
    );
    expect(recoveryFailureCode("anything-else")).toBe(
      "CONNECTOR_RECOVERY_UNAVAILABLE",
    );
  });
});
