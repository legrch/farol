import { describe, expect, it } from "vitest";
import {
  assertNoOpenFindings,
  OPEN_PROMOTION_FINDINGS,
} from "../../tooling/promote-preview.mjs";

describe("promotion while review findings are open", () => {
  it("the barrier mechanism still refuses --apply for any open finding, whatever the current list names", () => {
    expect(() => assertNoOpenFindings(true, ["F9-9"])).toThrow(
      "PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:F9-9",
    );
    expect(() =>
      assertNoOpenFindings(true, ["F9-9", "F9-10"]),
    ).toThrow("PROMOTION_APPLY_BLOCKED_BY_OPEN_FINDINGS:F9-9,F9-10");
  });

  it("an empty finding list never blocks --apply", () => {
    expect(() => assertNoOpenFindings(true, [])).not.toThrow();
  });

  it("a plan-only run is never blocked, even while findings are open", () => {
    expect(() => assertNoOpenFindings(false, ["F9-9"])).not.toThrow();
  });

  it("F3-3 and F3-4 are closed: neither still names promotion's own list of open findings", () => {
    expect(OPEN_PROMOTION_FINDINGS).not.toContain("F3-3");
    expect(OPEN_PROMOTION_FINDINGS).not.toContain("F3-4");
  });
});
