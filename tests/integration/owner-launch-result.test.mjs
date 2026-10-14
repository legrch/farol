import { describe, expect, it } from "vitest";
import {
  createOwnerLaunchResultCollector,
  parseOwnerLaunchResult,
  SECOND_INSTANCE_RESULT_PREFIX,
} from "../../tooling/owner-launch-result.mjs";

describe("owner launch result protocol", () => {
  it.each([
    "primary-started",
    "primary-recovery",
    "reopened",
    "identity-mismatch",
    "reopen-failed",
    "startup-failed",
    "unverified",
  ])("parses the exact %s result", (outcome) => {
    expect(
      parseOwnerLaunchResult(
        `ordinary output\n${SECOND_INSTANCE_RESULT_PREFIX}${outcome}\n`,
      ),
    ).toBe(outcome);
  });

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

  it("collects a mandatory result after arbitrarily large ordinary output", () => {
    const collector = createOwnerLaunchResultCollector();
    collector.push(Buffer.from(`${"x".repeat(70_000)}\n`));
    collector.push(
      Buffer.from(`${SECOND_INSTANCE_RESULT_PREFIX}identity-mismatch\n`),
    );
    expect(collector.finish()).toBe("identity-mismatch");
  });

  it("waits for complete stream data and refuses a lost result", () => {
    const collector = createOwnerLaunchResultCollector();
    collector.push(Buffer.from(SECOND_INSTANCE_RESULT_PREFIX.slice(0, 12)));
    collector.push(
      Buffer.from(
        `${SECOND_INSTANCE_RESULT_PREFIX.slice(12)}reopened\nordinary tail\n`,
      ),
    );
    expect(collector.finish()).toBe("reopened");

    expect(() => createOwnerLaunchResultCollector().finish()).toThrow(
      "OWNER_LAUNCH_RESULT_MISSING",
    );
  });
});
