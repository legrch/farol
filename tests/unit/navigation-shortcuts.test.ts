import { describe, expect, it } from "vitest";
import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  sectionForShortcut,
  sidebarShortcutMatches,
} from "../../src/pkg/ipc/navigation-shortcuts";

describe("navigation shortcuts", () => {
  it("migrates saved navigation assignments and lets the sidebar key change or turn off", () => {
    const prior = parseNavigationShortcuts({
      browser: 1,
      computer: 2,
      activity: 3,
      settings: 4,
    });
    expect(prior?.sidebar).toBe("s");
    expect(sidebarShortcutMatches(prior!, "S")).toBe(true);
    const changed = parseNavigationShortcuts({ ...prior, sidebar: "b" });
    expect(sidebarShortcutMatches(changed!, "b")).toBe(true);
    expect(sidebarShortcutMatches(changed!, "s")).toBe(false);
    expect(sidebarShortcutMatches({ ...changed!, sidebar: "off" }, "b")).toBe(
      false,
    );
  });
  it("accepts distinct assignments and deliberate unbound sections", () => {
    const settings = parseNavigationShortcuts({
      browser: 4,
      computer: 0,
      activity: 2,
      settings: 1,
    });
    expect(settings).not.toBeNull();
    expect(sectionForShortcut(settings!, "4")).toBe("browser");
    expect(sectionForShortcut(settings!, "3")).toBeNull();
    expect(sectionForShortcut(settings!, "0")).toBeNull();
  });

  it("rejects conflicts, extra keys, missing keys and malformed storage", () => {
    expect(
      parseNavigationShortcuts({
        ...defaultNavigationShortcuts,
        computer: 1,
      }),
    ).toBeNull();
    expect(
      parseNavigationShortcuts({ ...defaultNavigationShortcuts, extra: 0 }),
    ).toBeNull();
    expect(parseNavigationShortcuts({ browser: 1 })).toBeNull();
    expect(parseNavigationShortcuts("1,2,3,4")).toBeNull();
  });
});
