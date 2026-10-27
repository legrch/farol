import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { change, mount, readySettings, buildId } from "./setup-fixture";
import { bootstrap, deferred, fixture, signInReply } from "./fixture";
import { WindowController } from "../../src/ui/renderer/controller";
import { setupChecklist } from "../../src/ui/renderer/setup-navigation";
import { setupStepCheck } from "../../src/ui/renderer/setup-gate";
import { computerSetup } from "../../src/ui/renderer/computer-setup";

// Actual renderer/controller with scripted responses, never live verification.
describe("linear Setup", () => {
  it("retains current attachment presentation after a refused read-only recheck", async () => {
    const value = readySettings(true);
    value.connectors.secureMcp.challenge = null;
    const h = await mount({ value, shell: true, signIn: "authenticated" });
    await h.confirmSignIn();
    const id = `settings:connector.verify-app:${"a".repeat(64)}`;
    const snapshot = {
      ...h.c.getSnapshot(),
      intents: {
        [id]: {
          id,
          state: "refused" as const,
          code: "CONNECTOR_APP_VERIFICATION_NOT_READY",
        },
      },
    };
    expect(
      setupChecklist(snapshot).entries.find((e) => e.step === "attachment")
        ?.liveState,
    ).toBe("verified");
    expect(setupStepCheck(snapshot, "attachment").allowed).toBe(false);
    expect(snapshot.intents[id]!.state).toBe("refused");
    expect(
      setupChecklist({ ...snapshot, buildId: "f".repeat(64) }).entries.some(
        (e) => e.liveState === "verified",
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "retains confirmed progress during the workspace chooser without opening gates (%s)",
    async (complete) => {
      const value = readySettings(complete);
      if (!complete) {
        value.computer.workspaces = [];
        value.setup.computer.verified = null;
        value.connectors.secureMcp.runtime = null;
        value.connectors.secureMcp.challenge = null;
      }
      const h = await mount({
        step: "folders",
        value,
        shell: true,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      const count = () =>
        setupChecklist(h.c.getSnapshot()).entries.filter(
          (e) => e.state === "verified",
        ).length;
      expect(count()).toBe(complete ? 4 : 1);
      const waiting = deferred<unknown>();
      h.reply((command) => {
        expect(command.kind).toBe("computer.choose-workspace");
        return waiting.promise;
      });
      await h.click("+ Add workspace");
      expect(count()).toBe(complete ? 4 : 1);
      expect(h.host.querySelector(".setup-count")?.textContent).toBe(
        complete ? "✓" : "1 of 4",
      );
      const pending = h.c.getSnapshot();
      expect(setupStepCheck(pending, "signin").allowed).toBe(false);
      expect(setupStepCheck(pending, "folders").allowed).toBe(false);
      expect(setupChecklist(pending).ready).toBe(false);
      const stale = { ...pending, buildId: "f".repeat(64) };
      expect(
        setupChecklist(stale).entries.some((e) => e.state === "verified"),
      ).toBe(false);
      const id = "settings:computer.choose-workspace:";
      const unknown = {
        ...pending,
        intents: {
          ...pending.intents,
          [id]: {
            id,
            state: "unknown" as const,
            code: "FIXTURE_RESULT_UNKNOWN",
          },
        },
      };
      expect(
        setupChecklist(unknown).entries.some((e) => e.state === "verified"),
      ).toBe(false);
      await act(async () =>
        waiting.resolve({ ok: true, snapshot: h.configuration() }),
      );
      expect(count()).toBe(complete ? 4 : 1);
      expect(setupChecklist(h.c.getSnapshot()).ready).toBe(complete);
    },
  );
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
        expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
        await h.click("Test in ChatGPT");
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
    expect(h.host.querySelector(".setup-progress")).toBeTruthy();
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
      "Overview",
      "✓ Sign in",
      "2 Workspaces",
      "✓ Connect this Mac",
      "4 Add to ChatGPT",
    ]);
    expect(line.querySelector('[aria-current="step"]')?.textContent).toContain(
      "Workspaces",
    );
    expect(line.querySelectorAll("button")).toHaveLength(5);
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
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
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
        h.button(step === "attachment" ? "Test in ChatGPT" : "Continue")
          ?.disabled,
      ).toBe(true);
      await h.click(step === "attachment" ? "Test in ChatGPT" : "Continue");
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
      const alert = h.host.querySelector(
        step === "attachment"
          ? '.setup-test [role="status"]'
          : '[role="alert"]',
      )!;
      expect(alert).toBeTruthy();
      expect(alert.querySelectorAll("button")).toHaveLength(1);
      expect(alert.textContent).toContain(
        step === "attachment"
          ? "An earlier action is not confirmed"
          : "could not be confirmed",
      );
      expect(
        h.button(step === "attachment" ? "Test in ChatGPT" : "Continue")
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
  it.each([false, true])(
    "keeps one current connection test on a completed profile (legacy UNKNOWN %s)",
    async (unknown) => {
      const value = readySettings();
      value.setup.journey = { currentStep: "connect", dismissed: true };
      value.setup.connect.outcomeUnknown = unknown;
      value.connectors.secureMcp.appVerificationPending = unknown;
      const h = await mount({
        step: "attachment",
        value,
        signIn: "authenticated",
      });
      await h.confirmSignIn();
      const test = h.button("Test in ChatGPT")!;
      expect(test).toBeTruthy();
      expect(
        h.host.querySelectorAll(".setup-wizard-footer .primary"),
      ).toHaveLength(1);
      expect(test.disabled).toBe(false);
      expect(h.button("Start using Farol")).toBeUndefined();
      expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
      expect(h.f.api.configure).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "connector.verify-app" }),
      );
      expect(h.f.api.configure).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "connector.verify-separate-app" }),
      );
      if (unknown) expect(h.button("Refresh status")).toBeTruthy();
      await act(async () =>
        h.c.navigate({
          area: "home",
          homeView: "overview",
          homeSelection: null,
        }),
      );
      expect(h.c.getSnapshot().destination.area).toBe("home");
      expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
    },
  );
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
  it("coalesces confirmation reads, keeps an absent receipt pending, and never starts another test", async () => {
    const value = readySettings();
    value.setup.connect.outcomeUnknown = true;
    value.connectors.secureMcp.appVerificationPending = true;
    const h = await mount({
      step: "attachment",
      value,
      signIn: "authenticated",
    });
    await h.confirmSignIn();
    const waiting = deferred<unknown>();
    h.reply((command) => {
      expect(command).toEqual({ kind: "connector.check-attachment" });
      return waiting.promise;
    });
    vi.mocked(h.f.api.configure).mockClear();
    const bootstraps = vi.mocked(h.f.api.bootstrap).mock.calls.length;
    await h.click("Refresh status");
    expect(h.button("Refreshing…")?.disabled).toBe(true);
    await h.click("Refreshing…");
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.f.api.bootstrap).toHaveBeenCalledTimes(bootstraps + 1);
    await act(async () =>
      waiting.resolve({
        ok: false,
        error: "CONNECTOR_ATTACHMENT_NOT_FOUND",
        snapshot: h.configuration(),
      }),
    );
    expect(h.f.api.configure).toHaveBeenCalledTimes(1);
    expect(h.button("Refresh status")?.disabled).toBe(false);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(
      h.host
        .querySelector(".setup-gate-status")
        ?.getAttribute("data-confirmation-pending"),
    ).toBe("true");
    expect(h.configuration().settings.setup.connect.outcomeUnknown).toBe(true);
    expect(
      h.configuration().settings.connectors.secureMcp.appVerificationPending,
    ).toBe(true);
    expect(
      h.configuration().settings.connectors.secureMcp.attachment,
    ).toBeNull();
  });
  it("automatically reads a pending app receipt once per binding without a Send or owner click", async () => {
    const value = readySettings();
    value.setup.connect.outcomeUnknown = true;
    value.connectors.secureMcp.appVerificationPending = true;
    const h = await mount({ step: "attachment", value });
    const effects = () =>
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind !== "chatgpt.observe-sign-in")
        .map(([c]) => c.kind);
    expect(effects()).toEqual(["connector.check-attachment"]);
    await h.remount();
    expect(effects()).toEqual(["connector.check-attachment"]);
    expect(h.configuration().settings.setup.connect.outcomeUnknown).toBe(true);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
  });
  it("reads confirmation again on return to step four without replaying its test", async () => {
    const value = readySettings();
    value.setup.connect.outcomeUnknown = true;
    value.connectors.secureMcp.appVerificationPending = true;
    const h = await mount({ step: "attachment", value });
    const reads = () =>
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(([c]) => c.kind === "connector.check-attachment");
    expect(reads()).toHaveLength(1);
    await h.navigate("folders");
    await h.navigate("attachment");
    expect(reads()).toHaveLength(2);
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.some(([c]) => c.kind === "connector.verify-app"),
    ).toBe(false);
    expect(h.configuration().settings.setup.connect.outcomeUnknown).toBe(true);
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
  });
  it("reviews this Mac's connection locally without changing its app or tunnel", async () => {
    const value = readySettings();
    value.setup.connect.outcomeUnknown = true;
    value.connectors.secureMcp.appVerificationPending = true;
    const h = await mount({ step: "attachment", value });
    const details = h.host.querySelector<HTMLElement>(
      '[aria-label="Connection details for this Mac"]',
    )!;
    const scroll = vi.fn();
    details.scrollIntoView = scroll;
    const calls = vi.mocked(h.f.api.configure).mock.calls.length;
    const reads = vi.mocked(h.f.api.bootstrap).mock.calls.length;
    const destination = h.c.getSnapshot().destination;
    await h.click("Show connection details");
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(details);
    expect(h.c.getSnapshot().destination).toBe(destination);
    expect(h.f.api.configure).toHaveBeenCalledTimes(calls);
    expect(h.f.api.bootstrap).toHaveBeenCalledTimes(reads);
    expect(h.configuration().settings.connectors.secureMcp).toBe(
      value.connectors.secureMcp,
    );
    expect(details.textContent).toContain("synthetic-tunnel");
    expect(h.host.textContent).toContain(
      "A matching app name does not guarantee",
    );
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
    const failure = h.host.querySelector('.setup-test [role="status"]')!;
    expect(failure.querySelectorAll("button")).toHaveLength(1);
    expect(failure.textContent).not.toContain("Diagnostics");
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    await h.remount();
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
    expect(h.button("Refresh status")?.disabled).toBe(false);
    expect(
      vi
        .mocked(h.f.api.configure)
        .mock.calls.filter(
          ([command]) => command.kind !== "chatgpt.observe-sign-in",
        ),
    ).toHaveLength(1);
  });
});

