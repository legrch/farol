import { describe, expect, it } from "vitest";
const retirementModule = "../../tooling/preview-setup-retirement.mjs";
const selectionModule = "../../tooling/e2e-selection.mjs";
const { previewRetirementPlan } = await import(retirementModule);
const { resolveSelection } = await import(selectionModule);
describe("preview retirement selection", () => {
  it("keeps independent segments runnable and exposes every retired dependency", () => {
    const plan = previewRetirementPlan(null);
    expect(plan.selection.segments).toEqual([
      "ordinary-startup",
      "legacy-start-order",
      "fence-unheld",
      "fence-reconciled",
    ]);
    expect(plan.retired.length).toBeGreaterThan(0);
    for (const entry of plan.retired) {
      expect(entry.status).toBe("NOT_RUN");
      expect(entry.qualifying).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    // A non-null selection is reported SELECTED by the existing native runner,
    // which cannot qualify the full lane as PASS.
    expect(plan.selection).not.toBeNull();
  });
  it("preserves explicit runnable selections", () => {
    const selected = resolveSelection(["fence-unheld"]);
    expect(previewRetirementPlan(selected)).toEqual({
      selection: selected,
      retired: [],
    });
  });
  it("reports an explicitly retired selection without adding other journeys", () => {
    const plan = previewRetirementPlan(resolveSelection(["demo-main"]));
    expect(plan.selection.segments).toEqual([]);
    expect(plan.retired).toHaveLength(1);
    expect(plan.retired[0]).toMatchObject({
      journey: "demo-main",
      status: "NOT_RUN",
      qualifying: false,
    });
  });
  it("preserves unrelated members of a mixed selection", () => {
    const plan = previewRetirementPlan(
      resolveSelection(["ordinary-startup", "demo-main"]),
    );
    expect(plan.selection.segments).toEqual(["ordinary-startup"]);
    expect(
      plan.retired.map((entry: { journey: string }) => entry.journey),
    ).toEqual(["demo-main"]);
  });
});
