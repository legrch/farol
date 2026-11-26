import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import {
  Activity,
  activityItems,
  activityPhase,
  activitySelection,
  activityTitle,
  type ActivityFilter,
} from "./activity";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = WindowSnapshot["activity"][number];
const row = (over: Partial<Row>): Row =>
  ({
    id: "e1",
    label: "Event one",
    kind: "turn.terminal",
    phase: "completed",
    at: Date.UTC(2026, 0, 2, 3, 4, 5),
    taskId: "t1",
    turnId: "u1",
    generation: 1,
    ...over,
  }) as unknown as Row;
function snap(
  activity: Row[],
  over: Record<string, unknown> = {},
  destination: Record<string, unknown> = {},
) {
  return {
    status: "current",
    runtime: "ready",
    overlay: "none",
    sidebar: "expanded",
    activity,
    tasks: { tasks: [{ taskId: "t1", turnId: "u1", label: "Chat" }] },
    destination: { area: "activity", ...destination },
    ...over,
  } as unknown as WindowSnapshot;
}

describe("activity selection", () => {
  const rows = [
    row({ id: "a", label: "A", phase: "completed" }),
    row({ id: "b", label: "B", phase: "outcome_unknown" }),
  ];
  it("lists newest first and filters to events needing attention", () => {
    const s = snap(rows);
    expect(activityItems(s, "all").map((r) => r.id)).toEqual(["b", "a"]);
    expect(activityItems(s, "attention").map((r) => r.id)).toEqual(["b"]);
  });
  it("selects the first item when none is addressed", () => {
    const sel = activitySelection(snap(rows), "all");
    expect(sel.selected?.id).toBe("b");
    expect(sel.missing).toBe(false);
    expect(sel.filtered).toBe(false);
  });
  it("reports a missing addressed event and a filtered-out one", () => {
    expect(
      activitySelection(snap(rows, {}, { activityId: "zzz" }), "all").missing,
    ).toBe(true);
    const out = activitySelection(
      snap(rows, {}, { activityId: "a" }),
      "attention",
    );
    expect(out.filtered).toBe(true);
    expect(out.missing).toBe(false);
  });
  it("titles the page from the selected event unless filtered or diagnostic", () => {
    expect(activityTitle(snap(rows), "all")).toBe("B");
    expect(
      activityTitle(snap(rows, {}, { activityId: "a" }), "attention"),
    ).toBe("Activity");
    expect(activityTitle(snap(rows, { activityDiagnostics: {} }), "all")).toBe(
      "Activity",
    );
  });
  it("words the phase", () => {
    expect(activityPhase(row({ phase: "outcome_unknown" }))).toBe(
      "outcome unknown",
    );
    expect(activityPhase(row({ phase: null }))).toBe("Phase not recorded");
  });
});

const mounted: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function mount(
  snapshot: WindowSnapshot,
  filter: ActivityFilter = "all",
  showList = true,
) {
  const navigate = vi.fn();
  const onFilter = vi.fn();
  const facade = {
    getSnapshot: () => snapshot,
    navigate,
    overlay: vi.fn(),
  } as unknown as RendererFacade;
  const heading = createRef<HTMLHeadingElement>();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  act(() =>
    root.render(
      createElement(Activity, {
        snapshot,
        facade,
        filter,
        onFilter,
        showList,
        heading,
      }),
    ),
  );
  return { host, navigate, onFilter };
}

describe("Activity", () => {
  it("shows the empty state when nothing was recorded", () => {
    const { host } = mount(snap([]));
    expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
      "No activity yet",
    );
    expect(host.textContent).toContain("No matching events.");
  });
  it("shows the selected record with its identifiers", () => {
    const { host } = mount(snap([row({})]));
    expect(host.querySelector(".activity-event strong")?.textContent).toBe(
      "Completed event",
    );
    expect(host.textContent).toContain("A completed result was recorded.");
    expect(host.textContent).toContain("Event identity");
    expect(host.textContent).toContain("View chat");
  });
  it("hides the list when showList is false", () => {
    const { host } = mount(snap([row({})]), "all", false);
    expect(host.querySelector(".activity-navigation")).toBeNull();
  });
  it("navigates from a row and reports a filter change", () => {
    const { host, navigate, onFilter } = mount(snap([row({})]));
    act(() => host.querySelector<HTMLButtonElement>(".activity-row")?.click());
    expect(navigate).toHaveBeenCalledWith({
      area: "activity",
      activityId: "e1",
    });
    const select = host.querySelector("select")!;
    act(() => {
      select.value = "attention";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onFilter).toHaveBeenCalledWith("attention");
  });
  it("offers to show all activity when the attention filter is empty", () => {
    const { host, onFilter } = mount(snap([row({})]), "attention");
    expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
      "No events need attention",
    );
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Show all activity",
    );
    act(() => button?.click());
    expect(onFilter).toHaveBeenCalledWith("all");
  });
  it("says an addressed event is no longer available", () => {
    const { host } = mount(snap([row({})], {}, { activityId: "gone" }));
    expect(host.querySelector(".activity-empty h2")?.textContent).toBe(
      "Event no longer available",
    );
  });
});
