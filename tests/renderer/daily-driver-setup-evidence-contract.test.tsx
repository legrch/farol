import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Setup, SetupNavigation } from "../../src/ui/renderer/setup";
import { WindowController } from "../../src/ui/renderer/controller";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import type { ProductConfigurationSnapshot } from "../../src/pkg/product-settings/contract";
import { bootstrap, fixture, settings, signInReply } from "./fixture";

const observationHelper = "../e2e/current-react-setup.mjs";
const { assertSetupOverviewEvidence } = await import(observationHelper);
// Actual React/WindowController plus scripted IPC only. No native page, account,
// tunnel, provider or profile is observed or changed by these contract checks.
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

function readyConfiguration(): ProductConfigurationSnapshot {
  // Mutating a scenario must not alter schema default objects used by a later
  // fresh-bootstrap fixture in this file.
  const value = structuredClone(settings());
  const buildId = "3".repeat(64);
  const runtimeGeneration = "a".repeat(64);
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const verifiedAt = "2026-10-02T20:00:00.000Z";
  const rootIdentity = { device: "1", inode: "2" };
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/controlled/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity,
      accessCheck: { buildId, computerGeneration: 1, verifiedAt, rootIdentity },
    },
  ];
  const witness = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt,
  };
  value.setup.computer.verified = witness;
  value.setup.connect.verified = witness;
  Object.assign(value.connectors.secureMcp, {
    tunnelId: "controlled-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/controlled/tunnel",
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
    attachment: {
      tunnelId: "controlled-tunnel",
      workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt,
    },
  });
  return { status: "ready", settings: ProductSettingsSchema.parse(value) };
}

async function mount(
  configuration: ProductConfigurationSnapshot = {
    status: "ready",
    settings: settings(),
  },
) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration,
  });
  vi.mocked(f.api.configure).mockImplementation(async (command) =>
    command.kind === "chatgpt.observe-sign-in"
      ? signInReply(command, "unknown", configuration)
      : { ok: true, snapshot: configuration },
  );
  const c = new WindowController(f.api);
  controllers.push(c);
  await c.start();
  c.navigate({ area: "setup", setupStep: "overview" });
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
  await act(async () => root.render(<View />));
  const overview = async () =>
    act(async () => c.navigate({ area: "setup", setupStep: "overview" }));
  const observe = async (state: "authenticated" | "signed_out" | "unknown") => {
    vi.mocked(f.api.configure).mockImplementation(async (command) =>
      command.kind === "chatgpt.observe-sign-in"
        ? signInReply(command, state, configuration)
        : { ok: true, snapshot: configuration },
    );
    await act(async () => c.navigate({ area: "setup", setupStep: "signin" }));
    await overview();
  };
  const evidence = () => {
    const navigation = host.querySelector('[aria-label="Setup steps"]')!;
    const buttons = [...navigation.querySelectorAll("button")];
    const region = host.querySelector('[aria-label="Setup overview"]')!;
    const home = [...region.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "Open Home",
    );
    return {
      steps: buttons.map((button) => button.getAttribute("aria-label")),
      currentSteps: buttons
        .filter((button) => button.getAttribute("aria-current") === "step")
        .map((button) => button.getAttribute("aria-label")),
      obsoleteCount: host.querySelectorAll(
        '.setup-finish, [aria-label="Computer setup status"]',
      ).length,
      rows: [...region.querySelectorAll(".setup-checklist-row")].map((row) => {
        const label = row.querySelector("h2")!.firstChild!.textContent!.trim();
        const status = row.querySelector(".setup-check-status")!;
        const button = buttons.find(
          (item) => item.getAttribute("aria-label") === label,
        )!;
        return {
          step: row.getAttribute("data-setup-check"),
          label,
          optional: row.querySelectorAll(".setup-optional-tag").length === 1,
          state: status.getAttribute("data-check-state"),
          status: status.textContent!.trim(),
          navigationState: button
            .querySelector("[data-check-state]")!
            .getAttribute("data-check-state"),
          navigationStatus: button.getAttribute("aria-description"),
        };
      }),
      openHome: {
        count: home.length,
        visible: home.some((button) => !button.closest("[hidden]")),
        disabled: home.some((button) => button.disabled),
      },
    };
  };
  return { f, c, evidence, observe, overview };
}
function expected(signIn = "unknown", state = "unknown", ready = false) {
  return {
    ready,
    hasWorkspaces: ready,
    signIn,
    states: {
      signin: state,
      folders: ready ? "verified" : "needed",
      connection: ready ? "verified" : "needed",
      attachment: ready ? "verified" : "needed",
    },
  };
}

