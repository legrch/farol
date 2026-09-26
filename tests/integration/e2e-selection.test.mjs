import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SELECTABLE_SEGMENTS,
  createSelection,
  isSegmentSelected,
  resolveSelection,
  shouldRunDevelopmentSegment,
} from "../../tooling/e2e-selection.mjs";

const e2eSource = fs.readFileSync(
  path.resolve("tests/e2e/preview.e2e.mjs"),
  "utf8",
);

const declared = SELECTABLE_SEGMENTS.map((segment) => segment.name);

describe("the E2E lane selector", () => {
  it("runs the whole lane when no selector is given", () => {
    expect(createSelection(["node", "preview.e2e.mjs", "--development"])).toBe(
      null,
    );
    for (const name of declared) {
      expect(isSegmentSelected(null, name)).toBe(true);
    }
  });

  it("selects a segment by its own name", () => {
    const selection = createSelection(["--only=n04b-model"]);
    expect(selection?.segments).toEqual(["n04b-model"]);
    expect(isSegmentSelected(selection, "n04b-model")).toBe(true);
    expect(isSegmentSelected(selection, "live-tasks")).toBe(false);
  });

  it("selects a segment by a case id it owns, exact or longer", () => {
    expect(createSelection(["--only=ux34-sign"])?.segments).toEqual([
      "ux34-sign-in-return",
    ]);
    expect(
      createSelection(["--only=ux34-sign-in-return-pointer"])?.segments,
    ).toEqual(["ux34-sign-in-return"]);
  });

  it("accumulates several selectors and keeps every owning segment", () => {
    expect(
      createSelection(["--only=n04b-model,window-close"])?.segments,
    ).toEqual(["demo-main", "n04b-model"]);
    // `isolated-start-order-*` genuinely runs in two segments; selecting the
    // family must not silently drop one of them.
    expect(createSelection(["--only=isolated-start"])?.segments).toEqual([
      "legacy-start-order",
      "process-death",
    ]);
  });

  it("refuses a selector that matches nothing rather than running empty", () => {
    expect(() => createSelection(["--only=no-such-case"])).toThrow(
      /E2E_UNKNOWN_SELECTION:no-such-case/u,
    );
    expect(() => createSelection(["--only=n04b-model,typo"])).toThrow(
      /E2E_UNKNOWN_SELECTION:typo/u,
    );
    expect(() => createSelection(["--only="])).toThrow(/E2E_EMPTY_SELECTION/u);
  });

  it("refuses a gate that names an undeclared segment", () => {
    expect(() => isSegmentSelected(null, "not-a-segment")).toThrow(
      /E2E_UNDECLARED_SEGMENT:not-a-segment/u,
    );
  });

  it("declares each segment once, with at least one owned case family", () => {
    expect(new Set(declared).size).toBe(declared.length);
    for (const segment of SELECTABLE_SEGMENTS) {
      expect(segment.cases.length).toBeGreaterThan(0);
    }
  });

  it("keeps resolution independent of the order selectors arrive in", () => {
    const forward = resolveSelection(["n04b-model", "ux34-sidebar"]);
    const backward = resolveSelection(["ux34-sidebar", "n04b-model"]);
    expect(forward.segments).toEqual(backward.segments);
  });
});

describe("development-only E2E admission", () => {
  it("runs the required affordance journey in full and selected development runs", () => {
    const admitted = (argv, development) =>
      shouldRunDevelopmentSegment(
        createSelection(argv),
        development,
        "dev-new-task-affordance",
      );
    expect(admitted(["--development"], true)).toBe(true);
    expect(
      admitted(["--development", "--only=dev-new-task-affordance"], true),
    ).toBe(true);
    expect(admitted(["--development", "--only=live-tasks"], true)).toBe(false);
    expect(admitted([], false)).toBe(false);
    expect(admitted(["--only=dev-new-task-affordance"], false)).toBe(false);
    const gate = e2eSource.slice(
      e2eSource.indexOf("devNewTaskAffordanceSegment: {"),
      e2eSource.indexOf("devNewTaskAffordanceSegment: {") + 320,
    );
    expect(gate).toMatch(
      /if\s*\(\s*!shouldRunDevelopmentSegment\(\s*selection,\s*development,\s*"dev-new-task-affordance",?\s*\)\s*\)\s*\{\s*break devNewTaskAffordanceSegment;/u,
    );
  });
});

describe("the runner's selection gates", () => {
  const gated = [
    ...e2eSource.matchAll(/segmentSelected\("([a-z0-9-]+)"\)/gu),
  ].map((match) => match[1]);

  // `process-death` owns two adjacent top-level regions: the instance it
  // launches, and the startup-death stages that follow it outside that
  // instance's try.  Both are gated, so selecting the segment runs the whole
  // family and skipping it leaves neither half behind.
  const expectedGateCount = new Map(declared.map((name) => [name, 1]))
    .set("process-death", 2)
    .set("dev-new-task-affordance", 0);

  it("gates every declared segment, and nothing it has not declared", () => {
    expect([...new Set(gated)].sort()).toEqual(
      declared.filter((name) => name !== "dev-new-task-affordance").sort(),
    );
    for (const [name, count] of expectedGateCount) {
      expect(gated.filter((entry) => entry === name)).toHaveLength(count);
    }
  });

  it("keeps the quit-proof budget inside the segment that earns it", () => {
    // The budget must never be asserted in a run that deliberately skipped
    // the segments whose closes earn the proofs.
    const tail = e2eSource.slice(
      e2eSource.indexOf('if (segmentSelected("process-death")) {'),
    );
    expect(tail.slice(0, tail.indexOf("\n}\n"))).toContain(
      "E2E_QUIT_PROOF_INCOMPLETE",
    );
  });

  it("breaks out of a labelled segment instead of falling through", () => {
    for (const match of e2eSource.matchAll(
      /if \(!segmentSelected\("([a-z0-9-]+)"\)\) break ([A-Za-z0-9]+);/gu,
    )) {
      expect(e2eSource).toContain(`${match[2]}: `);
    }
  });

  it("records the selection where a crash cannot lose it", () => {
    // report.json is written at the very end; a run that throws first would
    // leave receipts that read exactly like a failed full lane.
    expect(e2eSource).toMatch(
      /input: \{[\s\S]*?\.\.\.\(selection \? \{ selection \} : \{\}\),/u,
    );
  });

  it("never reports a selected run as PASS", () => {
    expect(e2eSource).toMatch(/status: selectionActive\s*\?\s*"SELECTED"\s*:/u);
  });

  it("does not let a selected run claim the lane's required cases", () => {
    expect(e2eSource).toMatch(
      /const missingRequiredCases = selectionActive\s*\?\s*\[\]\s*:\s*missingCases\(/u,
    );
  });

  it("refuses to combine a selection with a whole-workload special lane", () => {
    expect(e2eSource).toContain("E2E_SELECTION_EXCLUSIVE_WITH_SPECIAL_LANE");
  });
});
