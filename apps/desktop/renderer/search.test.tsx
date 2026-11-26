import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { Search } from "./search";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: { unmount(): void; host: HTMLElement }[] = [];
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function mount() {
  const snapshot = {
    tasks: {
      tasks: [
        { taskId: "t1", label: "Alpha chat" },
        { taskId: "t2", label: "Beta chat" },
      ],
    },
  } as unknown as WindowSnapshot;
  const facade = {
    navigate: vi.fn(),
    overlay: vi.fn(),
  } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  act(() => root.render(createElement(Search, { snapshot, facade })));
  const labels = () =>
    [...host.querySelectorAll(".search-results button")].map(
      (b) => b.textContent,
    );
  return { host, facade, labels };
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Search", () => {
  it("lists every page, setup step, settings page and chat", () => {
    const { labels } = mount();
    expect(labels()).toEqual(
      expect.arrayContaining([
        "Home",
        "ChatGPT",
        "Activity",
        "Setup",
        "General",
        "Appearance",
        "Keyboard shortcuts",
        "Alpha chat",
        "Beta chat",
      ]),
    );
  });
  it("filters by case-insensitive substring", () => {
    const { host, labels } = mount();
    type(host.querySelector("input")!, "BETA");
    expect(labels()).toEqual(["Beta chat"]);
  });
  it("navigates to a chat from its button", () => {
    const { host, facade } = mount();
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Alpha chat",
    );
    act(() => button?.click());
    expect(facade.navigate).toHaveBeenCalledWith({
      area: "chatgpt",
      taskId: "t1",
    });
  });
  it("Enter opens the first match and ignores composition", () => {
    const { host, facade } = mount();
    const input = host.querySelector("input")!;
    type(input, "keyboard");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(facade.navigate).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(facade.navigate).toHaveBeenCalledWith({
      label: "Keyboard shortcuts",
      area: "settings",
      page: "shortcuts",
    });
  });
});
