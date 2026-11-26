import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import type { Actions } from "./page";
import { UnresolvedActionsContent } from "./unresolved";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const hosts: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of hosts.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
function render(intents: Record<string, Intent> = {}) {
  const snapshot = {
    status: "current",
    runtime: "ready",
    environment: "stable",
    intents,
    activity: [],
    update: { phase: "idle" },
    configuration: null,
    evidence: null,
  } as unknown as WindowSnapshot;
  const facade = {
    getSnapshot: () => snapshot,
    overlay: vi.fn(),
    navigate: vi.fn(),
  } as unknown as RendererFacade;
  const actions = {
    allowed: () => true,
    run: vi.fn(),
    refresh: vi.fn(async () => null),
  } as unknown as Actions;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  hosts.push({ unmount: () => root.unmount(), host });
  act(() =>
    root.render(
      createElement(UnresolvedActionsContent, { snapshot, facade, actions }),
    ),
  );
  return { host, actions };
}

describe("UnresolvedActionsContent", () => {
  it("reports an empty list and refreshes status", () => {
    const r = render();
    expect(r.host.querySelector("[role=status]")?.textContent).toBe(
      "No unresolved actions.",
    );
    act(() =>
      [...r.host.querySelectorAll("button")]
        .find((b) => b.textContent === "Refresh status")!
        .click(),
    );
    expect(r.actions.refresh).toHaveBeenCalledOnce();
  });
  it("lists an unknown row with its id and code", () => {
    const id = "settings:chatgpt.open-browser:";
    const r = render({
      [id]: { id, state: "unknown", code: "OUTCOME_UNKNOWN" } as Intent,
    });
    const list = r.host.querySelector(
      "ul[aria-label='Unresolved operations']",
    )!;
    expect(list.querySelector("h3")?.textContent).toBe("chatgpt open browser");
    expect(list.textContent).toContain("Outcome unknown.");
    expect(list.textContent).toContain("OUTCOME_UNKNOWN");
  });
});
