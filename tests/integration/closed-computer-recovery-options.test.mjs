import { describe, expect, it } from "vitest";
import { parseClosedRecoveryOptions } from "../../tooling/recover-closed-computer.mjs";

const valid = [
  "--apply",
  "--operation",
  "11111111-1111-4111-8111-111111111111",
  "--expected-run",
  "a".repeat(64),
  "--expected-quit",
  "b".repeat(64),
];
describe("closed Computer maintenance command boundary (no owner state read)", () => {
  it("requires an explicit operation and both exact historical byte identities", () => {
    expect(parseClosedRecoveryOptions(valid)).toEqual({
      operationId: valid[2],
      expectedRunSha256: valid[4],
      expectedQuitSha256: valid[6],
    });
  });
  for (const extra of [
    ["--home", "/tmp/home"],
    ["--user-data", "/tmp/profile"],
    ["--force"],
    ["--apply"],
    ["--operation", "duplicate"],
  ]) {
    it(`refuses ${extra[0]} without an alternate state/helper route`, () => {
      expect(() => parseClosedRecoveryOptions([...valid, ...extra])).toThrow(
        "CLOSED_COMPUTER_RECOVERY_OPTIONS_INVALID",
      );
    });
  }
  it("refuses missing or malformed evidence instead of selecting a new operation", () => {
    expect(() => parseClosedRecoveryOptions(valid.slice(1))).toThrow(
      "CLOSED_COMPUTER_RECOVERY_EXACT_EVIDENCE_REQUIRED",
    );
    expect(() => parseClosedRecoveryOptions(valid.slice(0, -1))).toThrow(
      "CLOSED_COMPUTER_RECOVERY_EXACT_EVIDENCE_REQUIRED",
    );
  });
});
