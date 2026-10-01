import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../src/pkg/product-settings/contract";
import { onboardingSteps } from "../../src/ui/guided-onboarding";
import {
  GuidedOnboardingView,
  type GuidedOnboardingPort,
} from "../../src/ui/guided-onboarding-view";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

afterEach(() => vi.unstubAllGlobals());

// Synthetic document listeners exercise the registered UI action. This is not
// native DOM, filesystem, tunnel or provider evidence.
function harness(stop: "confirmed" | "refused" | "unknown" = "confirmed") {
  const nodes = new Map<string, ReturnType<typeof node>>();
  function node() {
    const listeners = new Map<string, () => void>();
    return {
      value: "",
      disabled: false,
      hidden: false,
      textContent: "",
      scrollTop: 0,
      dataset: { onboardingStep: onboardingSteps[2]!.id },
      classList: { toggle: vi.fn() },
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      append: vi.fn(),
      replaceChildren: vi.fn(),
      parentElement: { append: vi.fn() },
      querySelector: () => ({ textContent: "" }),
      addEventListener: (event: string, callback: () => void) =>
        listeners.set(event, callback),
      click: () => listeners.get("click")?.(),
    };
  }
  const get = (selector: string) => {
    let current = nodes.get(selector);
    if (!current) {
      current = node();
      nodes.set(selector, current);
    }
    return current;
  };
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    activeElement: null,
    createElement: node,
    querySelector: get,
    querySelectorAll: (selector: string) =>
      selector === "[data-onboarding-step]" ? [get("connection-nav")] : [],
  });
  const settings = guidedSettingsFixture();
  const originalRuntime = settings.connectors.secureMcp.runtime!;
  settings.connectors.secureMcp.challenge = {
    value: "synthetic-ui-challenge",
    challengeSha256: "c".repeat(64),
    runtimeGeneration: originalRuntime.runtimeGeneration,
    computerGeneration: settings.computer.generation,
    buildId: fixtureBuildId,
    preparedAt: originalRuntime.observedAt,
  };
  const configure = vi.fn(async (command: ProductConfigurationCommand) => {
    if (command.kind === "connector.stop") {
      if (stop === "refused") return false;
      settings.connectors.secureMcp.runtime =
        stop === "unknown"
          ? { ...originalRuntime, state: "outcome_unknown" }
          : null;
      settings.connectors.secureMcp.challenge = null;
      settings.connectors.secureMcp.attachment = null;
    }
    if (command.kind === "connector.start")
      settings.connectors.secureMcp.runtime = { ...originalRuntime };
    return true;
  });
  const port: GuidedOnboardingPort = {
    mode: "embedded",
    verificationCard: () => null,
    settings: () => settings,
    buildId: () => fixtureBuildId,
    isActive: () => true,
    configure,
    configureAccess: async () => "applied",
    readSettings: async () => true,
    chooseFolder: async () => null,
    pickFolder: async () => null,
    openSettings: vi.fn(),
    openDiagnostics: vi.fn(),
    render: vi.fn(),
    openChat: vi.fn(),
    returnToChat: vi.fn(),
  };
  const view = new GuidedOnboardingView(port);
  get("connection-nav").click();
  vi.mocked(port.render).mockClear();
  const click = async (selector: string) => {
    get(selector).click();
    await vi.waitFor(() => expect(port.render).toHaveBeenCalledTimes(2));
  };
  return {
    click,
    configure,
    settings,
    get,
    render: () => view.render(true, "", false),
  };
}

describe("guided Connection registered actions", () => {
  it("offers explicit activation after a completed connection was stopped", async () => {
    const ui = harness();
    ui.settings.connectors.secureMcp.lastVerifiedAttachment =
      ui.settings.connectors.secureMcp.attachment;
    ui.settings.connectors.secureMcp.runtime = null;
    ui.settings.connectors.secureMcp.challenge = null;
    ui.settings.connectors.secureMcp.attachment = null;
    ui.render();
    expect(ui.get("#onboarding-primary").textContent).toBe("Continue");
    const activate = ui.get("#onboarding-reconnect");
    expect(activate.hidden).toBe(false);
    expect(activate.disabled).toBe(false);
    expect(activate.textContent).toBe("Activate and check");
    await ui.click("#onboarding-reconnect");
    expect(ui.configure.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.start",
    ]);
  });
  it("does not offer activation for an unknown stopped connection outcome", () => {
    const ui = harness();
    ui.settings.connectors.secureMcp.runtime = null;
    ui.settings.setup.connect.outcomeUnknown = true;
    ui.render();
    expect(ui.get("#onboarding-reconnect").hidden).toBe(true);
    expect(ui.configure).not.toHaveBeenCalled();
  });
  it("reconnects an already-current connection on the explicit Reconnect click", async () => {
    const ui = harness();
    await ui.click("#onboarding-reconnect");
    expect(ui.configure.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.stop",
      "connector.start",
    ]);
  });
  it("keeps Check connection read-only when the current connection is healthy", async () => {
    const ui = harness();
    await ui.click("#onboarding-recheck");
    expect(ui.configure.mock.calls.map(([command]) => command.kind)).toEqual([
      "connector.check-health",
    ]);
  });
  it.each(["refused", "unknown"] as const)(
    "does not start or retry after a %s stop",
    async (stop) => {
      const ui = harness(stop);
      await ui.click("#onboarding-reconnect");
      expect(ui.configure.mock.calls.map(([command]) => command.kind)).toEqual([
        "connector.stop",
      ]);
    },
  );
  it("does not submit reconnect with a pre-existing unknown outcome", async () => {
    const ui = harness();
    ui.settings.setup.connect.outcomeUnknown = true;
    await ui.click("#onboarding-reconnect");
    expect(ui.configure).not.toHaveBeenCalled();
  });
});
