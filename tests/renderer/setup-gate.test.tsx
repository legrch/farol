import { commandAllowed } from "../../src/ui/renderer/command-eligibility";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type {
  RendererFacade,
  WindowSnapshot,
} from "../../src/ui/renderer/contract";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";
import { setupStepCheck } from "../../src/ui/renderer/setup-gate";
import type { SetupCheckpoint } from "../../src/ui/renderer/setup-checklist";
import {
  buildId,
  change,
  mount,
  readySettings,
  workspaceId,
} from "./setup-fixture";

const steps: readonly SetupCheckpoint[] = [
  "signin",
  "folders",
  "connection",
  "attachment",
];
const states = [
  "success-current",
  "success-stale",
  "unknown",
  "pending",
  "refused",
  "missing",
] as const;
type Case = (typeof states)[number];
type BindingMutation = Readonly<{
  name: string;
  step: SetupCheckpoint;
  expectedState: "missing" | "success" | "stale" | "unknown" | "pending";
  mutate: (
    snapshot: WindowSnapshot,
    settings: ProductSettings,
  ) => WindowSnapshot;
}>;
function expectedAction(state: Case) {
  if (state === "success-current") return null;
  return state === "unknown" || state === "pending"
    ? "Refresh status"
    : "Read the setup guide";
}

function intentId(step: SetupCheckpoint) {
  switch (step) {
    case "signin":
      return "settings:chatgpt.verify:synthetic";
    case "folders":
      return `settings:computer.verify-workspace:${workspaceId}`;
    case "connection":
      return "settings:connector.check-health:synthetic";
    case "attachment":
      return "settings:connector.verify-app:synthetic";
  }
}

function syntheticSnapshot(
  source: WindowSnapshot,
  step: SetupCheckpoint,
  state: Case,
): WindowSnapshot {
  const settings = readySettings(true);
  const binding = { documentGeneration: 7, sequence: 19 };
  let currentBuildId = buildId;
  let intents: WindowSnapshot["intents"] = {};
  let setupSignInCheck: WindowSnapshot["setupSignInCheck"] = {
    buildId,
    binding,
  };

  if (state === "success-stale") {
    currentBuildId = "4".repeat(64);
  } else if (state === "missing") {
    switch (step) {
      case "signin":
        settings.setup.chatgpt.verified = null;
        settings.setup.chatgpt.reachable = "unreachable";
        setupSignInCheck = null;
        break;
      case "folders":
        settings.computer.workspaces = [];
        settings.setup.computer.verified = null;
        break;
      case "connection":
        settings.setup.computer.verified = null;
        settings.connectors.secureMcp.runtime = null;
        break;
      case "attachment":
        settings.setup.connect.verified = null;
        settings.setup.connect.reachable = "unreachable";
        settings.connectors.secureMcp.attachment = null;
        break;
    }
  } else if (
    state === "unknown" ||
    state === "pending" ||
    state === "refused"
  ) {
    intents = {
      [intentId(step)]: {
        id: intentId(step),
        state,
        code: null,
      },
    };
  }
  return {
    ...source,
    status: "current",
    runtime: "ready",
    buildId: currentBuildId,
    configuration: { status: "ready", settings },
    intents,
    signInObservation: {
      observationId: "synthetic-observation",
      buildId,
      counter: 1,
      pending: false,
      state: "authenticated",
      binding,
    },
    setupSignInCheck,
  };
}

