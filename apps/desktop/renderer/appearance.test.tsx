import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearancePage } from "./appearance";
import type { PageProps } from "./page";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function setup(appearance = { theme: "light", accent: "iris", font: "geist" }) {
  const live = { theme: "graphite", accent: "cobalt", font: "system" };
  const appearanceCall = vi.fn();
  const facade = {
    appearance: appearanceCall,
    getSnapshot: () => ({ appearance: live }),
  };
  const props = { snapshot: { appearance }, facade } as unknown as PageProps;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(AppearancePage, props)));
  hosts.push({ unmount: () => root.unmount(), host });
  return { host, appearanceCall, live };
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("AppearancePage", () => {
  it("renders the copy and marks the current choices pressed", () => {
    const { host } = setup();
    expect(host.querySelector(".appearance-intro")?.textContent).toBe(
      "One interface, in the light that feels right for you.",
    );
    expect(
      host.querySelector('[role="group"][aria-label="Theme"]'),
    ).not.toBeNull();
    expect(button(host, "Light").getAttribute("aria-pressed")).toBe("true");
    expect(button(host, "Graphite").getAttribute("aria-pressed")).toBe("false");
    const iris = host.querySelector('[aria-label="Iris accent"]')!;
    expect(iris.getAttribute("aria-pressed")).toBe("true");
    expect(iris.className).toBe("accent-choice iris");
    expect(
      (host.querySelector('select[aria-label="Typeface"]') as HTMLSelectElement)
        .value,
    ).toBe("geist");
    expect(host.textContent).toContain(
      "Changes apply immediately. You can change them again at any time.",
    );
  });
  it("labels the typeface select through its heading", () => {
    const { host } = setup();
    const select = host.querySelector("select")!;
    expect(host.querySelector(`label[for="${select.id}"]`)?.textContent).toBe(
      "Typeface",
    );
  });
  it("sends the live appearance with the chosen theme", () => {
    const { host, appearanceCall, live } = setup();
    act(() => button(host, "System").click());
    expect(appearanceCall).toHaveBeenCalledWith({ ...live, theme: "system" });
  });
  it("sends the live appearance with the chosen accent", () => {
    const { host, appearanceCall, live } = setup();
    act(() =>
      (
        host.querySelector('[aria-label="Amber accent"]') as HTMLElement
      ).click(),
    );
    expect(appearanceCall).toHaveBeenCalledWith({ ...live, accent: "amber" });
  });
  it("sends the live appearance with the chosen typeface", () => {
    const { host, appearanceCall, live } = setup();
    const select = host.querySelector("select") as HTMLSelectElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value",
      )!.set!;
      set.call(select, "system");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(appearanceCall).toHaveBeenCalledWith({ ...live, font: "system" });
  });
});
