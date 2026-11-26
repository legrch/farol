import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Intent,
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { ChatBrowser } from "./browser";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: { unmount(): void; host: HTMLElement }[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.unmount());
    m.host.remove();
  }
});
const intent = (state: string, code: string | null = null): Intent =>
  ({ id: "x", state, code }) as unknown as Intent;
function mount(
  route: string,
  intents: Record<string, Intent> = {},
  over: Record<string, unknown> = {},
) {
  const snapshot = { route, intents, ...over } as unknown as WindowSnapshot;
  const facade = {
    overlay: vi.fn(),
    navigate: vi.fn(),
  } as unknown as RendererFacade;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  act(() => root.render(createElement(ChatBrowser, { snapshot, facade })));
  return { host, facade };
}
const key = "settings:chatgpt.open-browser:";

describe("ChatBrowser", () => {
  it("renders nothing when the page is loaded and no intent is retained", () => {
    expect(mount("loaded").host.innerHTML).toBe("");
    expect(mount("loaded", { [key]: intent("applied") }).host.innerHTML).toBe(
      "",
    );
  });
  it("reports an unconfirmed open as an alert and opens Unresolved actions", () => {
    const { host, facade } = mount("loaded", { [key]: intent("unknown") });
    expect(host.querySelector(".notice")?.getAttribute("role")).toBe("alert");
    expect(host.querySelector(".notice")?.textContent).toContain("unconfirmed");
    act(() => host.querySelector("button")?.click());
    expect(facade.overlay).toHaveBeenCalledWith("unresolved-actions");
  });
  it("reports a pending open as a status", () => {
    const { host } = mount("loaded", { [key]: intent("pending") });
    expect(host.querySelector(".notice")?.getAttribute("role")).toBe("status");
    expect(host.querySelector(".notice")?.textContent).toBe("Opening ChatGPT…");
  });
  it("explains a failed page and offers the Connection step", () => {
    const { host, facade } = mount("failed");
    expect(host.querySelector(".notice")?.textContent).toContain(
      "The page failed to load.",
    );
    act(() => host.querySelector("button")?.click());
    expect(facade.navigate).toHaveBeenCalledWith({
      area: "setup",
      setupStep: "connection",
    });
  });
  it("points at Connection for a failed intent on a loaded page", () => {
    const { host } = mount("loaded", { [key]: intent("failed", "X") });
    expect(host.querySelector(".notice")?.textContent).toContain(
      "Check Connection in Setup for details.",
    );
  });
  it("names an in-progress sign-in", () => {
    const { host } = mount("loaded", {
      "settings:chatgpt.open-sign-in:": intent(
        "failed",
        "CHATGPT_SIGN_IN_IN_PROGRESS",
      ),
    });
    expect(host.querySelector(".notice")?.textContent).toContain(
      "Sign-in is already open in ChatGPT.",
    );
  });
  it("omits the button for a failed route when a sign-in return is set", () => {
    const { host } = mount("failed", {}, { setupSignInReturn: {} });
    expect(host.querySelector("button")).toBeNull();
  });
});