describe("rendered Setup gate", () => {
  it.each(
    steps.flatMap((step) => states.map((state) => [step, state] as const)),
  )(
    "%s renders the %s result and only permits a current confirmed success",
    async (step, state) => {
      const h = await mount({ step });
      const snapshot = syntheticSnapshot(h.c.getSnapshot(), step, state);
      const facade = new Proxy(h.c, {
        get(target, property) {
          if (property === "getSnapshot") return () => snapshot;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as RendererFacade;

      await h.renderSetup(snapshot, facade);

      const advance = h.button(
        step === "attachment" ? "Start using Farol" : "Continue",
      );
      expect(advance).toBeTruthy();
      expect(advance!.disabled).toBe(state !== "success-current");

      const status = h.host.querySelector<HTMLElement>(".setup-gate-status");
      const expected = setupStepCheck(
        snapshot,
        step,
        state === "success-stale",
      );
      const resultState =
        state === "success-current"
          ? "success"
          : state === "success-stale"
            ? "stale"
            : state;
      if (state === "success-current") {
        expect(status?.dataset.resultState).toBe(resultState);
        expect(status?.textContent).toContain(expected.cause);
        expect(status?.querySelectorAll("button")).toHaveLength(0);
      } else {
        expect(status?.dataset.resultState).toBe(resultState);
        expect(status?.textContent).toContain(
          step === "attachment" && state === "missing"
            ? "Add the app above, then run the check once."
            : step === "attachment" && state === "unknown"
              ? "An earlier action is not confirmed."
              : expected.cause,
        );
        expect(status?.querySelectorAll("button")).toHaveLength(
          step === "attachment" && state === "missing" ? 0 : 1,
        );
        expect(status?.querySelector("button")?.textContent?.trim()).toBe(
          step === "attachment" && state === "missing"
            ? undefined
            : step === "attachment" && state === "unknown"
              ? "Check for confirmation"
              : expectedAction(state),
        );
      }
    },
  );

  const nonConfirmingIds: Record<SetupCheckpoint, string> = {
    signin: "settings:chatgpt.open-sign-in:",
    folders: `settings:computer.remove-workspace:${workspaceId}`,
    connection: "settings:connector.stop:",
    attachment: "settings:connector.select-chatgpt-app:",
  };
  const afterCheckCases = [
    { name: "refused action", state: "refused", expected: "success" },
    { name: "refused check", state: "refused", expected: "refused" },
    { name: "unknown action", state: "unknown", expected: "unknown" },
    { name: "pending action", state: "pending", expected: "pending" },
    {
      name: "unconfirmed write refusal",
      state: "refused",
      expected: "unknown",
      code: "SETTINGS_WRITE_FAILED",
    },
  ] as const;
  it.each(
    steps.flatMap((step) =>
      afterCheckCases.map((testCase) => ({ step, ...testCase })),
    ),
  )("$step handles a newer $name after a confirmed check", async (testCase) => {
    const { step, name, state, expected } = testCase;
    const h = await mount({ step });
    const confirmation = intentId(step);
    const id = name === "refused check" ? confirmation : nonConfirmingIds[step];
    const snapshot: WindowSnapshot = {
      ...syntheticSnapshot(h.c.getSnapshot(), step, "success-current"),
      intents: {
        [confirmation]: { id: confirmation, state: "applied", code: null },
        [id]: {
          id,
          state,
          code: "code" in testCase ? testCase.code : null,
        },
      },
      setupCheckOrder: { [confirmation]: 1, [id]: 2 },
    };
    const facade = new Proxy(h.c, {
      get(target, property) {
        if (property === "getSnapshot") return () => snapshot;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as RendererFacade;
    await h.renderSetup(snapshot, facade);

    expect(
      h.button(step === "attachment" ? "Start using Farol" : "Continue")
        ?.disabled,
    ).toBe(expected !== "success");
    const status = h.host.querySelector<HTMLElement>(".setup-gate-status");
    expect(status?.dataset.resultState).toBe(expected);
    const error = h.host.querySelector<HTMLElement>(".setup-action-error");
    if (expected === "success") {
      expect(status?.textContent).toContain(
        setupStepCheck(snapshot, step).cause,
      );
      expect(status?.querySelectorAll("button")).toHaveLength(0);
      expect(error?.textContent).toContain(
        "The action could not be completed.",
      );
      expect(error?.querySelectorAll("button")).toHaveLength(1);
      expect(error?.querySelector("button")?.textContent?.trim()).toBe(
        "Read the setup guide",
      );
      await h.click("Read the setup guide");
      expect(vi.mocked(h.f.api.configure).mock.calls.at(-1)?.[0]).toEqual({
        kind: "onboarding.open-help",
        destination: "setup-guide",
      });
    } else {
      expect(error).toBeNull();
      expect(status?.querySelectorAll("button")).toHaveLength(1);
      if (expected === "unknown" || expected === "pending") {
        const effects = () =>
          vi
            .mocked(h.f.api.configure)
            .mock.calls.filter(
              ([command]) => command.kind !== "chatgpt.observe-sign-in",
            );
        const submissions = effects().length;
        await h.click(
          step === "attachment" && expected === "unknown"
            ? "Check for confirmation"
            : "Refresh status",
        );
        expect(effects()).toHaveLength(submissions);
        await h.remount(snapshot, facade);
        expect(
          h.button(step === "attachment" ? "Start using Farol" : "Continue")
            ?.disabled,
        ).toBe(true);
        expect(
          h.host.querySelector<HTMLElement>(".setup-gate-status")?.dataset
            .resultState,
        ).toBe(expected);
        expect(effects()).toHaveLength(submissions);
      }
    }
  });

  it("keeps the confirmed connection and action error after Disconnect is refused", async () => {
    const h = await mount({ step: "connection" });
    const snapshot = syntheticSnapshot(
      h.c.getSnapshot(),
      "connection",
      "success-current",
    );
    const configure = vi.fn<RendererFacade["configure"]>(
      async (_command, id) => ({ id, state: "refused", code: null }),
    );
    const facade = new Proxy(h.c, {
      get(target, property) {
        if (property === "getSnapshot") return () => snapshot;
        if (property === "configure") return configure;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as RendererFacade;
    await h.renderSetup(snapshot, facade);
    await h.click("Disconnect");
    expect(configure).toHaveBeenCalledExactlyOnceWith(
      { kind: "connector.stop" },
      "settings:connector.stop:",
    );
    expect(h.button("Continue")?.disabled).toBe(false);
    expect(h.host.textContent).toContain("✓ Connected");
    expect(
      h.host.querySelector(".setup-action-error")?.querySelectorAll("button"),
    ).toHaveLength(1);
    await h.remount(snapshot, facade);
    expect(h.button("Continue")?.disabled).toBe(false);
    expect(h.host.textContent).toContain("✓ Connected");
    expect(h.host.querySelector(".setup-action-error")?.textContent).toContain(
      "The action could not be completed.",
    );
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it.each(["refused", "unknown"] as const)(
    "a newer confirmed check supersedes an old %s only when its outcome is known",
    async (state) => {
      const h = await mount({ step: "connection" });
      const original = syntheticSnapshot(
        h.c.getSnapshot(),
        "connection",
        "success-current",
      );
      const old = "settings:connector.save-and-connect:old-attempt";
      const health = "settings:connector.check-health:";
      const snapshot: WindowSnapshot = {
        ...original,
        intents: {
          [old]: { id: old, state, code: null },
          [health]: { id: health, state: "applied", code: null },
        },
        setupCheckOrder: { [old]: 1, [health]: 2 },
      };
      const facade = new Proxy(h.c, {
        get(target, property) {
          if (property === "getSnapshot") return () => snapshot;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as RendererFacade;
      await h.renderSetup(snapshot, facade);
      expect(h.button("Continue")?.disabled).toBe(state === "unknown");
      expect(
        h.host.querySelector<HTMLElement>(".setup-gate-status")?.dataset
          .resultState,
      ).toBe(state === "unknown" ? "unknown" : "success");
    },
  );

  const bindingMutations: readonly BindingMutation[] = [
    {
      name: "sign-in rejects a changed document generation",
      step: "signin",
      expectedState: "stale",
      mutate: (snapshot) => ({
        ...snapshot,
        signInObservation: {
          ...snapshot.signInObservation!,
          binding: { documentGeneration: 8, sequence: 20 },
        },
      }),
    },
    {
      name: "sign-in accepts a newer sequence in the same document",
      step: "signin",
      expectedState: "success",
      mutate: (snapshot) => ({
        ...snapshot,
        signInObservation: {
          ...snapshot.signInObservation!,
          binding: { documentGeneration: 7, sequence: 20 },
        },
      }),
    },
    {
      name: "sign-in blocks a missing observation",
      step: "signin",
      expectedState: "stale",
      mutate: (snapshot) => ({ ...snapshot, signInObservation: null }),
    },
    {
      name: "sign-in needs a new status read after an inconclusive observation",
      step: "signin",
      expectedState: "missing",
      mutate: (snapshot) => ({
        ...snapshot,
        signInObservation: {
          ...snapshot.signInObservation!,
          state: "unknown",
          binding: null,
        },
      }),
    },
    {
      name: "sign-in blocks a pending observation",
      step: "signin",
      expectedState: "pending",
      mutate: (snapshot) => ({
        ...snapshot,
        signInObservation: {
          ...snapshot.signInObservation!,
          pending: true,
        },
      }),
    },
    {
      name: "workspaces require accessCheck for every current grant",
      step: "folders",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        const { accessCheck: _oldCheck, ...workspace } =
          settings.computer.workspaces[0]!;
        settings.computer.workspaces.push({
          ...workspace,
          workspaceId: "44444444-4444-4444-8444-444444444444",
          root: "/approved/second-project",
          label: "Second project",
        });
        return _snapshot;
      },
    },
    {
      name: "changed workspace access invalidates the computer generation",
      step: "folders",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.computer.workspaces[0]!.access = "write";
        settings.computer.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a changed connector generation",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a changed tunnel ID at a new generation",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.tunnelId = "changed-tunnel-id";
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a key replacement at a new generation",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a changed tunnel helper at a new generation",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.tunnelClient!.version = "2.0.0";
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a missing credential",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.credential = "missing";
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "connection rejects a missing tunnel helper",
      step: "connection",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.tunnelClient = null;
        settings.connectors.secureMcp.generation += 1;
        return _snapshot;
      },
    },
    {
      name: "attachment rejects a saved app-name change after its old proof is withdrawn",
      step: "attachment",
      expectedState: "missing",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.chatgptApp!.name = "Other";
        // The configuration service withdraws these proofs when it saves a new
        // name. A valid different name alone is no longer a stale binding.
        settings.connectors.secureMcp.attachment = null;
        settings.connectors.secureMcp.lastVerifiedAttachment = null;
        settings.setup.connect.verified = null;
        return _snapshot;
      },
    },
    {
      name: "attachment rejects a changed selected app tunnel",
      step: "attachment",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.chatgptApp!.tunnelId = "other-tunnel";
        return _snapshot;
      },
    },
    {
      name: "attachment rejects a changed selected app generation",
      step: "attachment",
      expectedState: "stale",
      mutate: (_snapshot, settings) => {
        settings.connectors.secureMcp.chatgptApp!.connectorGeneration += 1;
        return _snapshot;
      },
    },
  ];

  it.each(bindingMutations)(
    "$name",
    async ({ step, expectedState, mutate }) => {
      const h = await mount({ step });
      const snapshot = syntheticSnapshot(
        h.c.getSnapshot(),
        step,
        "success-current",
      );
      const configuration = snapshot.configuration;
      if (configuration?.status !== "ready")
        throw new Error("fixture not ready");
      const mutated = mutate(snapshot, configuration.settings);
      const facade = new Proxy(h.c, {
        get(target, property) {
          if (property === "getSnapshot") return () => mutated;
          const current = Reflect.get(target, property, target) as unknown;
          return typeof current === "function" ? current.bind(target) : current;
        },
      }) as unknown as RendererFacade;
      await h.renderSetup(mutated, facade);

      const allowed = expectedState === "success";
      expect(
        h.button(step === "attachment" ? "Start using Farol" : "Continue")
          ?.disabled,
      ).toBe(!allowed);
      expect(
        h.host.querySelector<HTMLElement>(".setup-gate-status")?.dataset
          .resultState,
      ).toBe(expectedState);
    },
  );

  it("requires all four current checks before attachment can finish Setup", async () => {
    const h = await mount({ step: "attachment" });
    const snapshot = syntheticSnapshot(h.c.getSnapshot(), "signin", "missing");
    const facade = new Proxy(h.c, {
      get(target, property) {
        if (property === "getSnapshot") return () => snapshot;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as RendererFacade;
    await h.renderSetup(snapshot, facade);
    expect(setupStepCheck(snapshot, "attachment").allowed).toBe(true);
    expect(h.button("Start using Farol")?.disabled).toBe(true);
  });

  it("refreshing an unknown result does not resubmit its original check", async () => {
    const h = await mount({ step: "connection" });
    const snapshot = syntheticSnapshot(
      h.c.getSnapshot(),
      "connection",
      "unknown",
    );
    const facade = new Proxy(h.c, {
      get(target, property) {
        if (property === "getSnapshot") return () => snapshot;
        const current = Reflect.get(target, property, target) as unknown;
        return typeof current === "function" ? current.bind(target) : current;
      },
    }) as unknown as RendererFacade;
    await h.renderSetup(snapshot, facade);
    const submissions = vi.mocked(h.f.api.configure).mock.calls.length;
    await h.click("Refresh status");
    expect(vi.mocked(h.f.api.configure)).toHaveBeenCalledTimes(submissions);
  });

  it("retains a thrown connection check as unknown across remount without retry", async () => {
    const h = await mount({ step: "connection", value: readySettings(true) });
    const base = syntheticSnapshot(
      h.c.getSnapshot(),
      "connection",
      "success-current",
    );
    const snapshot: WindowSnapshot = {
      ...base,
      intents: {
        "settings:connector.check-health:": {
          id: "settings:connector.check-health:",
          state: "refused",
          code: "CONNECTOR_POLLING_EXPIRED",
        },
      },
    };
    let healthAttempts = 0;
    let markAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      markAttempted = resolve;
    });
    const configure: RendererFacade["configure"] = async (
      command,
      intention,
    ) => {
      if (command.kind === "connector.check-health") {
        healthAttempts++;
        markAttempted();
        throw new Error("synthetic adapter loss");
      }
      return h.c.configure(command, intention);
    };
    const facade = new Proxy(h.c, {
      get(target, property) {
        if (property === "getSnapshot") return () => snapshot;
        if (property === "configure") return configure;
        const current = Reflect.get(target, property, target) as unknown;
        return typeof current === "function" ? current.bind(target) : current;
      },
    }) as unknown as RendererFacade;
    await h.renderSetup(snapshot, facade);
    expect(h.button("Connect")?.disabled).toBe(false);
    await h.click("Connect");
    await act(async () => {
      await attempted;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(healthAttempts).toBe(1);
    expect(
      h.host.querySelector<HTMLElement>(".setup-gate-status")?.dataset
        .resultState,
    ).toBe("unknown");
    expect(h.button("Continue")?.disabled).toBe(true);

    await h.remount(snapshot, facade);
    expect(
      h.host.querySelector<HTMLElement>(".setup-gate-status")?.dataset
        .resultState,
    ).toBe("unknown");
    expect(h.button("Continue")?.disabled).toBe(true);
    expect(h.button("Connect")?.disabled).toBe(true);
    expect(healthAttempts).toBe(1);
  });

  it.each([
    ["Tunnel ID", "synthetic-tunnel-draft"],
    ["Key", "synthetic-key-draft"],
  ])(
    "marks a changed %s draft stale until connection is checked",
    async (label, value) => {
      const h = await mount({ step: "connection" });
      const snapshot = syntheticSnapshot(
        h.c.getSnapshot(),
        "connection",
        "success-current",
      );
      const facade = new Proxy(h.c, {
        get(target, property) {
          if (property === "getSnapshot") return () => snapshot;
          const current = Reflect.get(target, property, target) as unknown;
          return typeof current === "function" ? current.bind(target) : current;
        },
      }) as unknown as RendererFacade;
      await h.renderSetup(snapshot, facade);
      const input = [
        ...h.host.querySelectorAll<HTMLInputElement>("input"),
      ].find((item) =>
        item.closest("label")?.textContent?.trim().startsWith(label),
      );
      expect(input).toBeTruthy();
      await change(input!, value);
      const status = h.host.querySelector<HTMLElement>(".setup-gate-status");
      expect(status?.dataset.resultState).toBe("stale");
      expect(status?.textContent).toContain(
        setupStepCheck(snapshot, "connection", true).cause,
      );
      expect(status?.querySelectorAll("button")).toHaveLength(1);
      expect(status?.querySelector("button")?.textContent?.trim()).toBe(
        "Read the setup guide",
      );
      expect(h.button("Continue")?.disabled).toBe(true);
    },
  );
});

describe("independent Setup facts with an uncertain app Send", () => {
  it.each(["signin", "folders", "connection"] as const)(
    "%s stays confirmed while attachment remains blocked",
    async (step) => {
      const h = await mount({ step });
      const snapshot = syntheticSnapshot(
        h.c.getSnapshot(),
        step,
        "success-current",
      );
      if (snapshot.configuration?.status !== "ready")
        throw Error("fixture missing");
      const settings = snapshot.configuration.settings;
      settings.setup.connect.outcomeUnknown = true;
      settings.setup.connect.verified = null;
      settings.connectors.secureMcp.attachment = null;
      settings.connectors.secureMcp.appVerificationPending = true;
      const pendingSnapshot = {
        ...snapshot,
        intents: {
          "settings:connector.verify-app:": {
            id: "settings:connector.verify-app:",
            state: "unknown",
            code: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
          },
        },
      } as WindowSnapshot;
      expect(setupStepCheck(pendingSnapshot, step).allowed).toBe(true);
      expect(setupStepCheck(pendingSnapshot, "attachment").state).toBe(
        "unknown",
      );
      const facade = new Proxy(h.c, {
        get(target, key) {
          if (key === "getSnapshot") return () => pendingSnapshot;
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as RendererFacade;
      await h.renderSetup(pendingSnapshot, facade);
      expect(h.button("Continue")?.disabled).toBe(false);
      expect(
        pendingSnapshot.intents["settings:connector.verify-app:"]?.state,
      ).toBe("unknown");
      settings.connectors.secureMcp.runtime!.state = "outcome_unknown";
      expect(setupStepCheck(pendingSnapshot, step).allowed).toBe(false);
    },
  );
});

it("does not tell a returning user to repeat successful steps for a pending app test", async () => {
  const value = readySettings();
  value.setup.connect.outcomeUnknown = true;
  value.connectors.secureMcp.appVerificationPending = true;
  const h = await mount({ step: "attachment", value, signIn: "authenticated" });
  await h.confirmSignIn();
  expect(setupStepCheck(h.c.getSnapshot(), "connection").allowed).toBe(true);
  expect(h.host.textContent).not.toContain(
    "Finish sign-in, workspace and connection checks",
  );
  expect(h.button("Test in ChatGPT")).toBeUndefined();
  expect(h.button("Check for confirmation")?.disabled).toBe(false);
  expect(h.button("Prepare new test")).toBeUndefined();
  const before = vi
    .mocked(h.f.api.configure)
    .mock.calls.filter(
      ([command]) => command.kind === "connector.verify-app",
    ).length;
  await h.click("Check for confirmation");
  expect(
    vi
      .mocked(h.f.api.configure)
      .mock.calls.filter(
        ([command]) => command.kind === "connector.verify-app",
      ),
  ).toHaveLength(before);
  const after = h.c.getSnapshot().configuration;
  expect(
    after?.status === "ready" && after.settings.setup.connect.outcomeUnknown,
  ).toBe(true);
});

it("allows only receipt readback while app Send is unknown, and qualifies matching evidence without erasing history", async () => {
  const h = await mount({ step: "attachment" });
  const snapshot = syntheticSnapshot(
    h.c.getSnapshot(),
    "attachment",
    "success-current",
  );
  if (snapshot.configuration?.status !== "ready")
    throw Error("fixture missing");
  const settings = snapshot.configuration.settings;
  const id = "settings:connector.verify-app:";
  const previous = {
    id,
    state: "unknown" as const,
    code: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
  };
  const pending = { ...snapshot, intents: { [id]: previous } };
  expect(setupStepCheck(pending, "attachment").allowed).toBe(true);
  expect(commandAllowed(pending, "setup.progress")).toBe(true);
  expect(pending.intents[id]).toBe(previous);
  settings.setup.connect.outcomeUnknown = true;
  settings.connectors.secureMcp.appVerificationPending = true;
  settings.connectors.secureMcp.attachment = null;
  expect(setupStepCheck(pending, "attachment").allowed).toBe(false);
  expect(commandAllowed(pending, "connector.verify-app")).toBe(false);
  expect(commandAllowed(pending, "connector.check-attachment")).toBe(true);
  const saveUnknown = {
    ...pending,
    intents: {
      ...pending.intents,
      "settings:connector.check-attachment:": {
        id: "settings:connector.check-attachment:",
        state: "unknown" as const,
        code: "SETTINGS_WRITE_FAILED",
      },
    },
  };
  expect(commandAllowed(saveUnknown, "connector.check-attachment")).toBe(false);
  expect(setupStepCheck(saveUnknown, "attachment").allowed).toBe(false);
});
