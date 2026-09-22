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

  it("does not request the duplicate sidebar fullscreen proof in the no-focus lane", () => {
    const start = e2eSource.indexOf("ux34SidebarToggleSegment:");
    const end = e2eSource.indexOf("// UX34-08 / UX34-07", start);
    const segment = e2eSource.slice(start, end);
    const focusGuard = segment.indexOf("if (nativeWindowProofAvailable)");
    const fullScreenRequest = segment.indexOf("shell?.setFullScreen(true)");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(focusGuard).toBeGreaterThan(-1);
    expect(fullScreenRequest).toBeGreaterThan(focusGuard);
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
