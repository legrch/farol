import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup, SetupNavigation } from "../../src/ui/renderer/setup";
import { WindowController } from "../../src/ui/renderer/controller";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
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
async function mount(step: SetupStep = "overview", shell = false) {
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
    if (shell)
      return (
        <Services value={c}>
          <Shell />
        </Services>
      );
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
  it("retains the original unknown receipt across real Review Setup navigation without dispatching commands", async () => {
    const h = await mount("connection", true);
    const operationId = "11111111-2222-4333-8444-555555555555";
    const intention = `settings:connector.save-and-connect:${operationId}`;
    const configuration = {
      status: "ready" as const,
      settings: settings(),
    };
    vi.mocked(h.f.api.configure).mockResolvedValueOnce({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
      snapshot: configuration,
      connectorAttempt: {
        method: "computer.connector.open",
        requestId: "22222222-3333-4444-8555-666666666666",
        operationId: "33333333-4444-4555-8666-777777777777",
        outcome: "unknown",
      },
      connectorSetup: {
        kind: "connector.save-and-connect",
        operationId,
        buildId: "3".repeat(64),
        state: "unknown",
        stoppedAt: "connection",
        credentials: "saved",
        connection: "unknown",
        code: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
        externalVerification: "not-proven",
        connectorAttempt: {
          method: "computer.connector.open",
          requestId: "22222222-3333-4444-8555-666666666666",
          operationId: "33333333-4444-4555-8666-777777777777",
          outcome: "unknown",
        },
      },
    });
    await act(async () => {
      await h.c.configure(
        {
          kind: "connector.save-and-connect",
          operationId,
          buildId: "3".repeat(64),
          tunnelId: "synthetic-tunnel",
          runtimeKey: "synthetic-local-draft-do-not-retain",
        },
        intention,
      );
    });
    const retained = structuredClone(h.c.getSnapshot().intents);
    expect(retained[intention]?.state).toBe("unknown");
    expect(retained[intention]?.connectorSetup?.operationId).toBe(operationId);
    expect(retained[intention]?.connectorAttempt).toEqual({
      method: "computer.connector.open",
      requestId: "22222222-3333-4444-8555-666666666666",
      operationId: "33333333-4444-4555-8666-777777777777",
      outcome: "unknown",
    });
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    vi.mocked(h.f.api.configure).mockClear();
    // Shell startup already observed update status before this review begins.
    vi.mocked(h.f.api.installedUpdate).mockClear();
    await h.click("Settings");
    await h.click("General");
    await h.click("Review Setup");
    for (const label of [
      "Overview",
      "Sign in",
      "Workspaces",
      "Connection",
      "Add to ChatGPT",
    ]) {
      const button = h.host.querySelector<HTMLButtonElement>(
        `nav[aria-label="Setup steps"] button[aria-label="${label}"]`,
      )!;
      expect(button).toBeTruthy();
      await act(async () => button.click());
      expect(h.c.getSnapshot().intents).toEqual(retained);
    }
    await act(async () => h.c.refresh());
    await h.click("Review setup");
    expect(h.c.getSnapshot().intents).toEqual(retained);
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(h.f.api.task).not.toHaveBeenCalled();
    expect(h.f.api.installedUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(h.c.getSnapshot())).not.toContain(
      "synthetic-local-draft-do-not-retain",
    );
    expect(h.button("Open Home")).toBeUndefined();
  });
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
