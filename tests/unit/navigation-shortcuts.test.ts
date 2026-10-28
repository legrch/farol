import { describe, expect, it } from "vitest";
import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  sectionForShortcut,
  sidebarShortcutMatches,
} from "../../src/pkg/ipc/navigation-shortcuts";

describe("navigation shortcuts", () => {
  it("assigns the page order to Cmd 1 through Cmd 4", () => {
    expect(defaultNavigationShortcuts).toMatchObject({
      home: 1,
      browser: 2,
      activity: 3,
      setup: 4,
    });
    expect(sectionForShortcut(defaultNavigationShortcuts, "1")).toBe("home");
    expect(sectionForShortcut(defaultNavigationShortcuts, "4")).toBe("setup");
  });
  it("retains custom legacy page keys while Settings uses its fixed menu shortcut", () => {
    expect(
      parseNavigationShortcuts({
        browser: 4,
        computer: 0,
        activity: 2,
        settings: 1,
        sidebar: "b",
      }),
    ).toEqual({ home: 0, browser: 4, activity: 2, setup: 0, sidebar: "b" });
  });
  it("migrates saved navigation assignments and lets the sidebar key change or turn off", () => {
    const prior = parseNavigationShortcuts({
      browser: 1,
      computer: 2,
      activity: 3,
      settings: 4,
    });
    expect(prior).toEqual(defaultNavigationShortcuts);
    expect(
      parseNavigationShortcuts({
        browser: 1,
        computer: 2,
        activity: 3,
        settings: 4,
        sidebar: null,
      }),
    ).toBeNull();
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
      home: 1,
      browser: 4,
      activity: 2,
      setup: 0,
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
        setup: 1,
      }),
    ).toBeNull();
    expect(
      parseNavigationShortcuts({ ...defaultNavigationShortcuts, extra: 0 }),
    ).toBeNull();
    expect(parseNavigationShortcuts({ browser: 1 })).toBeNull();
    expect(parseNavigationShortcuts("1,2,3,4")).toBeNull();
  });
});
