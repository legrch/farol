import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The menu template lives in apps/desktop/shell/menu.ts and is tested there
// with injected actions. Nothing else checks which main-process function each
// action receives, so a swapped callback would pass every other test. This
// asserts the wiring as text; it executes nothing from main.ts.

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);

describe("application menu wiring in main", () => {
  it("hands each menu action its own request function", async () => {
    const source = await readFile(mainSource, "utf8");
    const begin = source.indexOf("function installApplicationMenu(");
    expect(begin).toBeGreaterThanOrEqual(0);
    const body = source.slice(begin, source.indexOf("\n}\n", begin));
    const actions = /actions:\s*\{([^}]*)\}/.exec(body)?.[1] ?? "";
    const wiring = Object.fromEntries(
      [...actions.matchAll(/(\w+):\s*(\w+)/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    expect(wiring).toEqual({
      about: "requestAbout",
      updates: "requestUpdates",
      settings: "requestSettings",
      toggleSidebar: "requestSidebarToggle",
      quickSwitcher: "requestQuickSwitcher",
    });
    expect(body).toContain("Menu.setApplicationMenu(");
    expect(source).toMatch(/const requestAbout = aboutCommand\(/);
  });
});
