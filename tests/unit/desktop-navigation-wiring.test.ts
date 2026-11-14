import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Surface navigation lives in apps/desktop/shell/navigation.ts and is tested
// there with injected ports. Nothing else checks which main-process variable
// each state accessor and port reads, so a swapped one would pass every other
// test. This asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

const functions = [
  "publishLayout",
  "publishShellAction",
  "focusForLayoutAfterRendererCommit",
  "requestQuickSwitcher",
  "requestSidebarToggle",
  "handleShortcut",
  "applyRendererLayout",
  "currentSurfaceLayout",
  "applyLayout",
];

describe("surface navigation wiring in main", () => {
  it("lends the state and each port from its own main-process owner", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("} = surfaceNavigation({");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source.slice(begin, source.indexOf("\n});\n", begin) + 1);
    for (const name of [
      "section",
      "selectedTaskId",
      "setupOpen",
      "checkFeedbackVisible",
      "sidebarMode",
      "sidebarWidth",
      "shellOverlay",
    ]) {
      expect(body).toContain(
        `\n    get ${name}() {\n      return ${name};\n    },\n`,
      );
      expect(body).toContain(
        `\n    set ${name}(value) {\n      ${name} = value;\n    },\n`,
      );
    }
    // Navigation reads these two and never writes them.
    for (const name of ["browserHomeSurfaceOpen", "navigationShortcuts"]) {
      expect(body).toContain(
        `\n    get ${name}() {\n      return ${name};\n    },\n`,
      );
      expect(body).not.toContain(`set ${name}(`);
    }
    for (const name of [
      "window",
      "quitInProgress",
      "installedUpdateAdmission",
      "runtimeState",
      "taskViews",
      "taskViewKinds",
      "nativeViewVisibility",
    ])
      expect(body).toContain(`\n  ${name}: () => ${name},\n`);
    expect(body).toContain("\n  signInSurfaceId: SIGN_IN_SURFACE_ID,\n");
    expect(body).toMatch(
      /\n  compactBrowser: \(\) =>\n    compactBrowserSelected\(\{\n      environment: runtimeEnvironment,\n      demoMode,\n      legacySetupTestMode,\n    \}\),\n/,
    );
    for (const name of [
      "liveTaskRoutes",
      "productTasksState",
      "attachTaskView",
      "openLiveTaskSurface",
      "requestSettings",
    ])
      expect(body).toContain(`\n  ${name},\n`);
  });

  it("uses the navigation module's functions, not a local copy", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("// Surface navigation writes the layout");
    const names = source
      .slice(source.indexOf("const {", begin), source.indexOf("} =", begin))
      .match(/\w+/g)
      ?.slice(1);
    expect(names).toEqual(functions);
    for (const name of [...functions, "focusForLayout", "closeShellOverlay"])
      expect(source).not.toMatch(
        new RegExp(`\\n(?:async )?function ${name}\\(`),
      );
    expect(source).not.toMatch(/\nlet sectionNavigationSequence\b/);
    // The window hands native input and the renderer's layout report to it.
    expect(source).toContain("handleShortcut(");
    expect(source).toContain("applyRendererLayout(");
  });
});