describe("current Setup renderer and native observation helper contract", () => {
  it("matches ready empty-catalogue evidence without manufacturing file verification", async () => {
    const configuration = readyConfiguration();
    if (configuration.status !== "ready")
      throw new Error("fixture unavailable");
    const value = configuration.settings;
    value.computer.workspaces = [];
    value.setup.computer.verified = null;
    value.setup.connect.verified!.workspaceId = null;
    value.connectors.secureMcp.attachment!.workspaceId = null;
    const h = await mount(configuration);
    const expectedReady = expected("unknown", "unknown", true);
    assertSetupOverviewEvidence(h.evidence(), {
      ...expectedReady,
      hasWorkspaces: false,
      states: { ...expectedReady.states, folders: "needed" },
    });
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("matches fresh bootstrap unknown without claiming an unchecked or signed-out observation", async () => {
    const h = await mount();
    expect(h.c.getSnapshot().signInObservation).toBeNull();
    expect(h.f.api.configure).not.toHaveBeenCalled();
    assertSetupOverviewEvidence(h.evidence(), expected());
  });
  it.each([
    ["unknown", "unknown"],
    ["signed_out", "needed"],
    ["authenticated", "verified"],
  ] as const)(
    "matches an actual %s page observation on Overview and sidebar",
    async (state, checkState) => {
      const h = await mount();
      await h.observe(state);
      expect(h.c.getSnapshot().signInObservation?.state).toBe(state);
      assertSetupOverviewEvidence(h.evidence(), expected(state, checkState));
      expect(h.f.api.configure).toHaveBeenCalledTimes(1);
      expect(h.f.api.task).not.toHaveBeenCalled();
    },
  );
  it("preserves actual operation UNKNOWN rather than treating it as a page observation or retry", async () => {
    const h = await mount();
    await h.observe("signed_out");
    vi.mocked(h.f.api.configure).mockRejectedValueOnce(
      new Error("controlled lost sign-in ACK"),
    );
    const intention = "settings:chatgpt.open-sign-in:";
    await act(async () => {
      expect(
        (await h.c.configure({ kind: "chatgpt.open-sign-in" }, intention))
          .state,
      ).toBe("unknown");
    });
    const original = h.c.getSnapshot().intents[intention];
    const commands = vi.mocked(h.f.api.configure).mock.calls.length;
    await h.overview();
    assertSetupOverviewEvidence(h.evidence(), {
      ...expected("outcome_unknown"),
      states: {
        signin: "unknown",
        folders: "unknown",
        connection: "unknown",
        attachment: "unknown",
      },
    });
    await act(async () => {
      expect(
        await h.c.configure({ kind: "chatgpt.open-sign-in" }, intention),
      ).toEqual(original);
    });
    expect(h.c.getSnapshot().intents[intention]).toBe(original);
    expect(h.f.api.configure).toHaveBeenCalledTimes(commands);
  });
  it("keeps externally ready Computer independent of unknown optional sign-in", async () => {
    const h = await mount(readyConfiguration());
    assertSetupOverviewEvidence(
      h.evidence(),
      expected("unknown", "unknown", true),
    );
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
  it("keeps unavailable configuration honest without claiming an optional sign-in check", async () => {
    const h = await mount({ status: "error", error: "SETTINGS_CORRUPT" });
    assertSetupOverviewEvidence(h.evidence(), {
      ...expected(),
      states: {
        signin: "unknown",
        folders: "unavailable",
        connection: "unavailable",
        attachment: "unavailable",
      },
    });
    expect(h.f.api.configure).not.toHaveBeenCalled();
  });
});
