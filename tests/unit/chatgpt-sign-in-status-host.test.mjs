import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
  ProductConfigurationResultSchema,
} from "../../src/pkg/product-settings/contract.ts";

import { deriveSurfaceLayout } from "../../src/apps/desktop/surface-layout.ts";

// Actual host code with injected route mechanics. No browser, network, state
// writer, credential, provider or shared build output participates.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
let branch;
let returnCallback;
const continuityFunctions = new Map();
const continuityBranches = new Map();
const continuityCallbacks = new Map();
function visit(node) {
  if (
    node.type === "FunctionDeclaration" &&
    ["currentSurfaceLayout", "applyLayout"].includes(node.id?.name)
  )
    continuityFunctions.set(node.id.name, source.slice(node.start, node.end));
  if (
    node.type === "SwitchCase" &&
    [
      "chatgpt.open-sign-in",
      "chatgpt.open-browser",
      "chatgpt.verification-return",
    ].includes(node.test?.value)
  )
    continuityBranches.set(node.test.value, source.slice(node.start, node.end));
  if (
    node.type === "ObjectProperty" &&
    ["onLoadStateChanged", "onSignInOutcome"].includes(node.key?.name)
  )
    continuityCallbacks.set(
      node.key.name,
      source.slice(node.value.start, node.value.end),
    );
  if (
    node.type === "SwitchCase" &&
    node.test?.value === "chatgpt.observe-sign-in"
  )
    branch = source.slice(node.start, node.end);
  if (
    node.type === "FunctionDeclaration" &&
    node.id?.name === "recordChatGptSignInOutcome"
  )
    returnCallback = source.slice(node.start, node.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child?.type) visit(child);
    } else if (value?.type) visit(value);
  }
}
visit(tree);
if (!branch || !returnCallback)
  throw new Error("SIGN_IN_STATUS_HOST_CODE_MISSING");
