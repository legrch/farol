import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

describe("Route B check admission contract", () => {
  it("reserves the shared host-check admission before the first await and releases it in finally", async () => {
    const source = await fs.readFile(
      path.join(root, "src/apps/desktop/main.ts"),
      "utf8",
    );
    const start = source.indexOf('case "host.run-route-b-check"');
    const end = source.indexOf('case "host.run-codex-smoke"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);
    const reservation = branch.indexOf("codexHostTaskAdmission = true");
    const firstAwait = branch.indexOf("await ");
    const protectedTry = branch.indexOf("try {");
    const release = branch.indexOf("codexHostTaskAdmission = false");
    const finalizer = branch.indexOf("finally {");

    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(firstAwait).toBeGreaterThan(reservation);
    expect(protectedTry).toBeGreaterThan(reservation);
    expect(protectedTry).toBeLessThan(firstAwait);
    expect(finalizer).toBeGreaterThan(firstAwait);
    expect(release).toBeGreaterThan(finalizer);
  });

  it("invalidates local host readiness when the preflight contract no longer matches", async () => {
    const source = await fs.readFile(
      path.join(root, "src/apps/desktop/main.ts"),
      "utf8",
    );
    const start = source.indexOf('case "host.run-route-b-check"');
    const end = source.indexOf('case "host.run-codex-smoke"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const branch = source.slice(start, end);
    const mismatch = branch.indexOf(
      'configurationFailure("CODEX_HOST_RECHECK_REQUIRED")',
    );
    const invalidation = branch.indexOf(
      'configuration.recordCodexHostFailure("unreachable")',
    );

    expect(invalidation).toBeGreaterThanOrEqual(0);
    expect(invalidation).toBeLessThan(mismatch);
  });
});
