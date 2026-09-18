import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const e2eSource = fs.readFileSync(
  path.resolve("tests/e2e/preview.e2e.mjs"),
  "utf8",
);

describe("the native E2E window policy", () => {
  it("never treats BrowserWindow array order as owned-shell identity", () => {
    expect(e2eSource).not.toMatch(
      /BrowserWindow\.getAllWindows\(\)\s*\[\s*0\s*\]/u,
    );
  });

  it("offers an explicit no-focus lane without accepting native focus proof", () => {
    expect(e2eSource).toContain(
      'const skipNativeFocus = process.argv.includes("--skip-native-focus")',
    );
    expect(e2eSource).toMatch(
      /skipNativeFocus\s*\?\s*"blocked-owner-authorization"/u,
    );
  });

  it("records an unavailable secondary topology before any visible launch", () => {
    const preflight = e2eSource.indexOf(
      "await writeWindowTopologyBlockedReport(ordinary.presentation)",
    );
    const visibleLaunch = e2eSource.indexOf(
      'const ordinaryLiveTasks = await launch([], "secondary-visible", "ordinary")',
    );

    expect(preflight).toBeGreaterThan(-1);
    expect(visibleLaunch).toBeGreaterThan(preflight);
  });
});
