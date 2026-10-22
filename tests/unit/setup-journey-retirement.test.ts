import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

it("delivers the full UTF-8 retirement record to a captured pipe before exit", () => {
  // A tiny Node fixture, never a native E2E entrypoint or product process.
  const reason = "synthetic-☀".repeat(20_000);
  const helperUrl = pathToFileURL(
    resolve("tooling/setup-journey-retirement.mjs"),
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { reportRetiredJourney } from ${JSON.stringify(helperUrl)}; reportRetiredJourney("pipe-fixture", "synthetic-☀".repeat(20000)); process.exit(0);`,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(child.stdout).toBe(
    `${JSON.stringify(retiredJourneyReport("pipe-fixture", reason))}\n`,
  );
});
