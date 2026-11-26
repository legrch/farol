import { describe, expect, it } from "vitest";
import type { Destination } from "../../../src/ui/renderer/contract";
import {
  canGoBack,
  canGoForward,
  currentDestination,
  historyLimit,
  initialHistory,
  reduceHistory,
  resolveDestination,
  sectionDestination,
  type History,
  type SectionNavigationAction,
} from "./history";
import { home } from "./snapshot";

const at = (area: Destination["area"], taskId = ""): Destination => ({
  area,
  page: "general",
  taskId,
});
function history(
  areas: readonly Destination["area"][],
  cursor: number,
): History {
  return { entries: areas.map((area) => at(area)), cursor };
}
const areas = (value: History) => value.entries.map((entry) => entry.area);

describe("initial history", () => {
  it("holds only the Home placeholder with nothing to travel to", () => {
    expect(initialHistory).toEqual({ entries: [home], cursor: 0 });
    expect(currentDestination(initialHistory)).toBe(home);
    expect(canGoBack(initialHistory)).toBe(false);
    expect(canGoForward(initialHistory)).toBe(false);
  });
});

describe("push", () => {
  it("appends after the cursor and moves to the new entry", () => {
    const next = reduceHistory(initialHistory, {
      kind: "push",
      destination: at("chatgpt"),
    });
    expect(areas(next)).toEqual(["home", "chatgpt"]);
    expect(next.cursor).toBe(1);
    expect(canGoBack(next)).toBe(true);
    expect(canGoForward(next)).toBe(false);
  });
  it("drops forward entries when pushing from the middle", () => {
    const next = reduceHistory(history(["home", "chatgpt", "activity"], 0), {
      kind: "push",
      destination: at("settings"),
    });
    expect(areas(next)).toEqual(["home", "settings"]);
    expect(next.cursor).toBe(1);
    expect(canGoForward(next)).toBe(false);
  });
  it("keeps a repeated destination as its own entry; callers dedupe", () => {
    const next = reduceHistory(history(["chatgpt"], 0), {
      kind: "push",
      destination: at("chatgpt"),
    });
    expect(areas(next)).toEqual(["chatgpt", "chatgpt"]);
  });
  it("forgets the oldest entry past the limit and keeps the cursor on the newest", () => {
    const full: History = {
      entries: Array.from({ length: historyLimit }, (_, index) =>
        at("activity", `task-${index}`),
      ),
      cursor: historyLimit - 1,
    };
    const next = reduceHistory(full, {
      kind: "push",
      destination: at("chatgpt", "newest"),
    });
    expect(next.entries).toHaveLength(historyLimit);
    expect(next.entries[0]!.taskId).toBe("task-1");
    expect(currentDestination(next).taskId).toBe("newest");
    expect(next.cursor).toBe(historyLimit - 1);
  });
  it("does not mutate the previous history", () => {
    const before = history(["home", "chatgpt"], 1);
    const snapshot = JSON.stringify(before);
    reduceHistory(before, { kind: "push", destination: at("setup") });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("travel", () => {
  const three = history(["home", "chatgpt", "activity"], 1);
  it.each([
    [-1, 0, "back"],
    [1, 2, "forward"],
  ] as const)("steps %i to cursor %i (%s)", (direction, cursor, _label) => {
    const next = reduceHistory(three, { kind: "travel", direction });
    expect(next.cursor).toBe(cursor);
    expect(next.entries).toBe(three.entries);
  });
  it("reports the neighbours available at each position", () => {
    const first = reduceHistory(three, { kind: "travel", direction: -1 });
    expect([canGoBack(first), canGoForward(first)]).toEqual([false, true]);
    const last = reduceHistory(three, { kind: "travel", direction: 1 });
    expect([canGoBack(last), canGoForward(last)]).toEqual([true, false]);
  });
  it.each([
    ["back from the first entry", history(["home", "chatgpt"], 0), -1],
    ["forward from the last entry", history(["home", "chatgpt"], 1), 1],
    ["back in a single-entry history", initialHistory, -1],
    ["forward in a single-entry history", initialHistory, 1],
  ] as const)(
    "refuses %s with the same reference",
    (_name, start, direction) => {
      expect(reduceHistory(start, { kind: "travel", direction })).toBe(start);
    },
  );
  it("walks the whole history and returns to where it started", () => {
    let walk = history(["home", "chatgpt", "activity", "settings"], 3);
    const seen: string[] = [];
    for (let step = 0; step < 3; step++) {
      walk = reduceHistory(walk, { kind: "travel", direction: -1 });
      seen.push(currentDestination(walk).area);
    }
    for (let step = 0; step < 3; step++) {
      walk = reduceHistory(walk, { kind: "travel", direction: 1 });
      seen.push(currentDestination(walk).area);
    }
    expect(seen).toEqual([
      "activity",
      "chatgpt",
      "home",
      "chatgpt",
      "activity",
      "settings",
    ]);
  });
  it("lets a later push replace what Back left ahead", () => {
    const back = reduceHistory(three, { kind: "travel", direction: -1 });
    const pushed = reduceHistory(back, {
      kind: "push",
      destination: at("setup"),
    });
    expect(areas(pushed)).toEqual(["home", "setup"]);
    expect(reduceHistory(pushed, { kind: "travel", direction: 1 })).toBe(
      pushed,
    );
  });
});

describe("replace", () => {
  it("rewrites only the shown entry and adds no navigation", () => {
    const start = history(["home", "chatgpt", "activity"], 1);
    const next = reduceHistory(start, {
      kind: "replace",
      destination: at("setup"),
    });
    expect(areas(next)).toEqual(["home", "setup", "activity"]);
    expect(next.cursor).toBe(1);
    expect(areas(start)).toEqual(["home", "chatgpt", "activity"]);
  });
});

describe("adopt-task", () => {
  it("fills every blank placeholder and leaves chosen tasks alone", () => {
    const start: History = {
      entries: [at("home"), at("activity", "chosen"), at("chatgpt")],
      cursor: 2,
    };
    const next = reduceHistory(start, { kind: "adopt-task", taskId: "task-9" });
    expect(next.entries.map((entry) => entry.taskId)).toEqual([
      "task-9",
      "chosen",
      "task-9",
    ]);
    expect(next.cursor).toBe(2);
    expect(next.entries[1]).toBe(start.entries[1]);
  });
  it("is a no-op when no placeholder is blank", () => {
    const start: History = { entries: [at("home", "chosen")], cursor: 0 };
    expect(reduceHistory(start, { kind: "adopt-task", taskId: "other" })).toBe(
      start,
    );
  });
});

describe("currentDestination", () => {
  it("refuses a cursor outside the history instead of inventing a destination", () => {
    expect(() =>
      currentDestination({ entries: [home], cursor: 3 }),
    ).toThrowError("HISTORY_CURSOR_OUT_OF_RANGE");
  });
});

describe("resolveDestination", () => {
  const shown: Destination = { area: "chatgpt", page: "general", taskId: "t1" };
  it("inherits the area, page and task that the request leaves out", () => {
    expect(resolveDestination(shown, {})).toEqual(shown);
    expect(resolveDestination(shown, { area: "activity" })).toEqual({
      area: "activity",
      page: "general",
      taskId: "t1",
    });
    expect(resolveDestination(shown, { taskId: "t2" }).taskId).toBe("t2");
  });
  it("sends a bare settings page to Settings", () => {
    expect(resolveDestination(shown, { page: "appearance" })).toEqual({
      area: "settings",
      page: "appearance",
      taskId: "t1",
    });
  });
  it("keeps the connection-check return only for the browser area", () => {
    expect(
      resolveDestination(home, {
        area: "chatgpt",
        connectionCheckReturn: true,
      }),
    ).toMatchObject({ area: "chatgpt", connectionCheckReturn: true });
    expect(
      resolveDestination(home, {
        area: "activity",
        connectionCheckReturn: true,
      }),
    ).not.toHaveProperty("connectionCheckReturn");
  });
  it("carries the activity id forward and lets null clear it", () => {
    const withActivity: Destination = { ...home, activityId: "a1" };
    expect(
      resolveDestination(withActivity, { area: "activity" }),
    ).toMatchObject({ activityId: "a1" });
    expect(
      resolveDestination(withActivity, { area: "activity", activityId: null }),
    ).toMatchObject({ activityId: null });
    expect(resolveDestination(home, { area: "activity" })).not.toHaveProperty(
      "activityId",
    );
  });
  it("resets the home selection when the home view changes", () => {
    const selected: Destination = {
      ...home,
      homeView: "overview",
      homeSelection: { kind: "task", id: "t1" },
    };
    expect(
      resolveDestination(selected, { homeView: "overview" }),
    ).toMatchObject({ homeSelection: { kind: "task", id: "t1" } });
    const fresh = resolveDestination(
      { ...home, homeSelection: { kind: "task", id: "t1" } },
      { homeView: "overview" },
    );
    expect(fresh.homeSelection).toBeNull();
    expect(
      resolveDestination(selected, {
        homeView: "overview",
        homeSelection: { kind: "activity", id: "a" },
      }).homeSelection,
    ).toEqual({ kind: "activity", id: "a" });
  });
  describe("setup", () => {
    it("opens at the overview and forces the general page", () => {
      expect(
        resolveDestination(shown, { area: "setup", page: "appearance" }),
      ).toMatchObject({
        area: "setup",
        setupStep: "overview",
        page: "general",
      });
    });
    it("keeps the current step only while staying inside setup", () => {
      const inSetup: Destination = {
        area: "setup",
        page: "general",
        taskId: "",
        setupStep: "connection",
      };
      expect(resolveDestination(inSetup, { area: "setup" }).setupStep).toBe(
        "connection",
      );
      expect(
        resolveDestination(inSetup, { area: "setup", setupStep: "signin" })
          .setupStep,
      ).toBe("signin");
      expect(
        resolveDestination({ ...inSetup, area: "activity" }, { area: "setup" })
          .setupStep,
      ).toBe("overview");
    });
    it("selects a workspace only on the folders step", () => {
      expect(
        resolveDestination(home, {
          area: "setup",
          setupStep: "folders",
          workspaceId: "w1",
        }),
      ).toMatchObject({ setupStep: "folders", workspaceId: "w1" });
      expect(
        resolveDestination(home, {
          area: "setup",
          setupStep: "signin",
          workspaceId: "w1",
        }),
      ).not.toHaveProperty("workspaceId");
    });
    it("keeps the selected workspace on a request that names no destination", () => {
      const folders: Destination = {
        area: "setup",
        page: "general",
        taskId: "",
        setupStep: "folders",
        workspaceId: "w1",
      };
      expect(resolveDestination(folders, { taskId: "t2" })).toMatchObject({
        workspaceId: "w1",
      });
      expect(
        resolveDestination(folders, { area: "setup", setupStep: "folders" }),
      ).not.toHaveProperty("workspaceId");
    });
  });
  it("orders its keys deterministically so equal requests compare equal as JSON", () => {
    const request = {
      area: "chatgpt",
      connectionCheckReturn: true,
      activityId: null,
    } as const;
    expect(JSON.stringify(resolveDestination(home, request))).toBe(
      JSON.stringify(resolveDestination(home, request)),
    );
    expect(Object.keys(resolveDestination(home, request))).toEqual([
      "area",
      "page",
      "taskId",
      "connectionCheckReturn",
      "activityId",
    ]);
  });
  it("does not mutate the shown destination or the request", () => {
    const request = {
      area: "setup",
      setupStep: "folders",
      workspaceId: "w",
    } as const;
    const before = JSON.stringify([shown, request]);
    resolveDestination(shown, request);
    expect(JSON.stringify([shown, request])).toBe(before);
  });
});

describe("sectionDestination", () => {
  const action = (
    section: SectionNavigationAction["section"],
    taskId = "t1",
  ): SectionNavigationAction => ({
    eventId: "11111111-1111-4111-8111-111111111111",
    authWindowGeneration: null,
    action: "navigate-section",
    source: "section-shortcut-command",
    section,
    taskId,
    sequence: 1,
  });
  it.each([
    ["home", { area: "home" }],
    ["browser", { area: "chatgpt" }],
    ["activity", { area: "activity" }],
    ["settings", { area: "settings" }],
    ["setup", { area: "setup", setupStep: "overview" }],
    ["computer", { area: "setup", setupStep: "folders" }],
  ] as const)("maps %s", (section, expected) => {
    expect(sectionDestination(action(section))).toEqual({
      ...expected,
      page: "general",
      taskId: "t1",
    });
  });
  it("passes a blank task through to clear the selection", () => {
    expect(sectionDestination(action("home", "")).taskId).toBe("");
  });
});