const buildId = "3".repeat(64);
const observationId = "11111111-1111-4111-8111-111111111111";
const binding = { documentGeneration: 7, sequence: 2 };
function harness(state = "authenticated") {
  const observation = { state, binding: state === "unknown" ? null : binding };
  const context = {
    command: { kind: "chatgpt.observe-sign-in", buildId, observationId },
    buildIdentity: { buildId },
    chatGptRoute: {
      observeSignInStatus: vi.fn(async () => observation),
      isCurrentSignInStatus: vi.fn(() => true),
      open: vi.fn(),
      observeAccount: vi.fn(),
    },
    quitInProgress: false,
    installedUpdateAdmission: false,
    configuration: {
      snapshot: vi.fn(() => ({
        status: "error",
        error: "SETTINGS_READ_FAILED",
      })),
      recordChatGptObservation: vi.fn(async () => ({ ok: true })),
    },
    ProductConfigurationResultSchema,
    activeDesktopIdentity: { chatGptPartition: "synthetic-partition" },
    runtimeEnvironment: "dev",
    setupOpen: true,
    section: "computer",
    publishShellAction: vi.fn(),
  };
  const handle = vm.runInNewContext(
    stripTypeScriptTypes(
      `async function handle() { switch(command.kind) { ${branch} } } handle`,
    ),
    context,
  );
  const returned = vm.runInNewContext(
    stripTypeScriptTypes(`${returnCallback}\nrecordChatGptSignInOutcome`),
    context,
  );
  return { context, observation, handle, returned };
}
describe("bounded Sign in status host disclosure", () => {
  it("admits only exact content-free input and refuses known status without binding", () => {
    const h = harness();
    expect(ProductConfigurationCommandSchema.parse(h.context.command)).toEqual(
      h.context.command,
    );
    expect(
      ProductConfigurationCommandSchema.safeParse({
        ...h.context.command,
        key: "synthetic",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.sign-in-status",
        observationId,
        buildId,
        state: "authenticated",
        binding: null,
      }).success,
    ).toBe(false);
  });

  it.each(["authenticated", "signed_out", "unknown"])(
    "discloses %s without opening, account fetch or Settings write",
    async (state) => {
      const h = harness(state);
      expect(await h.handle()).toMatchObject({
        ok: true,
        evidence: {
          kind: "chatgpt.sign-in-status",
          observationId,
          buildId,
          ...h.observation,
        },
      });
      expect(h.context.chatGptRoute.observeSignInStatus).toHaveBeenCalledTimes(
        1,
      );
      expect(h.context.chatGptRoute.open).not.toHaveBeenCalled();
      expect(h.context.chatGptRoute.observeAccount).not.toHaveBeenCalled();
      expect(
        h.context.configuration.recordChatGptObservation,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["missing-route", "wrong-build"])(
    "observes no substitute for %s",
    async (kind) => {
      const h = harness();
      const original = h.context.chatGptRoute;
      if (kind === "missing-route") h.context.chatGptRoute = null;
      else h.context.command.buildId = "4".repeat(64);
      expect(await h.handle()).toMatchObject({
        ok: true,
        evidence: { state: "unknown", binding: null },
      });
      expect(original.observeSignInStatus).not.toHaveBeenCalled();
    },
  );

  it.each(["quit", "update", "replacement", "document", "throw"])(
    "does not disclose a late positive answer after %s",
    async (loss) => {
      const h = harness();
      let settle;
      const waiting = new Promise((resolve) => {
        settle = resolve;
      });
      const original = h.context.chatGptRoute;
      original.observeSignInStatus.mockReturnValue(waiting);
      const result = h.handle();
      if (loss === "quit") h.context.quitInProgress = true;
      if (loss === "update") h.context.installedUpdateAdmission = true;
      if (loss === "replacement") h.context.chatGptRoute = { ...original };
      if (loss === "document")
        original.isCurrentSignInStatus.mockReturnValue(false);
      if (loss === "throw")
        original.isCurrentSignInStatus.mockImplementation(() => {
          throw new Error("lost");
        });
      settle(h.observation);
      expect(await result).toMatchObject({
        ok: true,
        evidence: { state: "unknown", binding: null },
      });
      expect(
        h.context.configuration.recordChatGptObservation,
      ).not.toHaveBeenCalled();
    },
  );

  it("classifies a failed route read without exposing its detail", async () => {
    const h = harness();
    h.context.chatGptRoute.observeSignInStatus.mockRejectedValue(
      new Error("private-detail"),
    );
    const result = await h.handle();
    expect(result).toMatchObject({
      ok: true,
      evidence: { state: "unknown", binding: null },
    });
    expect(JSON.stringify(result)).not.toContain("private-detail");
  });

  it.each(["authenticated", "not_authenticated", "unknown"])(
    "the original sign-in return preserves uncertainty for %s without another observation",
    async (state) => {
      const h = harness();
      await h.returned(3, state);
      if (state === "unknown")
        expect(
          h.context.configuration.recordChatGptObservation,
        ).not.toHaveBeenCalled();
      else {
        expect(
          h.context.configuration.recordChatGptObservation,
        ).toHaveBeenCalledTimes(1);
        expect(
          h.context.configuration.recordChatGptObservation.mock.calls[0][1],
        ).toBe(true);
      }
      expect(h.context.chatGptRoute.observeSignInStatus).not.toHaveBeenCalled();
      expect(h.context.publishShellAction).toHaveBeenCalledExactlyOnceWith(
        "sign-in-returned",
        "auth-window-closed",
        3,
      );
    },
  );
});

// Executed host functions with fake native mechanics. These fixtures prove
// layout decisions, not Electron stacking, hit testing, focus or provider login.
function continuityHarness(width = 1180, height = 760) {
  const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" };
  const view = {
    webContents: { isDestroyed: () => false },
    setBounds: vi.fn(),
  };
  const context = {
    window: {
      isDestroyed: () => false,
      getContentSize: () => [width, height],
      webContents: { send: vi.fn() },
    },
    section: "settings",
    setupOpen: false,
    quitInProgress: false,
    selectedTaskId: "",
    browserHomeSurfaceOpen: true,
    sidebarMode: "full",
    sidebarWidth: 152,
    shellOverlay: "none",
    runtimeState: "ready",
    runtimeEnvironment: "dev",
    demoMode: false,
    legacySetupTestMode: false,
    checkFeedbackVisible: false,
    installedUpdateAdmission: false,
    productTasksState: () => ({ tasks: [] }),
    SIGN_IN_SURFACE_ID: "fixture-sign-in",
    taskViews: new Map([["fixture-sign-in", view]]),
    taskViewKinds: new Map(),
    deriveSurfaceLayout,
    compactBrowserSelected: () => false,
    nativeViewVisibility: { hide: vi.fn() },
    attachTaskView: vi.fn(),
    channels: { browserRouteState: "fixture-route" },
    embeddedBrowserEnabled: () => true,
    chatGptRoute: {
      openForSignIn: vi.fn(async () => ({ status: "opened" })),
      retryFailedOpen: vi.fn(async () => ({ status: "opened" })),
      returnFromSignIn: vi.fn(() => false),
    },
    SIGN_IN_WINDOW_TITLE: "Fixture sign-in",
    chatGptTaskAdmission: false,
    connectorTaskAdmission: false,
    chatGptSignInBlocked: { beginAttempt: vi.fn() },
    chatGptSignInOutcome: null,
    chatGptSignInGeneration: 0,
    chatGptSignInOpenGeneration: null,
    configuration: {
      snapshot: () => snapshot,
      markSetupVisited: vi.fn(async () => ({ ok: true, snapshot })),
      recordChatGptObservation: vi.fn(async () => ({ ok: true, snapshot })),
    },
    configurationFailure: (error) => ({ ok: false, error, snapshot }),
    ProductConfigurationResultSchema,
    publishLayout: vi.fn(),
    publishShellAction: vi.fn(),
    recordChatGptSignInOutcome: vi.fn(async () => undefined),
  };
  const code = `
    ${[...continuityFunctions.values()].join("\n")}
    async function command(kind) { switch(kind) {
      ${continuityBranches.get("chatgpt.open-sign-in")}
      ${continuityBranches.get("chatgpt.open-browser")}
      ${continuityBranches.get("chatgpt.verification-return")}
    } }
    ({ layout: currentSurfaceLayout, apply: applyLayout, command,
      load: ${continuityCallbacks.get("onLoadStateChanged")},
      outcome: ${continuityCallbacks.get("onSignInOutcome")} })`;
  const api = vm.runInNewContext(stripTypeScriptTypes(code), context);
  return { context, view, api };
}

describe("retained sign-in host continuity", () => {
  it("does not compete with renderer destination on open, return or outcome", async () => {
    const { context: c, api } = continuityHarness();
    await api.command("chatgpt.open-sign-in");
    expect(c.chatGptRoute.openForSignIn).toHaveBeenCalledTimes(1);
    expect(c.section).toBe("settings");
    expect(c.setupOpen).toBe(false);
    c.section = "browser";
    const before = api.layout();
    c.chatGptSignInOpenGeneration = 4;
    await api.command("chatgpt.verification-return");
    expect(c.chatGptSignInOpenGeneration).toBeNull();
    api.outcome("unknown", { reason: "synthetic" });
    expect(c.section).toBe("browser");
    expect(api.layout()).toEqual(before);
    expect(c.publishLayout).not.toHaveBeenCalled();
    expect(c.publishShellAction).not.toHaveBeenCalled();
  });

  it("Open ChatGPT retains the home document while renderer selection alone presents it", async () => {
    const { context: c, api } = continuityHarness();
    c.productTasksState = () => ({ tasks: [{ taskId: "retained-task" }] });
    c.section = "browser";
    c.selectedTaskId = "retained-task";
    expect(api.layout().showBrowserHome).toBe(false);
    await api.command("chatgpt.open-browser");
    expect(c.chatGptRoute.retryFailedOpen).toHaveBeenCalledTimes(1);
    expect(api.layout().showBrowserHome).toBe(false);
    c.selectedTaskId = "";
    expect(api.layout().showBrowserHome).toBe(true);
    expect(api.layout().pageVisible).toBe(true);
  });

  it.each([
    [1180, 760, 214],
    [640, 600, 58],
  ])(
    "retains one browser across passive loads and navigation at %sx%s",
    (width, height, rail) => {
      const { context: c, view, api } = continuityHarness(width, height);
      c.section = "browser";
      for (const state of ["loaded", "loading", "loaded", "failed"]) {
        api.load(state);
        expect(c.browserHomeSurfaceOpen).toBe(true);
        expect(c.section).toBe("browser");
        expect(c.taskViews.get("fixture-sign-in")).toBe(view);
        expect(api.layout()).toMatchObject({
          pageVisible: true,
          pageBounds: {
            x: rail,
            y: 58,
            width: width - rail,
            height: height - 58,
          },
        });
      }
      api.load("loaded");
      c.section = "settings";
      api.apply();
      expect(api.layout().pageVisible).toBe(false);
      api.load("loading");
      expect(api.layout().pageVisible).toBe(false);
      c.section = "browser";
      api.apply();
      expect(api.layout().pageVisible).toBe(true);
      c.shellOverlay = "quick-switcher";
      api.apply();
      expect(api.layout().pageVisible).toBe(false);
      expect(c.nativeViewVisibility.hide).toHaveBeenCalledWith(view);
      c.shellOverlay = "none";
      api.apply();
      expect(c.attachTaskView).toHaveBeenLastCalledWith(
        "fixture-sign-in",
        view,
        api.layout().pageBounds,
      );
    },
  );
});
