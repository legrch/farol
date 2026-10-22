import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, readySettings } from "./setup-fixture";
import { bootstrap, deferred, fixture, signInReply } from "./fixture";
import { WindowController } from "../../src/ui/renderer/controller";
import { setupChecklist } from "../../src/ui/renderer/setup-navigation";
import { computerSetup } from "../../src/ui/renderer/computer-setup";

// Actual renderer/controller with scripted responses, never live verification.
describe("linear Setup", () => {
  it.each([
    ["home", "home"],
    ["browser", "chatgpt"],
    ["computer", "setup"],
    ["settings", "settings"],
    ["activity", "activity"],
  ] as const)(
    "persists Finish, preserves completion on Open Setup and restarts at %s",
    async (launch, area) => {
      const value = readySettings(true);
      value.general.openAtLaunch = launch;
      const h = await mount({
        step: "attachment",
        value,
        shell: true,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      expect(setupChecklist(h.c.getSnapshot()).ready).toBe(true);
      expect(h.configuration().settings.setup.journey.dismissed).toBe(false);
      expect(h.button("Start using Farol")?.disabled).toBe(false);
      await h.click("Start using Farol");
      expect(h.c.getSnapshot().destination.area).toBe("home");
      expect(h.configuration().settings.setup.journey).toEqual({
        currentStep: "connect",
        dismissed: true,
      });
      expect(
        vi
          .mocked(h.f.api.configure)
          .mock.calls.filter(([command]) => command.kind === "setup.progress"),
      ).toEqual([
        [{ kind: "setup.progress", currentStep: "connect", dismissed: true }],
      ]);
      await act(async () =>
        h.c.navigate({ area: "settings", page: "general" }),
      );
      await h.click("Open Setup");
      expect(h.c.getSnapshot().destination).toMatchObject({
        area: "setup",
        setupStep: "overview",
      });
      expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
      h.c.dispose();
      const restarted = new WindowController(h.f.api);
      try {
        await restarted.start();
        expect(restarted.getSnapshot().destination).toMatchObject({
          area,
          ...(launch === "computer" ? { setupStep: "folders" } : {}),
        });
      } finally {
        restarted.dispose();
      }
    },
  );
  it.each([false, true])(
    "waits for saved completion and respects subsequent navigation (%s)",
    async (leave) => {
      const h = await mount({
        step: "attachment",
        value: readySettings(true),
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      const waiting = deferred<unknown>();
      h.reply(() => waiting.promise);
      await h.click("Start using Farol");
      await h.click("Start using Farol");
      expect(h.c.getSnapshot().destination.area).toBe("setup");
      expect(h.button("Start using Farol")?.disabled).toBe(true);
      expect(
        vi
          .mocked(h.f.api.configure)
          .mock.calls.filter(([command]) => command.kind === "setup.progress"),
      ).toHaveLength(1);
      if (leave) await h.navigate("overview");
      const settings = readySettings(true);
      settings.revision++;
      settings.setup.journey = { currentStep: "connect", dismissed: true };
      await act(async () =>
        waiting.resolve({ ok: true, snapshot: { status: "ready", settings } }),
      );
      expect(h.c.getSnapshot().destination).toMatchObject(
        leave ? { area: "setup", setupStep: "overview" } : { area: "home" },
      );
    },
  );
  it.each(["refused", "unknown", "unconfirmed"] as const)(
    "keeps Setup open when completion is %s",
    async (outcome) => {
      const h = await mount({
        step: "attachment",
        value: readySettings(true),
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      h.reply(() => {
        if (outcome === "unknown") throw new Error("scripted lost reply");
        return outcome === "refused"
          ? {
              ok: false,
              error: "SETUP_INCOMPLETE",
              snapshot: h.configuration(),
            }
          : { ok: true, snapshot: h.configuration() };
      });
      await h.click("Start using Farol");
      expect(h.c.getSnapshot().destination).toMatchObject({
        area: "setup",
        setupStep: "attachment",
      });
      expect(h.configuration().settings.setup.journey.dismissed).toBe(false);
      if (outcome === "refused") {
        expect(h.host.textContent).toContain(
          "Finish the remaining steps before using Farol.",
        );
        expect(
          h.c.getSnapshot().intents["settings:setup.progress:"],
        ).toMatchObject({ state: "refused", code: "SETUP_INCOMPLETE" });
      }
      if (outcome === "unknown") {
        await h.remount();
        expect(h.button("Start using Farol")?.disabled).toBe(true);
        await h.click("Start using Farol");
        expect(
          vi
            .mocked(h.f.api.configure)
            .mock.calls.filter(
              ([command]) => command.kind === "setup.progress",
            ),
        ).toHaveLength(1);
      }
    },
  );
  it("all four checks without finishing Setup still open Welcome", async () => {
    const f = fixture();
    const data = bootstrap();
    const configuration = {
      status: "ready" as const,
      settings: readySettings(true),
    };
    configuration.settings.general.openAtLaunch = "activity";
    data.configuration = configuration;
    vi.mocked(f.api.bootstrap).mockResolvedValue(data);
    vi.mocked(f.api.configure).mockImplementation(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command, "authenticated", configuration)
        : {
            ok: true,
            snapshot: configuration,
            evidence: {
              kind: "chatgpt.readiness",
              state: "authenticated",
              code: null,
            },
          },
    );
    const c = new WindowController(f.api);
    await c.start();
    c.navigate({ area: "setup", setupStep: "signin" });
    await vi.waitFor(() =>
      expect(c.getSnapshot().signInObservation?.state).toBe("authenticated"),
    );
    await c.configure({ kind: "chatgpt.verify" }, "settings:chatgpt.verify:");
    expect(setupChecklist(c.getSnapshot()).ready).toBe(true);
    c.dispose();

    const restarted = new WindowController(f.api);
    await restarted.start();
    expect(restarted.getSnapshot().destination).toMatchObject({
      area: "setup",
      setupStep: "overview",
    });
    expect(computerSetup(restarted.getSnapshot()).ready).toBe(true);
    expect(data.configuration.settings.setup.journey.dismissed).toBe(false);
    restarted.dispose();
  });

  it("welcomes with four steps, one Start setup and the permanent sidebar", async () => {
    const h = await mount({ shell: true });
    expect(h.host.textContent).toContain("Welcome to Farol");
    expect(h.host.querySelectorAll(".setup-welcome li")).toHaveLength(4);
    expect(h.host.querySelector(".contextual-sidebar")).toBeNull();
    expect(h.host.querySelector(".rail")).toBeTruthy();
    expect(h.host.querySelector(".setup-progress")).toBeNull();
    expect(h.button("Start setup")).toBeTruthy();
    expect(h.button("Read the setup guide")).toBeTruthy();
    expect(h.f.api.configure).not.toHaveBeenCalled();
    await h.click("Start setup");
    expect(h.c.getSnapshot().destination.setupStep).toBe("signin");
    expect(h.button("Continue")?.disabled).toBe(true);
  });
  it("uses one read-only progress line with current and real completed states", async () => {
    const h = await mount({
      step: "folders",
      value: readySettings(),
      shell: true,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    expect(h.c.getSnapshot().setupSignInCheck).toBeTruthy();
    const line = h.host.querySelector('[aria-label="Setup progress"]')!;
    expect(
      [...line.querySelectorAll("li")].map((x) => x.textContent?.trim()),
    ).toEqual([
      "✓ Sign in",
      "2 Workspaces",
      "✓ Connect this Mac",
      "4 Add to ChatGPT",
    ]);
    expect(line.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Workspaces",
    );
    expect(line.querySelectorAll("button")).toHaveLength(0);
    expect(h.host.querySelector(".contextual-sidebar")).toBeNull();
    expect(h.host.querySelector(".rail")).toBeTruthy();
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
  });
  it.each(["signin", "folders", "connection", "attachment"] as const)(
    "gates %s on its actual check",
    async (step) => {
      const h = await mount({
        step,
        signIn: step === "attachment" ? "authenticated" : "signed_out",
      });
      expect(
        h.button(step === "attachment" ? "Start using Farol" : "Continue")
          ?.disabled,
      ).toBe(true);
      await h.click(step === "attachment" ? "Start using Farol" : "Continue");
      expect(h.c.getSnapshot().destination.setupStep).toBe(step);
      await h.publish(readySettings(true));
      if (step === "signin") {
        await h.navigate("folders");
        await h.navigate("signin");
      }
      if (step === "attachment") await h.confirmSignIn();
      // A signed-out current page must still block sign-in even with an older saved witness.
      expect(
        h.button(step === "attachment" ? "Start using Farol" : "Continue")
          ?.disabled,
      ).toBe(step === "signin");
    },
  );
  it("requires durable sign-in verification in addition to a current signed-in page", async () => {
    const h = await mount({ step: "signin", signIn: "authenticated" });
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(h.button("Check sign-in")).toBeTruthy();
    h.reply(() => ({
      ok: true,
      snapshot: { status: "ready", settings: readySettings() },
      evidence: {
        kind: "chatgpt.readiness",
        state: "authenticated",
        code: null,
      },
    }));
    await h.click("Check sign-in");
    expect(h.button("Continue")?.disabled).toBe(false);
    await h.click("Continue");
    expect(h.c.getSnapshot().destination.setupStep).toBe("folders");
    await h.click("Back");
    expect(h.c.getSnapshot().destination.setupStep).toBe("signin");
    expect(h.button("Skip for now")).toBeUndefined();
  });
  it("withdraws Continue on background workspace identity changes", async () => {
    const h = await mount({ step: "folders", value: readySettings() });
    expect(h.button("Continue")?.disabled).toBe(false);
    const changed = readySettings();
    changed.revision = 2;
    changed.computer.workspaces[0]!.rootIdentity = { device: "7", inode: "8" };
    await h.publish(changed);
    expect(h.button("Continue")?.disabled).toBe(true);
  });
  it("keeps unknown checks blocked across navigation, refresh and remount", async () => {
    const value = readySettings();
    const h = await mount({ step: "connection", value });
    h.reply(() => {
      throw new Error("scripted loss");
    });
    await h.click("Connect");
    expect(h.button("Continue")?.disabled).toBe(true);
    await h.remount();
    await h.navigate("folders");
    expect(h.button("Continue")?.disabled).toBe(true);
    await h.navigate("connection");
    expect(h.button("Connect")?.disabled).toBe(true);
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  });
  it.each(["signin", "folders", "connection", "attachment"] as const)(
    "shows one recovery action for an unconfirmed %s check without a local reply",
    async (step) => {
      const value = readySettings();
      value.setup.connect.outcomeUnknown = true;
      const h = await mount({ step, value });
      const alert = h.host.querySelector('[role="alert"]')!;
      expect(alert).toBeTruthy();
      expect(alert.querySelectorAll("button")).toHaveLength(1);
      expect(alert.textContent).toContain("could not be confirmed");
      expect(
        h.button(step === "attachment" ? "Start using Farol" : "Continue")
          ?.disabled,
      ).toBe(true);
    },
  );
  it("shows the welcome screen at Overview without effects", async () => {
    const h = await mount({ step: "overview" });
    expect(h.host.textContent).toContain("Welcome to Farol");
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
});

describe("Add to ChatGPT", () => {
  it("shows exact values and the honest bounded test description", async () => {
    const h = await mount({ step: "attachment", value: readySettings() });
    expect(h.host.querySelector(".setup-app-values")?.textContent).toBe(
      "NameFarolConnectionTunnel · synthetic-tunnelSign-inNone",
    );
    expect(h.host.textContent).toContain("without reading file contents");
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
    await h.click("Open ChatGPT Apps");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "onboarding.open-help",
      destination: "chatgpt",
    });
  });
  it("selects Farol for the current tunnel and runs the existing check exactly once", async () => {
    const h = await mount({
      step: "attachment",
      value: readySettings(),
      shell: true,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    expect(h.c.getSnapshot().setupSignInCheck).toBeTruthy();
    let value = readySettings();
    const wait = deferred<unknown>();
    h.reply((command) => {
      if (command.kind === "connector.select-chatgpt-app") {
        value = structuredClone(value);
        value.revision = 2;
        value.connectors.secureMcp.chatgptApp = {
          name: "Farol",
          tunnelId: "synthetic-tunnel",
          connectorGeneration: 1,
        };
        return { ok: true, snapshot: { status: "ready", settings: value } };
      }
      return wait.promise;
    });
    expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
    await h.click("Test in ChatGPT");
    expect(h.c.getSnapshot().destination).toMatchObject({
      area: "chatgpt",
      connectionCheckReturn: true,
    });
    expect(h.button("Back to setup")).toBeTruthy();
    await h.click("Back to setup");
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind === "connector.verify-app"),
    ).toHaveLength(1);
    await act(async () =>
      wait.resolve({
        ok: true,
        snapshot: {
          status: "ready",
          settings: { ...readySettings(true), revision: 3 },
        },
      }),
    );
    expect(h.host.textContent).toContain("✓ Everything works");
    expect(h.host.textContent).toContain("No file contents were read");
    expect(h.button("Start using Farol")?.disabled).toBe(false);
    h.reply((command) => {
      expect(command).toEqual({
        kind: "setup.progress",
        currentStep: "connect",
        dismissed: true,
      });
      const settings = readySettings(true);
      settings.revision = 4;
      settings.setup.journey = { currentStep: "connect", dismissed: true };
      return { ok: true, snapshot: { status: "ready", settings } };
    });
    await h.click("Start using Farol");
    expect(h.c.getSnapshot().destination.area).toBe("home");
    expect(h.c.getSnapshot().configuration).toMatchObject({
      status: "ready",
      settings: { setup: { journey: { dismissed: true } } },
    });
  });
  it("does not submit the ChatGPT test or steal navigation after a late app selection", async () => {
    const h = await mount({ step: "attachment", value: readySettings() });
    const waiting = deferred<unknown>();
    h.reply(() => waiting.promise);
    await h.click("Test in ChatGPT");
    await h.navigate("folders");
    await act(async () =>
      waiting.resolve({ ok: true, snapshot: h.configuration() }),
    );
    expect(h.c.getSnapshot().destination.setupStep).toBe("folders");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  });
  it("shows one recovery action after an unknown app check and never repeats it", async () => {
    const value = readySettings();
    value.connectors.secureMcp.chatgptApp = {
      name: "Farol",
      tunnelId: "synthetic-tunnel",
      connectorGeneration: 1,
    };
    const h = await mount({ step: "attachment", value });
    h.reply(() => {
      throw new Error("lost result");
    });
    await h.click("Test in ChatGPT");
    await h.navigate("attachment");
    const failure = h.host.querySelector('[role="alert"]')!;
    expect(failure.querySelectorAll("button")).toHaveLength(1);
    expect(failure.textContent).not.toContain("Diagnostics");
    expect(h.button("Start using Farol")?.disabled).toBe(true);
    await h.remount();
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
  });
});

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});
const walkthroughs = [
  {
    step: "connection",
    label: "Create a tunnel and a key",
    titles: ["1 · Create a tunnel", "2 · Create a key", "3 · Copy both here"],
    open: "Open OpenAI Tunnels",
    destination: "tunnels",
  },
  {
    step: "attachment",
    label: "Add to ChatGPT",
    titles: [
      "1 · Settings → Connectors",
      "2 · Add Farol: name, Tunnel, ID",
      "3 · Test in ChatGPT",
    ],
    open: "Open ChatGPT Apps",
    destination: "chatgpt",
  },
] as const;
describe("compact walkthroughs", () => {
  it.each(walkthroughs)(
    "shows all $step cards in order with accessible names and no real IDs",
    async ({ step, label, titles, open, destination }) => {
      const h = await mount({ step, value: readySettings() });
      const list = h.host.querySelector(
        `ol[aria-label="${label} walkthrough"]`,
      )!;
      expect(
        [...list.querySelectorAll("li > strong")].map((x) => x.textContent),
      ).toEqual(titles);
      expect(list.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(3);
      expect(list.textContent).not.toContain("synthetic-tunnel");
      expect(h.button(`Replay ${label} walkthrough`)?.textContent).toBe(
        "↻ Replay",
      );
      const actions = h.host.querySelector(".walkthrough-actions")!;
      expect(actions.querySelectorAll("button")).toHaveLength(2);
      expect(actions.querySelector("button")?.textContent?.trim()).toBe(open);
      expect(h.f.api.configure).not.toHaveBeenCalled();
      await h.click(open);
      expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
        kind: "onboarding.open-help",
        destination,
      });
    },
  );
  it.each(walkthroughs)(
    "plays $step once in order and replays from the first card without IPC",
    async ({ step, label }) => {
      vi.useFakeTimers();
      const h = await mount({ step, value: readySettings() });
      const active = () =>
        [...h.host.querySelectorAll(".walkthrough-cards > li")].findIndex(
          (x) => x.getAttribute("data-active") === "true",
        );
      expect(active()).toBe(0);
      await act(async () => vi.advanceTimersByTime(1600));
      expect(active()).toBe(1);
      // Replay also restarts the first card's full duration while playing.
      await h.click(`Replay ${label} walkthrough`);
      expect(active()).toBe(0);
      await act(async () => vi.advanceTimersByTime(1599));
      expect(active()).toBe(0);
      await act(async () => vi.advanceTimersByTime(1));
      expect(active()).toBe(1);
      await act(async () => vi.advanceTimersByTime(1600));
      expect(active()).toBe(2);
      await act(async () => vi.advanceTimersByTime(1600));
      expect(active()).toBe(-1);
      expect(h.host.querySelector(".walkthrough-cursor")).toBeNull();
      await act(async () => vi.advanceTimersByTime(20000));
      expect(active()).toBe(-1);
      await h.click(`Replay ${label} walkthrough`);
      expect(active()).toBe(0);
      expect(h.f.api.configure).not.toHaveBeenCalled();
    },
  );
  it.each(walkthroughs)(
    "keeps all three $step cards static under reduced motion, including Replay",
    async ({ step, label }) => {
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      vi.useFakeTimers();
      const h = await mount({ step, value: readySettings() });
      const cards = h.host.querySelector(".walkthrough-cards")!;
      const before = cards.innerHTML;
      expect(cards.querySelectorAll("li")).toHaveLength(3);
      expect(cards.querySelector('[data-active="true"]')).toBeNull();
      expect(h.host.querySelector(".walkthrough-cursor")).toBeNull();
      expect(h.button(`Replay ${label} walkthrough`)?.disabled).toBe(true);
      await h.click(`Replay ${label} walkthrough`);
      await act(async () => vi.advanceTimersByTime(20000));
      expect(cards.innerHTML).toBe(before);
      expect(h.f.api.configure).not.toHaveBeenCalled();
    },
  );
  it("stops motion immediately when the preference changes and cleans up on navigation", async () => {
    let change = () => {};
    const query = {
      matches: false,
      addEventListener: vi.fn((_event, listener) => {
        change = listener;
      }),
      removeEventListener: vi.fn(),
    };
    window.matchMedia = vi.fn().mockReturnValue(query);
    vi.useFakeTimers();
    const h = await mount({ step: "connection" });
    expect(h.host.querySelector(".walkthrough-cursor")).toBeTruthy();
    await act(async () => {
      query.matches = true;
      change();
    });
    expect(h.host.querySelector(".walkthrough-cursor")).toBeNull();
    expect(h.host.querySelector('[data-active="true"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(h.host.querySelector('[data-active="true"]')).toBeNull();
    await h.navigate("folders");
    expect(query.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
});