const walkthroughs = [
  {
    step: "connection",
    label: "Create a tunnel and a key",
    open: "Open OpenAI Tunnels",
    destination: "tunnels",
    initiallyOpen: true,
  },
  {
    step: "attachment",
    label: "Add to ChatGPT",
    open: "Open ChatGPT Apps",
    destination: "chatgpt",
    initiallyOpen: true,
  },
] as const;
describe("always-open Setup instructions", () => {
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
      expect(h.button("Close instructions")).toBeUndefined();
      await act(async () => cards[2]!.click());
      expect(region.hidden).toBe(false);
      await h.click("Previous instruction");
      expect(cards[1]!.getAttribute("aria-current")).toBe("step");
      await h.click("Next instruction");
      expect(cards[2]!.getAttribute("aria-current")).toBe("step");
      expect(region.hidden).toBe(false);
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
      expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
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
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
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
    expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
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

describe("automatic checks after removing a Setup folder", () => {
  it.each(["applied", "refused", "unknown", "crossed"] as const)(
    "follows only its own acknowledged unchanged-scope removal: %s",
    async (outcome) => {
      let value = readySettings();
      const retained = value.computer.workspaces[0]!;
      const scratchId = "44444444-4444-4444-8444-444444444444";
      value.computer.workspaces.push({
        ...structuredClone(retained),
        workspaceId: scratchId,
        root: "/approved/scratch",
        label: "Scratch",
      });
      value.connectors.secureMcp.runtime = null;
      value.connectors.secureMcp.challenge = null;
      const h = await mount({ step: "folders", value });
      const calls: string[] = [];
      h.reply((command) => {
        calls.push(command.kind);
        if (command.kind === "computer.remove-workspace") {
          if (outcome === "unknown")
            throw Error("scripted lost removal acknowledgement");
          if (outcome === "refused")
            return {
              ok: false,
              error: "WORKSPACE_NOT_FOUND",
              snapshot: { status: "ready", settings: value },
            };
          value = {
            ...value,
            revision: value.revision + 1,
            computer: {
              ...value.computer,
              generation: value.computer.generation + 1,
              workspaces: value.computer.workspaces.filter(
                (w) => w.workspaceId !== scratchId,
              ),
            },
            setup: {
              ...value.setup,
              computer: {
                ...value.setup.computer,
                reachable: "unknown",
                verified: null,
              },
            },
          };
          if (outcome === "crossed") value.computer.commands = "workspace";
        } else if (command.kind === "computer.verify-workspace") {
          expect(command.workspaceId).toBe(retained.workspaceId);
          value = {
            ...value,
            revision: value.revision + 1,
            computer: {
              ...value.computer,
              workspaces: value.computer.workspaces.map((w) => ({
                ...w,
                accessCheck: {
                  buildId,
                  computerGeneration: value.computer.generation,
                  rootIdentity: w.rootIdentity!,
                  verifiedAt: "2026-10-24T00:00:00.000Z",
                  checkId: command.checkId!,
                },
              })),
            },
            setup: {
              ...value.setup,
              computer: {
                ...value.setup.computer,
                reachable: "reachable",
                outcomeUnknown: false,
                verified: {
                  ...retainedWitness(),
                  configRevision: value.computer.generation,
                  workspaceId: retained.workspaceId,
                },
              },
            },
          };
        } else throw Error("unexpected follow-up " + command.kind);
        return { ok: true, snapshot: { status: "ready", settings: value } };
      });
      function retainedWitness() {
        return readySettings().setup.computer.verified!;
      }
      await h.click("Remove scratch");
      await vi.waitFor(() =>
        expect(calls).toEqual(
          outcome === "applied"
            ? ["computer.remove-workspace", "computer.verify-workspace"]
            : ["computer.remove-workspace"],
        ),
      );
      if (outcome === "applied") {
        await vi.waitFor(() =>
          expect(h.button("Continue")?.disabled).toBe(false),
        );
        expect(h.host.textContent).toContain("✓ Works");
        expect(h.host.textContent).not.toContain("Check access");
      }
    },
  );
});

it("shows local readiness separately from an unconfirmed app on Overview", async () => {
  const value = readySettings();
  value.setup.connect.outcomeUnknown = true;
  value.connectors.secureMcp.appVerificationPending = true;
  const h = await mount({ step: "overview", value, signIn: "authenticated" });
  await h.confirmSignIn();
  await h.navigate("overview");
  expect(
    h.host.querySelector(".setup-overview-summary")?.textContent,
  ).toContain("3 of 4 steps ready");
  expect(h.host.textContent).toContain(
    "Your Mac is ready. Confirm the app in ChatGPT",
  );
  const rows = h.host.querySelectorAll(".setup-overview-step");
  expect(rows).toHaveLength(4);
  for (const row of rows)
    expect(row.getAttribute("aria-describedby")).toBeTruthy();
  expect(
    h.host.querySelectorAll('.setup-welcome li[data-check-state="verified"]'),
  ).toHaveLength(3);
  const sends = vi
    .mocked(h.f.api.configure)
    .mock.calls.filter(
      ([command]) => command.kind === "connector.verify-app",
    ).length;
  await h.click("Continue setup");
  expect(h.c.getSnapshot().destination.setupStep).toBe("attachment");
  expect(h.button("Test in ChatGPT")?.disabled).toBe(true);
  expect(h.host.textContent).toContain("without sending a message");
  expect(
    vi
      .mocked(h.f.api.configure)
      .mock.calls.filter(
        ([command]) => command.kind === "connector.verify-app",
      ),
  ).toHaveLength(sends);
});

it("shows saved completion without claiming a stale app check is current", async () => {
  const value = readySettings(true);
  value.setup.journey.dismissed = true;
  value.connectors.secureMcp.attachment = null;
  const h = await mount({ step: "overview", value, signIn: "authenticated" });
  await h.confirmSignIn();
  await h.navigate("overview");
  expect(h.host.textContent).toContain("Setup complete");
  expect(h.host.textContent).toContain("3 of 4 current checks are ready");
  const row = h.host.querySelector<HTMLButtonElement>(
    '.setup-overview-step[aria-label="Add to ChatGPT"]',
  );
  expect(row?.textContent).toContain("Check the app connection in ChatGPT");
  expect(row?.textContent).not.toContain("App confirmed in ChatGPT");
  expect(row?.closest("li")?.getAttribute("data-check-state")).not.toBe(
    "verified",
  );
  expect(
    h.host.querySelector('[aria-label="4. Add to ChatGPT, completed"]'),
  ).toBeNull();
  expect(h.configuration().settings.setup.journey.dismissed).toBe(true);
});

it("completed Setup keeps Next and returns to Activity rather than forcing Home", async () => {
  const value = readySettings(true);
  value.setup.journey.dismissed = true;
  const h = await mount({ value, shell: true, signIn: "authenticated" });
  await act(async () => {
    h.c.navigate({ area: "activity" });
    h.c.navigate({ area: "setup", setupStep: "signin" });
  });
  for (const expected of ["folders", "connection", "attachment"]) {
    await act(async () =>
      h.host
        .querySelector<HTMLButtonElement>(".setup-wizard-footer .primary")!
        .click(),
    );
    expect(h.c.getSnapshot().destination.setupStep).toBe(expected);
  }
  await h.click("Back to Activity");
  expect(h.c.getSnapshot().destination.area).toBe("activity");
});
