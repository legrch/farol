import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup, SetupNavigation } from "../../src/ui/renderer/setup";
import { WindowController } from "../../src/ui/renderer/controller";
import type { SetupStep } from "../../src/ui/renderer/contract";
import { bootstrap, fixture, settings } from "./fixture";
// Controlled DOM/IPC fixtures only; not sign-in, native dialog or live-provider proof.
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
const controllers: WindowController[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
async function mount(step: SetupStep = "overview") {
  const f = fixture();
  const configuration = { status: "ready" as const, settings: settings() };
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    environment: "dev",
    configuration,
  });
  vi.mocked(f.api.configure).mockResolvedValue({
    ok: true,
    snapshot: configuration,
  });
  const c = new WindowController(f.api);
  controllers.push(c);
  await c.start();
  c.navigate({ area: "setup", setupStep: step });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  function View() {
    const snapshot = useSyncExternalStore(c.subscribe, c.getSnapshot);
    return (
      <>
        <SetupNavigation snapshot={snapshot} facade={c} />
        <Setup snapshot={snapshot} facade={c} />
      </>
    );
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    ),
  );
  const visible = (e: Element) => !e.closest("[hidden]");
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .sort(
        (a, b) =>
          Number(Boolean(a.closest("nav"))) - Number(Boolean(b.closest("nav"))),
      )
      .find(
        (e) =>
          visible(e) &&
          (e.textContent?.trim() === text ||
            e.getAttribute("aria-label") === text),
      )!;
  const click = async (text: string) => {
    const b = button(text);
    expect(b).toBeTruthy();
    await act(async () => b.click());
  };
  return { f, c, host, button, click, visible };
}
describe("reference-aligned Setup wizard", () => {
  it("renders the same five section names without conflicting counters", async () => {
    const h = await mount();
    const nav = h.host.querySelector('nav[aria-label="Setup steps"]')!;
    expect(
      [...nav.querySelectorAll("button")].map((x) =>
        x.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Overview",
      "Sign in",
      "Workspaces",
      "Connection",
      "Add to ChatGPT",
    ]);
    expect(
      h.host.querySelectorAll(
        ".setup-step-number,.setup-overview-number,.setup-eyebrow",
      ).length,
    ).toBe(0);
    expect(
      [...h.host.querySelectorAll("[data-setup-check]")].map((x) =>
        x.getAttribute("data-setup-check"),
      ),
    ).toEqual(["signin", "folders", "connection", "attachment"]);
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("shows Sign in as a real Setup route, not a Settings or ChatGPT redirect", async () => {
    const h = await mount();
    await h.click("Set up Sign in");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "signin",
      page: "connection",
    });
    expect(h.button("Sign in")).toBeTruthy();
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("opens sign-in only on the owner's explicit click", async () => {
    const h = await mount("signin");
    await h.click("Sign in");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.f.api.configure).toHaveBeenLastCalledWith({
      kind: "chatgpt.open-sign-in",
    });
    expect(h.host.querySelector('[data-setup-step="signin"]')).toBeTruthy();
  });
  it("leaves embedded sign-in optional and navigation effect-free", async () => {
    const h = await mount("signin");
    await h.click("Continue");
    expect(h.c.getSnapshot().destination.setupStep).toBe("folders");
    expect(h.f.api.configure).not.toHaveBeenCalled();
    await h.click("Previous");
    expect(h.c.getSnapshot().destination.setupStep).toBe("signin");
  });
  it("does not expose credentials or connector controls on the Sign in step", async () => {
    const h = await mount("signin");
    for (const name of ["Tunnel ID", "Runtime key"]) {
      expect(
        [...h.host.querySelectorAll("label")]
          .filter(h.visible)
          .some((x) => x.textContent?.includes(name)),
      ).toBe(false);
    }
    expect(h.button("Stop connection")).toBeUndefined();
  });
  it("returns to Overview after Add to ChatGPT rather than another numbered Finish", async () => {
    const h = await mount("attachment");
    await h.click("Review setup");
    expect(h.c.getSnapshot().destination.setupStep).toBe("overview");
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("keeps legacy Finish destinations usable without creating a sixth sidebar entry", async () => {
    const h = await mount("finish");
    expect(h.host.querySelector('[data-setup-step="overview"]')).toBeTruthy();
    expect(h.host.querySelector('nav button[aria-label="Finish"]')).toBeNull();
    expect(
      h.host
        .querySelector('nav button[aria-label="Overview"]')
        ?.getAttribute("aria-current"),
    ).toBe("step");
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
});
