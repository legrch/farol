import { describe, expect, it } from "vitest";
import {
  parseOwnerLaunchResult,
  SECOND_INSTANCE_RESULT_PREFIX,
} from "../../tooling/owner-launch-result.mjs";

describe("owner launch result protocol", () => {
  it.each(["reopened", "identity-mismatch", "reopen-failed", "unverified"])(
    "parses the exact %s result",
    (outcome) => {
      expect(
        parseOwnerLaunchResult(
          `ordinary output\n${SECOND_INSTANCE_RESULT_PREFIX}${outcome}\n`,
        ),
      ).toBe(outcome);
    },
  );

  it("returns null when a primary instance exits without a second launch", () => {
    expect(parseOwnerLaunchResult("ordinary output\n")).toBeNull();
  });

  it("fails closed on unknown or duplicate markers", () => {
    expect(() =>
      parseOwnerLaunchResult(`${SECOND_INSTANCE_RESULT_PREFIX}unknown\n`),
    ).toThrow("OWNER_LAUNCH_RESULT_INVALID");
    expect(() =>
      parseOwnerLaunchResult(
        `${SECOND_INSTANCE_RESULT_PREFIX}reopened\n${SECOND_INSTANCE_RESULT_PREFIX}reopened\n`,
      ),
    ).toThrow("OWNER_LAUNCH_RESULT_AMBIGUOUS");
  });
});
