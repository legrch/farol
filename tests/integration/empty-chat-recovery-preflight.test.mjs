import { describe, expect, it } from "vitest";
import { parseEmptyRecoveryOptions } from "../../tooling/recover-empty-chat.mjs";

// Actual private CLI admission only; no process, profile, maintenance or native
// effect. These checks do not confer host or recovery authority.
describe("one-shot empty Chat recovery preflight", () => {
  const exact = [
    "--apply",
    "--development",
    "--selection",
    "/private/tmp/selected.json",
    "--selection-sha",
    "a".repeat(64),
    "--expected-source",
    "b".repeat(40),
    "--expected-run",
    "c".repeat(64),
    "--expected-config",
    "d".repeat(64),
  ];
  it("requires a complete exact Dev-only selection", () => {
    expect(parseEmptyRecoveryOptions(exact)["--expected-source"]).toBe(
      "b".repeat(40),
    );
    for (let n = 0; n < exact.length; n++) {
      if (exact[n].startsWith("--")) {
        const count = n < 2 ? 1 : 2;
        expect(() =>
          parseEmptyRecoveryOptions([
            ...exact.slice(0, n),
            ...exact.slice(n + count),
          ]),
        ).toThrow();
      }
    }
  });
  it.each([
    "--profile",
    "--home",
    "--production",
    "--retry",
    "--resume",
    "--force",
    "--development",
  ])("refuses %s overrides or duplicates", (flag) => {
    expect(() =>
      parseEmptyRecoveryOptions([...exact, flag, "anything"]),
    ).toThrow();
  });
  it("refuses relative selection paths and malformed source/digests", () => {
    for (const [name, value] of [
      ["--selection", "relative.json"],
      ["--expected-source", "b".repeat(39)],
      ["--expected-run", "Z".repeat(64)],
    ]) {
      const bad = [...exact];
      bad[bad.indexOf(name) + 1] = value;
      expect(() => parseEmptyRecoveryOptions(bad)).toThrow();
    }
  });
});
