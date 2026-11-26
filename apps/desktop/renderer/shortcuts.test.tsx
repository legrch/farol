import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultNavigationShortcuts } from "../../../src/pkg/ipc/navigation-shortcuts";
import type { PageProps } from "./page";
import { Shortcuts } from "./shortcuts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
const saved = { home: 1, browser: 2, activity: 3, setup: 4, sidebar: "s" };
function setup(over: Record<string, unknown> = {}, result = "applied") {
  const shortcuts = vi.fn(async () => ({ state: result }));
  const props = {
    snapshot: { status: "current", shortcuts: saved, intents: {}, ...over },
    facade: { shortcuts },
  } as unknown as PageProps;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(Shortcuts, props)));
  hosts.push({ unmount: () => root.unmount(), host });
  return { host, shortcuts };
}
const select = (host: HTMLElement, label: string) =>
  host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const flush = () => act(async () => {});

describe("Shortcuts", () => {
  it("shows the saved choices", () => {
    const { host } = setup();
    expect(host.querySelector("h2")?.textContent).toBe("Shortcuts");
    expect(select(host, "Home shortcut").value).toBe("1");
    expect(select(host, "ChatGPT shortcut").value).toBe("2");
    expect(select(host, "Activity shortcut").value).toBe("3");
    expect(select(host, "Setup shortcut").value).toBe("4");
    expect(select(host, "Toggle sidebar shortcut").value).toBe("s");
    expect(host.textContent).toContain("Settings always opens with ⌘,.");
    expect(
      [...select(host, "Home shortcut").options].map((o) => o.textContent),
    ).toEqual(["Off", "⌘1", "⌘2", "⌘3", "⌘4"]);
  });
  it("saves the edited draft and reports the applied result", async () => {
    const { host, shortcuts } = setup();
    choose(select(host, "Home shortcut"), "0");
    choose(select(host, "Toggle sidebar shortcut"), "b");
    act(() => button(host, "Save shortcuts").click());
    await flush();
    expect(shortcuts).toHaveBeenCalledWith({
      ...saved,
      home: 0,
      sidebar: "b",
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Shortcuts saved and active.",
    );
  });
  it.each([
    ["unknown", "Outcome unknown. Do not repeat this change."],
    ["refused", "Shortcut change refused."],
  ])("reports a %s result", async (state, text) => {
    const { host } = setup({}, state);
    act(() => button(host, "Save shortcuts").click());
    await flush();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(text);
  });
  it("rejects duplicate section keys without calling the facade", () => {
    const { host, shortcuts } = setup();
    choose(select(host, "Home shortcut"), "2");
    act(() => button(host, "Save shortcuts").click());
    expect(shortcuts).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Choose distinct section keys, or turn unused keys off.",
    );
  });
  it("restores the default choices locally", () => {
    const { host } = setup();
    act(() => button(host, "Restore default choices").click());
    expect(select(host, "Home shortcut").value).toBe(
      String(defaultNavigationShortcuts.home),
    );
    expect(select(host, "Toggle sidebar shortcut").value).toBe(
      defaultNavigationShortcuts.sidebar,
    );
  });
  it.each([
    [{ status: "stale" }],
    [{ intents: { shortcuts: { id: "x", state: "pending", code: null } } }],
    [{ intents: { shortcuts: { id: "x", state: "unknown", code: null } } }],
  ])("disables both buttons for %j", (over) => {
    const { host } = setup(over);
    expect(button(host, "Save shortcuts").disabled).toBe(true);
    expect(button(host, "Restore default choices").disabled).toBe(true);
  });
});
