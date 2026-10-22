import { describe, expect, it, vi } from "vitest";
const retirementModule = "../../tooling/setup-journey-retirement.mjs";
const { reportRetiredJourney, retiredJourneyReport } = await import(
  retirementModule
);

describe("setup journey retirement reports", () => {
  it("returns a structured non-qualifying NOT_RUN report", () => {
    expect(
      retiredJourneyReport("guided-setup", "required observer was removed"),
    ).toEqual({
      schema: 1,
      status: "NOT_RUN",
      journey: "guided-setup",
      reason: "required observer was removed",
      qualifying: false,
    });
  });

  it.each([
    ["", "reason"],
    ["  ", "reason"],
    [1, "reason"],
    ["journey", ""],
    ["journey", "  "],
    ["journey", null],
  ])("rejects invalid journey or reason: %j", (journey, reason) => {
    expect(() => retiredJourneyReport(journey, reason)).toThrow(TypeError);
  });

  it("writes one JSON line through the injected writer and returns the report", () => {
    const write = vi.fn();
    const report = reportRetiredJourney(
      "connector-polling",
      "UI removed",
      write,
    );

    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(report)}\n`);
    expect(report).toEqual(
      retiredJourneyReport("connector-polling", "UI removed"),
    );
  });
});
