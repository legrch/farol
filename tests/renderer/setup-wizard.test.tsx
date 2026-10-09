import { StrictMode, act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup, SetupNavigation } from "../../src/ui/renderer/setup";
import { WindowController } from "../../src/ui/renderer/controller";
import { Shell } from "../../src/ui/renderer/shell";
import { Services } from "../../src/ui/renderer/services";
import type { SetupStep } from "../../src/ui/renderer/contract";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { bootstrap, deferred, fixture, settings } from "./fixture";
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
function attachmentSettings() {
  const value = settings();
  const buildId = "3".repeat(64);
  const runtimeGeneration = "a".repeat(64);
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const verifiedAt = "2026-10-02T20:00:00.000Z";
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
      accessCheck: {
        buildId,
        computerGeneration: 1,
        verifiedAt,
        rootIdentity: { device: "1", inode: "2" },
      },
    },
  ];
  value.setup.computer.verified = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt,
  };
  // Published current workspace/runtime/challenge data; attachment and embedded
  // sign-in remain unverified. No admission function or controller is bypassed.
  Object.assign(value.connectors.secureMcp, {
    tunnelId: "synthetic-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/approved/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: verifiedAt,
    },
    challenge: {
      value: "33333333-3333-4333-8333-333333333333",
      challengeSha256: "c".repeat(64),
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      preparedAt: verifiedAt,
    },
  });
  return ProductSettingsSchema.parse(value);
}
async function mount(
  step: SetupStep = "overview",
  shell = false,
  value = settings(),
) {
  const f = fixture();
  const configuration = { status: "ready" as const, settings: value };
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
  return {
    f,
    c,
    host,
    button,
    click,
    visible,
    configuration,
    async remount() {
      await act(async () => root.render(null));
      await act(async () =>
        root.render(
          <StrictMode>
            <View />
          </StrictMode>,
        ),
      );
    },
  };
}
describe("reference-aligned Setup wizard", () => {
  it.each(["refused", "unknown"] as const)(
    "keeps pending and late attachment %s feedback on its Setup origin across Shell navigation and remount",
    async (outcome) => {
      const h = await mount("attachment", true, attachmentSettings());
      const id = "settings:connector.check-attachment:";
      const wait = deferred<unknown>();
      const notice = () =>
        [...h.host.querySelectorAll('.settings-page > [role="status"]')].find(
          h.visible,
        )?.textContent;
      const stepTo = async (label: string) => {
        const button = h.host.querySelector<HTMLButtonElement>(
          `nav[aria-label="Setup steps"] button[aria-label="${label}"]`,
        )!;
        expect(button).toBeTruthy();
        await act(async () => button.click());
      };
      expect(h.button("Check attachment").disabled).toBe(false);
      expect(h.button("Copy verification request").disabled).toBe(false);
      vi.mocked(h.f.api.configure).mockReturnValueOnce(wait.promise);
      await h.click("Check attachment");
      expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
        kind: "connector.check-attachment",
      });
      expect(notice()).toContain("Saving or checking");
      const pending = structuredClone(h.c.getSnapshot().intents[id]);
      expect(pending?.state).toBe("pending");
      await stepTo("Sign in");
      expect(h.c.getSnapshot().destination).toMatchObject({
        area: "setup",
        page: "connection",
        setupStep: "signin",
      });
      expect(notice()).toBeUndefined();
      // Attachment checks are shared writers: hiding feedback must not weaken
      // the original pending/UNKNOWN fences on optional sign-in.
      expect(h.button("Sign in").disabled).toBe(true);
      await h.click("Sign in");
      await stepTo("Add to ChatGPT");
      expect(notice()).toContain("Saving or checking");
      await h.remount();
      expect(notice()).toContain("Saving or checking");
      expect(h.c.getSnapshot().intents[id]).toEqual(pending);
      await h.click("Check attachment");
      await stepTo("Sign in");
      await act(async () => {
        if (outcome === "unknown")
          wait.reject(new Error("attachment reply lost"));
        else
          wait.resolve({
            ok: false,
            error: "CONNECTOR_ATTACHMENT_NOT_FOUND",
            snapshot: h.configuration,
          });
      });
      expect(notice()).toBeUndefined();
      const receipt = structuredClone(h.c.getSnapshot().intents[id]);
      expect(receipt).toMatchObject({
        id,
        state: outcome,
        code:
          outcome === "unknown"
            ? "CONFIGURATION_OUTCOME_UNKNOWN"
            : "CONNECTOR_ATTACHMENT_NOT_FOUND",
      });
      await h.remount();
      expect(notice()).toBeUndefined();
      expect(h.button("Sign in").disabled).toBe(outcome === "unknown");
      await stepTo("Add to ChatGPT");
      const originalNotice = notice();
      expect(originalNotice).toContain(
        outcome === "unknown"
          ? "Outcome unknown"
          : "This action could not be completed",
      );
      expect(h.host.textContent).not.toContain(
        "Attachment checked · Computer ready",
      );
      expect(h.c.getSnapshot().configuration).toEqual(h.configuration);
      await h.remount();
      expect(notice()).toBe(originalNotice);
      expect(h.c.getSnapshot().intents[id]).toEqual(receipt);
      if (outcome === "unknown") {
        expect(h.button("Check attachment").disabled).toBe(true);
        await h.click("Check attachment");
      }
      // A normal Settings Connection destination shares the legacy page value,
      // but must not inherit Setup's pending/late presentation either.
      await h.click("Settings");
      await h.click("Connection");
      expect(notice()).toBeUndefined();
      await h.click("Diagnostics");
      const retained = h.host.querySelector('[aria-label="Retained actions"]')!;
      expect(retained.textContent).toContain(id);
      expect(retained.textContent).toContain(receipt!.code);
      if (outcome === "unknown") {
        const observation = h.host.querySelector(
          '[aria-label="Actions needing observation"]',
        )!;
        expect(observation.textContent).toContain(id);
        await h.click("Return to Setup");
        expect(h.c.getSnapshot().destination).toMatchObject({
          area: "setup",
          setupStep: "attachment",
        });
        expect(notice()).toBe(originalNotice);
      } else {
        await h.click("General");
        await h.click("Review Setup");
        await stepTo("Sign in");
        expect(notice()).toBeUndefined();
        await h.click("Sign in");
        expect(notice()).toContain("Sign-in request opened");
        expect(notice()).toContain(
          "opening it does not confirm an authenticated account",
        );
        await stepTo("Add to ChatGPT");
        expect(notice()).toBe(originalNotice);
        expect(h.c.getSnapshot().intents[id]).toEqual(receipt);
      }
      expect(
        vi.mocked(h.f.api.configure).mock.calls.map(([command]) => command),
      ).toEqual([
        { kind: "connector.check-attachment" },
        ...(outcome === "refused" ? [{ kind: "chatgpt.open-sign-in" }] : []),
      ]);
      expect(h.f.api.task).not.toHaveBeenCalled();
    },
  );
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
