// What the ordinary lane does when the harness, not the product, is the thing
// that fails late.  A contour run on 6aa80691 recorded the shape these guard
// against: terminal.json said FAIL with `cases: []` while the attempt
// directory held ~25 screenshots, because an exception thrown by `close()` in
// a `finally` ended the run before the case list was ever serialised.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const e2eSource = fs.readFileSync(
  path.resolve("tests/e2e/preview.e2e.mjs"),
  "utf8",
);

describe("an interrupted ordinary lane", () => {
  it("hands its live case lists to the attempt instead of only serialising at the end", () => {
    expect(e2eSource).toMatch(
      /evidenceAttempt\.trackRecords\(\(\) => \(\{\s*cases,\s*blockedCases,\s*skippedCases,\s*\}\)\);/u,
    );
  });
});

describe("closing an application that is already gone", () => {
  it("routes every application read in close() through the guard", () => {
    const close = e2eSource.slice(
      e2eSource.indexOf("async function close(instance, options = {}) {"),
    );
    const body = close.slice(0, close.indexOf("\nasync function restart("));
    expect(body).toContain(
      'ifApplicationLive(\n      instance,\n      "window-presentation"',
    );
    expect(body).toContain('ifApplicationLive(instance, "utility-metrics"');
    expect(body).toContain('ifApplicationLive(instance, "application-close"');
    // No unguarded read is left behind.
    expect(body).not.toMatch(
      /^\s*(const \w+ = )?await inspectWindowPresentation\(/mu,
    );
  });

  it("keeps the original assertions for an application that is still live", () => {
    expect(e2eSource).toMatch(
      /assert\.equal\(inspected\.value\.mode, instance\.windowMode\);/u,
    );
    expect(e2eSource).toMatch(
      /inspected\.value\.visible,\s*instance\.windowMode === "secondary-visible",/u,
    );
  });

  it("only swallows the errors that mean the target is gone, and rethrows the rest", () => {
    expect(e2eSource).toMatch(
      /const APPLICATION_ALREADY_GONE =\s*\/[^\n]*has been closed[^\n]*\/u;/u,
    );
    expect(e2eSource).toMatch(
      /if \(!APPLICATION_ALREADY_GONE\.test\(String\(error\?\.message \?\? error\)\)\) \{\s*throw error;/u,
    );
  });

  it("records the observation against the case that owned the instance", () => {
    expect(e2eSource).toContain('kind: "closed-before-inspection"');
    expect(e2eSource).toMatch(/owningCase,\s*caseCount: cases\.length,/u);
  });

  it("keeps the run classified as a failure rather than a quiet skip", () => {
    expect(e2eSource).toMatch(
      /evidenceAttempt\.recordFailure\(\s*"close",\s*`E2E_CLOSED_BEFORE_INSPECTION/u,
    );
    // Observations now carry a severity, and only the blocking ones decide
    // the run. The assertion that matters is unchanged: an application that
    // was already gone at close still forces FAIL and a non-zero exit. It
    // records no severity, and `blockingObservations` treats an absent
    // severity as blocking, so this kind cannot become informational by
    // omission.
    expect(e2eSource).toMatch(
      /const blockingObservations = blockingObservationsOf\(harnessObservations\);/u,
    );
    expect(e2eSource).toMatch(
      /missingRequiredCases\.length > 0 \|\| blockingObservations\.length > 0\s*\?\s*"FAIL"/u,
    );
    expect(e2eSource).toMatch(
      /if \(blockingObservations\.length > 0\) \{[\s\S]{0,200}process\.exitCode = 1;/u,
    );
    const closedBeforeInspection = e2eSource.slice(
      e2eSource.indexOf('kind: "closed-before-inspection"'),
    );
    expect(
      closedBeforeInspection.slice(0, closedBeforeInspection.indexOf("});")),
    ).not.toContain("severity");
  });

  it("does not count a quit it could not prove", () => {
    expect(e2eSource).toMatch(/if \(provedQuit\) quitProofs \+= 1;/u);
    expect(e2eSource).not.toMatch(/^\s*quitProofs \+= 1;\s*$/mu);
  });

  it("reports the observations in the run's own report", () => {
    expect(e2eSource).toMatch(/^\s*harnessObservations,$/mu);
  });
});
