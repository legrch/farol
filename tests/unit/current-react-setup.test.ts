import { describe, expect, it } from "vitest";

// Pure source-helper retirement proof: never launch a native journey.
const {
  assertSetupOverviewEvidence,
  assertSetupOverview,
  reviewSetupWithoutChanges,
} = await import(
  new URL("../e2e/current-react-setup.mjs", import.meta.url).href
);
describe("retired Setup checklist journeys", () => {
  it("explicitly retires the removed optional-sign-in overview evidence", () => {
    expect(() => assertSetupOverviewEvidence()).toThrow(
      /E2E_JOURNEY_RETIRED:setup-overview-evidence:.*required linear steps/u,
    );
  });
  it("refuses the removed overview and retained-action review before touching a page", async () => {
    await expect(assertSetupOverview()).rejects.toThrow(
      /E2E_JOURNEY_RETIRED:setup-overview:/u,
    );
    await expect(reviewSetupWithoutChanges()).rejects.toThrow(
      /E2E_JOURNEY_RETIRED:review-setup-retained-actions:/u,
    );
  });
});
