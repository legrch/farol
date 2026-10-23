import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { change, mount, readySettings } from "./setup-fixture";
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
    expect(line.querySelectorAll("button")).toHaveLength(4);
    expect(h.host.querySelector(".contextual-sidebar")).toBeNull();
    expect(h.host.querySelector(".rail")).toBeTruthy();
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
  });
  it("lets progress buttons review any step without running checks or changing settings", async () => {
    const h = await mount({
      step: "attachment",
      value: readySettings(true),
      shell: true,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    const progress = h.host.querySelector('[aria-label="Setup progress"]')!;
    expect(
      progress.querySelector('[aria-label="1. Sign in, completed"]'),
    ).toBeTruthy();
    const effectCalls = () =>
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind !== "chatgpt.observe-sign-in");
    const configureCalls = effectCalls().length;
    const settingsBeforeNavigation = structuredClone(h.configuration());
    const stage = h.host.querySelector<HTMLElement>("main.stage")!;
    stage.scrollTop = 180;

    for (const [step, label] of [
      ["signin", "1. Sign in, completed"],
      ["folders", "2. Workspaces, completed"],
      ["connection", "3. Connect this Mac, completed"],
      ["attachment", "4. Add to ChatGPT, completed"],
    ] as const) {
      const button = progress.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"]`,
      )!;
      await act(async () => button.click());
      expect(h.c.getSnapshot().destination).toMatchObject({
        area: "setup",
        setupStep: step,
      });
      expect(progress.querySelector('[aria-current="step"]')).toBe(button);
      expect(stage.scrollTop).toBe(0);
    }

    expect(h.c.getSnapshot().destination.setupStep).toBe("attachment");
    expect(h.configuration()).toEqual(settingsBeforeNavigation);
    expect(effectCalls()).toHaveLength(configureCalls);
  });
  it("does not let progress navigation skip the final attachment gate", async () => {
    const h = await mount({ step: "signin" });
    const progress = h.host.querySelector('[aria-label="Setup progress"]')!;
    const configureCalls = vi.mocked(h.f.api.configure).mock.calls.length;
    const settingsBeforeNavigation = structuredClone(h.configuration());

    await act(async () =>
      progress
        .querySelector<HTMLButtonElement>('[aria-label="4. Add to ChatGPT"]')!
        .click(),
    );

    expect(h.c.getSnapshot().destination.setupStep).toBe("attachment");
    expect(h.button("Start using Farol")?.disabled).toBe(true);
    expect(h.configuration()).toEqual(settingsBeforeNavigation);
    expect(vi.mocked(h.f.api.configure).mock.calls).toHaveLength(
      configureCalls,
    );
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
    value.connectors.secureMcp.runtime = null;
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
    expect(
      h.host.querySelector<HTMLInputElement>('[aria-label="ChatGPT app name"]')
        ?.value,
    ).toBe("Farol");
    expect(h.host.querySelector(".setup-app-values")?.textContent).toContain(
      "ConnectionTunnel · synthetic-tunnelApp authenticationNo additional sign-in",
    );
    expect(h.host.textContent).toContain("without reading file contents");
    expect(h.host.querySelectorAll("details")).toHaveLength(0);
    await h.click("Open ChatGPT Apps");
    expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
      kind: "onboarding.open-help",
      destination: "chatgpt",
    });
  });
  it.each(["Farol", "Farol Dev", "Farol Preview"])(
    "selects %s and completes the verified Setup journey",
    async (appName) => {
      const h = await mount({
        step: "attachment",
        value: readySettings(),
        shell: true,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      await change(
        h.host.querySelector<HTMLInputElement>(
          '[aria-label="ChatGPT app name"]',
        )!,
        appName,
      );
      expect(h.c.getSnapshot().setupSignInCheck).toBeTruthy();
      let value = readySettings();
      const wait = deferred<unknown>();
      h.reply((command) => {
        if (command.kind === "connector.select-chatgpt-app") {
          value = structuredClone(value);
          value.revision = 2;
          value.connectors.secureMcp.chatgptApp = {
            name: appName,
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
      const verified = readySettings(true);
      verified.connectors.secureMcp.chatgptApp!.name = appName;
      await act(async () =>
        wait.resolve({
          ok: true,
          snapshot: {
            status: "ready",
            settings: { ...verified, revision: 3 },
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
        settings.connectors.secureMcp.chatgptApp!.name = appName;
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
    },
  );
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

const walkthroughs = [
  {
    step: "connection",
    label: "Create a tunnel and a key",
    open: "Open OpenAI Tunnels",
    destination: "tunnels",
    initiallyOpen: false,
  },
  {
    step: "attachment",
    label: "Add to ChatGPT",
    open: "Open ChatGPT Apps",
    destination: "chatgpt",
    initiallyOpen: true,
  },
] as const;
describe("on-demand Setup instructions", () => {
  it.each(walkthroughs)(
    "shows $step guidance in its expected initial state and never advances on a timer",
    async ({ step, label, open, destination, initiallyOpen = false }) => {
      vi.useFakeTimers();
      const h = await mount({ step, value: readySettings() });
      const region = h.host.querySelector<HTMLElement>(
        `[aria-label="${label} instructions"]`,
      )!;
      const cards = [
        ...h.host.querySelectorAll<HTMLButtonElement>(".walkthrough-step"),
      ];
      expect(cards).toHaveLength(3);
      expect(region.hidden).toBe(!initiallyOpen);
      if (step === "attachment") {
        expect(region.textContent).toContain("open Apps or Connectors");
        expect(h.host.textContent).toContain("No additional sign-in");
        const section = h.host.querySelector(
          '[aria-label="Create the ChatGPT app"]',
        )!;
        const children = [...section.children];
        expect(
          children.indexOf(section.querySelector(".setup-walkthrough")!),
        ).toBeLessThan(
          children.indexOf(section.querySelector(".setup-app-values")!),
        );
      }
      for (const [i, card] of cards.entries()) {
        if (initiallyOpen && i === 0) {
          expect(card.getAttribute("aria-expanded")).toBe("true");
          expect(region.hidden).toBe(false);
          expect(
            region.querySelectorAll("ol > li").length,
          ).toBeGreaterThanOrEqual(2);
          continue;
        }
        await act(async () => card.click());
        expect(card.getAttribute("aria-expanded")).toBe("true");
        expect(card.getAttribute("aria-controls")).toBe(region.id);
        expect(region.hidden).toBe(false);
        expect(
          region.querySelectorAll("ol > li").length,
        ).toBeGreaterThanOrEqual(2);
        const before = region.textContent;
        await act(async () => vi.advanceTimersByTime(60000));
        expect(region.textContent).toBe(before);
        expect(
          cards.filter((c) => c.getAttribute("aria-expanded") === "true"),
        ).toEqual([cards[i]]);
      }
      await h.click("Close instructions");
      expect(region.hidden).toBe(true);
      expect(h.f.api.configure).not.toHaveBeenCalled();
      await h.click(open);
      expect(h.f.api.configure).toHaveBeenCalledExactlyOnceWith({
        kind: "onboarding.open-help",
        destination,
      });
      vi.useRealTimers();
    },
  );
  it.each(["refused", "unknown"] as const)(
    "does not submit or automatically repeat a fresh-test preparation that is %s",
    async (outcome) => {
      const value = readySettings();
      value.connectors.secureMcp.challenge = null;
      value.connectors.secureMcp.chatgptApp = {
        name: "Farol Dev",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 1,
      };
      const h = await mount({
        step: "attachment",
        value,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      h.reply((command) => {
        expect(command).toEqual({ kind: "connector.repair" });
        if (outcome === "unknown") throw Error("scripted lost reply");
        return {
          ok: false,
          error: "CONNECTOR_RUNTIME_UNREACHABLE",
          snapshot: h.configuration(),
        };
      });
      await h.click("Prepare new test");
      await h.remount();
      const calls = vi.mocked(h.f.api.configure).mock.calls;
      expect(calls.filter(([c]) => c.kind === "connector.repair")).toHaveLength(
        1,
      );
      expect(
        calls.filter(([c]) => c.kind === "connector.verify-app"),
      ).toHaveLength(0);
      expect(h.button("Start using Farol")?.disabled).toBe(true);
      if (outcome === "unknown")
        expect(h.button("Prepare new test")).toBeUndefined();
    },
  );

  it("withdraws the success card immediately when the displayed app name changes", async () => {
    const h = await mount({
      step: "attachment",
      value: readySettings(true),
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    expect(h.host.textContent).toContain("✓ Everything works");
    await change(
      h.host.querySelector<HTMLInputElement>(
        '[aria-label="ChatGPT app name"]',
      )!,
      "Farol Dev",
    );
    expect(h.host.textContent).not.toContain("✓ Everything works");
    expect(h.button("Start using Farol")?.disabled).toBe(true);
  });

  it("prepares one fresh test after a verified app is renamed without a manual disconnect", async () => {
    let value = readySettings(true);
    const h = await mount({
      step: "attachment",
      value,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    await change(
      h.host.querySelector<HTMLInputElement>(
        '[aria-label="ChatGPT app name"]',
      )!,
      "Farol Dev",
    );
    h.reply((command) => {
      expect(command.kind).toBe("connector.select-chatgpt-app");
      value = structuredClone(value);
      value.revision++;
      value.connectors.secureMcp.chatgptApp!.name = "Farol Dev";
      value.connectors.secureMcp.attachment = null;
      value.connectors.secureMcp.lastVerifiedAttachment = null;
      value.setup.connect.verified = null;
      value.setup.connect.reachable = "unknown";
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await h.click("Save app name");
    expect(h.button("Start using Farol")?.disabled).toBe(true);
    expect(h.button("Prepare new test")?.disabled).toBe(false);
    const pending = deferred<unknown>();
    h.reply((command) => {
      expect(command).toEqual({ kind: "connector.repair" });
      return pending.promise;
    });
    const prepare = h.button("Prepare new test")!;
    await act(async () => {
      prepare.click();
      prepare.click();
    });
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind === "connector.repair"),
    ).toHaveLength(1);
    value = readySettings();
    value.revision = 4;
    value.connectors.secureMcp.chatgptApp = {
      name: "Farol Dev",
      tunnelId: "synthetic-tunnel",
      connectorGeneration: 1,
    };
    value.connectors.secureMcp.runtime!.runtimeGeneration = "e".repeat(64);
    value.connectors.secureMcp.challenge!.runtimeGeneration = "e".repeat(64);
    value.connectors.secureMcp.challenge!.value =
      "44444444-4444-4444-8444-444444444444";
    await act(async () =>
      pending.resolve({
        ok: true,
        snapshot: { status: "ready", settings: value },
      }),
    );
    expect(h.button("Test in ChatGPT")?.disabled).toBe(false);
    h.reply((command) => {
      expect(command).toEqual({ kind: "connector.verify-app" });
      const ready = readySettings(true);
      ready.revision = 5;
      ready.connectors.secureMcp.chatgptApp!.name = "Farol Dev";
      ready.connectors.secureMcp.runtime!.runtimeGeneration = "e".repeat(64);
      ready.connectors.secureMcp.attachment!.runtimeGeneration = "e".repeat(64);
      ready.setup.connect.verified!.runtimeGeneration = "e".repeat(64);
      return { ok: true, snapshot: { status: "ready", settings: ready } };
    });
    await h.click("Test in ChatGPT");
    await h.navigate("attachment");
    expect(h.button("Start using Farol")?.disabled).toBe(false);
    expect(h.host.textContent).toContain("✓ Everything works");
  });

  it("saves a separate app name without opening ChatGPT or starting a check", async () => {
    const h = await mount({ step: "attachment", value: readySettings() });
    await change(
      h.host.querySelector<HTMLInputElement>(
        '[aria-label="ChatGPT app name"]',
      )!,
      "Farol Dev",
    );
    h.reply((command) => {
      expect(command).toMatchObject({
        kind: "connector.select-chatgpt-app",
        name: "Farol Dev",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 1,
      });
      const value = readySettings();
      value.revision++;
      value.connectors.secureMcp.chatgptApp = {
        name: "Farol Dev",
        tunnelId: "synthetic-tunnel",
        connectorGeneration: 1,
      };
      return { ok: true, snapshot: { status: "ready", settings: value } };
    });
    await h.click("Save app name");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.c.getSnapshot().destination.setupStep).toBe("attachment");
    await h.navigate("connection");
    await h.navigate("attachment");
    expect(
      h.host.querySelector<HTMLInputElement>('[aria-label="ChatGPT app name"]')
        ?.value,
    ).toBe("Farol Dev");
  });
  it("shows a masked saved key and cannot reconnect unchanged confirmed inputs", async () => {
    const h = await mount({ step: "connection", value: readySettings() });
    const key = h.host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("••••••••");
    expect(h.button("Connect")).toBeUndefined();
    expect(h.host.textContent).toContain("✓ Connected to this Mac");
    await h.remount();
    expect(h.button("Connect")).toBeUndefined();
    expect(h.f.api.configure).not.toHaveBeenCalled();
    expect(h.button("Continue")?.disabled).toBe(false);
  });
});
afterEach(() => vi.useRealTimers());
