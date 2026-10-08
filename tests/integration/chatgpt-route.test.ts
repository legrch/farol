import { EventEmitter } from "node:events";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StagedChatGptAttachment } from "../../src/apps/desktop/chatgpt-attachment-staging";

const electronMock = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));
const attachmentMock = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: electronMock.fromPartition },
}));

vi.mock("../../src/apps/desktop/chatgpt-attachment-upload", () => ({
  uploadChatGptAttachments: attachmentMock.upload,
}));

import {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  activateTaskScript,
  bindChatGptAppScript,
  collapseChatGptSidebarScript,
  temporaryInstantProfileProbe,
  openInstantPowerPickerScript,
  focusInstantPowerSliderScript,
  openTemporaryPersonalizationScript,
  selectTemporaryPersonalizationScript,
  taskProbeScript,
  toggleChatGptSidebarScript,
  installManualAppGateScript,
  classifyChatGptProviderError,
  prepareTaskScript,
  resolveChatGptWindowPresentation,
  verifyChatGptAppScript,
  type ChatGptRouteSurfaceFactory,
  type ChatGptSignInOutcomeDiagnostic,
  type ChatGptSignInBlockedDiagnostic,
  type ChatGptRouteOptions,
  type ChatGptUpdateAdmissionDiagnostic,
  type ChatGptUpdateIdleEffectGuard,
} from "../../src/apps/desktop/chatgpt-route";

const prepared = {
  ready: true,
  baselineAssistantCount: 0,
  baselineUserCount: 0,
  baselineMessageIds: [],
} as const;

describe("temporary Instant connector profile", () => {
  type Profile = {
    composerReady: boolean;
    draftPresent: boolean;
    temporary: boolean;
    personalized: boolean;
    personalizationReady: boolean;
    instant: boolean;
    modelReady: boolean;
  };
  const regular: Profile = {
    composerReady: true,
    draftPresent: false,
    temporary: false,
    personalized: false,
    personalizationReady: false,
    instant: false,
    modelReady: true,
  };
  const temporary = {
    ...regular,
    temporary: true,
    personalized: true,
    personalizationReady: true,
  };

  function profileRoute(
    initial: Profile = regular,
    afterLoad: Profile = temporary,
    hydrating?: Profile,
  ) {
    const route = devTaskRoute(vi.fn());
    let current = initial;
    let currentUrl = "https://chatgpt.com/";
    let minimum = false;
    let pickerOpens = 0;
    let personalizationOpens = 0;
    let readsDuringHydration = 0;
    const loadURL = vi.fn(async (url: string) => {
      currentUrl = url;
      current = hydrating ?? afterLoad;
    });
    const sendInputEvent = vi.fn(() => {
      minimum = true;
      current = { ...current, instant: true };
    });
    const executeJavaScript = vi.fn(
      async (script: string): Promise<unknown> => {
        if (script === temporaryInstantProfileProbe) {
          if (hydrating && current === hydrating && ++readsDuringHydration > 2)
            current = afterLoad;
          return current;
        }
        if (script === openInstantPowerPickerScript) {
          pickerOpens += 1;
          return true;
        }
        if (script === openTemporaryPersonalizationScript) {
          personalizationOpens += 1;
          return true;
        }
        if (script === selectTemporaryPersonalizationScript) {
          current = { ...current, personalized: true };
          return true;
        }
        if (script === focusInstantPowerSliderScript)
          return { ready: true, atMinimum: minimum };
        throw new Error("Unexpected provider script");
      },
    );
    const surface = {
      isDestroyed: () => false,
      loadURL,
      webContents: {
        executeJavaScript,
        sendInputEvent,
        getURL: () => currentUrl,
      },
    };
    Reflect.set(route, "routeWindow", surface);
    const prepare = Reflect.get(route, "prepareTemporaryInstantProfile") as (
      candidate: typeof surface,
    ) => Promise<string | null>;
    return {
      prepare: () => prepare.call(route, surface),
      loadURL,
      sendInputEvent,
      executeJavaScript,
      pickerOpens: () => pickerOpens,
      personalizationOpens: () => personalizationOpens,
      close: () => Reflect.set(route, "routeWindow", null),
      navigate: (url?: string) => {
        if (url !== undefined) currentUrl = url;
        Reflect.set(
          route,
          "routeDocumentGeneration",
          Number(Reflect.get(route, "routeDocumentGeneration")) + 1,
        );
      },
    };
  }

  it("opens a fresh temporary chat and actively lowers the model before continuing", async () => {
    const route = profileRoute();
    await expect(route.prepare()).resolves.toBeNull();
    expect(route.loadURL).toHaveBeenCalledWith(
      "https://chatgpt.com/?temporary-chat=true",
    );
    expect(route.sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "Left",
    });
    expect(route.pickerOpens()).toBe(1);
    expect(route.sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "Escape",
    });
  });

  it("waits for the opened model picker to expose its slider before changing the model", async () => {
    const route = profileRoute();
    const execute = route.executeJavaScript.getMockImplementation()!;
    let sliderReads = 0;
    route.executeJavaScript.mockImplementation(async (script: string) => {
      if (script === focusInstantPowerSliderScript && ++sliderReads <= 2) {
        expect(route.sendInputEvent).not.toHaveBeenCalled();
        return { ready: false };
      }
      return execute(script);
    });
    await expect(route.prepare()).resolves.toBeNull();
    expect(sliderReads).toBeGreaterThan(2);
    expect(route.pickerOpens()).toBe(1);
    expect(route.sendInputEvent).toHaveBeenCalledWith({
      type: "keyDown",
      keyCode: "Left",
    });
  });

  it("stops waiting for an unavailable picker without typing or reopening it", async () => {
    const route = profileRoute();
    const execute = route.executeJavaScript.getMockImplementation()!;
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    route.executeJavaScript.mockImplementation(async (script: string) =>
      script === focusInstantPowerSliderScript
        ? { ready: false }
        : execute(script),
    );
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_INSTANT_MODEL_REQUIRED",
    );
    expect(route.pickerOpens()).toBe(1);
    expect(route.sendInputEvent).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognized slider response without a readiness retry", async () => {
    const route = profileRoute();
    const execute = route.executeJavaScript.getMockImplementation()!;
    let sliderReads = 0;
    route.executeJavaScript.mockImplementation(async (script: string) => {
      if (script === focusInstantPowerSliderScript) {
        sliderReads += 1;
        return { ready: "unknown" };
      }
      return execute(script);
    });
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_INSTANT_MODEL_REQUIRED",
    );
    expect(sliderReads).toBe(1);
    expect(route.pickerOpens()).toBe(1);
    expect(route.sendInputEvent).not.toHaveBeenCalled();
  });

  it("does not act on a replacement route while the picker is rendering", async () => {
    const route = profileRoute();
    const execute = route.executeJavaScript.getMockImplementation()!;
    let sliderReads = 0;
    route.executeJavaScript.mockImplementation(async (script: string) => {
      if (script === focusInstantPowerSliderScript) {
        sliderReads += 1;
        route.close();
        return { ready: false };
      }
      return execute(script);
    });
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_INSTANT_MODEL_REQUIRED",
    );
    expect(sliderReads).toBe(1);
    expect(route.sendInputEvent).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://chatgpt.com/c/other"])(
    "does not press model keys if the same surface document navigates while probing (%s)",
    async (url) => {
      const route = profileRoute();
      const execute = route.executeJavaScript.getMockImplementation()!;
      let sliderReads = 0;
      route.executeJavaScript.mockImplementation(async (script: string) => {
        if (script === focusInstantPowerSliderScript) {
          sliderReads += 1;
          if (sliderReads === 1) return { ready: false };
          route.navigate(url);
          return { ready: true, atMinimum: false };
        }
        return execute(script);
      });
      await expect(route.prepare()).resolves.toBe(
        "CHATGPT_INSTANT_MODEL_REQUIRED",
      );
      expect(sliderReads).toBe(2);
      expect(route.pickerOpens()).toBe(1);
      expect(route.sendInputEvent).not.toHaveBeenCalled();
    },
  );

  it("still requires the visible Instant label after reaching the slider minimum", async () => {
    const route = profileRoute();
    const execute = route.executeJavaScript.getMockImplementation()!;
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    route.executeJavaScript.mockImplementation(async (script: string) => {
      const result = await execute(script);
      return script === temporaryInstantProfileProbe &&
        typeof result === "object" &&
        result !== null
        ? { ...result, instant: false }
        : result;
    });
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_INSTANT_MODEL_REQUIRED",
    );
    expect(route.pickerOpens()).toBe(1);
  });

  it("preserves an owner draft before any profile navigation", async () => {
    const route = profileRoute({ ...regular, draftPresent: true });
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_COMPOSER_DRAFT_PRESENT",
    );
    expect(route.loadURL).not.toHaveBeenCalled();
  });

  it("selects Personalized so the approved app is available in temporary chat", async () => {
    const route = profileRoute(regular, { ...temporary, personalized: false });
    await expect(route.prepare()).resolves.toBeNull();
    expect(route.personalizationOpens()).toBe(1);
  });

  it("waits for the temporary chat controls to hydrate before choosing the model", async () => {
    const loading = {
      ...temporary,
      personalized: false,
      personalizationReady: false,
      modelReady: false,
    };
    const route = profileRoute(regular, temporary, loading);
    await expect(route.prepare()).resolves.toBeNull();
    expect(route.pickerOpens()).toBe(1);
    expect(route.personalizationOpens()).toBe(0);
  });

  it("recognizes the visible Instant label when hidden button text describes thinking effort", () => {
    class HTMLElement {
      constructor(
        readonly textContent = "",
        readonly innerText = textContent,
        readonly ariaLabel: string | null = null,
      ) {}
      getAttribute(name: string) {
        return name === "aria-label" ? this.ariaLabel : null;
      }
      getBoundingClientRect() {
        return { width: 100, height: 32 };
      }
      getClientRects() {
        return [1];
      }
    }
    class HTMLTextAreaElement extends HTMLElement {
      value = "";
    }
    const composer = new HTMLTextAreaElement();
    const controls = [
      new HTMLElement("", "", "Turn off temporary chat"),
      new HTMLElement("Personalized"),
      new HTMLElement(
        "Thinking effortInstant",
        "Instant",
        "Select ChatGPT model",
      ),
    ];
    const result = vm.runInNewContext(temporaryInstantProfileProbe, {
      document: {
        querySelector: (selector: string) =>
          selector === "#prompt-textarea" ? composer : null,
        querySelectorAll: () => controls,
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      location: { href: "https://chatgpt.com/?temporary-chat=true" },
      HTMLElement,
      HTMLTextAreaElement,
      URL,
    });
    expect(result).toMatchObject({
      composerReady: true,
      temporary: true,
      personalized: true,
      instant: true,
    });
  });

  it("fails closed when ChatGPT does not confirm temporary mode", async () => {
    const route = profileRoute(regular, regular);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(13_000);
    await expect(route.prepare()).resolves.toBe(
      "CHATGPT_TEMPORARY_CHAT_REQUIRED",
    );
    expect(route.sendInputEvent).not.toHaveBeenCalled();
  });

  it("checks the active profile again in the send script before clicking", () => {
    let sends = 0;
    class HTMLElement {
      getClientRects() {
        return [1];
      }
      getAttribute() {
        return null;
      }
      click() {
        sends += 1;
      }
    }
    const button = new HTMLElement();
    const context = vm.createContext({
      location: { href: "https://chatgpt.com/" },
      document: { querySelectorAll: () => [button] },
      HTMLElement,
      URL,
    });
    expect(
      vm.runInContext(
        activateTaskScript("https://chatgpt.com/", undefined, true),
        context,
      ),
    ).toEqual({ profileLost: true });
    expect(sends).toBe(0);
  });
});

it("correlates an app-bound reply when ChatGPT renders the selected app before the prompt", () => {
  class HTMLElement {
    constructor(
      readonly role: string,
      readonly id: string,
      readonly textContent: string,
      readonly innerText = textContent,
    ) {}
    getAttribute(name: string) {
      return name === "data-message-author-role"
        ? this.role
        : name === "data-message-id"
          ? this.id
          : null;
    }
    closest(selector: string) {
      return selector === "[data-message-id]" ? this : null;
    }
    getBoundingClientRect() {
      return { width: 100, height: 32 };
    }
  }
  const user = new HTMLElement("user", "user-1", "Farol Dev  Check once.");
  const assistant = new HTMLElement("assistant", "assistant-1", "ok");
  const send = new HTMLElement("button", "send", "");
  const document = {
    querySelector: (selector: string) =>
      selector === 'button[aria-label="Send"]' ? send : null,
    querySelectorAll: (selector: string) =>
      selector.includes('data-message-author-role="user"') &&
      selector.includes('data-message-author-role="assistant"')
        ? [user, assistant]
        : selector === '[data-message-author-role="user"]'
          ? [user]
          : [],
  };
  const context = {
    document,
    HTMLElement,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  expect(
    vm.runInNewContext(
      taskProbeScript("Check once.", [], undefined, "Farol Dev"),
      context,
    ),
  ).toMatchObject({
    turnUserId: "user-1",
    turnAssistantId: "assistant-1",
    assistantText: "ok",
  });
  expect(
    vm.runInNewContext(
      taskProbeScript("Different prompt.", [], undefined, "Farol Dev"),
      context,
    ),
  ).toMatchObject({ turnUserId: null, turnAssistantId: null });
});

it("stops the initial sidebar collapse after ChatGPT exposes Show sidebar", () => {
  let tick: (() => void) | null = null;
  let collapsed = false;
  let clicks = 0;
  let clears = 0;
  const control = {
    disabled: false,
    getAttribute: (name: string) =>
      name === "aria-label"
        ? collapsed
          ? "Show sidebar"
          : "Hide sidebar"
        : null,
    getClientRects: () => [1],
    click: () => {
      collapsed = true;
      clicks += 1;
    },
  };
  vm.runInNewContext(collapseChatGptSidebarScript(), {
    document: {
      querySelectorAll: () => [control],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      clears += 1;
    },
    Date,
    Set,
  });
  expect(tick).not.toBeNull();
  tick!();
  expect(clicks).toBe(1);
  tick!();
  expect(clears).toBe(1);
});

it.each([false, true])(
  "cancels pending default collapse when the owner toggles (initial collapse=%s)",
  (initialCollapse) => {
    let tick: (() => void) | null = null;
    let collapsed = false;
    let clicks = 0;
    let now = 1000;
    const control = {
      disabled: false,
      getAttribute: (name: string) =>
        name === "aria-label"
          ? collapsed
            ? "Open sidebar"
            : "Close sidebar"
          : null,
      getClientRects: () => [1],
      click: () => {
        collapsed = !collapsed;
        clicks += 1;
      },
    };
    const context = vm.createContext({
      document: {
        querySelectorAll: () => [control],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      setInterval: (callback: () => void) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
      Date: { now: () => now },
      Set,
    });
    vm.runInContext(collapseChatGptSidebarScript(), context);
    if (initialCollapse) {
      tick!();
      expect(clicks).toBe(1);
    }
    now = 1020;
    expect(vm.runInContext(toggleChatGptSidebarScript, context)).toBe(true);
    const ownerChoice = collapsed;
    const afterOwnerClicks = clicks;
    expect(tick).toBeNull();
    now = 1500;
    (tick as (() => void) | null)?.();
    expect(collapsed).toBe(ownerChoice);
    expect(clicks).toBe(afterOwnerClicks);
  },
);

it("stops delayed hydration collapse on trusted owner input", () => {
  let tick: (() => void) | null = null;
  let pointer: ((event: { isTrusted: boolean }) => void) | null = null;
  const remove = vi.fn();
  vm.runInNewContext(collapseChatGptSidebarScript(), {
    document: {
      querySelectorAll: () => [],
      addEventListener: (_name: string, listener: typeof pointer) => {
        pointer = listener;
      },
      removeEventListener: remove,
    },
    setInterval: (callback: () => void) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    Date,
    Set,
  });
  pointer!({ isTrusted: false });
  expect(tick).not.toBeNull();
  pointer!({ isTrusted: true });
  expect(tick).toBeNull();
  expect(remove).toHaveBeenCalledWith("pointerdown", pointer, true);
});

it("toggles the provider sidebar through its own visible control", () => {
  let clicks = 0;
  const button = {
    disabled: false,
    getAttribute: (name: string) =>
      name === "aria-label" ? "Show sidebar" : null,
    getClientRects: () => [1],
    click: () => {
      clicks += 1;
    },
  };
  expect(
    vm.runInNewContext(toggleChatGptSidebarScript, {
      document: { querySelectorAll: () => [button] },
      Set,
    }),
  ).toBe(true);
  expect(clicks).toBe(1);
});

const attachment: StagedChatGptAttachment = {
  name: "evidence.md",
  mimeType: "text/markdown",
  bytes: 8,
  sha256: "a".repeat(64),
  stagedPath: "/private/tmp/evidence.md",
};

function route(
  options: Pick<ChatGptRouteOptions, "onUpdateAdmissionDiagnostic"> = {},
): ChatGptRoute {
  return new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
    ...options,
  });
}

function routedExecutor(
  executeJavaScript: ReturnType<typeof vi.fn>,
  activity: unknown,
) {
  return vi.fn((script: string, userGesture: boolean) => {
    if (script.includes("return { composerVisible: composer, signInVisible:"))
      return Promise.resolve({ composerVisible: true, signInVisible: false });
    if (script.includes("const running = [")) return Promise.resolve(activity);
    return Reflect.apply(executeJavaScript as unknown as Function, undefined, [
      script,
      userGesture,
    ]);
  });
}

function taskRoute(
  executeJavaScript: ReturnType<typeof vi.fn>,
  activity: unknown = { running: false },
): ChatGptRoute {
  const candidate = route();
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  Reflect.set(candidate, "load", "loaded");
  Reflect.set(candidate, "routeWindow", {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: routedExecutor(executeJavaScript, activity),
      getURL: () => "https://chatgpt.com/",
    },
  });
  return candidate;
}

function devTaskRoute(
  executeJavaScript: ReturnType<typeof vi.fn>,
  activity: unknown = { running: false },
): ChatGptRoute {
  const candidate = new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
    requiredAppName: "Farol DEV",
  });
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  Reflect.set(candidate, "load", "loaded");
  Reflect.set(candidate, "routeWindow", {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: routedExecutor(executeJavaScript, activity),
      getURL: () => "https://chatgpt.com/",
    },
  });
  return candidate;
}

function streamingTaskRoute(
  executeJavaScript: ReturnType<typeof vi.fn>,
  taskTimeoutMs = 1_000,
  activity: unknown = { running: false },
  publicOutputProfile?: "message-anchors-v1",
): ChatGptRoute {
  const candidate = new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
    taskPollMs: 1,
    taskTimeoutMs,
    ...(publicOutputProfile ? { publicOutputProfile } : {}),
  });
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  Reflect.set(candidate, "load", "loaded");
  Reflect.set(candidate, "routeWindow", {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: routedExecutor(executeJavaScript, activity),
      getURL: () => "https://chatgpt.com/",
    },
  });
  return candidate;
}

function harden(
  routeCandidate: ChatGptRoute,
  sharedSession: EventEmitter,
): void {
  const hardenSession = Reflect.get(routeCandidate, "hardenSession") as (
    this: ChatGptRoute,
    routeSession: EventEmitter,
  ) => void;
  hardenSession.call(routeCandidate, sharedSession);
  Reflect.set(routeCandidate, "routeSession", sharedSession);
}

function embeddedSurface() {
  let url = "about:blank";
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
  });
  const closing = new Set<() => void>();
  const closed = new Set<() => void>();
  return {
    kind: "embedded" as const,
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (nextUrl: string) => {
      url = nextUrl;
    }),
    hide: vi.fn(),
    reveal: vi.fn(),
    focus: vi.fn(),
    setTitle: vi.fn(),
    destroy: vi.fn(() => {
      for (const listener of closing) listener();
      for (const listener of closed) listener();
    }),
    onPageTitleUpdated: vi.fn(),
    onClosing: vi.fn((listener: () => void) => closing.add(listener)),
    onClosed: vi.fn((listener: () => void) => closed.add(listener)),
  };
}

beforeEach(() => {
  const routeSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  });
  electronMock.fromPartition.mockReset();
  electronMock.fromPartition.mockReturnValue(routeSession);
  attachmentMock.upload.mockReset();
  attachmentMock.upload.mockResolvedValue({ status: "ready" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installed-update browser admission", () => {
  it.each(["open", "retry", "sign-in"])(
    "reserves an unopened route against %s until update admission releases",
    async (entry) => {
      const diagnostics =
        vi.fn<(diagnostic: ChatGptUpdateAdmissionDiagnostic) => void>();
      const candidate = route({ onUpdateAdmissionDiagnostic: diagnostics });
      const createSurface = vi.fn(async () => ({ status: "opened" as const }));
      Reflect.set(candidate, "openRouteWindow", createSurface);
      const admission = await candidate.acquireUpdateIdle();
      expect(admission.ok).toBe(true);
      if (!admission.ok) throw new Error(admission.code);
      expect(await admission.recheck()).toEqual({ ok: true });
      expect(diagnostics).not.toHaveBeenCalled();
      // Simulate the durable dispatch write yielding after its final recheck.
      await Promise.resolve();
      const open = () =>
        entry === "retry"
          ? candidate.retryFailedOpen()
          : entry === "sign-in"
            ? candidate.openForSignIn("Sign in")
            : candidate.open();
      expect(await open()).toEqual({ status: "unreachable" });
      expect(createSurface).not.toHaveBeenCalled();
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_BUSY",
      });
      expect(diagnostics.mock.calls).toEqual([
        [{ stage: "admission", reason: "busy" }],
      ]);
      await admission.release();
      await admission.release();
      expect(await admission.recheck()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(diagnostics.mock.calls).toEqual([
        [{ stage: "admission", reason: "busy" }],
        [{ stage: "admission", reason: "reservation_lost" }],
      ]);
      expect(await candidate.open()).toEqual({ status: "opened" });
      expect(createSurface).toHaveBeenCalledOnce();
    },
  );
  function updatePage(state = "idle") {
    const diagnostics =
      vi.fn<(diagnostic: ChatGptUpdateAdmissionDiagnostic) => void>();
    const candidate = route({ onUpdateAdmissionDiagnostic: diagnostics });
    const surface = embeddedSurface();
    const execute = vi.fn<() => Promise<unknown>>(async () => ({ state }));
    let attached = false;
    const debuggerClient = Object.assign(new EventEmitter(), {
      isAttached: () => attached,
      attach: vi.fn(() => {
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
        debuggerClient.emit("detach", {}, "target_closed");
      }),
      sendCommand: vi.fn(
        async (
          method: string,
          _parameters?: Readonly<{ expression?: string }>,
        ): Promise<unknown> => {
          if (method === "Debugger.pause" || method === "Debugger.resume")
            debuggerClient.emit(
              "message",
              {},
              method === "Debugger.pause"
                ? "Debugger.paused"
                : "Debugger.resumed",
            );
          return method === "Runtime.evaluate"
            ? { result: { type: "object", value: await execute() } }
            : {};
        },
      ),
    });
    Object.assign(surface.webContents, {
      executeJavaScript: execute,
      debugger: debuggerClient,
      isDevToolsOpened: () => false,
    });
    void surface.loadURL("https://chatgpt.com/");
    Reflect.set(candidate, "routeWindow", surface);
    Reflect.set(candidate, "load", "loaded");
    return { candidate, surface, execute, debuggerClient, diagnostics };
  }
  // These fixtures classify local mock outcomes only; they exercise no native
  // debugger, provider page, browser profile, or installed application.
  it.each([
    null,
    {},
    { deadlineAt: "100", canStartEffect: () => true },
    { deadlineAt: Number.NaN, canStartEffect: () => true },
    { deadlineAt: Number.POSITIVE_INFINITY, canStartEffect: () => true },
    { deadlineAt: 100, canStartEffect: true },
  ])(
    "rejects malformed host-only Quit guards %# before any browser effect",
    async (guard) => {
      const { candidate, execute, debuggerClient, diagnostics } = updatePage();
      expect(
        await candidate.acquireUpdateIdle(
          guard as ChatGptUpdateIdleEffectGuard,
        ),
      ).toEqual({ ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" });
      expect(diagnostics.mock.calls).toEqual([
        [{ stage: "admission", reason: "guard_invalid" }],
      ]);
      expect(execute).not.toHaveBeenCalled();
      expect(debuggerClient.attach).not.toHaveBeenCalled();
      expect(debuggerClient.sendCommand).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "revoked", "throws", "expires_in_callback"] as const)(
    "honors a %s Quit guard even without an open surface",
    async (failure) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const candidate = route();
        const deadlineAt = 100;
        const guard = {
          deadlineAt,
          canStartEffect: () => {
            if (failure === "throws") throw new Error("private host state");
            if (failure === "expires_in_callback") vi.setSystemTime(deadlineAt);
            return failure !== "revoked";
          },
        };
        if (failure === "expired") vi.setSystemTime(deadlineAt);
        expect(await candidate.acquireUpdateIdle(guard)).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        expect(Reflect.get(candidate, "updateAdmission")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["deadline", "host"] as const)(
    "rechecks the original %s guard on an unopened reservation and allows cleanup",
    async (failure) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const candidate = route();
        let allowed = true;
        const guard = { deadlineAt: 100, canStartEffect: () => allowed };
        const admission = await candidate.acquireUpdateIdle(guard);
        if (!admission.ok) throw new Error(admission.code);
        expect(await admission.recheck()).toEqual({ ok: true });
        // Changing the caller's object cannot renew the original budget.
        guard.deadlineAt = 10_000;
        if (failure === "deadline") vi.setSystemTime(100);
        else allowed = false;
        expect(await admission.recheck()).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        await admission.release();
        await admission.release();
        expect(Reflect.get(candidate, "updateAdmission")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["probe", "enable", "pause"] as const)(
    "bounds a lost %s reply by the original Quit deadline and fences its late continuation",
    async (stage) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const { candidate, execute, debuggerClient, surface } = updatePage();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        let finish: ((value: unknown) => void) | undefined;
        const lost = () =>
          new Promise<unknown>((resolve) => {
            finish = resolve;
          });
        if (stage === "probe") execute.mockImplementation(lost);
        else
          debuggerClient.sendCommand.mockImplementation(
            async (method, parameters) => {
              if (
                method ===
                (stage === "enable" ? "Debugger.enable" : "Debugger.pause")
              )
                return lost();
              return original(method, parameters);
            },
          );
        const pending = candidate.acquireUpdateIdle({
          deadlineAt: 100,
          canStartEffect: () => true,
        });
        await vi.advanceTimersByTimeAsync(99);
        expect(finish).toBeDefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        if (stage === "probe")
          expect(debuggerClient.attach).not.toHaveBeenCalled();
        else expect(debuggerClient.detach).toHaveBeenCalledOnce();
        const commands = debuggerClient.sendCommand.mock.calls.length;
        finish?.({ state: "idle" });
        await vi.advanceTimersByTimeAsync(1);
        expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(commands);
        if (stage === "enable")
          expect(debuggerClient.sendCommand).not.toHaveBeenCalledWith(
            "Debugger.pause",
          );
        expect(
          debuggerClient.sendCommand.mock.calls.filter(
            ([m]) => m === "Runtime.evaluate",
          ),
        ).toHaveLength(0);
        expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "probe",
    "attach",
    "enable",
    "pause",
    "quiet_pause",
    "paused_probe",
  ] as const)(
    "rechecks expiry at the actual %s boundary without starting the next command",
    async (stage) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const { candidate, execute, debuggerClient } = updatePage();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        const expires = () => vi.setSystemTime(100);
        if (stage === "probe")
          execute.mockImplementationOnce(async () => {
            expires();
            return { state: "idle" };
          });
        if (stage === "attach") {
          const attach = debuggerClient.attach.getMockImplementation()!;
          debuggerClient.attach.mockImplementation(() => {
            attach();
            expires();
          });
        }
        debuggerClient.sendCommand.mockImplementation(
          async (method, parameters) => {
            if (stage === "quiet_pause" && method === "Debugger.pause") {
              expires();
              return {};
            }
            const reply = await original(method, parameters);
            if (
              (stage === "enable" && method === "Debugger.enable") ||
              (stage === "pause" && method === "Debugger.pause") ||
              (stage === "paused_probe" && method === "Runtime.evaluate")
            )
              expires();
            return reply;
          },
        );
        expect(
          await candidate.acquireUpdateIdle({
            deadlineAt: 100,
            canStartEffect: () => true,
          }),
        ).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        const commands = debuggerClient.sendCommand.mock.calls.map(([m]) => m);
        const expected =
          stage === "probe" || stage === "attach"
            ? []
            : stage === "enable"
              ? ["Debugger.enable"]
              : stage === "paused_probe"
                ? [
                    "Debugger.enable",
                    "Debugger.pause",
                    "Runtime.evaluate",
                    "Debugger.resume",
                  ]
                : ["Debugger.enable", "Debugger.pause"];
        expect(commands).toEqual(expected);
        if (stage === "probe")
          expect(debuggerClient.attach).not.toHaveBeenCalled();
        else expect(debuggerClient.detach).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["probe", "before_attach", "attach", "enable", "pause"] as const)(
    "fences a revoked host admission at %s before the next effect",
    async (stage) => {
      const { candidate, execute, debuggerClient, surface } = updatePage();
      let allowed = true;
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      if (stage === "probe")
        execute.mockImplementationOnce(async () => {
          allowed = false;
          return { state: "idle" };
        });
      if (stage === "before_attach")
        Object.assign(surface.webContents, {
          isDevToolsOpened: () => {
            allowed = false;
            return false;
          },
        });
      if (stage === "attach") {
        const attach = debuggerClient.attach.getMockImplementation()!;
        debuggerClient.attach.mockImplementation(() => {
          attach();
          allowed = false;
        });
      }
      debuggerClient.sendCommand.mockImplementation(
        async (method, parameters) => {
          const reply = await original(method, parameters);
          if (
            (stage === "enable" && method === "Debugger.enable") ||
            (stage === "pause" && method === "Debugger.pause")
          )
            allowed = false;
          return reply;
        },
      );
      expect(
        await candidate.acquireUpdateIdle({
          deadlineAt: Date.now() + 10_000,
          canStartEffect: () => allowed,
        }),
      ).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(debuggerClient.sendCommand.mock.calls.map(([m]) => m)).toEqual(
        stage === "enable"
          ? ["Debugger.enable"]
          : stage === "pause"
            ? ["Debugger.enable", "Debugger.pause"]
            : [],
      );
      if (stage === "probe" || stage === "before_attach")
        expect(debuggerClient.attach).not.toHaveBeenCalled();
      else expect(debuggerClient.detach).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "invalidates a timed-out pause before failed detach, fencing a late reply (guard=%s)",
    async (guarded) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const { candidate, debuggerClient, surface } = updatePage();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        let finish: ((value: unknown) => void) | undefined;
        debuggerClient.sendCommand.mockImplementation(
          async (method, parameters) =>
            method === "Debugger.pause"
              ? new Promise((resolve) => {
                  finish = resolve;
                })
              : original(method, parameters),
        );
        debuggerClient.detach.mockImplementation(() => {
          throw new Error("fixture detach failed");
        });
        const pending = candidate.acquireUpdateIdle(
          guarded
            ? { deadlineAt: 10_000, canStartEffect: () => true }
            : undefined,
        );
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
        });
        const commands = debuggerClient.sendCommand.mock.calls.length;
        finish?.({});
        await vi.advanceTimersByTimeAsync(1);
        expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(commands);
        expect(debuggerClient.sendCommand.mock.calls.map(([m]) => m)).toEqual([
          "Debugger.enable",
          "Debugger.pause",
        ]);
        expect(debuggerClient.detach).toHaveBeenCalledOnce();
        expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
        expect(await candidate.open()).toEqual({ status: "unreachable" });
        expect(await candidate.acquireUpdateIdle()).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_BUSY",
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds a later held recheck by the remaining original Quit deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { candidate, debuggerClient } = updatePage();
      const admission = await candidate.acquireUpdateIdle({
        deadlineAt: 100,
        canStartEffect: () => true,
      });
      if (!admission.ok) throw new Error(admission.code);
      vi.setSystemTime(80);
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      let finish: ((value: unknown) => void) | undefined;
      debuggerClient.sendCommand.mockImplementation(
        async (method, parameters) =>
          method === "Runtime.evaluate"
            ? new Promise((resolve) => {
                finish = resolve;
              })
            : original(method, parameters),
      );
      let settled = false;
      const pending = admission.recheck().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      const commands = debuggerClient.sendCommand.mock.calls.length;
      finish?.({ result: { type: "object", value: { state: "idle" } } });
      await vi.advanceTimersByTimeAsync(1);
      expect(await admission.recheck()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(debuggerClient.sendCommand).toHaveBeenCalledTimes(commands);
      await admission.release();
      await admission.release();
      expect(debuggerClient.detach).toHaveBeenCalledOnce();
      expect(
        debuggerClient.sendCommand.mock.calls.filter(
          ([m]) => m === "Debugger.resume",
        ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the remaining original budget across DOM, enable and pause stages", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { candidate, execute, debuggerClient } = updatePage();
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      execute.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ state: "idle" }), 40);
          }),
      );
      debuggerClient.sendCommand.mockImplementation(
        async (method, parameters) => {
          if (method === "Debugger.enable")
            await new Promise((resolve) => setTimeout(resolve, 40));
          if (method === "Debugger.pause") return new Promise(() => {});
          return original(method, parameters);
        },
      );
      let settled = false;
      const pending = candidate
        .acquireUpdateIdle({ deadlineAt: 100, canStartEffect: () => true })
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      expect(debuggerClient.sendCommand).toHaveBeenCalledWith("Debugger.pause");
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(debuggerClient.detach).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["deadline", "host"] as const)(
    "refuses a held pause after %s invalidation and still resumes/detaches exactly once",
    async (failure) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const { candidate, debuggerClient, surface } = updatePage();
        let allowed = true;
        const admission = await candidate.acquireUpdateIdle({
          deadlineAt: 100,
          canStartEffect: () => allowed,
        });
        if (!admission.ok) throw new Error(admission.code);
        if (failure === "deadline") vi.setSystemTime(100);
        else allowed = false;
        debuggerClient.sendCommand.mockClear();
        expect(await admission.recheck()).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        expect(debuggerClient.sendCommand).not.toHaveBeenCalled();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        debuggerClient.sendCommand.mockImplementation(
          async (method, parameters) => {
            if (method === "Debugger.resume")
              await new Promise((resolve) => setTimeout(resolve, 500));
            return original(method, parameters);
          },
        );
        const first = admission.release();
        expect(admission.release()).toBe(first);
        await vi.advanceTimersByTimeAsync(500);
        await first;
        expect(debuggerClient.sendCommand.mock.calls.map(([m]) => m)).toEqual([
          "Debugger.resume",
        ]);
        expect(debuggerClient.detach).toHaveBeenCalledOnce();
        expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps a lost cleanup reply release-unconfirmed after Quit expiry without replay", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const { candidate, debuggerClient, surface } = updatePage();
      const admission = await candidate.acquireUpdateIdle({
        deadlineAt: 100,
        canStartEffect: () => true,
      });
      if (!admission.ok) throw new Error(admission.code);
      vi.setSystemTime(100);
      debuggerClient.sendCommand.mockClear();
      let finish: ((value: unknown) => void) | undefined;
      debuggerClient.sendCommand.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const first = admission.release();
      const rejected = expect(first).rejects.toThrow(
        "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
      );
      expect(admission.release()).toBe(first);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      finish?.({});
      debuggerClient.emit("message", {}, "Debugger.resumed");
      await vi.advanceTimersByTimeAsync(1);
      await expect(admission.release()).rejects.toThrow(
        "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
      );
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_BUSY",
      });
      expect(await candidate.open()).toEqual({ status: "unreachable" });
      expect(debuggerClient.sendCommand.mock.calls.map(([m]) => m)).toEqual([
        "Debugger.resume",
      ]);
      expect(debuggerClient.detach).not.toHaveBeenCalled();
      expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["not_embedded", "not_loaded", "url_unrecognized"] as const)(
    "reports initial surface/document refusal %s without page content",
    async (reason) => {
      const { candidate, surface, execute, diagnostics } = updatePage();
      if (reason === "not_embedded") Reflect.set(surface, "kind", "window");
      if (reason === "not_loaded") Reflect.set(candidate, "load", "failed");
      if (reason === "url_unrecognized")
        await surface.loadURL(
          "https://example.invalid/private-chat?token=fixture-secret#private-text",
        );
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(diagnostics.mock.calls).toEqual([
        [
          {
            stage: reason === "not_embedded" ? "surface" : "document",
            reason,
          },
        ],
      ]);
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    "changed",
    "url_changed",
    "not_loaded",
    "surface_changed",
    "destroyed",
  ] as const)(
    "reports document/surface invalidation during a probe (%s)",
    async (reason) => {
      const { candidate, surface, execute, diagnostics } = updatePage();
      execute.mockImplementation(async () => {
        if (reason === "changed")
          Reflect.set(candidate, "routeDocumentGeneration", 1);
        if (reason === "url_changed")
          await surface.loadURL(
            "https://chatgpt.com/c/private-chat?token=fixture-secret",
          );
        if (reason === "not_loaded") Reflect.set(candidate, "load", "loading");
        if (reason === "surface_changed")
          Reflect.set(candidate, "routeWindow", embeddedSurface());
        if (reason === "destroyed") surface.isDestroyed.mockReturnValue(true);
        return { state: "idle" };
      });
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(diagnostics.mock.calls).toEqual([
        [
          {
            stage:
              reason === "surface_changed" || reason === "destroyed"
                ? "surface"
                : "document",
            reason: reason === "surface_changed" ? "changed" : reason,
          },
        ],
      ]);
      expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
    },
  );
  it.each(["probe", "paused_probe"] as const)(
    "distinguishes parse failure, unknown state and thrown %s errors without leaking content",
    async (stage) => {
      for (const reason of ["parse_failed", "unknown", "failed"] as const) {
        const { candidate, execute, debuggerClient, diagnostics } =
          updatePage();
        const observe = async (): Promise<unknown> => {
          if (reason === "failed") {
            const error = new Error("private DOM text / token=fixture-secret");
            Object.defineProperty(error, "message", {
              get: () => {
                throw new Error("must not inspect error text");
              },
            });
            throw error;
          }
          return reason === "unknown"
            ? { state: "unknown" }
            : {
                state: "unexpected-private-text",
                url: "https://chatgpt.com/c/private-chat?token=fixture-secret",
                dom: "private DOM text",
              };
        };
        if (stage === "probe") execute.mockImplementation(observe);
        else {
          const original = debuggerClient.sendCommand.getMockImplementation()!;
          debuggerClient.sendCommand.mockImplementation(async (method) =>
            method === "Runtime.evaluate"
              ? { result: { type: "object", value: await observe() } }
              : original(method),
          );
        }
        expect(await candidate.acquireUpdateIdle()).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        expect(diagnostics.mock.calls).toEqual([[{ stage, reason }]]);
        expect(Object.isFrozen(diagnostics.mock.calls[0]![0])).toBe(true);
        expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(
          /private|secret|https|DOM/u,
        );
        if (stage === "paused_probe")
          expect(debuggerClient.sendCommand).toHaveBeenCalledWith(
            "Debugger.resume",
          );
      }
    },
  );
  it.each([
    "already_attached",
    "devtools_open",
    "attach_failed",
    "enable_failed",
    "pause_failed",
  ] as const)("reports debugger/pause refusal %s once", async (reason) => {
    const { candidate, surface, debuggerClient, diagnostics } = updatePage();
    if (reason === "already_attached") debuggerClient.attach();
    if (reason === "devtools_open")
      Object.assign(surface.webContents, { isDevToolsOpened: () => true });
    if (reason === "attach_failed")
      debuggerClient.attach.mockImplementation(() => {
        throw new Error("fixture-secret");
      });
    if (reason === "enable_failed" || reason === "pause_failed") {
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      debuggerClient.sendCommand.mockImplementation(async (method) => {
        if (
          method ===
          (reason === "enable_failed" ? "Debugger.enable" : "Debugger.pause")
        )
          throw new Error("fixture-secret");
        return original(method);
      });
    }
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(diagnostics.mock.calls).toEqual([
      [
        {
          stage: reason === "pause_failed" ? "pause" : "debugger",
          reason: reason === "pause_failed" ? "failed" : reason,
        },
      ],
    ]);
  });
  it.each(["probe", "paused_probe", "debugger", "pause", "resume"] as const)(
    "classifies %s deadlines without accepting late evidence or replaying release",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const { candidate, execute, debuggerClient, diagnostics, surface } =
          updatePage();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        let finish: ((value: unknown) => void) | undefined;
        const hung = (): Promise<unknown> =>
          new Promise((resolve) => {
            finish = resolve;
          });
        if (stage === "probe") execute.mockImplementation(hung);
        else if (stage !== "resume")
          debuggerClient.sendCommand.mockImplementation(async (method) => {
            if (
              method ===
              (stage === "paused_probe"
                ? "Runtime.evaluate"
                : stage === "debugger"
                  ? "Debugger.enable"
                  : "Debugger.pause")
            )
              return hung();
            return original(method);
          });
        if (stage === "resume") {
          const admission = await candidate.acquireUpdateIdle();
          if (!admission.ok) throw new Error(admission.code);
          debuggerClient.sendCommand.mockImplementation(async (method) =>
            method === "Debugger.resume" ? hung() : original(method),
          );
          const first = admission.release();
          const rejected = expect(first).rejects.toThrow(
            "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
          );
          expect(admission.release()).toBe(first);
          await vi.advanceTimersByTimeAsync(2_001);
          await rejected;
          expect(debuggerClient.detach).not.toHaveBeenCalled();
          expect(surface.webContents.listenerCount("before-input-event")).toBe(
            1,
          );
          expect(await candidate.open()).toEqual({ status: "unreachable" });
        } else {
          const pending = candidate.acquireUpdateIdle();
          await vi.advanceTimersByTimeAsync(2_001);
          expect(await pending).toEqual({
            ok: false,
            code: "UPDATE_BROWSER_STATE_UNKNOWN",
          });
          expect(surface.webContents.listenerCount("before-input-event")).toBe(
            0,
          );
        }
        expect(diagnostics.mock.calls).toEqual([
          [{ stage, reason: "timeout" }],
        ]);
        finish?.({ state: "idle" });
        await vi.advanceTimersByTimeAsync(1);
        expect(diagnostics).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["pause_detach", "held_detach", "held_resume"] as const)(
    "reports only the final cleanup failure (%s) and preserves the input fence",
    async (failure) => {
      const { candidate, debuggerClient, diagnostics, surface } = updatePage();
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      debuggerClient.sendCommand.mockImplementation(async (method) => {
        if (failure === "pause_detach" && method === "Debugger.pause")
          throw new Error("fixture pause failed");
        if (failure !== "pause_detach" && method === "Runtime.evaluate")
          return { privateText: "fixture-secret" };
        if (failure === "held_resume" && method === "Debugger.resume")
          throw new Error("fixture-secret");
        return original(method);
      });
      if (failure !== "held_resume")
        debuggerClient.detach.mockImplementation(() => {
          throw new Error("fixture-secret");
        });
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
      });
      expect(diagnostics.mock.calls).toEqual([
        [
          failure === "held_resume"
            ? { stage: "resume", reason: "failed" }
            : { stage: "release", reason: "detach_failed" },
        ],
      ]);
      expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
      expect(await candidate.open()).toEqual({ status: "unreachable" });
    },
  );
  it("keeps successful acquire/recheck/release quiet and emits one diagnostic per later refusal", async () => {
    const { candidate, debuggerClient, diagnostics } = updatePage();
    const admission = await candidate.acquireUpdateIdle();
    if (!admission.ok) throw new Error(admission.code);
    expect(await admission.recheck()).toEqual({ ok: true });
    expect(diagnostics).not.toHaveBeenCalled();
    debuggerClient.emit("message", {}, "Debugger.resumed");
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(diagnostics.mock.calls).toEqual([
      [{ stage: "pause", reason: "unconfirmed" }],
    ]);
    await admission.release();
    await admission.release();
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(diagnostics.mock.calls[1]).toEqual([
      { stage: "admission", reason: "reservation_lost" },
    ]);
  });
  it("isolates a throwing diagnostic observer from refusal and failed release", async () => {
    const { candidate, execute, debuggerClient, diagnostics, surface } =
      updatePage();
    diagnostics.mockImplementation(() => {
      throw new Error("observer failed");
    });
    execute.mockResolvedValueOnce({ state: "unknown" });
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
    const admission = await candidate.acquireUpdateIdle();
    if (!admission.ok) throw new Error(admission.code);
    debuggerClient.detach.mockImplementation(() => {
      throw new Error("fixture-secret");
    });
    const first = admission.release();
    expect(admission.release()).toBe(first);
    await expect(first).rejects.toThrow("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
    expect(diagnostics.mock.calls).toEqual([
      [{ stage: "probe", reason: "unknown" }],
      [{ stage: "release", reason: "detach_failed" }],
    ]);
    expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
  });
  it("holds an acknowledged page-script pause through update admission and resumes once", async () => {
    const { candidate, surface, debuggerClient, diagnostics } = updatePage();
    const admission = await candidate.acquireUpdateIdle();
    if (!admission.ok) throw new Error(admission.code);
    expect(debuggerClient.sendCommand).toHaveBeenCalledWith("Debugger.pause");
    expect(debuggerClient.isAttached()).toBe(true);
    expect(await admission.recheck()).toEqual({ ok: true });
    const first = admission.release();
    const second = admission.release();
    expect(second).toBe(first);
    await first;
    expect(
      debuggerClient.sendCommand.mock.calls.filter(
        ([m]) => m === "Debugger.resume",
      ),
    ).toHaveLength(1);
    expect(debuggerClient.detach).toHaveBeenCalledOnce();
    expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
    expect(await candidate.open()).toEqual({ status: "opened" });
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it("triggers a quiet page and waits for the actual delayed pause, not a command acknowledgment", async () => {
    vi.useFakeTimers();
    try {
      const { candidate, debuggerClient } = updatePage();
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      let finishTrigger: (() => void) | undefined;
      debuggerClient.sendCommand.mockImplementation(
        async (method, parameters) => {
          if (method === "Debugger.pause") return {};
          if (
            method === "Runtime.evaluate" &&
            parameters?.expression === "void 0"
          ) {
            setTimeout(
              () => debuggerClient.emit("message", {}, "Debugger.paused"),
              1_500,
            );
            return new Promise((resolve) => {
              finishTrigger = () => resolve({});
            });
          }
          if (method === "Debugger.resume") finishTrigger?.();
          return original(method, parameters);
        },
      );
      let settled = false;
      const pending = candidate.acquireUpdateIdle().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);
      expect(debuggerClient.sendCommand).toHaveBeenCalledWith(
        "Runtime.evaluate",
        {
          expression: "void 0",
          returnByValue: true,
        },
      );
      await vi.advanceTimersByTimeAsync(500);
      const admission = await pending;
      if (!admission.ok) throw new Error(admission.code);
      expect(await admission.recheck()).toEqual({ ok: true });
      await admission.release();
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps input fenced until a delayed resume event confirms release", async () => {
    vi.useFakeTimers();
    try {
      const { candidate, debuggerClient, surface } = updatePage();
      const admission = await candidate.acquireUpdateIdle();
      if (!admission.ok) throw new Error(admission.code);
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      debuggerClient.sendCommand.mockImplementation(
        async (method, parameters) => {
          if (method === "Debugger.resume") {
            setTimeout(
              () => debuggerClient.emit("message", {}, "Debugger.resumed"),
              1_500,
            );
            return {};
          }
          return original(method, parameters);
        },
      );
      const released = admission.release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await candidate.open()).toEqual({ status: "unreachable" });
      expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
      expect(debuggerClient.detach).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await released;
      expect(await candidate.open()).toEqual({ status: "opened" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not detach twice while its successful detach event is still pending", async () => {
    const { candidate, debuggerClient, surface } = updatePage();
    const original = debuggerClient.sendCommand.getMockImplementation()!;
    debuggerClient.sendCommand.mockImplementation(
      async (method, parameters) => {
        if (method === "Debugger.pause")
          throw new Error("fixture pause failed");
        return original(method, parameters);
      },
    );
    debuggerClient.detach.mockImplementation(() => {
      queueMicrotask(() => debuggerClient.emit("detach", {}, "target_closed"));
    });
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(debuggerClient.detach).toHaveBeenCalledOnce();
    expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
  });
  it("classifies failed owned detach and preserves its fence without replay", async () => {
    const { candidate, debuggerClient, surface } = updatePage();
    const original = debuggerClient.sendCommand.getMockImplementation()!;
    debuggerClient.sendCommand.mockImplementation(
      async (method, parameters) => {
        if (method === "Debugger.pause")
          throw new Error("fixture pause failed");
        return original(method, parameters);
      },
    );
    debuggerClient.detach.mockImplementation(() => {
      throw new Error("fixture detach unconfirmed");
    });
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(await candidate.open()).toEqual({ status: "unreachable" });
    await candidate.acquireUpdateIdle();
    expect(debuggerClient.detach).toHaveBeenCalledOnce();
    expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
  });
  it("disconnects its owned session if pause executes before its command rejects", async () => {
    const { candidate, debuggerClient, surface } = updatePage();
    const original = debuggerClient.sendCommand.getMockImplementation()!;
    debuggerClient.sendCommand.mockImplementation(
      async (method, parameters) => {
        if (method === "Debugger.pause") {
          debuggerClient.emit("message", {}, "Debugger.paused");
          throw new Error("fixture late pause command failure");
        }
        return original(method, parameters);
      },
    );
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(debuggerClient.detach).toHaveBeenCalledOnce();
    expect(debuggerClient.sendCommand).not.toHaveBeenCalledWith(
      "Debugger.resume",
    );
    expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
  });
  it.each(["Debugger.resumed", "detach"])(
    "rejects loss of page-script pause via %s",
    async (event) => {
      const { candidate, debuggerClient } = updatePage();
      const admission = await candidate.acquireUpdateIdle();
      if (!admission.ok) throw new Error(admission.code);
      if (event === "detach") debuggerClient.detach();
      else debuggerClient.emit("message", {}, event);
      expect(await admission.recheck()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      await admission.release();
    },
  );
  it("does not take over an already attached page debugger", async () => {
    const { candidate, debuggerClient } = updatePage();
    debuggerClient.attach();
    debuggerClient.attach.mockClear();
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(debuggerClient.attach).not.toHaveBeenCalled();
    expect(debuggerClient.detach).not.toHaveBeenCalled();
    expect(debuggerClient.sendCommand).not.toHaveBeenCalled();
  });
  it("refuses an open DevTools session without attaching or detaching", async () => {
    const { candidate, debuggerClient, surface } = updatePage();
    Object.assign(surface.webContents, { isDevToolsOpened: () => true });
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(debuggerClient.attach).not.toHaveBeenCalled();
    expect(debuggerClient.detach).not.toHaveBeenCalled();
    expect(debuggerClient.sendCommand).not.toHaveBeenCalled();
  });
  it.each(["missing-event", "hung-command"])(
    "refuses an unacknowledged pause (%s) and disconnects only its owned session",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const { candidate, debuggerClient, surface } = updatePage();
        const original = debuggerClient.sendCommand.getMockImplementation()!;
        debuggerClient.sendCommand.mockImplementation(async (method) => {
          if (method === "Debugger.pause")
            return failure === "hung-command"
              ? new Promise(() => undefined)
              : {};
          return original(method);
        });
        const pending = candidate.acquireUpdateIdle();
        await vi.advanceTimersByTimeAsync(2_001);
        expect(await pending).toEqual({
          ok: false,
          code: "UPDATE_BROWSER_STATE_UNKNOWN",
        });
        expect(debuggerClient.detach).toHaveBeenCalledOnce();
        expect(debuggerClient.sendCommand).not.toHaveBeenCalledWith(
          "Debugger.resume",
        );
        expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
        expect(debuggerClient.listenerCount("message")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each([
    {
      result: { type: "object", value: { state: "idle" } },
      exceptionDetails: {},
    },
    { result: { type: "string", value: "idle" } },
    { result: { type: "object", value: { state: "unexpected" } } },
  ])(
    "rejects malformed inspector idle evidence %# and resumes the page",
    async (reply) => {
      const { candidate, debuggerClient } = updatePage();
      const original = debuggerClient.sendCommand.getMockImplementation()!;
      debuggerClient.sendCommand.mockImplementation(async (method) =>
        method === "Runtime.evaluate" ? reply : original(method),
      );
      expect(await candidate.acquireUpdateIdle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(debuggerClient.sendCommand).toHaveBeenCalledWith(
        "Debugger.resume",
      );
      expect(debuggerClient.detach).toHaveBeenCalledOnce();
    },
  );
  it("retains admission after an unconfirmed resume and never sends another resume", async () => {
    const { candidate, debuggerClient, surface } = updatePage();
    const admission = await candidate.acquireUpdateIdle();
    if (!admission.ok) throw new Error(admission.code);
    const original = debuggerClient.sendCommand.getMockImplementation()!;
    debuggerClient.sendCommand.mockImplementation(async (method) => {
      if (method === "Debugger.resume")
        throw new Error("fixture unconfirmed resume");
      return original(method);
    });
    await expect(admission.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    await expect(admission.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    expect(await candidate.open()).toEqual({ status: "unreachable" });
    expect(
      debuggerClient.sendCommand.mock.calls.filter(
        ([m]) => m === "Debugger.resume",
      ),
    ).toHaveLength(1);
    expect(surface.webContents.listenerCount("before-input-event")).toBe(1);
  });
  it("does not queue ordinary activity probes into the paused renderer", async () => {
    const { candidate, surface, execute } = updatePage();
    const admission = await candidate.acquireUpdateIdle();
    if (!admission.ok) throw new Error(admission.code);
    execute.mockClear();
    const poll = Reflect.get(candidate, "pollTaskActivity") as (
      contents: unknown,
      generation: number,
    ) => Promise<void>;
    await poll.call(
      candidate,
      surface.webContents,
      Reflect.get(candidate, "activityGeneration") as number,
    );
    expect(execute).not.toHaveBeenCalled();
    await admission.release();
  });
  it.each([
    [false, "ordinary"],
    [false, "attachment"],
    [false, "connector"],
    [true, "ordinary"],
    [true, "attachment"],
    [true, "connector"],
  ] as const)(
    "refuses an internal %s/%s submission without disturbing update admission",
    async (opened, task) => {
      const page = updatePage();
      const candidate = opened ? page.candidate : route();
      const open = vi.spyOn(candidate, "open");
      const admission = await candidate.acquireUpdateIdle();
      if (!admission.ok) throw new Error(admission.code);
      expect(await admission.recheck()).toEqual({ ok: true });
      // Dispatch persistence can yield after the final browser observation.
      await Promise.resolve();
      const pending =
        task === "connector"
          ? candidate.runReadonlyTask(
              "fixture check only",
              [],
              { readConnectorReceipt: vi.fn(async () => true) },
              "temporary-instant",
              { name: "Farol" },
            )
          : candidate.runReadonlyTask(
              "fixture task only",
              task === "attachment" ? [attachment] : [],
            );
      expect(await admission.recheck()).toEqual({ ok: true });
      expect(await pending).toMatchObject({
        state: "failed_before_submit",
        code: "CHATGPT_TASK_IN_PROGRESS",
        deltaCount: 0,
        observedCharacters: 0,
      });
      expect(open).not.toHaveBeenCalled();
      expect(attachmentMock.upload).not.toHaveBeenCalled();
      expect(await admission.recheck()).toEqual({ ok: true });
      await admission.release();
      open.mockResolvedValue({ status: "unreachable" });
      expect(await candidate.runReadonlyTask("after release")).toMatchObject({
        state: "failed_before_submit",
        code: "CHATGPT_PAGE_UNREACHABLE",
      });
      expect(open).toHaveBeenCalledOnce();
    },
  );
  it.each([false, true])(
    "keeps an existing turn unknown without starting observation during update admission (opened=%s)",
    async (opened) => {
      const candidate = opened ? updatePage().candidate : route();
      const open = vi.spyOn(candidate, "open");
      const admission = await candidate.acquireUpdateIdle();
      if (!admission.ok) throw new Error(admission.code);
      const pending = candidate.observeReadonlyTask({
        prompt: "fixture existing turn",
        turnUserId: "user-fixture",
        turnAssistantId: "assistant-fixture",
      });
      expect(await admission.recheck()).toEqual({ ok: true });
      expect(await pending).toMatchObject({
        state: "outcome_unknown",
        code: "CHATGPT_TASK_IN_PROGRESS",
        turnUserId: "user-fixture",
        turnAssistantId: "assistant-fixture",
      });
      expect(open).not.toHaveBeenCalled();
      await admission.release();
    },
  );
  it("admits an open browser only after fresh idle proof and holds input until release", async () => {
    const { candidate, surface, execute } = updatePage();
    const admission = await candidate.acquireUpdateIdle();
    expect(admission.ok).toBe(true);
    if (!admission.ok) throw new Error(admission.code);
    const event = { preventDefault: vi.fn() };
    surface.webContents.emit("before-input-event", event);
    surface.webContents.emit("before-mouse-event", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockResolvedValue({ state: "draft" });
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_DRAFT",
    });
    await admission.release();
    surface.webContents.emit("before-input-event", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
  });
  it.each(["running", "draft", "unknown"])(
    "refuses %s and releases its input fence",
    async (state) => {
      const { candidate, surface, diagnostics } = updatePage(state);
      expect((await candidate.acquireUpdateIdle()).ok).toBe(false);
      expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
      expect(diagnostics.mock.calls).toEqual([
        [{ stage: "probe", reason: state }],
      ]);
    },
  );
  it("rejects a navigation during the fresh observation", async () => {
    const { candidate, execute } = updatePage();
    execute.mockImplementation(async () => {
      Reflect.set(candidate, "routeDocumentGeneration", 1);
      return { state: "idle" };
    });
    expect(await candidate.acquireUpdateIdle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
  });
  it("bounds a hung observation and never accepts its late idle reply", async () => {
    vi.useFakeTimers();
    try {
      const { candidate, surface, execute } = updatePage();
      let finish!: (value: { state: string }) => void;
      execute.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = candidate.acquireUpdateIdle();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await pending).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      finish({ state: "idle" });
      await Promise.resolve();
      expect(surface.webContents.listenerCount("before-input-event")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports an open browser surface separately from its fresh idle admission", () => {
    const candidate = route();
    expect(candidate.hasOpenUpdateSurface()).toBe(false);
    const surface = embeddedSurface();
    Reflect.set(candidate, "routeWindow", surface);
    expect(candidate.hasOpenUpdateSurface()).toBe(true);
    surface.isDestroyed.mockReturnValue(true);
    expect(candidate.hasOpenUpdateSurface()).toBe(false);
  });
  it("also refuses an opening surface, in-flight task or live popup", () => {
    const candidate = route();
    Reflect.set(candidate, "opening", new Promise(() => undefined));
    expect(candidate.hasOpenUpdateSurface()).toBe(true);
    Reflect.set(candidate, "opening", null);
    Reflect.set(candidate, "taskInFlight", true);
    expect(candidate.hasOpenUpdateSurface()).toBe(true);
    Reflect.set(candidate, "taskInFlight", false);
    Reflect.set(
      candidate,
      "popupWindows",
      new Set([{ isDestroyed: () => false }]),
    );
    expect(candidate.hasOpenUpdateSurface()).toBe(true);
  });
});

describe("ChatGPT test-window presentation", () => {
  it("preserves ordinary foreground behavior outside an explicit test mode", () => {
    expect(
      resolveChatGptWindowPresentation(undefined, {
        width: 1080,
        height: 760,
      }),
    ).toEqual({ bounds: null, reveal: "show", focus: true });
  });

  it("keeps every hidden-lane route window hidden and unfocused", () => {
    expect(
      resolveChatGptWindowPresentation(
        { mode: "hidden" },
        { width: 720, height: 760 },
      ),
    ).toEqual({ bounds: null, reveal: "remain-hidden", focus: false });
  });

  it("places a visible sign-in or popup exactly before inactive reveal", () => {
    const place = vi.fn(() => ({
      x: -1110,
      y: 530,
      width: 1080,
      height: 760,
    }));

    expect(
      resolveChatGptWindowPresentation(
        { mode: "secondary-visible", place },
        { width: 1080, height: 760 },
      ),
    ).toEqual({
      bounds: { x: -1110, y: 530, width: 1080, height: 760 },
      reveal: "show-inactive",
      focus: false,
    });
    expect(place).toHaveBeenCalledExactlyOnceWith({
      width: 1080,
      height: 760,
    });
  });

  it("rejects a placement adapter that shrinks the requested child viewport", () => {
    expect(() =>
      resolveChatGptWindowPresentation(
        {
          mode: "secondary-visible",
          place: () => ({ x: 0, y: 0, width: 719, height: 760 }),
        },
        { width: 720, height: 760 },
      ),
    ).toThrow("CHATGPT_WINDOW_PLACEMENT_INVALID");
  });

  it("hides a separate route before fail-closed topology re-evaluation", async () => {
    const surface = { ...embeddedSurface(), kind: "window" as const };
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      windowPresentation: {
        mode: "secondary-visible",
        place: () => ({ x: -1080, y: 0, width: 1080, height: 760 }),
      },
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
    });
    await candidate.open();
    surface.hide.mockClear();
    surface.reveal.mockClear();
    surface.reveal.mockImplementationOnce(() => {
      throw new Error("NO_SECONDARY_DISPLAY");
    });

    expect(() => candidate.reconcileWindowPresentation()).not.toThrow();
    expect(surface.hide).toHaveBeenCalledTimes(1);
    expect(surface.reveal).toHaveBeenCalledTimes(1);
  });

  it("keeps a separate hidden-lane route hidden after topology changes", async () => {
    const surface = { ...embeddedSurface(), kind: "window" as const };
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      windowPresentation: { mode: "hidden" },
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
    });
    await candidate.open();
    surface.hide.mockClear();
    surface.reveal.mockClear();

    candidate.reconcileWindowPresentation();

    expect(surface.hide).toHaveBeenCalledTimes(1);
    expect(surface.reveal).not.toHaveBeenCalled();
  });
});

describe("readiness ordering and document identity (local surface fixtures)", () => {
  const ready = { composerVisible: true, signInVisible: false };
  const signedOut = { composerVisible: false, signInVisible: true };
  function readinessRoute() {
    const candidate = route();
    const pending: ((value: unknown) => void)[] = [];
    let currentUrl = "https://chatgpt.com/c/fixture-readiness";
    const execute = vi.fn((script: string, _gesture: boolean) => {
      if (!script.includes("const labelledSignIn"))
        return Promise.reject(new Error("UNEXPECTED_NON_READINESS_EFFECT"));
      return new Promise((resolve) => pending.push(resolve));
    });
    const surface = {
      isDestroyed: () => false,
      webContents: { getURL: () => currentUrl, executeJavaScript: execute },
    };
    Reflect.set(candidate, "routeWindow", surface);
    Reflect.set(candidate, "load", "loaded");
    return {
      candidate,
      pending,
      execute,
      surface,
      setUrl: (url: string) => {
        currentUrl = url;
      },
    };
  }
  it("does not let an older ready answer overwrite a newer sign-in requirement", async () => {
    const { candidate, pending } = readinessRoute();
    const older = candidate.observe();
    const newer = candidate.observe();
    pending[1]!(signedOut);
    await expect(newer).resolves.toMatchObject({
      state: "signed_out",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
    pending[0]!(ready);
    await expect(older).resolves.toMatchObject({
      state: "signed_out",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
  });
  it("accepts a current recovery and does not let an older sign-out override it", async () => {
    const { candidate, pending } = readinessRoute();
    const older = candidate.observe();
    const newer = candidate.observe();
    pending[1]!(ready);
    await expect(newer).resolves.toMatchObject({ state: "authenticated" });
    pending[0]!(signedOut);
    await expect(older).resolves.toMatchObject({ state: "authenticated" });
  });
  it.each([
    "same-URL generation",
    "changed URL",
    "replacement surface",
    "disposed",
  ])("does not use a readiness answer after %s", async (change) => {
    const { candidate, pending, surface, setUrl } = readinessRoute();
    const observation = candidate.observe();
    if (change === "same-URL generation")
      Reflect.set(candidate, "routeDocumentGeneration", 1);
    if (change === "changed URL") setUrl("https://chatgpt.com/c/new-document");
    if (change === "replacement surface")
      Reflect.set(candidate, "routeWindow", { ...surface });
    if (change === "disposed") Reflect.set(candidate, "disposing", true);
    pending[0]!(ready);
    await expect(observation).resolves.toMatchObject({
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
  });
  it("keeps sign-in-required when a newer same-document probe is unrecognized", async () => {
    const { candidate, pending } = readinessRoute();
    const initial = candidate.observe();
    pending[0]!(signedOut);
    await initial;
    const unknown = candidate.observe();
    pending[1]!({ unexpected: true });
    await expect(unknown).resolves.toMatchObject({
      state: "signed_out",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
    const recovered = candidate.observe();
    pending[2]!(ready);
    await expect(recovered).resolves.toMatchObject({ state: "authenticated" });
  });
  it("retains a known sign-in barrier while a newer observation is pending", async () => {
    const { candidate, pending } = readinessRoute();
    const initial = candidate.observe();
    pending[0]!(signedOut);
    await initial;
    const older = candidate.observe();
    const newer = candidate.observe();
    pending[1]!(ready);
    await expect(older).resolves.toMatchObject({
      state: "signed_out",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
    pending[2]!(ready);
    await expect(newer).resolves.toMatchObject({ state: "authenticated" });
  });
  it("does not authorize an old ready observation while a later read is still pending", async () => {
    const { candidate, pending } = readinessRoute();
    const older = candidate.observe();
    const newer = candidate.observe();
    pending[0]!(ready);
    await expect(older).resolves.toMatchObject({ state: "unsupported" });
    pending[1]!(signedOut);
    await expect(newer).resolves.toMatchObject({ state: "signed_out" });
  });
  it.each([
    ["signed out", signedOut, "not_authenticated", "CHATGPT_SIGN_IN_REQUIRED"],
    [
      "unrecognized",
      { unexpected: true },
      "failed_before_submit",
      "CHATGPT_UI_UNRECOGNIZED",
    ],
  ])(
    "refuses Send after a newer %s read during dispatch-intent persistence",
    async (_label, laterRead, state, code) => {
      const candidate = route();
      let page: unknown = ready;
      let sends = 0;
      const execute = vi.fn(async (script: string) => {
        if (script.includes("const labelledSignIn")) return page;
        if (script.includes("const running = [")) return { running: false };
        if (script.includes("const baselineAssistantCount")) return prepared;
        if (script.includes("send.click()")) {
          sends += 1;
          return { activated: true };
        }
        return { invalidFixtureProbe: true };
      });
      Reflect.set(candidate, "routeWindow", {
        isDestroyed: () => false,
        webContents: {
          getURL: () => "https://chatgpt.com/c/fixture-readiness",
          executeJavaScript: execute,
        },
      });
      Reflect.set(candidate, "load", "loaded");
      vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
      const result = await candidate.runReadonlyTask(
        "fixture prompt only",
        [],
        {
          onDispatchIntent: async () => {
            page = laterRead;
            await candidate.observe();
          },
        },
      );
      expect(result).toMatchObject({ state, code });
      expect(sends).toBe(0);
    },
  );
  it("requires scoped readiness even when an overridden observation claims success", async () => {
    const execute = vi.fn().mockResolvedValue(prepared);
    const candidate = taskRoute(execute);
    vi.spyOn(candidate, "observe").mockResolvedValue({
      state: "authenticated",
      code: null,
    });
    await expect(
      candidate.runReadonlyTask("fixture prompt only"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("re-observes the new profile document before preparing its composer", async () => {
    let url = "https://chatgpt.com/c/fixture-document-a";
    const probes: string[] = [];
    const candidate = route();
    const execute = vi.fn(async (script: string) => {
      if (
        script.includes("return { composerVisible: composer, signInVisible:")
      ) {
        probes.push(url);
        return ready;
      }
      if (script.includes("const running = [")) return { running: false };
      if (script.includes("const baselineAssistantCount")) {
        expect(probes).toEqual([
          "https://chatgpt.com/c/fixture-document-a",
          "https://chatgpt.com/?temporary-chat=true",
        ]);
        return { navigated: true };
      }
      throw new Error("UNEXPECTED_EFFECT");
    });
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: { getURL: () => url, executeJavaScript: execute },
    });
    Reflect.set(candidate, "load", "loaded");
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "prepareTemporaryInstantProfile", async () => {
      url = "https://chatgpt.com/?temporary-chat=true";
      Reflect.set(candidate, "routeDocumentGeneration", 1);
      return null;
    });
    await expect(
      candidate.runReadonlyTask(
        "fixture prompt only",
        [],
        {},
        "temporary-instant",
      ),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    expect(
      execute.mock.calls.some(([script]) => script.includes("send.click()")),
    ).toBe(false);
  });
  it("refuses Send while the new profile document has a pending readiness read", async () => {
    const candidate = route();
    let url = "https://chatgpt.com/c/fixture-document-a";
    let pendingRead: Promise<unknown> | null = null;
    let resolvePending!: (value: unknown) => void;
    let sends = 0;
    const execute = vi.fn(async (script: string) => {
      if (script.includes("const labelledSignIn")) return pendingRead ?? ready;
      if (script.includes("const running = [")) return { running: false };
      if (script.includes("const baselineAssistantCount")) return prepared;
      if (script.includes("send.click()")) {
        sends += 1;
        return { navigated: true };
      }
      return { invalidFixtureProbe: true };
    });
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: { getURL: () => url, executeJavaScript: execute },
    });
    Reflect.set(candidate, "load", "loaded");
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "prepareTemporaryInstantProfile", async () => {
      url = "https://chatgpt.com/?temporary-chat=true";
      Reflect.set(candidate, "routeDocumentGeneration", 1);
      return null;
    });
    let pendingObservation: Promise<unknown> | undefined;
    const result = await candidate.runReadonlyTask(
      "fixture prompt only",
      [],
      {
        onDispatchIntent: async () => {
          pendingRead = new Promise((resolve) => {
            resolvePending = resolve;
          });
          pendingObservation = candidate.observe();
        },
      },
      "temporary-instant",
    );
    resolvePending(signedOut);
    await pendingObservation;
    expect(result).toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
    expect(sends).toBe(0);
  });
  it("does not return an intermediate ready cache while the latest third read is pending", async () => {
    const { candidate, pending } = readinessRoute();
    const oldest = candidate.observe();
    const middle = candidate.observe();
    pending[1]!(ready);
    await middle;
    const newest = candidate.observe();
    pending[0]!(ready);
    await expect(oldest).resolves.toMatchObject({
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
    pending[2]!(signedOut);
    await expect(newest).resolves.toMatchObject({ state: "signed_out" });
  });
  it("does not prepare the composer after a same-URL replacement during app binding", async () => {
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => {
        Reflect.set(candidate, "routeDocumentGeneration", 1);
        return { state: "bound" };
      })
      .mockResolvedValue(prepared);
    const candidate = devTaskRoute(execute);
    await expect(
      candidate.runReadonlyTask("fixture prompt only"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    expect(
      execute.mock.calls.some(([script]) =>
        (script as string).includes("const baselineAssistantCount"),
      ),
    ).toBe(false);
  });
  it("does not reuse a sign-in latch in a different document", async () => {
    const { candidate, pending } = readinessRoute();
    const first = candidate.observe();
    pending[0]!(signedOut);
    await first;
    Reflect.set(candidate, "routeDocumentGeneration", 1);
    const next = candidate.observe();
    pending[1]!({ unexpected: true });
    await expect(next).resolves.toMatchObject({ state: "unsupported" });
  });
  it("does not prepare or Send when an older task readiness read loses to sign-in-required", async () => {
    const { candidate, pending, execute } = readinessRoute();
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    const task = candidate.runReadonlyTask("fixture prompt only");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const current = candidate.observe();
    pending[1]!(signedOut);
    await current;
    pending[0]!(ready);
    await expect(task).resolves.toMatchObject({
      state: "not_authenticated",
      code: "CHATGPT_SIGN_IN_REQUIRED",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      execute.mock.calls.every(
        ([script]) => !(script as string).includes("send.click()"),
      ),
    ).toBe(true);
  });
});

describe("ChatGPT route submission boundary", () => {
  it("does not Send into a replacement document at the same URL after app verification", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        // A same-URL reload advances the route's document generation while
        // the awaited verification belongs to the document it replaced.
        Reflect.set(candidate, "routeDocumentGeneration", 1);
        return { state: "bound" };
      })
      .mockResolvedValue({ activated: true });
    const candidate = devTaskRoute(execute);
    expect(
      await candidate.runReadonlyTask("stay in this document"),
    ).toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    expect(
      execute.mock.calls.some(([script]) => script.includes("send.click()")),
    ).toBe(false);
  });

  it("does not Send after cancellation during the last asynchronous app verification", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        await candidate.cancelActiveTask();
        return { state: "bound" };
      })
      .mockResolvedValue({ activated: false });
    const candidate = devTaskRoute(execute);
    expect(await candidate.runReadonlyTask("cancel before Send")).toMatchObject(
      { state: "failed_before_submit" },
    );
    // Three app/composer probes plus the owned cancellation control read.
    expect(execute).toHaveBeenCalledTimes(4);
    expect(
      execute.mock.calls.some(([script]) => script.includes("send.click()")),
    ).toBe(false);
  });

  it("opens the rich ChatGPT app picker through native editing", async () => {
    const expectedHref = "https://chatgpt.com/c/native-picker";
    const nativeInputs: string[] = [];
    let pickerVisible = false;
    let pickerDelayTicks = 0;
    let selected = false;
    class HTMLElement {
      parentElement: HTMLElement | null = null;
      textContent = "";
      innerText = "";
      getBoundingClientRect(): Readonly<{ width: number; height: number }> {
        return { width: 240, height: 40 };
      }
      getAttribute(): null {
        return null;
      }
      closest(): HTMLElement | null {
        return this.parentElement;
      }
      contains(candidate: unknown): boolean {
        return candidate === this;
      }
      querySelectorAll(): readonly HTMLElement[] {
        return [];
      }
      cloneNode(): HTMLElement {
        return new HTMLElement();
      }
      focus(): void {}
      replaceChildren(...children: Array<{ text?: string }>): void {
        this.innerText = children.map((child) => child.text ?? "").join("");
      }
      dispatchEvent(): boolean {
        return true;
      }
      click(): void {}
    }
    class HTMLTextAreaElement extends HTMLElement {}
    class InputEvent {
      constructor(..._arguments: unknown[]) {}
    }
    const form = new HTMLElement();
    const composer = new HTMLElement();
    composer.parentElement = form;
    const chip = new HTMLElement();
    chip.textContent = "Farol Dev";
    form.querySelectorAll = () => (selected ? [chip] : []);
    const title = new HTMLElement();
    title.textContent = "Farol Dev";
    const option = new HTMLElement();
    option.textContent = "Farol Dev Private development connector";
    option.querySelectorAll = () => [title];
    option.click = () => {
      selected = true;
    };
    const picker = new HTMLElement();
    picker.querySelectorAll = () => [option];
    const context = vm.createContext({
      location: { href: expectedHref },
      document: {
        querySelector: (selector: string) =>
          selector.includes("prompt-textarea") ? composer : null,
        querySelectorAll: () => (pickerVisible ? [picker] : []),
        createTextNode: (text: string) => ({ text }),
        execCommand: (command: string, _showUi: boolean, value: string) => {
          if (command !== "insertText") return false;
          nativeInputs.push(value);
          composer.innerText = value;
          return true;
        },
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      setTimeout: (callback: () => void) => {
        pickerDelayTicks += 1;
        if (pickerDelayTicks === 3) pickerVisible = true;
        callback();
        return 0;
      },
      HTMLElement,
      HTMLTextAreaElement,
      InputEvent,
      Set,
      Object,
      Array,
    });

    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "bound" });
    expect(nativeInputs).toEqual(["@Farol Dev"]);
    expect(pickerDelayTicks).toBeGreaterThanOrEqual(3);
  });

  it.each([540, 620, 700])(
    "selects one exact app from a visible non-semantic Plugins picker at row y=%i",
    async (titleTop) => {
      const expectedHref = "https://chatgpt.com/c/plain-picker";
      let selected = false;
      let pickerVisible = false;
      let pickerAvailable = true;
      let headingVisible = true;
      let fileHeadingVisible = false;
      let transcriptVisible = false;
      let transcriptClicks = 0;
      let clicks = 0;
      let buttonAvailable = false;
      let buttonClicks = 0;
      let duplicateVisible = false;
      let duplicateClicks = 0;
      let clipMode = "hidden";
      let clipAxis = "y";
      class HTMLElement {
        parentElement: HTMLElement | null = null;
        article = false;
        textContent = "";
        innerText = "";
        children: HTMLElement[] = [];
        rect = {
          left: 550,
          right: 640,
          top: 540,
          bottom: 560,
          width: 90,
          height: 20,
        };
        getBoundingClientRect() {
          return this.rect;
        }
        getAttribute(): null {
          return null;
        }
        closest(selector: string): HTMLElement | null {
          if (
            selector.includes("article") ||
            selector.includes("data-message-author-role")
          ) {
            let current: HTMLElement | null = this;
            while (current) {
              if (current.article) return current;
              current = current.parentElement;
            }
            return null;
          }
          return this.parentElement;
        }
        contains(candidate: unknown): boolean {
          let current = candidate as HTMLElement | null;
          while (current) {
            if (current === this) return true;
            current = current.parentElement;
          }
          return false;
        }
        querySelectorAll(): readonly HTMLElement[] {
          return [];
        }
        cloneNode(): HTMLElement {
          return new HTMLElement();
        }
        focus(): void {}
        replaceChildren(...children: Array<{ text?: string }>): void {
          this.innerText = children.map((child) => child.text ?? "").join("");
        }
        dispatchEvent(): boolean {
          return true;
        }
        click(): void {}
      }
      class HTMLTextAreaElement extends HTMLElement {}
      class InputEvent {
        constructor(..._arguments: unknown[]) {}
      }
      const form = new HTMLElement();
      const composer = new HTMLElement();
      composer.rect = {
        left: 510,
        right: 1130,
        top: 420,
        bottom: 470,
        width: 620,
        height: 50,
      };
      composer.parentElement = form;
      const popup = new HTMLElement();
      popup.rect = {
        left: 510,
        right: 1130,
        top: 480,
        bottom: 730,
        width: 620,
        height: 250,
      };
      popup.parentElement = form;
      const clipper = new HTMLElement();
      clipper.parentElement = popup;
      clipper.rect = {
        ...popup.rect,
        right: 690,
        bottom: 600,
        width: 180,
        height: 120,
      };
      const chip = new HTMLElement();
      chip.textContent = "Farol Dev";
      form.querySelectorAll = () => (selected ? [chip] : []);
      const heading = new HTMLElement();
      heading.textContent = "Plugins";
      heading.rect = {
        left: 530,
        right: 590,
        top: 500,
        bottom: 520,
        width: 60,
        height: 20,
      };
      heading.parentElement = popup;
      const fileHeading = new HTMLElement();
      fileHeading.textContent = "Files";
      fileHeading.rect = {
        left: 530,
        right: 570,
        top: 580,
        bottom: 600,
        width: 40,
        height: 20,
      };
      fileHeading.parentElement = popup;
      const title = new HTMLElement();
      title.textContent = "Farol Dev";
      title.parentElement = popup;
      title.rect = { ...title.rect, top: titleTop, bottom: titleTop + 20 };
      const duplicate = new HTMLElement();
      duplicate.textContent = "Farol Dev";
      duplicate.parentElement = popup;
      duplicate.rect = { ...title.rect, top: 680, bottom: 700 };
      duplicate.click = () => {
        duplicateClicks += 1;
      };
      title.click = () => {
        clicks += 1;
        selected = true;
        composer.innerText = "";
      };
      const wrong = new HTMLElement();
      wrong.textContent = "Farol Dev Other";
      wrong.rect = {
        left: 560,
        right: 700,
        top: 570,
        bottom: 590,
        width: 140,
        height: 20,
      };
      wrong.parentElement = popup;
      const buttonTitle = new HTMLElement();
      buttonTitle.textContent = "Farol Dev";
      const appButton = new HTMLElement();
      appButton.textContent =
        "Farol Dev Private development connector to the approved workspace.";
      appButton.parentElement = popup;
      appButton.querySelectorAll = () => [buttonTitle];
      appButton.click = () => {
        buttonClicks += 1;
        selected = true;
        composer.innerText = "";
      };
      const transcriptHeading = new HTMLElement();
      transcriptHeading.textContent = "Plugins";
      transcriptHeading.rect = { ...heading.rect };
      const transcriptTitle = new HTMLElement();
      transcriptTitle.textContent = "Farol Dev";
      transcriptTitle.rect = { ...title.rect };
      const message = new HTMLElement();
      message.article = true;
      const transcriptPopup = new HTMLElement();
      transcriptPopup.rect = { ...popup.rect };
      transcriptPopup.parentElement = message;
      transcriptHeading.parentElement = transcriptPopup;
      transcriptTitle.parentElement = transcriptPopup;
      transcriptTitle.click = () => {
        transcriptClicks += 1;
      };
      const context = vm.createContext({
        location: { href: expectedHref },
        document: {
          querySelector: (selector: string) =>
            selector.includes("prompt-textarea") ? composer : null,
          querySelectorAll: (selector: string) =>
            selector.includes("button")
              ? pickerVisible && buttonAvailable
                ? [appButton]
                : []
              : selector === "span,div,strong" && pickerVisible
                ? [
                    ...(headingVisible ? [heading] : []),
                    ...(fileHeadingVisible ? [fileHeading] : []),
                    title,
                    ...(duplicateVisible ? [duplicate] : []),
                    wrong,
                  ]
                : transcriptVisible
                  ? [transcriptHeading, transcriptTitle]
                  : [],
          createTextNode: (text: string) => ({ text }),
          execCommand: (_command: string, _showUi: boolean, value: string) => {
            composer.innerText = value;
            pickerVisible = pickerAvailable;
            return true;
          },
        },
        getComputedStyle: (element: HTMLElement) => ({
          display: "block",
          visibility: "visible",
          overflowX:
            element === clipper && clipAxis === "x" ? clipMode : "visible",
          overflowY:
            element === clipper && clipAxis === "y" ? clipMode : "visible",
          position:
            element === popup || element === transcriptPopup
              ? "absolute"
              : "static",
        }),
        setTimeout: (callback: () => void) => {
          callback();
          return 0;
        },
        HTMLElement,
        HTMLTextAreaElement,
        InputEvent,
        Set,
        Object,
        Array,
      });

      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "bound" });
      expect(clicks).toBe(1);
      selected = false;
      headingVisible = false;
      buttonAvailable = true;
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "bound" });
      expect(clicks).toBe(1);
      expect(buttonClicks).toBe(1);

      selected = false;
      buttonAvailable = false;
      headingVisible = true;
      duplicateVisible = true;
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "blocked", reason: "ambiguous" });
      expect(clicks).toBe(1);
      expect(duplicateClicks).toBe(0);
      duplicateVisible = false;

      // A scrolled/clipped label outside the popup must not be selected.
      const visibleTitleRect = { ...title.rect };
      title.rect = { ...title.rect, top: 740, bottom: 760 };
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "blocked", reason: "missing" });
      expect(clicks).toBe(1);
      title.rect = visibleTitleRect;

      // Nonzero bounds inside the popup do not prove visibility through
      // intermediate clipping ancestors, on either axis.
      title.parentElement = clipper;
      for (const axis of ["x", "y"]) {
        clipAxis = axis;
        title.rect =
          axis === "y"
            ? { ...visibleTitleRect, top: 620, bottom: 640 }
            : {
                ...visibleTitleRect,
                left: 700,
                right: 790,
                top: 540,
                bottom: 560,
              };
        for (const mode of ["hidden", "auto", "scroll", "clip"]) {
          clipMode = mode;
          await expect(
            vm.runInContext(
              bindChatGptAppScript("Farol Dev", expectedHref),
              context,
            ),
          ).resolves.toEqual({ state: "blocked", reason: "missing" });
          expect(clicks).toBe(1);
        }
      }
      title.parentElement = popup;
      title.rect = { ...visibleTitleRect, top: 540, bottom: 560 };
      duplicate.parentElement = clipper;
      clipAxis = "y";
      clipMode = "auto";
      duplicateVisible = true;
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "bound" });
      expect(clicks).toBe(2);
      expect(duplicateClicks).toBe(0);
      selected = false;
      duplicateVisible = false;
      duplicate.parentElement = popup;
      title.rect = visibleTitleRect;

      fileHeadingVisible = false;
      pickerAvailable = false;
      transcriptVisible = true;
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "blocked", reason: "missing" });
      expect(transcriptClicks).toBe(0);

      pickerAvailable = true;
      transcriptVisible = false;
      headingVisible = true;
      fileHeadingVisible = true;
      title.rect = {
        left: 560,
        right: 650,
        top: 610,
        bottom: 630,
        width: 90,
        height: 20,
      };
      await expect(
        vm.runInContext(
          bindChatGptAppScript("Farol Dev", expectedHref),
          context,
        ),
      ).resolves.toEqual({ state: "blocked", reason: "missing" });
      expect(clicks).toBe(2);
    },
  );

  it("filters the real @ picker and accepts one exact Farol Dev option with description", async () => {
    const expectedHref = "https://chatgpt.com/c/dev-binding";
    let selected = false;
    const contacts = { pickerClicks: 0, values: [] as string[] };

    class StubElement {
      disabled = false;
      parentElement: StubElement | null = null;
      textContent = "";
      getBoundingClientRect(): Readonly<{ width: number; height: number }> {
        return { width: 240, height: 40 };
      }
      getAttribute(): null {
        return null;
      }
      contains(candidate: unknown): boolean {
        return candidate === this;
      }
      click(): void {}
      focus(): void {}
      dispatchEvent(): boolean {
        return true;
      }
      querySelectorAll(): readonly StubElement[] {
        return [];
      }
      closest(): StubElement | null {
        return this.parentElement;
      }
    }
    class HTMLElement extends StubElement {}
    class HTMLTextAreaElement extends HTMLElement {}
    class HTMLButtonElement extends HTMLElement {}
    const form = new HTMLElement();
    const composer = new HTMLTextAreaElement();
    composer.parentElement = form;
    const chip = new HTMLElement();
    chip.textContent = "Farol Dev";
    form.querySelectorAll = () => (selected ? [chip] : []);
    const picker = new HTMLElement();
    const option = new HTMLButtonElement();
    option.textContent =
      "Farol Dev Private development connector to the approved Farol Dev test workspace.";
    const optionTitle = new HTMLElement();
    optionTitle.textContent = "Farol Dev";
    option.querySelectorAll = () => [optionTitle];
    option.click = () => {
      contacts.pickerClicks += 1;
      selected = true;
    };
    picker.querySelectorAll = () => [option];
    let composerValue = "";
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
      configurable: true,
      get() {
        return composerValue;
      },
      set(next: string) {
        composerValue = next;
        contacts.values.push(next);
      },
    });
    class InputEvent {
      constructor(..._arguments: unknown[]) {}
    }
    const context = vm.createContext({
      location: { href: expectedHref },
      document: {
        querySelector: (selector: string) =>
          selector.includes("prompt-textarea") ? composer : null,
        querySelectorAll: (selector: string) =>
          selector.includes('role="listbox"') ? [picker] : [],
        createTextNode: (text: string) => ({ text }),
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      HTMLElement,
      HTMLTextAreaElement,
      HTMLButtonElement,
      InputEvent,
      Set,
      Object,
      Array,
    });

    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "bound" });
    expect(contacts.values).toEqual(["@Farol Dev"]);
    expect(contacts.pickerClicks).toBe(1);

    composerValue = "OWNER_DRAFT";
    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
    expect(composerValue).toBe("OWNER_DRAFT");
    expect(contacts.values).toEqual(["@Farol Dev"]);

    selected = false;
    composerValue = "";
    optionTitle.textContent = "Farol Dev Other";
    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "blocked", reason: "missing" });
    expect(contacts.pickerClicks).toBe(1);
  });

  it("does not accept a matching-name generic Lexical decorator as an app chip", () => {
    const expectedHref = "https://chatgpt.com/c/dev-binding";

    class Element {
      textContent = "";
      getBoundingClientRect(): Readonly<{ width: number; height: number }> {
        return { width: 240, height: 40 };
      }
      getAttribute(): null {
        return null;
      }
      contains(candidate: unknown): boolean {
        return candidate === this;
      }
      closest(): Element | null {
        return form;
      }
      querySelectorAll(selector: string): readonly Element[] {
        return selector.includes("data-lexical-decorator") ? [decorator] : [];
      }
    }
    class HTMLElement extends Element {}
    class HTMLTextAreaElement extends HTMLElement {}
    const form = new HTMLElement();
    const composer = new HTMLTextAreaElement();
    const decorator = new HTMLElement();
    decorator.textContent = "Farol DEV";
    const context = vm.createContext({
      location: { href: expectedHref },
      document: {
        querySelector: (selector: string) =>
          selector.includes("prompt-textarea") ? composer : null,
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      HTMLElement,
      HTMLTextAreaElement,
      Set,
      Object,
      Array,
    });

    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol DEV", expectedHref),
        context,
      ),
    ).toEqual({ state: "blocked", reason: "missing" });
  });

  it.each([
    ["missing", "CHATGPT_APP_SELECTION_MISSING"],
    ["ambiguous", "CHATGPT_APP_SELECTION_AMBIGUOUS"],
    ["conflict", "CHATGPT_APP_SELECTION_CONFLICT"],
    ["draft_present", "CHATGPT_COMPOSER_DRAFT_PRESENT"],
  ] as const)(
    "blocks a DEV submission before typing or clicking when app selection is %s",
    async (reason, code) => {
      const executeJavaScript = vi
        .fn()
        .mockResolvedValueOnce({ state: "blocked", reason });

      await expect(
        devTaskRoute(executeJavaScript).runReadonlyTask("must stay local"),
      ).resolves.toMatchObject({ state: "failed_before_submit", code });

      expect(executeJavaScript).toHaveBeenCalledTimes(1);
      expect(executeJavaScript.mock.calls[0]?.[0]).toContain("Farol DEV");
      expect(executeJavaScript.mock.calls[0]?.[0]).not.toContain(
        "send.click()",
      );
    },
  );

  it("blocks before the send script when the observed DEV app chip is lost", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ state: "blocked", reason: "missing" });

    await expect(
      devTaskRoute(executeJavaScript).runReadonlyTask("must stay bound"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_APP_SELECTION_LOST",
    });

    expect(executeJavaScript).toHaveBeenCalledTimes(3);
    expect(
      executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes("send.click()"),
      ),
    ).toBe(false);
  });

  it("preserves a draft that appears after app binding and blocks before send", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce({ draftPresent: true });

    await expect(
      devTaskRoute(executeJavaScript).runReadonlyTask("must not replace draft"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
    });

    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    expect(
      executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes("send.click()"),
      ),
    ).toBe(false);
  });

  it("installs a manual gate covering send clicks, form submit and Enter without a forgeable page marker", () => {
    const script = installManualAppGateScript("Farol DEV");
    expect(script).toContain('addEventListener("click"');
    expect(script).toContain('addEventListener("submit"');
    expect(script).toContain('addEventListener("keydown"');
    expect(script).toContain("form.contains(button)");
    expect(script).toContain("HTMLFormElement.prototype.submit");
    expect(script).toContain("HTMLFormElement.prototype.requestSubmit");
    expect(script).toContain(
      'target.closest(\'[role="option"],[role="menuitem"]\')',
    );
    expect(script).toContain("stopImmediatePropagation");
    expect(script).toContain("Farol DEV");
    expect(script).not.toContain("globalThis[gateId]");
  });

  it("executes the manual gate for click, Enter, submit APIs and the app-picker repair control", () => {
    type GateEvent = {
      target: unknown;
      key?: string;
      shiftKey?: boolean;
      isComposing?: boolean;
      prevented: boolean;
      stopped: boolean;
      preventDefault: () => void;
      stopImmediatePropagation: () => void;
    };

    function harness(
      selectedLabels: readonly string[],
      options: Readonly<{
        exposeKnownComposer?: boolean;
        secondarySelectedLabels?: readonly string[];
      }> = {},
    ) {
      const listeners = new Map<string, (event: GateEvent) => void>();
      const contacts = { submit: 0, requestSubmit: 0 };
      let notice: HTMLElement | null = null;

      class Node {
        contains(candidate: unknown): boolean {
          return candidate === this;
        }
      }
      class Element extends Node {
        parentElement: Element | null = null;
        textContent = "";
        style = { cssText: "" };
        readonly attributes = new Map<string, string>();
        getBoundingClientRect(): Readonly<{ width: number; height: number }> {
          return { width: 240, height: 40 };
        }
        getAttribute(name: string): string | null {
          return this.attributes.get(name) ?? null;
        }
        setAttribute(name: string, value: string): void {
          this.attributes.set(name, value);
        }
        remove(): void {
          if (notice === this) notice = null;
        }
        closest(selector: string): Element | null {
          if (
            selector === "form" &&
            this.parentElement instanceof HTMLFormElement
          ) {
            return this.parentElement;
          }
          if (selector === "button" && this instanceof HTMLButtonElement) {
            return this;
          }
          if (
            selector.includes("send-button") &&
            this instanceof HTMLButtonElement &&
            this.kind === "send"
          ) {
            return this;
          }
          if (
            selector.includes('[role="option"]') &&
            this instanceof HTMLButtonElement &&
            this.kind === "picker"
          ) {
            return this;
          }
          if (
            selector.includes("stop-button") &&
            this instanceof HTMLButtonElement &&
            this.kind === "stop"
          ) {
            return this;
          }
          if (
            selector.includes("composer-app-chip") &&
            this instanceof HTMLButtonElement &&
            this.kind === "remove"
          ) {
            return this;
          }
          return null;
        }
        querySelectorAll(_selector: string): readonly Element[] {
          return [];
        }
      }
      class HTMLElement extends Element {}
      class HTMLTextAreaElement extends HTMLElement {}
      class HTMLButtonElement extends HTMLElement {
        constructor(
          readonly kind: "send" | "picker" | "other" | "stop" | "remove",
        ) {
          super();
        }
      }
      class HTMLFormElement extends HTMLElement {
        readonly children = new Set<Element>();
        composerElement: HTMLElement | null = null;
        selectedChips: readonly Element[] = [];
        override contains(candidate: unknown): boolean {
          return candidate === this || this.children.has(candidate as Element);
        }
        override querySelectorAll(selector: string): readonly Element[] {
          if (
            selector.includes("textarea") ||
            selector.includes('[contenteditable="true"]') ||
            selector.includes('[role="textbox"]')
          ) {
            return this.composerElement === null ? [] : [this.composerElement];
          }
          return this.selectedChips;
        }
        submit(): void {
          contacts.submit += 1;
        }
        requestSubmit(): void {
          contacts.requestSubmit += 1;
        }
      }

      const form = new HTMLFormElement();
      const composer = new HTMLTextAreaElement();
      composer.parentElement = form;
      const send = new HTMLButtonElement("send");
      send.parentElement = form;
      const picker = new HTMLButtonElement("picker");
      picker.parentElement = form;
      picker.textContent = "Farol DEV";
      const stop = new HTMLButtonElement("stop");
      stop.parentElement = form;
      const remove = new HTMLButtonElement("remove");
      remove.parentElement = form;
      form.children.add(composer);
      form.children.add(send);
      form.children.add(picker);
      form.children.add(stop);
      form.children.add(remove);
      const chips = selectedLabels.map((label) => {
        const chip = new HTMLElement();
        chip.textContent = label;
        return chip;
      });
      form.composerElement = composer;
      form.selectedChips = chips;

      const secondaryForm = new HTMLFormElement();
      const secondaryComposer = new HTMLTextAreaElement();
      secondaryComposer.parentElement = secondaryForm;
      const secondaryGenericSubmit = new HTMLButtonElement("other");
      secondaryGenericSubmit.parentElement = secondaryForm;
      secondaryForm.children.add(secondaryComposer);
      secondaryForm.children.add(secondaryGenericSubmit);
      secondaryForm.composerElement = secondaryComposer;
      secondaryForm.selectedChips = (options.secondarySelectedLabels ?? []).map(
        (label) => {
          const chip = new HTMLElement();
          chip.textContent = label;
          return chip;
        },
      );

      const document = {
        documentElement: {
          appendChild(element: HTMLElement) {
            notice = element;
          },
        },
        querySelector: (selector: string): HTMLElement | null =>
          options.exposeKnownComposer !== false &&
          selector.includes("prompt-textarea")
            ? composer
            : null,
        getElementById: (): HTMLElement | null => notice,
        createElement: (): HTMLElement => new HTMLElement(),
        addEventListener: (
          type: string,
          listener: (event: GateEvent) => void,
        ): void => {
          listeners.set(type, listener);
        },
      };
      const context = vm.createContext({
        document,
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        setTimeout: () => 0,
        Node,
        Element,
        HTMLElement,
        HTMLTextAreaElement,
        HTMLButtonElement,
        HTMLFormElement,
        Reflect,
        Set,
        Object,
        Array,
      });
      expect(
        vm.runInContext(installManualAppGateScript("Farol DEV"), context),
      ).toBe(true);

      const event = (
        target: unknown,
        extra: Partial<GateEvent> = {},
      ): GateEvent => {
        const candidate: GateEvent = {
          target,
          shiftKey: false,
          isComposing: false,
          prevented: false,
          stopped: false,
          preventDefault: () => {
            candidate.prevented = true;
          },
          stopImmediatePropagation: () => {
            candidate.stopped = true;
          },
          ...extra,
        };
        return candidate;
      };
      const genericSubmit = new HTMLButtonElement("other");
      genericSubmit.parentElement = form;
      form.children.add(genericSubmit);
      return {
        listeners,
        contacts,
        form,
        composer,
        send,
        genericSubmit,
        picker,
        stop,
        remove,
        secondaryForm,
        secondaryComposer,
        secondaryGenericSubmit,
        event,
      };
    }

    const blocked = harness([]);
    for (const [type, candidate] of [
      ["click", blocked.event(blocked.send)],
      ["submit", blocked.event(blocked.form)],
      ["keydown", blocked.event(blocked.composer, { key: "Enter" })],
    ] as const) {
      blocked.listeners.get(type)?.(candidate);
      expect(candidate.prevented, type).toBe(true);
      expect(candidate.stopped, type).toBe(true);
    }
    blocked.form.submit();
    blocked.form.requestSubmit();
    expect(blocked.contacts).toEqual({ submit: 0, requestSubmit: 0 });

    for (const [label, control] of [
      ["stop", blocked.stop],
      ["remove app chip", blocked.remove],
    ] as const) {
      const controlEvent = blocked.event(control);
      blocked.listeners.get("click")?.(controlEvent);
      expect(controlEvent.prevented, label).toBe(false);
      expect(controlEvent.stopped, label).toBe(false);
    }

    const repair = blocked.event(blocked.picker);
    blocked.listeners.get("click")?.(repair);
    expect(repair.prevented).toBe(false);
    expect(repair.stopped).toBe(false);

    const bound = harness(["Farol DEV"]);
    for (const [type, candidate] of [
      ["click", bound.event(bound.send)],
      ["submit", bound.event(bound.form)],
      ["keydown", bound.event(bound.composer, { key: "Enter" })],
    ] as const) {
      bound.listeners.get(type)?.(candidate);
      expect(candidate.prevented, type).toBe(false);
      expect(candidate.stopped, type).toBe(false);
    }
    bound.form.submit();
    bound.form.requestSubmit();
    expect(bound.contacts).toEqual({ submit: 1, requestSubmit: 1 });

    for (const secondarySelectedLabels of [[], ["Farol Legacy"]] as const) {
      const crossForm = harness(["Farol DEV"], { secondarySelectedLabels });
      for (const [type, candidate] of [
        ["click", crossForm.event(crossForm.secondaryGenericSubmit)],
        ["submit", crossForm.event(crossForm.secondaryForm)],
        [
          "keydown",
          crossForm.event(crossForm.secondaryComposer, { key: "Enter" }),
        ],
      ] as const) {
        crossForm.listeners.get(type)?.(candidate);
        expect(candidate.prevented, `cross-form ${type}`).toBe(true);
        expect(candidate.stopped, `cross-form ${type}`).toBe(true);
      }
      crossForm.secondaryForm.submit();
      crossForm.secondaryForm.requestSubmit();
      expect(crossForm.contacts).toEqual({ submit: 0, requestSubmit: 0 });
    }

    const drifted = harness([], { exposeKnownComposer: false });
    for (const [type, candidate] of [
      ["click", drifted.event(drifted.genericSubmit)],
      ["submit", drifted.event(drifted.form)],
      ["keydown", drifted.event(drifted.composer, { key: "Enter" })],
    ] as const) {
      drifted.listeners.get(type)?.(candidate);
      expect(candidate.prevented, `selector drift ${type}`).toBe(true);
      expect(candidate.stopped, `selector drift ${type}`).toBe(true);
    }
    drifted.form.submit();
    drifted.form.requestSubmit();
    expect(drifted.contacts).toEqual({ submit: 0, requestSubmit: 0 });
  });

  it("keeps a DEV ChatGPT popup hidden and destroys it when the mandatory app gate cannot be installed", async () => {
    const rootContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
    let destroyed = false;
    const executeJavaScript = vi.fn<(script: string) => Promise<boolean>>(
      async () => false,
    );
    const popupContents = Object.assign(new EventEmitter(), {
      getURL: () => "https://chatgpt.com/c/popup",
      isDestroyed: () => destroyed,
      executeJavaScript,
      setWindowOpenHandler: vi.fn(),
    });
    const popup = Object.assign(new EventEmitter(), {
      webContents: popupContents,
      hide: vi.fn(),
      show: vi.fn(),
      showInactive: vi.fn(),
      setBounds: vi.fn(),
      isDestroyed: () => destroyed,
      destroy: vi.fn(),
    });
    popup.destroy.mockImplementation(() => {
      destroyed = true;
      popup.emit("closed");
    });
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol DEV",
      requireAppForManualMessages: true,
    });
    const hardenContents = Reflect.get(candidate, "hardenContents") as (
      this: ChatGptRoute,
      contents: typeof rootContents,
      tracksRouteReadiness: boolean,
    ) => void;
    hardenContents.call(candidate, rootContents, false);

    rootContents.emit("did-create-window", popup);
    popup.emit("ready-to-show");
    expect(popup.show).not.toHaveBeenCalled();

    popupContents.emit("did-finish-load");
    await vi.waitFor(() => expect(popup.destroy).toHaveBeenCalledTimes(1));
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain("Farol DEV");
    expect(popup.show).not.toHaveBeenCalled();
  });

  it("does not apply a popup gate result to a later document", async () => {
    const rootContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
    });
    let currentUrl = "https://chatgpt.com/c/popup-first";
    let resolveFirstGate: ((value: boolean) => void) | undefined;
    const firstGate = new Promise<boolean>((resolve) => {
      resolveFirstGate = resolve;
    });
    const executeJavaScript = vi
      .fn<(script: string) => Promise<boolean>>()
      .mockImplementationOnce(async () => firstGate)
      .mockResolvedValueOnce(true);
    const popupContents = Object.assign(new EventEmitter(), {
      getURL: () => currentUrl,
      isDestroyed: () => false,
      executeJavaScript,
      setWindowOpenHandler: vi.fn(),
    });
    const popup = Object.assign(new EventEmitter(), {
      webContents: popupContents,
      hide: vi.fn(),
      show: vi.fn(),
      showInactive: vi.fn(),
      setBounds: vi.fn(),
      isDestroyed: () => false,
      destroy: vi.fn(),
    });
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol DEV",
      requireAppForManualMessages: true,
    });
    const hardenContents = Reflect.get(candidate, "hardenContents") as (
      this: ChatGptRoute,
      contents: typeof rootContents,
      tracksRouteReadiness: boolean,
    ) => void;
    hardenContents.call(candidate, rootContents, false);
    rootContents.emit("did-create-window", popup);
    popup.emit("ready-to-show");

    popupContents.emit("did-finish-load");
    await vi.waitFor(() => expect(executeJavaScript).toHaveBeenCalledTimes(1));
    currentUrl = "https://chatgpt.com/c/popup-second";
    popupContents.emit(
      "did-start-navigation",
      undefined,
      currentUrl,
      false,
      true,
    );
    resolveFirstGate?.(true);
    await firstGate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      Reflect.get(candidate, "submissionGatedPopupWindows") as Set<unknown>,
    ).not.toContain(popup);
    expect(popup.show).not.toHaveBeenCalled();

    popupContents.emit("did-finish-load");
    await vi.waitFor(() => expect(popup.show).toHaveBeenCalledTimes(1));
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("never reveals a retained DEV ChatGPT surface before the navigation gate is installed", async () => {
    const executeJavaScript = vi.fn(async () => false);
    const surface = {
      kind: "window" as const,
      webContents: {
        getURL: () => "https://chatgpt.com/c/retained",
        executeJavaScript,
      },
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      hide: vi.fn(),
      reveal: vi.fn(),
      focus: vi.fn(),
      setTitle: vi.fn(),
      destroy: vi.fn(),
      onPageTitleUpdated: vi.fn(),
      onClosing: vi.fn(),
      onClosed: vi.fn(),
    };
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol DEV",
      requireAppForManualMessages: true,
    });
    Reflect.set(candidate, "routeWindow", surface);
    Reflect.set(candidate, "load", "failed");

    await expect(candidate.open()).resolves.toEqual({
      status: "unreachable",
    });
    expect(surface.reveal).not.toHaveBeenCalled();
    expect(executeJavaScript).not.toHaveBeenCalled();

    Reflect.set(candidate, "load", "loaded");
    await expect(candidate.open()).resolves.toEqual({
      status: "unreachable",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(surface.destroy).toHaveBeenCalledTimes(1);
    expect(surface.reveal).not.toHaveBeenCalled();
  });

  it("discards a stale gate result when a full navigation starts before installation completes", async () => {
    let currentUrl = "https://chatgpt.com/c/first";
    let resolveGate: ((value: boolean) => void) | undefined;
    const gate = new Promise<boolean>((resolve) => {
      resolveGate = resolve;
    });
    const contents = Object.assign(new EventEmitter(), {
      getURL: () => currentUrl,
      executeJavaScript: vi.fn(async () => gate),
      setWindowOpenHandler: vi.fn(),
      mainFrame: { processId: 1, routingId: 1 },
    });
    const surface = {
      kind: "window" as const,
      webContents: contents,
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      hide: vi.fn(),
      reveal: vi.fn(),
      focus: vi.fn(),
      setTitle: vi.fn(),
      destroy: vi.fn(),
      onPageTitleUpdated: vi.fn(),
      onClosing: vi.fn(),
      onClosed: vi.fn(),
    };
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: currentUrl,
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol DEV",
      requireAppForManualMessages: true,
    });
    Reflect.set(candidate, "routeWindow", surface);
    const hardenContents = Reflect.get(candidate, "hardenContents") as (
      this: ChatGptRoute,
      routeContents: typeof contents,
      tracksRouteReadiness: boolean,
    ) => void;
    hardenContents.call(candidate, contents, true);

    contents.emit("did-finish-load");
    await vi.waitFor(() =>
      expect(contents.executeJavaScript).toHaveBeenCalledTimes(1),
    );
    currentUrl = "https://chatgpt.com/c/second";
    contents.emit("did-start-navigation", undefined, currentUrl, false, true);
    resolveGate?.(true);
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Reflect.get(candidate, "load")).toBe("failed");
    expect(surface.reveal).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not apply a stale initial-open gate result (%s) to the next document",
    async (installed) => {
      let currentUrl = "about:blank";
      let resolveGate: ((value: boolean) => void) | undefined;
      const gate = new Promise<boolean>((resolve) => {
        resolveGate = resolve;
      });
      const contents = Object.assign(new EventEmitter(), {
        getURL: () => currentUrl,
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async () => gate),
        setWindowOpenHandler: vi.fn(),
        mainFrame: { processId: 1, routingId: 1 },
      });
      const surface = {
        kind: "window" as const,
        webContents: contents,
        isDestroyed: vi.fn(() => false),
        loadURL: vi.fn(async (nextUrl: string) => {
          currentUrl = nextUrl;
        }),
        hide: vi.fn(),
        reveal: vi.fn(),
        focus: vi.fn(),
        setTitle: vi.fn(),
        destroy: vi.fn(),
        onPageTitleUpdated: vi.fn(),
        onClosing: vi.fn(),
        onClosed: vi.fn(),
      };
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/c/initial",
        e2eOrigin: null,
        parent: () => null,
        requiredAppName: "Farol DEV",
        requireAppForManualMessages: true,
        surfaceFactory: (() =>
          surface) as unknown as ChatGptRouteSurfaceFactory,
      });

      const opening = candidate.open();
      await vi.waitFor(() =>
        expect(contents.executeJavaScript).toHaveBeenCalledTimes(1),
      );
      currentUrl = "https://chatgpt.com/c/next";
      contents.emit("did-start-navigation", undefined, currentUrl, false, true);
      resolveGate?.(installed);

      await expect(opening).resolves.toEqual({ status: "unreachable" });
      expect(Reflect.get(candidate, "load")).toBe("failed");
      expect(surface.reveal).not.toHaveBeenCalled();
      expect(surface.focus).not.toHaveBeenCalled();
      expect(surface.destroy).not.toHaveBeenCalled();
    },
  );

  it("blocks a busy retained page before touching the composer", async () => {
    const executeJavaScript = vi.fn();

    await expect(
      taskRoute(executeJavaScript, { running: true }).runReadonlyTask(
        "do not replace this turn",
      ),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_IN_PROGRESS",
    });
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("blocks an indeterminate page activity probe before touching the composer", async () => {
    const executeJavaScript = vi.fn();

    await expect(
      taskRoute(executeJavaScript, { malformed: true }).runReadonlyTask(
        "do not risk a second turn",
      ),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_UI_UNRECOGNIZED",
    });
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  it("keeps a lost send acknowledgement outcome unknown without retrying", async () => {
    let submissions = 0;
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        submissions += 1;
        throw new Error("bridge lost after click");
      });

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(submissions).toBe(1);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("treats a malformed send acknowledgement as unknown without retrying", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ malformed: true });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValue(9_000);

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("keeps a positively observed pre-click refusal retry-safe", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: false });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValue(9_000);

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_SUBMIT_UNAVAILABLE",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("uses the same unknown boundary after an attachment upload", async () => {
    let submissions = 0;
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        submissions += 1;
        throw new Error("bridge lost after attachment send");
      });

    await expect(
      taskRoute(executeJavaScript).runReadonlyTask("inspect evidence", [
        attachment,
      ]),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
    });
    expect(attachmentMock.upload).toHaveBeenCalledTimes(1);
    expect(submissions).toBe(1);
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("F2-3 refuses to type into the composer after a navigation between preflight and dispatch", async () => {
    let currentUrl = "https://chatgpt.com/";
    const executeJavaScript = vi.fn().mockImplementationOnce(async () => {
      // The page navigated to a different conversation while this exact
      // script ran: the click that would actually submit must never reach
      // whatever this page is now showing.
      currentUrl = "https://chatgpt.com/c/another-conversation";
      return prepared;
    });
    const candidate = route();
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: routedExecutor(executeJavaScript, {
          running: false,
        }),
        getURL: () => currentUrl,
      },
    });

    await expect(
      candidate.runReadonlyTask("do not type into another conversation"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    // Only the prompt-composer script ran; the click that actually submits
    // never reached the page the route navigated to underneath it.
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("F2-3 refuses a later retry once navigation is observed mid-loop, without submitting twice", async () => {
    let currentUrl = "https://chatgpt.com/";
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockImplementationOnce(async () => {
        // The click control was not yet ready, and the page navigated away
        // right after this read.
        currentUrl = "https://chatgpt.com/c/another-conversation";
        return { activated: false };
      });
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(4_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValue(9_000);
    const candidate = route();
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: routedExecutor(executeJavaScript, {
          running: false,
        }),
        getURL: () => currentUrl,
      },
    });

    await expect(
      candidate.runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    // The composer was typed once and the send control was read once (not
    // yet activated); the retry that would have clicked send on the
    // navigated-to page never ran.
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });

  // The main process cannot check anything between dispatching a script and
  // the script running in the page, so the scripts carry the validated page
  // identity and compare it against `location.href` themselves, before
  // typing or clicking. The executor here stands in for the page: it answers
  // the closed `{ navigated: true }` shape the script returns when that
  // comparison fails.
  it("F2-3 refuses when the page itself reports it moved before the prompt was typed", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({ navigated: true });
    const candidate = taskRoute(executeJavaScript);

    await expect(
      candidate.runReadonlyTask("do not type into another conversation"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    // Only the composer script was dispatched, and it carried the validated
    // identity for the page to compare against its own location; no send
    // click followed.
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
    expect(executeJavaScript.mock.calls[0]?.[0]).toContain(
      JSON.stringify("https://chatgpt.com/"),
    );
  });

  it("F2-3 refuses when the page itself reports it moved before the send click, and never retries the click", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ navigated: true });
    const candidate = taskRoute(executeJavaScript);

    await expect(
      candidate.runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    // The composer was typed once and the click script ran once, carrying
    // the validated identity; the page declined to click, which is a
    // positive statement that nothing was submitted, so no retry followed.
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    expect(executeJavaScript.mock.calls[1]?.[0]).toContain(
      JSON.stringify("https://chatgpt.com/"),
    );
  });

  it("F2-3 re-checks the page identity after the dispatch-intent record is written, before the click script is dispatched", async () => {
    let currentUrl = "https://chatgpt.com/";
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValue({ activated: true });
    const candidate = route();
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: routedExecutor(executeJavaScript, {
          running: false,
        }),
        getURL: () => currentUrl,
      },
    });

    await expect(
      candidate.runReadonlyTask("read the selected file", [], {
        // The dispatch-intent record is a disk write; the page moved while
        // it landed.
        onDispatchIntent: async () => {
          currentUrl = "https://chatgpt.com/c/another-conversation";
        },
      }),
    ).resolves.toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
    });
    // Only the composer script ran: the identity was re-read after the
    // intent write resolved, and the click script was never dispatched.
    expect(executeJavaScript).toHaveBeenCalledTimes(1);
  });
});

describe("ChatGPT route streaming observation", () => {
  const probe = (
    assistantText: string,
    input: Readonly<{ busy: boolean; sendVisible: boolean }>,
  ) => ({
    assistantCount: 1,
    assistantCharacters: assistantText.length,
    assistantText,
    userCount: 1,
    turnUserId: "user-current",
    turnAssistantId: "assistant-current",
    busy: input.busy,
    sendVisible: input.sendVisible,
    signInVisible: false,
    errorVisible: false,
  });
  const correlatedProbe = (
    assistantText: string,
    input: Readonly<{
      busy: boolean;
      sendVisible: boolean;
      turnUserId: string | null;
      turnAssistantId: string | null;
    }>,
  ) => ({
    ...probe(assistantText, input),
    turnUserId: input.turnUserId,
    turnAssistantId: input.turnAssistantId,
  });

  it("classifies only explicit provider limit messages", () => {
    expect(
      classifyChatGptProviderError("You have reached your usage limit"),
    ).toBe("usage_limited");
    expect(classifyChatGptProviderError("Too many requests; try later")).toBe(
      "usage_limited",
    );
    expect(
      classifyChatGptProviderError("The network connection was lost"),
    ).toBe("generic");
  });

  it("classifies an explicit provider usage limit without a retry", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce({
        ...probe("", { busy: false, sendVisible: true }),
        errorVisible: true,
        errorKind: "usage_limited",
      });

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask(
        "preserve this context",
      ),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_USAGE_LIMITED",
      deltaCount: 0,
      observedCharacters: 0,
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(3);
  });

  it("delivers exact incremental text before the terminal result", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(probe("Hel", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(probe("Hello", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(probe("Hello", { busy: false, sendVisible: true }))
      .mockResolvedValueOnce(probe("Hello", { busy: false, sendVisible: true }))
      .mockResolvedValueOnce(
        probe("Hello", { busy: false, sendVisible: true }),
      );
    const deltas: unknown[] = [];

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask(
        "reply with a greeting",
        [],
        {
          onTextDelta: (delta) => {
            deltas.push(delta);
          },
        },
      ),
    ).resolves.toEqual({
      state: "completed",
      code: null,
      deltaCount: 2,
      observedCharacters: 5,
      outputText: "Hello",
    });
    expect(deltas).toEqual([
      {
        sequence: 1,
        delta: "Hel",
        text: "Hel",
        observedCharacters: 3,
      },
      {
        sequence: 2,
        delta: "lo",
        text: "Hello",
        observedCharacters: 5,
      },
    ]);
  });

  it("refuses a non-prefix rewrite after text was delivered", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(probe("Alpha", { busy: true, sendVisible: false }))
      .mockResolvedValueOnce(
        probe("Omega", { busy: true, sendVisible: false }),
      );
    const deltas: unknown[] = [];

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask("reply once", [], {
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      }),
    ).resolves.toEqual({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_OUTPUT_CHANGED",
      deltaCount: 1,
      observedCharacters: 5,
      outputText: "Alpha",
    });
    expect(deltas).toHaveLength(1);
  });

  it("continues the same logical provider turn after history remounts", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(
        correlatedProbe("Hel", {
          busy: true,
          sendVisible: false,
          turnUserId: "user-current",
          turnAssistantId: "assistant-current",
        }),
      )
      .mockResolvedValueOnce(
        correlatedProbe("", {
          busy: true,
          sendVisible: false,
          turnUserId: null,
          turnAssistantId: null,
        }),
      )
      .mockResolvedValueOnce(
        correlatedProbe("Hello", {
          busy: true,
          sendVisible: false,
          turnUserId: "user-current",
          turnAssistantId: "assistant-current",
        }),
      )
      .mockResolvedValue(
        correlatedProbe("Hello", {
          busy: false,
          sendVisible: true,
          turnUserId: "user-current",
          turnAssistantId: "assistant-current",
        }),
      );

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask("reply once"),
    ).resolves.toMatchObject({
      state: "completed",
      code: null,
      outputText: "Hello",
    });
  });

  it("does not accept an uncorrelated late response as the current turn", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValue(
        correlatedProbe("Late response from an older turn", {
          busy: false,
          sendVisible: true,
          turnUserId: null,
          turnAssistantId: null,
        }),
      );

    await expect(
      streamingTaskRoute(executeJavaScript, 20).runReadonlyTask("new turn"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_TIMEOUT",
      outputText: "",
    });
  });

  it("returns the observed user-message identity when a correlated reply is still late", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValue(
        correlatedProbe("", {
          busy: true,
          sendVisible: false,
          turnUserId: "user-current",
          turnAssistantId: null,
        }),
      );

    await expect(
      streamingTaskRoute(executeJavaScript, 20).runReadonlyTask(
        "preserve this context",
      ),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_TIMEOUT",
      turnUserId: "user-current",
      turnAssistantId: null,
    });
  });

  it("observes one known late provider turn without touching the composer or send control", async () => {
    const executeJavaScript = vi.fn().mockResolvedValue(
      correlatedProbe("Recovered summary", {
        busy: false,
        sendVisible: true,
        turnUserId: "user-current",
        turnAssistantId: "assistant-current",
      }),
    );
    const candidate = streamingTaskRoute(executeJavaScript);

    await expect(
      candidate.observeReadonlyTask({
        prompt: "preserve this context",
        turnUserId: "user-current",
        turnAssistantId: null,
      }),
    ).resolves.toEqual({
      state: "completed",
      code: null,
      deltaCount: 1,
      observedCharacters: "Recovered summary".length,
      outputText: "Recovered summary",
      turnUserId: "user-current",
      turnAssistantId: "assistant-current",
    });
    expect(executeJavaScript).toHaveBeenCalledTimes(4);
    expect(
      executeJavaScript.mock.calls.every(
        ([script]) => !String(script).includes("send.click()"),
      ),
    ).toBe(true);
  });

  it("keeps a provider error after streamed text outcome-unknown", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce(
        probe("Partial", { busy: true, sendVisible: false }),
      )
      .mockResolvedValueOnce({
        ...probe("Partial", { busy: false, sendVisible: true }),
        errorVisible: true,
        errorKind: "generic",
      });
    const deltas: unknown[] = [];

    await expect(
      streamingTaskRoute(executeJavaScript).runReadonlyTask("reply once", [], {
        onTextDelta: (delta) => void deltas.push(delta),
      }),
    ).resolves.toEqual({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_ERROR",
      deltaCount: 1,
      observedCharacters: 7,
      outputText: "Partial",
      turnUserId: "user-current",
      turnAssistantId: "assistant-current",
    });
    expect(deltas).toHaveLength(1);
  });

  it("F2-3 ends the poll as page-lost once the page moves to another conversation than the one this submission created, however similar its messages look", async () => {
    let probeCalls = 0;
    const answer = correlatedProbe("Done.", {
      busy: false,
      sendVisible: true,
      turnUserId: "user-current",
      turnAssistantId: "assistant-current",
    });
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ activated: true })
      .mockImplementation(async () => {
        probeCalls += 1;
        return answer;
      });
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      taskPollMs: 1,
      taskTimeoutMs: 1_000,
    });
    vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "routeWindow", {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: routedExecutor(executeJavaScript, {
          running: false,
        }),
        // Submitted from the home page; the conversation the submission
        // created appears after the second probe (the one allowed
        // transition), and the page then moves to another conversation
        // that happens to show the same prompt and reply.
        getURL: () =>
          probeCalls < 2
            ? "https://chatgpt.com/"
            : probeCalls === 2
              ? "https://chatgpt.com/c/first-conversation-0001"
              : "https://chatgpt.com/c/other-conversation-0002",
      },
    });

    await expect(
      candidate.runReadonlyTask("read the selected file"),
    ).resolves.toMatchObject({
      state: "outcome_unknown",
      code: "CHATGPT_TASK_PAGE_LOST",
      turnUserId: "user-current",
      turnAssistantId: "assistant-current",
    });
    // Three probes read the pinned conversation (home, home, then the
    // created conversation); the fourth iteration saw another conversation
    // and ended without reading it, so its matching messages were never
    // adopted as this submission's result.
    expect(probeCalls).toBe(3);
  });

  it("waits through an interim missing stop control before cancelling", async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce({ activated: false })
      .mockResolvedValueOnce({ activated: true })
      .mockResolvedValueOnce({ running: false });
    const candidate = taskRoute(executeJavaScript);
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "observedTaskRunning", true);

    await expect(candidate.cancelActiveTask()).resolves.toBe("cancelled");
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
  });
});

describe("ChatGPT embedded task surface", () => {
  it("OBS-F7 reports a hung activity probe as unknown without piling up probes or trusting its late answer", async () => {
    vi.useFakeTimers();
    try {
      const changes: string[] = [];
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/",
        e2eOrigin: null,
        parent: () => null,
        onTaskActivityChanged: (state) => {
          changes.push(state);
        },
      });
      let settleHung!: (value: unknown) => void;
      const executeJavaScript = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              settleHung = resolve;
            }),
        )
        .mockResolvedValue({ running: false });
      const contents = {
        isDestroyed: () => false,
        executeJavaScript,
        getURL: () => "https://chatgpt.com/c/activity",
      };
      Reflect.set(candidate, "load", "loaded");
      const poll = () =>
        Reflect.apply(
          Reflect.get(candidate, "pollTaskActivity") as (
            ...args: unknown[]
          ) => Promise<void>,
          candidate,
          [contents, Reflect.get(candidate, "activityGeneration")],
        );

      const hung = poll();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(changes).toEqual(["outcome_unknown"]);
      // No second probe starts while the first one hangs.
      await poll();
      expect(executeJavaScript).toHaveBeenCalledTimes(1);

      // The hung probe's late answer is discarded.
      settleHung({ running: true });
      await hung;
      expect(changes).toEqual(["outcome_unknown"]);

      // The next poll measures afresh.
      await poll();
      expect(executeJavaScript).toHaveBeenCalledTimes(2);
      expect(changes).toEqual(["outcome_unknown", "idle"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains an exact owned conversation binding before the surface reopens", () => {
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-after-restart",
      e2eOrigin: null,
      parent: () => null,
    });

    expect(candidate.currentConversationUrl()).toBeNull();
    expect(candidate.retainedConversationUrl()).toBe(
      "https://chatgpt.com/c/task-owned-after-restart",
    );
  });

  it("clears the durable conversation binding when the source is retired", () => {
    const onConversationChanged = vi.fn();
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-before-retirement",
      e2eOrigin: null,
      parent: () => null,
      onConversationChanged,
    });

    candidate.resetConversation();

    expect(candidate.retainedConversationUrl()).toBeNull();
    expect(onConversationChanged).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("ignores closing and navigation events from a retired surface", async () => {
    const surface = embeddedSurface();
    const onConversationChanged = vi.fn();
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-stale-surface",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onConversationChanged,
    });
    await candidate.open();
    onConversationChanged.mockClear();

    candidate.resetConversation();
    surface.webContents.emit("did-finish-load");
    surface.webContents.emit(
      "did-navigate-in-page",
      {},
      "https://chatgpt.com/c/task-owned-stale-surface",
      true,
    );

    expect(candidate.retainedConversationUrl()).toBeNull();
    expect(onConversationChanged).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("uses the injected task-owned surface without creating a separate window", async () => {
    const surface = embeddedSurface();
    const surfaceFactory = vi.fn(() => surface);
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/c/task-owned-surface",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: surfaceFactory as unknown as ChatGptRouteSurfaceFactory,
    });

    await expect(candidate.open()).resolves.toEqual({ status: "opened" });
    expect(surfaceFactory).toHaveBeenCalledTimes(1);
    expect(surfaceFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "ChatGPT · Farol Next",
        webPreferences: expect.objectContaining({
          partition: "persist:farol-next-chatgpt",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        }),
      }),
    );
    expect(surface.loadURL).toHaveBeenCalledWith(
      "https://chatgpt.com/c/task-owned-surface",
    );
    expect(surface.reveal).toHaveBeenCalledTimes(1);
    expect(surface.focus).toHaveBeenCalledTimes(1);

    candidate.dispose();
    expect(surface.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses a Chromium error document and recreates it only on explicit retry", async () => {
    const first = embeddedSurface();
    const second = embeddedSurface();
    const originalLoad = first.loadURL.getMockImplementation()!;
    first.loadURL.mockImplementation(async (url: string) => {
      await originalLoad(url);
      first.webContents.emit("did-start-navigation", {}, url, false, true);
      first.webContents.emit(
        "did-fail-load",
        {},
        -102,
        "ERR_CONNECTION_REFUSED",
        url,
        true,
      );
      first.webContents.emit("did-finish-load");
    });
    const surfaces = [first, second];
    const changes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() =>
        surfaces.shift()) as unknown as ChatGptRouteSurfaceFactory,
      onLoadStateChanged: (state) => changes.push(state),
    });

    await expect(candidate.open()).resolves.toEqual({ status: "unreachable" });
    expect(first.reveal).not.toHaveBeenCalled();
    expect(changes).toEqual(["loading", "failed"]);
    await expect(candidate.retryFailedOpen()).resolves.toEqual({
      status: "opened",
    });
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.reveal).toHaveBeenCalledTimes(1);
    candidate.dispose();
  });

  it("does not gate ordinary manual ChatGPT messages when automated tasks require an app", async () => {
    const surface = embeddedSurface();
    const contents = Object.assign(surface.webContents, {
      executeJavaScript: vi.fn(async () => true),
    });
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol Dev",
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
    });
    await expect(candidate.open()).resolves.toEqual({ status: "opened" });
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
    candidate.dispose();
  });

  it("keeps a full navigation hidden until its app gate settles and reports renderer loss", async () => {
    const surface = embeddedSurface();
    const contents = Object.assign(surface.webContents, {
      executeJavaScript: vi.fn(async () => true),
    });
    const changes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol Dev",
      requireAppForManualMessages: true,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onLoadStateChanged: (state) => changes.push(state),
    });
    await expect(candidate.open()).resolves.toEqual({ status: "opened" });

    let releaseGate: ((value: boolean) => void) | undefined;
    const gate = new Promise<boolean>((resolve) => {
      releaseGate = resolve;
    });
    contents.executeJavaScript.mockImplementation(async () => gate);
    const nextUrl = "https://chatgpt.com/c/new-document";
    await surface.loadURL(nextUrl);
    contents.emit("did-start-navigation", {}, nextUrl, false, true);
    contents.emit("did-finish-load");
    await vi.waitFor(() =>
      expect(contents.executeJavaScript).toHaveBeenCalledTimes(2),
    );
    expect(changes.at(-1)).toBe("loading");
    expect(surface.hide).toHaveBeenCalled();
    expect(surface.reveal).toHaveBeenCalledTimes(1);

    releaseGate?.(true);
    await vi.waitFor(() => expect(changes.at(-1)).toBe("loaded"));
    expect(surface.reveal).toHaveBeenCalledTimes(2);
    contents.emit("render-process-gone");
    expect(changes.at(-1)).toBe("failed");
    expect(surface.hide).toHaveBeenCalledTimes(2);
    candidate.dispose();
  });
});

describe("ChatGPT shared partition lifecycle", () => {
  it("keeps one download guard across repeated route disposal", () => {
    const sharedSession = new EventEmitter() as EventEmitter & {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
    };
    sharedSession.setMaxListeners(0);
    sharedSession.setPermissionRequestHandler = vi.fn();
    sharedSession.setPermissionCheckHandler = vi.fn();

    for (let cycle = 0; cycle < 25; cycle += 1) {
      const candidate = route();
      harden(candidate, sharedSession);
      candidate.dispose();
    }

    expect(sharedSession.listenerCount("will-download")).toBe(1);
    const event = { preventDefault: vi.fn() };
    sharedSession.emit("will-download", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(sharedSession.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(sharedSession.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });
});

describe("ChatGPT sign-in return", () => {
  it.each([false, true])(
    "bounds an embedded sign-in page that never finishes loading (teardown throws: %s)",
    async (teardownThrows) => {
      vi.useFakeTimers();
      try {
        const base = embeddedSurface();
        let destroyed = false;
        const surface = {
          ...base,
          isDestroyed: vi.fn(() => destroyed),
          loadURL: vi.fn(() => new Promise<void>(() => undefined)),
          destroy: vi.fn(() => {
            if (teardownThrows) throw new Error("TEARDOWN_FAILED");
            destroyed = true;
            base.destroy();
          }),
        };
        const outcomes: string[] = [];
        const candidate = new ChatGptRoute({
          homeUrl: "https://chatgpt.com/",
          initialUrl: "https://chatgpt.com/",
          e2eOrigin: null,
          parent: () => null,
          surfaceFactory: (() =>
            surface) as unknown as ChatGptRouteSurfaceFactory,
          onSignInOutcome: (status) => outcomes.push(status),
        });

        const opening = candidate.openForSignIn(
          "Sign in to ChatGPT — Farol Dev",
        );
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(opening).resolves.toEqual({ status: "unreachable" });
        expect(surface.destroy).toHaveBeenCalledTimes(1);
        expect(surface.reveal).not.toHaveBeenCalled();
        expect(surface.hide).toHaveBeenCalledTimes(teardownThrows ? 1 : 0);
        expect(outcomes).toEqual(["unknown"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("returns from an embedded sign-in without destroying its verified page", async () => {
    const surface = embeddedSurface();
    Object.assign(surface.webContents, {
      executeJavaScript: vi.fn(async () => ({
        composerVisible: true,
        signInVisible: false,
      })),
    });
    const outcomes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status) => outcomes.push(status),
    });

    await expect(
      candidate.openForSignIn("Sign in to ChatGPT — Farol Dev"),
    ).resolves.toEqual({ status: "opened" });
    candidate.returnFromSignIn();
    candidate.returnFromSignIn();
    await vi.waitFor(() => expect(outcomes).toEqual(["authenticated"]));
    expect(surface.hide).toHaveBeenCalled();
    expect(surface.destroy).not.toHaveBeenCalled();
    await expect(candidate.observe()).resolves.toMatchObject({
      state: "authenticated",
    });
    candidate.dispose();
  });

  it("recreates a failed embedded sign-in page on the next explicit open", async () => {
    const first = embeddedSurface();
    const second = embeddedSurface();
    for (const surface of [first, second]) {
      Object.assign(surface.webContents, {
        executeJavaScript: vi.fn(async () => ({})),
      });
    }
    const surfaces = [first, second];
    const outcomes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() =>
        surfaces.shift()) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status) => outcomes.push(status),
    });

    await expect(
      candidate.openForSignIn("Sign in to ChatGPT — Farol Dev"),
    ).resolves.toEqual({ status: "opened" });
    first.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://chatgpt.com/auth/login",
      true,
    );
    candidate.returnFromSignIn();
    await vi.waitFor(() => expect(outcomes).toEqual(["unknown"]));

    expect(first.destroy).toHaveBeenCalledTimes(1);
    await expect(
      candidate.openForSignIn("Sign in to ChatGPT — Farol Dev"),
    ).resolves.toEqual({ status: "opened" });
    expect(second.reveal).toHaveBeenCalledTimes(1);
    candidate.dispose();
  });

  it("closes on one Return and reports one unknown outcome when the page read never settles", async () => {
    vi.useFakeTimers();
    try {
      const base = embeddedSurface();
      const mainFrame = {
        processId: 1,
        routingId: 7,
        url: "https://chatgpt.com/",
      };
      Object.assign(base.webContents, {
        mainFrame,
        executeJavaScript: vi.fn(() => new Promise(() => undefined)),
      });
      const close = vi.fn(() => base.destroy());
      const surface = { ...base, kind: "window" as const, close };
      const outcomes: string[] = [];
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/",
        e2eOrigin: null,
        parent: () => null,
        surfaceFactory: (() =>
          surface) as unknown as ChatGptRouteSurfaceFactory,
        onSignInOutcome: (status) => outcomes.push(status),
      });
      await candidate.openForSignIn("Sign in to ChatGPT — Farol");

      base.webContents.emit("console-message", {
        message: "farol-sign-in-return-to-farol",
        frame: mainFrame,
      });
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(close).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(outcomes).toEqual(["unknown"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores the return signal from a frame other than the page's top-level frame", async () => {
    const base = embeddedSurface();
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://chatgpt.com/",
    };
    Object.assign(base.webContents, {
      mainFrame,
      executeJavaScript: vi.fn(async () => ({})),
    });
    const close = vi.fn(() => base.destroy());
    const surface = { ...base, kind: "window" as const, close };
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
    });
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");

    base.webContents.emit("console-message", {
      message: "farol-sign-in-return-to-farol",
      frame: { processId: 2, routingId: 9, url: "https://chatgpt.com/" },
    });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
  });

  // A fixture that tracks `isDestroyed()` faithfully (unlike the shared
  // `embeddedSurface()`, which hardcodes it to `false`), so a guard the
  // production code takes against a second native close is actually
  // exercised instead of silently no-opped by the fixture. `nativeClose`
  // fires the "close" then "closed" listeners directly, without going
  // through the `close`/`destroy` spies — modelling the owner's own OS
  // close button, a trigger independent of the Return control.
  function signInSurface() {
    const closing = new Set<() => void>();
    const closed = new Set<() => void>();
    let destroyed = false;
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://chatgpt.com/",
    };
    const executeJavaScript = vi.fn(() => new Promise(() => undefined));
    const contents = Object.assign(new EventEmitter(), {
      mainFrame,
      getURL: () => "https://chatgpt.com/",
      isDestroyed: () => destroyed,
      executeJavaScript,
      setWindowOpenHandler: vi.fn(),
    });
    const fireClosing = () => {
      for (const listener of closing) listener();
    };
    const fireClosed = () => {
      for (const listener of closed) listener();
    };
    const nativeClose = () => {
      if (destroyed) return;
      fireClosing();
      destroyed = true;
      fireClosed();
    };
    const close = vi.fn(nativeClose);
    const destroy = vi.fn(nativeClose);
    const surface = {
      kind: "window" as const,
      webContents: contents,
      isDestroyed: () => destroyed,
      loadURL: vi.fn(async () => undefined),
      hide: vi.fn(),
      reveal: vi.fn(),
      focus: vi.fn(),
      setTitle: vi.fn(),
      destroy,
      close,
      onPageTitleUpdated: vi.fn(),
      onClosing: vi.fn((listener: () => void) => closing.add(listener)),
      onClosed: vi.fn((listener: () => void) => closed.add(listener)),
    };
    return {
      surface,
      contents,
      close,
      destroy,
      nativeClose,
      executeJavaScript,
    };
  }

  function emitReturn(contents: EventEmitter & { mainFrame: unknown }) {
    contents.emit("console-message", {
      message: "farol-sign-in-return-to-farol",
      frame: (contents as unknown as { mainFrame: unknown }).mainFrame,
    });
  }

  it("closes once and reports exactly one outcome for two Return clicks in a row, from the bound when the page read never settles", async () => {
    vi.useFakeTimers();
    try {
      const { surface, contents, close, executeJavaScript } = signInSurface();
      const outcomes: string[] = [];
      const diagnostics: ChatGptSignInOutcomeDiagnostic[] = [];
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/",
        e2eOrigin: null,
        parent: () => null,
        surfaceFactory: (() =>
          surface) as unknown as ChatGptRouteSurfaceFactory,
        onSignInOutcome: (status, diagnostic) => {
          outcomes.push(status);
          diagnostics.push(diagnostic);
        },
      });
      await candidate.openForSignIn("Sign in to ChatGPT — Farol");
      expect(executeJavaScript).not.toHaveBeenCalled();

      emitReturn(contents);
      emitReturn(contents);
      // The second click, arriving while the first click's bounded read is
      // still in flight, joins that read rather than closing the window
      // under it: nothing closes until the read answers or its bound ends.
      expect(close).not.toHaveBeenCalled();
      // Joining means ONE read, not two racing reads of the same page: a
      // second `executeJavaScript` would be a second answer nobody reports
      // and a second chance to observe a page mid-teardown.
      expect(executeJavaScript).toHaveBeenCalledTimes(1);

      // The bound expires: both joined clicks resolve to the same close,
      // which happens exactly once, and the one outcome is the bound's.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(["unknown"]);
      // S35-R7: the outcome alone cannot say why it is "unknown", and a
      // recorded "unknown" writes nothing at all. The diagnostic names the
      // bound that won and how long the read actually ran.
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        reason: "timeout",
        state: null,
        readStartedBy: "return",
      });
      expect(diagnostics[0]?.elapsedMs).toBeGreaterThanOrEqual(2_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "authenticated",
      { composerVisible: true, signInVisible: false },
      "authenticated",
      "authenticated",
    ],
    [
      "signed out",
      { composerVisible: false, signInVisible: true },
      "not_authenticated",
      "signed_out",
    ],
  ] as const)(
    "reports the page's own answer (%s) for two Return clicks in a row once the read the first click started settles",
    async (_label, page, expected, observedState) => {
      vi.useFakeTimers();
      try {
        let resolveRead!: (value: unknown) => void;
        const { surface, contents, close } = signInSurface();
        const executeJavaScript = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveRead = resolve;
            }),
        );
        Object.assign(contents, { executeJavaScript });
        const outcomes: string[] = [];
        const diagnostics: ChatGptSignInOutcomeDiagnostic[] = [];
        const candidate = new ChatGptRoute({
          homeUrl: "https://chatgpt.com/",
          initialUrl: "https://chatgpt.com/",
          e2eOrigin: null,
          parent: () => null,
          surfaceFactory: (() =>
            surface) as unknown as ChatGptRouteSurfaceFactory,
          onSignInOutcome: (status, diagnostic) => {
            outcomes.push(status);
            diagnostics.push(diagnostic);
          },
        });
        await candidate.openForSignIn("Sign in to ChatGPT — Farol");
        expect(executeJavaScript).not.toHaveBeenCalled();

        emitReturn(contents);
        emitReturn(contents);
        expect(close).not.toHaveBeenCalled();
        // One read serves both clicks; `resolveRead` below therefore
        // settles the only read there is, and both clicks observe its
        // answer rather than one of two racing reads.
        expect(executeJavaScript).toHaveBeenCalledTimes(1);

        // The page answers the read the first click started, well inside
        // the bound. The second click did not tear the page down under it,
        // so the answer is the page's own, not a degraded "unknown".
        resolveRead(page);
        await vi.advanceTimersByTimeAsync(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual([expected]);
        expect(executeJavaScript).toHaveBeenCalledTimes(1);

        // S35-R7: an answered read says so, and carries the page state it
        // classified — the evidence that separates this from a timeout.
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          reason: "answered",
          state: observedState,
          readStartedBy: "return",
        });
        expect(diagnostics[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
        expect(diagnostics[0]?.elapsedMs).toBeLessThan(2_000);

        // The bound that raced the read expires later and changes nothing.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(close).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual([expected]);
        expect(diagnostics).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // S35-R7: the third way a sign-in attempt ends without a page read — no
  // route window was ever opened, so the Return control had nothing to
  // read and nothing to close. That is an explanation of its own, not an
  // unexplained "unknown".
  it("S35-R7 reports no-window when the sign-in window never opened, with no page read at all", async () => {
    const { surface, executeJavaScript } = signInSurface();
    const unopenable = {
      ...surface,
      loadURL: vi.fn(async () => {
        throw new Error("ERR_CONNECTION_REFUSED");
      }),
    };
    const outcomes: string[] = [];
    const diagnostics: ChatGptSignInOutcomeDiagnostic[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() =>
        unopenable) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status, diagnostic) => {
        outcomes.push(status);
        diagnostics.push(diagnostic);
      },
    });

    const opened = await candidate.openForSignIn("Sign in to ChatGPT — Farol");

    expect(opened).toEqual({ status: "unreachable" });
    expect(outcomes).toEqual(["unknown"]);
    expect(diagnostics).toEqual([
      {
        reason: "no-window",
        state: null,
        elapsedMs: 0,
        readStartedBy: "return",
      },
    ]);
    expect(executeJavaScript).not.toHaveBeenCalled();
  });

  // Where the return signal may come from. The sentinel is a console
  // message, which any script on any page could print; only ChatGPT's own
  // top-level page, while the sign-in surface is open, may end it -- and
  // what it says about the outcome is never trusted over the page read.
  it("ignores the return signal from an identity provider's page, even from its top-level frame", async () => {
    const base = embeddedSurface();
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://accounts.google.com/",
    };
    Object.assign(base.webContents, {
      mainFrame,
      executeJavaScript: vi.fn(async () => ({})),
    });
    const close = vi.fn(() => base.destroy());
    const surface = { ...base, kind: "window" as const, close };
    const outcomes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status) => outcomes.push(status),
    });
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");

    base.webContents.emit("console-message", {
      message: "farol-sign-in-return-to-farol",
      frame: mainFrame,
    });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("ignores the return signal outside sign-in mode", async () => {
    const base = embeddedSurface();
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://chatgpt.com/",
    };
    Object.assign(base.webContents, {
      mainFrame,
      executeJavaScript: vi.fn(async () => ({})),
    });
    const close = vi.fn(() => base.destroy());
    const surface = { ...base, kind: "window" as const, close };
    const outcomes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status) => outcomes.push(status),
    });
    // The same route, opened as an ordinary surface rather than through
    // `openForSignIn`: there is no sign-in attempt for the signal to end.
    await candidate.open();

    base.webContents.emit("console-message", {
      message: "farol-sign-in-return-to-farol",
      frame: mainFrame,
    });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("takes the outcome from the page read, never from what the return signal claims", async () => {
    const base = embeddedSurface();
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://chatgpt.com/",
    };
    // The page reads as signed out, whatever any console text claims.
    Object.assign(base.webContents, {
      mainFrame,
      executeJavaScript: vi.fn(async () => ({
        composerVisible: false,
        signInVisible: true,
      })),
    });
    const close = vi.fn(() => base.destroy());
    const surface = { ...base, kind: "window" as const, close };
    const outcomes: string[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onSignInOutcome: (status) => outcomes.push(status),
    });
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");

    // A signal that carries a claim is not the sentinel at all.
    base.webContents.emit("console-message", {
      message: "farol-sign-in-return-to-farol authenticated",
      frame: mainFrame,
    });
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);

    // The exact sentinel ends the surface; the outcome is what the page
    // read said, not "authenticated".
    base.webContents.emit("console-message", {
      message: "farol-sign-in-return-to-farol",
      frame: mainFrame,
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(outcomes).toEqual(["not_authenticated"]));
  });
  it("still reports exactly one outcome when a native close arrives while the bounded read is in flight", async () => {
    vi.useFakeTimers();
    try {
      const { surface, contents, close, nativeClose } = signInSurface();
      const outcomes: string[] = [];
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/",
        e2eOrigin: null,
        parent: () => null,
        surfaceFactory: (() =>
          surface) as unknown as ChatGptRouteSurfaceFactory,
        onSignInOutcome: (status) => outcomes.push(status),
      });
      await candidate.openForSignIn("Sign in to ChatGPT — Farol");

      emitReturn(contents);
      // The owner's OS close button, independent of the Return control's
      // own close() call, arrives while Return's bounded read is pending.
      nativeClose();
      expect(close).not.toHaveBeenCalled();

      // Return's own deferred close, once its bounded read settles, must
      // find the window already gone and must not report a second time.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(close).not.toHaveBeenCalled();
      expect(outcomes).toEqual(["unknown"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a read that answers only after the window is already gone", async () => {
    vi.useFakeTimers();
    try {
      let resolveRead!: (value: unknown) => void;
      const { surface, contents, close } = signInSurface();
      Object.assign(contents, {
        executeJavaScript: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveRead = resolve;
            }),
        ),
      });
      const outcomes: string[] = [];
      const candidate = new ChatGptRoute({
        homeUrl: "https://chatgpt.com/",
        initialUrl: "https://chatgpt.com/",
        e2eOrigin: null,
        parent: () => null,
        surfaceFactory: (() =>
          surface) as unknown as ChatGptRouteSurfaceFactory,
        onSignInOutcome: (status) => outcomes.push(status),
      });
      await candidate.openForSignIn("Sign in to ChatGPT — Farol");

      emitReturn(contents);
      expect(close).not.toHaveBeenCalled();

      // The bound expires before the real read ever answers: the window
      // closes and the outcome is reported from the bound, not the read.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(close).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(["unknown"]);

      // The read the bound raced against finally answers, well after the
      // window is gone and the outcome already reported. It must change
      // nothing: no second outcome, no further state write.
      resolveRead({ composerVisible: true, signInVisible: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(outcomes).toEqual(["unknown"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// UX34-07: the sign-in surface's diagnostics carry no page content, and the
// one the product shows as current belongs to the current attempt only.
describe("ChatGPT sign-in blocked diagnostics (UX34-07)", () => {
  function signInRoute() {
    const base = embeddedSurface();
    const mainFrame = {
      processId: 1,
      routingId: 7,
      url: "https://chatgpt.com/",
    };
    Object.assign(base.webContents, {
      mainFrame,
      executeJavaScript: vi.fn(async () => ({})),
    });
    const close = vi.fn(() => base.destroy());
    const surface = { ...base, kind: "window" as const, close };
    const blocked: ChatGptSignInBlockedDiagnostic[] = [];
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: "https://chatgpt.com/",
      e2eOrigin: null,
      parent: () => null,
      surfaceFactory: (() => surface) as unknown as ChatGptRouteSurfaceFactory,
      onSignInBlocked: (diagnostic) => blocked.push(diagnostic),
    });
    return { base, candidate, blocked };
  }

  it("reports a blocked popup by host only, never its path, query or fragment", async () => {
    const { base, candidate, blocked } = signInRoute();
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");
    const openHandler = base.webContents.setWindowOpenHandler.mock
      .calls[0]?.[0] as (details: { url: string }) => { action: string };

    expect(
      openHandler({
        url: "https://evil.example.com/oauth/callback?code=SECRET-CODE&state=abc#token=SECRET-TOKEN",
      }),
    ).toEqual({ action: "deny" });
    expect(blocked).toEqual([
      { kind: "popup-blocked", host: "evil.example.com" },
    ]);
  });

  it("reports a denied permission by its name only, and only while a sign-in attempt is open", async () => {
    const routeSession = electronMock.fromPartition() as EventEmitter & {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
    };
    const { candidate, blocked } = signInRoute();
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");
    const permissionHandler = routeSession.setPermissionRequestHandler.mock
      .calls[0]?.[0] as (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;
    const callback = vi.fn();

    permissionHandler(
      { url: "https://chatgpt.com/c/secret" },
      "media",
      callback,
    );
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(blocked).toEqual([
      { kind: "permission-denied", permission: "media" },
    ]);
  });

  it("reports a failed load by its numeric code only, and reports nothing once the attempt is over", async () => {
    const { base, candidate, blocked } = signInRoute();
    await candidate.openForSignIn("Sign in to ChatGPT — Farol");

    base.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://chatgpt.com/auth/login?next=%2Fc%2Fsecret-conversation",
      true,
    );
    expect(blocked).toEqual([{ kind: "load-failed", code: -105 }]);

    // The owner closed the surface: the attempt is over, and a later block
    // on the same contents is nobody's current diagnostic.
    base.destroy();
    base.webContents.emit(
      "did-fail-load",
      {},
      -106,
      "ERR_INTERNET_DISCONNECTED",
      "https://chatgpt.com/",
      true,
    );
    expect(blocked).toEqual([{ kind: "load-failed", code: -105 }]);
  });

  it("shows a block as current only for the attempt it happened in", () => {
    const ledger = new ChatGptSignInBlockLedger();
    expect(ledger.current()).toBeNull();

    ledger.beginAttempt();
    ledger.record({ kind: "popup-blocked", host: "evil.example.com" });
    ledger.record({ kind: "load-failed", code: -105 });
    // The latest block within an attempt is the current one.
    expect(ledger.current()).toEqual({ kind: "load-failed", code: -105 });

    // The next attempt starts clean: a stale block is never shown as
    // current, until this attempt reports one of its own.
    ledger.beginAttempt();
    expect(ledger.current()).toBeNull();
    ledger.record({ kind: "permission-denied", permission: "media" });
    expect(ledger.current()).toEqual({
      kind: "permission-denied",
      permission: "media",
    });
  });
});

// S35-H2-4. The main process cannot check anything between dispatching a
// submission script and that script running, so the last check before
// typing or clicking happens in-page: both scripts compare the page's own
// `location.href` with the identity the caller validated and return
// `{ navigated: true }` without touching anything when they differ.
//
// These evaluate the real source strings the route dispatches, in
// `node:vm`, against a stub page whose composer and send button record any
// contact. A paraphrase of the guard would prove nothing about the bytes
// that are actually sent to the renderer.
describe("ChatGPT in-page navigation guard (S35-H2-4)", () => {
  const expectedHref = "https://chatgpt.com/c/abc-123";

  type Contacts = Readonly<{
    focused: number;
    typed: string[];
    events: string[];
    clicked: number;
    replaced: number;
  }>;

  function pageContext(
    href: string,
    selectedAppName?: string,
    options: Readonly<{
      composer?: "textarea" | "rich";
      draft?: string;
      chipTextInComposer?: boolean;
      linkOnly?: boolean;
      extraSelectedLink?: string;
      separateRepresentations?: boolean;
      markerPluginId?: string;
      linkHref?: string;
      promptLinkHref?: string;
      sendLabelOnly?: boolean;
      invalidateChipOnAppend?: boolean;
    }> = {},
  ): Readonly<{
    context: vm.Context;
    contacts: Contacts;
  }> {
    const contacts = {
      focused: 0,
      typed: [] as string[],
      events: [] as string[],
      clicked: 0,
      replaced: 0,
    };

    class StubElement {
      disabled = false;
      parentElement: StubElement | null = null;
      textContent = "";
      innerText = "";
      focus(): void {
        contacts.focused += 1;
      }
      click(): void {
        contacts.clicked += 1;
      }
      replaceChildren(): void {
        contacts.replaced += 1;
      }
      append(node: { text?: string }): void {
        contacts.typed.push(node.text ?? "");
      }
      dispatchEvent(event: { type: string }): boolean {
        contacts.events.push(event.type);
        return true;
      }
      getBoundingClientRect(): Readonly<{ width: number; height: number }> {
        return { width: 320, height: 48 };
      }
      closest(): null {
        return null;
      }
      contains(candidate: unknown): boolean {
        let current = candidate as StubElement | null;
        while (current) {
          if (current === this) return true;
          current = current.parentElement;
        }
        return false;
      }
      getAttribute(_name: string): string | null {
        return null;
      }
      querySelectorAll(_selector: string): readonly StubElement[] {
        return [];
      }
      cloneNode(): StubElement {
        const clone = new (this.constructor as new () => StubElement)();
        // The live rich editor puts its app mention inside the composer.
        // Removing that selected element from a clone leaves only owner text.
        const ownerText =
          this === composer && options.promptLinkHref
            ? (options.draft ?? "")
            : this.textContent;
        clone.textContent = ownerText;
        clone.innerText = ownerText;
        return clone;
      }
      remove(): void {}
    }

    class HTMLElement extends StubElement {}
    class HTMLTextAreaElement extends HTMLElement {}
    class HTMLButtonElement extends HTMLElement {}

    const composer =
      options.composer === "rich"
        ? new HTMLElement()
        : new HTMLTextAreaElement();
    let selectedChipPresent = true;
    if (options.invalidateChipOnAppend) {
      composer.append = (node: { text?: string }): void => {
        contacts.typed.push(node.text ?? "");
        selectedChipPresent = false;
      };
    }
    const composerText =
      options.draft ??
      (options.chipTextInComposer ? (selectedAppName ?? "") : "");
    composer.innerText = composerText;
    composer.textContent = composerText;
    const send = new HTMLButtonElement();
    const appChip = new HTMLElement();
    appChip.textContent = selectedAppName ?? "";
    appChip.getAttribute = (name: string) =>
      name === "data-app-id"
        ? (options.markerPluginId ?? null)
        : name === "data-prompt-link-href"
          ? (options.promptLinkHref ?? null)
          : null;
    const appLink = new HTMLElement();
    appLink.textContent = selectedAppName ?? "";
    if (!options.linkOnly && !options.separateRepresentations) {
      appLink.parentElement = appChip;
    }
    appLink.getAttribute = (name: string) =>
      name === "href"
        ? (options.linkHref ??
          "/plugins/plugin_asdk_app_6ab3b56de6d48191beec1e050abb549a?plugin_detail_origin=inline_selection_pill")
        : null;
    const otherLink = new HTMLElement();
    otherLink.textContent = options.extraSelectedLink ?? "";
    otherLink.getAttribute = (name: string) =>
      name === "href"
        ? "/plugins/plugin_asdk_app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?plugin_detail_origin=inline_selection_pill"
        : null;
    composer.querySelectorAll = (selector: string) =>
      selector.includes('a[href*="/plugins/plugin_asdk_app_"]')
        ? selectedChipPresent &&
          options.chipTextInComposer &&
          selectedAppName !== undefined
          ? [appLink, ...(options.extraSelectedLink ? [otherLink] : [])]
          : []
        : options.promptLinkHref
          ? selector.includes("[data-prompt-link-href]") ||
            selector.includes('[data-prompt-link-href^="app://asdk_app_"]')
            ? [appChip]
            : []
          : !selectedChipPresent ||
              selectedAppName === undefined ||
              options.linkOnly
            ? []
            : [appChip];

    // The value setter the prepare script reaches for, instrumented.
    let composerValue = options.draft ?? "";
    Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
      configurable: true,
      get() {
        return composerValue;
      },
      set(next: string) {
        composerValue = next;
        contacts.typed.push(next);
      },
    });

    class InputEvent {
      readonly type = "input";
      constructor(
        _type: string,
        readonly init: unknown,
      ) {}
    }

    const document = {
      querySelector: (selector: string): unknown => {
        if (selector.includes("prompt-textarea")) return composer;
        if (
          options.sendLabelOnly
            ? selector === 'button[aria-label="Send"]'
            : selector.includes("send-button") || selector.includes("Send")
        ) {
          return send;
        }
        return null;
      },
      querySelectorAll: (): readonly unknown[] => [],
      createTextNode: (text: string) => ({ text }),
      execCommand: (_command: string, _showUi: boolean, text: string) => {
        contacts.typed.push(text);
        return true;
      },
      createRange: () => ({ selectNodeContents() {}, collapse() {} }),
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    };

    const context = vm.createContext({
      location: { href },
      document,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      getBoundingClientRect: () => ({ width: 320, height: 48 }),
      HTMLElement,
      HTMLTextAreaElement,
      HTMLButtonElement,
      InputEvent,
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
      Set,
      Object,
      RegExp,
      Array,
    });
    return { context, contacts };
  }

  it("prepareTaskScript returns { navigated: true } and never touches the composer when the page has navigated", () => {
    const { context, contacts } = pageContext("https://chatgpt.com/c/other");
    const result = vm.runInContext(
      prepareTaskScript("Secret prompt.", expectedHref),
      context,
    );
    expect(result).toEqual({ navigated: true });
    expect(contacts.focused).toBe(0);
    expect(contacts.typed).toEqual([]);
    expect(contacts.replaced).toBe(0);
    expect(contacts.events).toEqual([]);
  });

  it("activateTaskScript returns { navigated: true } and never clicks send when the page has navigated", () => {
    const { context, contacts } = pageContext("https://chatgpt.com/c/other");
    const result = vm.runInContext(activateTaskScript(expectedHref), context);
    expect(result).toEqual({ navigated: true });
    expect(contacts.clicked).toBe(0);
  });

  it("the DEV activation bytes refuse to click when the app chip is absent", () => {
    const { context, contacts } = pageContext(expectedHref);
    const result = vm.runInContext(
      activateTaskScript(expectedHref, "Farol DEV"),
      context,
    );
    expect(result).toEqual({ appSelectionLost: true });
    expect(contacts.clicked).toBe(0);
  });

  it("the renamed Dev activation accepts only the configured title-case app", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev");
    const result = vm.runInContext(
      activateTaskScript(expectedHref, "Farol Dev"),
      context,
    );
    expect(result).toEqual({ activated: true });
    expect(contacts.clicked).toBe(1);
  });

  it("does not treat the selected app link alone as an owner draft", async () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
    });
    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "bound" });
    expect(
      vm.runInContext(
        prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol Dev"),
        context,
      ),
    ).toMatchObject({ ready: true });
    expect(contacts.typed).toEqual(["AUTHORIZED_CHECK"]);
  });

  it("keeps the exact selected plugin link bound after the picker marker disappears", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkOnly: true,
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        context,
      ),
    ).toEqual({ state: "bound" });
    expect(
      vm.runInContext(
        prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol Dev"),
        context,
      ),
    ).toMatchObject({ ready: true });
    expect(contacts.typed).toEqual(["AUTHORIZED_CHECK"]);
  });

  it("keeps a selected app bound when ChatGPT changes its chip link origin", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkOnly: true,
      linkHref:
        "/plugins/plugin_asdk_app_6ab3b56de6d48191beec1e050abb549a?plugin_detail_origin=mention_selection",
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        context,
      ),
    ).toEqual({ state: "bound" });
    expect(
      vm.runInContext(
        prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol Dev"),
        context,
      ),
    ).toMatchObject({ ready: true });
    expect(contacts.typed).toEqual(["AUTHORIZED_CHECK"]);
  });

  it("accepts the live ChatGPT app mention only with its exact app identity", async () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkHref: "",
      promptLinkHref: "app://asdk_app_6ab3b56de6d48191beec1e050abb549a",
    });
    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "bound" });
    expect(
      vm.runInContext(
        prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol Dev"),
        context,
      ),
    ).toMatchObject({ ready: true });
    expect(
      vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
    ).toEqual({ activated: true });
    expect(contacts.typed).toEqual(["AUTHORIZED_CHECK"]);
    expect(contacts.clicked).toBe(1);
  });

  it("activates the current ChatGPT Send control with the selected app", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkHref: "",
      promptLinkHref: "app://asdk_app_6ab3b56de6d48191beec1e050abb549a",
      sendLabelOnly: true,
    });
    expect(
      vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
    ).toEqual({ activated: true });
    expect(contacts.clicked).toBe(1);
  });

  it("rejects a matching app name with a non-app prompt link", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkHref: "",
      promptLinkHref: "https://example.com/farol-dev",
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        context,
      ),
    ).toEqual({ state: "blocked", reason: "missing" });
    expect(
      vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
    ).toEqual({ appSelectionLost: true });
    expect(contacts.clicked).toBe(0);
  });

  it("inserts the check through the editor without detaching the selected app", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      linkOnly: true,
      invalidateChipOnAppend: true,
    });
    expect(
      vm.runInContext(
        prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol Dev"),
        context,
      ),
    ).toMatchObject({ ready: true });
    expect(contacts.typed).toEqual(["AUTHORIZED_CHECK"]);
    expect(
      vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
    ).toEqual({ activated: true });
  });

  it("blocks a second selected plugin link beside the Farol Dev marker", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      extraSelectedLink: "Other app",
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        context,
      ),
    ).toEqual({ state: "blocked", reason: "ambiguous" });
    expect(
      vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
    ).toEqual({ appSelectionLost: true });
    expect(contacts.clicked).toBe(0);
  });

  it("deduplicates separate marker and link only when their plugin IDs match", () => {
    const exactId = "plugin_asdk_app_6ab3b56de6d48191beec1e050abb549a";
    const same = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      separateRepresentations: true,
      markerPluginId: exactId,
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        same.context,
      ),
    ).toEqual({ state: "bound" });

    const different = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      separateRepresentations: true,
      markerPluginId: "plugin_asdk_app_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      vm.runInContext(
        verifyChatGptAppScript("Farol Dev", expectedHref),
        different.context,
      ),
    ).toEqual({ state: "blocked", reason: "ambiguous" });
  });

  it("still preserves a real draft beside the selected app link", async () => {
    const { context, contacts } = pageContext(expectedHref, "Farol Dev", {
      composer: "rich",
      chipTextInComposer: true,
      draft: "Farol Dev OWNER_DRAFT",
    });
    await expect(
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
    expect(contacts.typed).toEqual([]);
  });

  it.each(["Farol DEV", "farol dev", "Farol", "Farol-Dev", "Farol Dev Other"])(
    "does not silently accept %s as the renamed Farol Dev app",
    (selectedName) => {
      const { context, contacts } = pageContext(expectedHref, selectedName);
      expect(
        vm.runInContext(
          prepareTaskScript("SYNTHETIC_CHECK", expectedHref, "Farol Dev"),
          context,
        ),
      ).toEqual({ appSelectionLost: true });
      expect(
        vm.runInContext(activateTaskScript(expectedHref, "Farol Dev"), context),
      ).toEqual({ appSelectionLost: true });
      expect(contacts.clicked).toBe(0);
      expect(contacts.typed).toEqual([]);
    },
  );

  // Older fixtures below request the uppercase name explicitly. They still
  // exercise the generic exact-label contract, not a legacy-name fallback.
  it("the DEV activation bytes click only with one exact Farol DEV chip", () => {
    const { context, contacts } = pageContext(expectedHref, "Farol DEV");
    const result = vm.runInContext(
      activateTaskScript(expectedHref, "Farol DEV"),
      context,
    );
    expect(result).toEqual({ activated: true });
    expect(contacts.clicked).toBe(1);
  });

  it.each(["textarea", "rich"] as const)(
    "the DEV preparation bytes preserve an owner draft in a bound %s composer",
    (composer) => {
      const { context, contacts } = pageContext(expectedHref, "Farol DEV", {
        composer,
        draft: "OWNER_DRAFT",
      });

      expect(
        vm.runInContext(
          prepareTaskScript("AUTHORIZED_CHECK", expectedHref, "Farol DEV"),
          context,
        ),
      ).toEqual({ draftPresent: true });
      expect(contacts.focused).toBe(0);
      expect(contacts.typed).toEqual([]);
      expect(contacts.replaced).toBe(0);
      expect(contacts.events).toEqual([]);
    },
  );

  it("control: on the expected href both scripts reach the composer and the send button", () => {
    const prepareRun = pageContext(expectedHref);
    const prepared = vm.runInContext(
      prepareTaskScript("Secret prompt.", expectedHref),
      prepareRun.context,
    );
    expect(prepared).toMatchObject({ ready: true });
    expect(prepareRun.contacts.focused).toBe(1);
    expect(prepareRun.contacts.typed).toEqual(["Secret prompt."]);
    expect(prepareRun.contacts.events).toEqual(["input"]);

    const activateRun = pageContext(expectedHref);
    const activated = vm.runInContext(
      activateTaskScript(expectedHref),
      activateRun.context,
    );
    expect(activated).toEqual({ activated: true });
    expect(activateRun.contacts.clicked).toBe(1);
  });

  it("the guard is an exact comparison: a query string, a fragment or a trailing slash is a different page", () => {
    for (const href of [
      `${expectedHref}?x=1`,
      `${expectedHref}#top`,
      `${expectedHref}/`,
      "https://chatgpt.com/",
    ]) {
      const { context, contacts } = pageContext(href);
      expect(
        vm.runInContext(
          prepareTaskScript("Secret prompt.", expectedHref),
          context,
        ),
      ).toEqual({ navigated: true });
      expect(
        vm.runInContext(activateTaskScript(expectedHref), context),
      ).toEqual({ navigated: true });
      expect(contacts.typed).toEqual([]);
      expect(contacts.clicked).toBe(0);
    }
  });
});

describe("candidate public source route (synthetic observations)", () => {
  const semanticProbe = (terminal: boolean, text = "**Hello** 👋") => ({
    assistantCount: 1,
    assistantCharacters: 0,
    assistantText: "",
    userCount: 1,
    turnUserId: "u",
    turnAssistantId: "a",
    busy: !terminal,
    sendVisible: terminal,
    signInVisible: false,
    errorVisible: false,
    publicFrame: {
      userId: "u",
      terminal,
      messages: [{ id: "a", text, channel: "answer", complete: terminal }],
    },
  });

  for (const method of ["initial", "resumed"] as const) {
    const invoke = (
      candidate: ChatGptRoute,
      observer: Parameters<ChatGptRoute["runReadonlyTask"]>[2],
    ) =>
      method === "initial"
        ? candidate.runReadonlyTask("hello", [], observer)
        : candidate.observeReadonlyTask(
            { prompt: "hello", turnUserId: "u", turnAssistantId: "a" },
            observer,
          );
    const executor = () => {
      const execute = vi.fn();
      if (method === "initial")
        execute
          .mockResolvedValueOnce(prepared)
          .mockResolvedValueOnce({ activated: true });
      return execute;
    };
    it(`${method}: sends Markdown once and never also delivers text deltas`, async () => {
      const execute = executor()
        .mockResolvedValueOnce(semanticProbe(false))
        .mockResolvedValueOnce(semanticProbe(true));
      const items: unknown[] = [];
      const delta = vi.fn();
      const candidate = streamingTaskRoute(
        execute,
        1000,
        { running: false },
        "message-anchors-v1",
      );
      expect(
        await invoke(candidate, {
          onVisibleItem: (item) => {
            items.push(item);
          },
          onTextDelta: delta,
        }),
      ).toMatchObject({
        state: "completed",
        outputText: "**Hello** 👋",
        deltaCount: 1,
        turnUserId: "u",
        turnAssistantId: "a",
      });
      expect(items).toEqual([
        { id: "a", sequence: 1, channel: "answer", text: "**Hello** 👋" },
      ]);
      expect(delta).not.toHaveBeenCalled();
      if (method === "resumed") {
        expect(
          execute.mock.calls.every(
            ([script]) => !script.includes("send.click()"),
          ),
        ).toBe(true);
        expect(execute.mock.calls[0]![0]).toContain('"userId":"u"');
      }
    });
    it(`${method}: public status and commentary arrive while the answer remains pending`, async () => {
      const pending = {
        ...semanticProbe(false),
        publicFrame: {
          userId: "u",
          terminal: false,
          messages: [
            { id: "a", channel: "status", text: "Searching", complete: true },
            {
              id: "b",
              channel: "commentary",
              text: "Checking",
              complete: true,
            },
            { id: "c", channel: "answer", text: "Partial", complete: false },
          ],
        },
      };
      let finalRead = false;
      const execute = executor()
        .mockResolvedValueOnce(pending)
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 520));
          return pending;
        })
        .mockImplementationOnce(async () => {
          finalRead = true;
          return {
            ...semanticProbe(true),
            publicFrame: {
              userId: "u",
              terminal: true,
              messages: [
                ...pending.publicFrame.messages.slice(0, 2),
                {
                  id: "c",
                  channel: "answer",
                  text: "**Done** 👋",
                  complete: true,
                },
              ],
            },
          };
        });
      const observations: { channel: string; finalRead: boolean }[] = [];
      const candidate = streamingTaskRoute(
        execute,
        2000,
        { running: false },
        "message-anchors-v1",
      );
      expect(
        await invoke(candidate, {
          onVisibleItem: (item) => {
            observations.push({ channel: item.channel, finalRead });
          },
        }),
      ).toMatchObject({
        state: "completed",
        outputText: "**Done** 👋",
        deltaCount: 3,
      });
      expect(observations).toEqual([
        { channel: "status", finalRead: false },
        { channel: "commentary", finalRead: false },
        { channel: "answer", finalRead: true },
      ]);
    });
    it.each(["throw", "cancel"] as const)(
      `${method}: preserves the acknowledged answer prefix on %s during batch delivery`,
      async (failure) => {
        const execute = executor().mockResolvedValueOnce({
          ...semanticProbe(true),
          publicFrame: {
            userId: "u",
            terminal: true,
            messages: [
              { id: "a", channel: "answer", text: "A", complete: true },
              { id: "b", channel: "answer", text: "B", complete: true },
            ],
          },
        });
        const candidate = streamingTaskRoute(
          execute,
          1000,
          { running: false },
          "message-anchors-v1",
        );
        let delivered = 0;
        expect(
          await invoke(candidate, {
            onVisibleItem: async () => {
              if (++delivered === 2) throw new Error("delivery refused");
              if (failure === "cancel") await candidate.cancelActiveTask();
            },
          }),
        ).toMatchObject({
          state: "outcome_unknown",
          deltaCount: 1,
          outputText: "A",
          observedCharacters: 1,
        });
      },
    );
    it(`${method}: missing qualified frame is unknown without legacy fallback`, async () => {
      const execute = executor().mockResolvedValueOnce({
        ...semanticProbe(true),
        publicFrame: undefined,
        assistantText: "legacy",
      });
      const onTextDelta = vi.fn();
      const candidate = streamingTaskRoute(
        execute,
        1000,
        { running: false },
        "message-anchors-v1",
      );
      expect(
        await invoke(candidate, { onVisibleItem: vi.fn(), onTextDelta }),
      ).toMatchObject({ state: "outcome_unknown" });
      expect(onTextDelta).not.toHaveBeenCalled();
    });
    it(`${method}: cancellation during delivery prevents completion`, async () => {
      const execute = executor().mockResolvedValueOnce(semanticProbe(true));
      const candidate = streamingTaskRoute(
        execute,
        1000,
        { running: false },
        "message-anchors-v1",
      );
      expect(
        await invoke(candidate, {
          onVisibleItem: async () => {
            await candidate.cancelActiveTask();
          },
        }),
      ).toMatchObject({ state: "outcome_unknown" });
    });
    it(`${method}: a broken display observer cannot complete`, async () => {
      const execute = executor().mockResolvedValueOnce(semanticProbe(true));
      const candidate = streamingTaskRoute(
        execute,
        1000,
        { running: false },
        "message-anchors-v1",
      );
      expect(
        await invoke(candidate, {
          onVisibleItem: () => {
            throw new Error("display closed");
          },
        }),
      ).toMatchObject({ state: "outcome_unknown" });
    });
  }
});

describe("serialized task probe correlation (synthetic DOM)", () => {
  class Message {
    readonly parentElement = null;
    constructor(
      readonly id: string,
      readonly role: string,
      readonly innerText: string,
      readonly hidden = false,
    ) {}
    getAttribute(name: string) {
      return name === "data-message-id"
        ? this.id
        : name === "data-message-author-role"
          ? this.role
          : null;
    }
    closest(selector: string) {
      return selector === "[data-message-id]" ? this : null;
    }
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    }
  }
  const probe = (
    messages: Message[],
    userId: string | null,
    assistantId: string | null = null,
    options: Readonly<{
      baseline?: readonly string[];
      appName?: string;
      semantic?: boolean;
    }> = {},
  ) =>
    vm.runInNewContext(
      taskProbeScript(
        "same prompt",
        options.baseline ?? [],
        {
          semantic: options.semantic ?? false,
          userId,
          assistantId,
        },
        options.appName,
      ),
      {
        HTMLElement: Message,
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        document: {
          querySelector: () => null,
          querySelectorAll: (selector: string) =>
            selector ===
            '[data-message-author-role="user"],[data-message-author-role="assistant"]'
              ? messages
              : selector === '[data-message-author-role="user"]'
                ? messages.filter((message) => message.role === "user")
                : [],
        },
      },
    );
  for (const semantic of [false, true]) {
    const options = { appName: "Farol Dev", semantic };
    it(`keeps the exact app-prefix match with source identity, semantic=${semantic}`, () => {
      expect(
        probe(
          [new Message("u1", "user", "Farol Dev\nsame prompt")],
          null,
          null,
          options,
        ),
      ).toMatchObject({ turnUserId: "u1" });
    });
    it(`refuses ambiguous app-prefixed new messages, semantic=${semantic}`, () => {
      expect(() =>
        probe(
          [
            new Message("u1", "user", "Farol Dev same prompt"),
            new Message("u2", "user", "Farol Dev same prompt"),
          ],
          null,
          null,
          options,
        ),
      ).toThrow("CHATGPT_PUBLIC_USER_AMBIGUOUS");
    });
    it(`does not mistake the baseline app-prefixed message for a new reply, semantic=${semantic}`, () => {
      expect(
        probe(
          [
            new Message("old", "user", "Farol Dev same prompt"),
            new Message("new", "user", "Farol Dev same prompt"),
          ],
          null,
          null,
          { ...options, baseline: ["old"] },
        ),
      ).toMatchObject({ turnUserId: "new" });
    });
    it(`resumes the retained app-prefixed user instead of another text match, semantic=${semantic}`, () => {
      expect(
        probe(
          [
            new Message("old", "user", "Farol Dev same prompt"),
            new Message("new", "user", "Farol Dev same prompt"),
          ],
          "old",
          null,
          { ...options, baseline: ["old"] },
        ),
      ).toMatchObject({ turnUserId: "old" });
      expect(
        probe(
          [new Message("new", "user", "Farol Dev same prompt")],
          "old",
          null,
          options,
        ),
      ).toMatchObject({ turnUserId: null });
    });
    it(`does not accept a different, absent or hidden app-prefix match, semantic=${semantic}`, () => {
      for (const text of [
        "Farol Other same prompt",
        "Farol Dev Other same prompt",
      ]) {
        expect(
          probe([new Message("u1", "user", text)], null, null, options),
        ).toMatchObject({ turnUserId: null });
      }
      expect(
        probe(
          [new Message("u1", "user", "Farol Dev same prompt")],
          null,
          null,
          { semantic },
        ),
      ).toMatchObject({ turnUserId: null });
      expect(
        probe(
          [new Message("u1", "user", "Farol Dev same prompt", true)],
          null,
          null,
          options,
        ),
      ).toMatchObject({ turnUserId: null });
    });
  }

  it("refuses duplicate matching new prompts rather than choosing the newest turn", () => {
    expect(() =>
      probe(
        [
          new Message("u1", "user", "same prompt"),
          new Message("u2", "user", "same prompt"),
        ],
        null,
      ),
    ).toThrow("CHATGPT_PUBLIC_USER_AMBIGUOUS");
  });
  it("resolves the exact retained user and stops at the next user", () => {
    expect(
      probe(
        [
          new Message("u1", "user", "same prompt"),
          new Message("a1", "assistant", "owned"),
          new Message("u2", "user", "same prompt"),
          new Message("a2", "assistant", "other"),
        ],
        "u1",
      ),
    ).toMatchObject({
      turnUserId: "u1",
      turnAssistantId: "a1",
      assistantText: "owned",
    });
  });
  it("does not manufacture a retained assistant ID when the actual legacy source changed", () => {
    expect(
      probe(
        [
          new Message("u1", "user", "same prompt"),
          new Message("replacement", "assistant", "other"),
        ],
        "u1",
        "a1",
      ),
    ).toMatchObject({ turnAssistantId: "replacement" });
  });
  it("never uses a different prompt match when the retained user is virtualized", () => {
    expect(
      probe(
        [
          new Message("u2", "user", "same prompt"),
          new Message("a2", "assistant", "other"),
        ],
        "u1",
      ),
    ).toMatchObject({
      turnUserId: null,
      turnAssistantId: null,
      assistantText: "",
    });
  });
});

describe("per-operation NEW app verification target", () => {
  it.each(["missing", "ambiguous", "conflict", "draft_present"] as const)(
    "fails closed for %s without typing or sending",
    async (reason) => {
      const execute = vi.fn().mockResolvedValue({ state: "blocked", reason });
      const candidate = devTaskRoute(execute);
      const result = await candidate.runReadonlyTask(
        "local fixture",
        [],
        {},
        "ordinary",
        { name: "NEW fixture" },
      );
      expect(result.state).toBe("failed_before_submit");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toContain('"NEW fixture"');
      expect(execute.mock.calls[0]?.[0]).not.toContain('"Farol DEV"');
      expect(execute.mock.calls[0]?.[0]).not.toContain("send.click()");
      execute.mockClear();
      await candidate.runReadonlyTask("old default unchanged");
      expect(execute.mock.calls[0]?.[0]).toContain('"Farol DEV"');
    },
  );
  it("refuses an invalid target before opening or navigating a page", async () => {
    const execute = vi.fn();
    const candidate = devTaskRoute(execute);
    expect(
      await candidate.runReadonlyTask("local fixture", [], {}, "ordinary", {
        name: "NEW\nfixture",
      }),
    ).toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_APP_TARGET_INVALID",
    });
    expect(candidate.open).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("carries the same target through prepare and the final pre-Send app fence", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ state: "blocked", reason: "missing" });
    const candidate = devTaskRoute(execute);
    expect(
      await candidate.runReadonlyTask("local fixture", [], {}, "ordinary", {
        name: "NEW fixture",
      }),
    ).toMatchObject({
      state: "failed_before_submit",
      code: "CHATGPT_APP_SELECTION_LOST",
    });
    expect(execute).toHaveBeenCalledTimes(3);
    for (const [script] of execute.mock.calls) {
      expect(script).toContain('"NEW fixture"');
      expect(script).not.toContain('"Farol DEV"');
      expect(script).not.toContain("send.click()");
    }
  });
});

describe("connector receipt completion before provider output", () => {
  function fixture(activation: unknown = { activated: true }) {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ state: "bound" })
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ state: "bound" })
      .mockImplementationOnce(async () => {
        if (activation instanceof Error) throw activation;
        return activation;
      })
      .mockResolvedValue({
        assistantCount: 1,
        assistantCharacters: 0,
        assistantText: "",
        userCount: 1,
        turnUserId: "user-current",
        turnAssistantId: "assistant-current",
        busy: true,
        sendVisible: false,
        signInVisible: false,
        errorVisible: false,
      });
    const candidate = streamingTaskRoute(execute, 50);
    Reflect.set(
      candidate,
      "prepareTemporaryInstantProfile",
      vi.fn(async () => null),
    );
    return { execute, candidate };
  }

  it("releases the route on an exact local receipt without claiming a model answer", async () => {
    const { execute, candidate } = fixture();
    const readConnectorReceipt = vi.fn(async () => true);
    expect(
      await candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({
      state: "receipt_confirmed",
      code: null,
      observedCharacters: 0,
      outputText: "",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(readConnectorReceipt).toHaveBeenCalledTimes(1);
    expect(Reflect.get(candidate, "taskInFlight")).toBe(false);
  });

  it("keeps a missing or rejected proof unknown without a second send", async () => {
    const { execute, candidate } = fixture();
    const readConnectorReceipt = vi.fn(async () => false);
    expect(
      await candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({ state: "outcome_unknown", code: "CHATGPT_TASK_TIMEOUT" });
    expect(readConnectorReceipt).toHaveBeenCalled();
    expect(
      execute.mock.calls.filter(([script]) =>
        String(script).includes("send.click()"),
      ),
    ).toHaveLength(1);
  });

  it("never invokes receipt completion after a lost send acknowledgement", async () => {
    const { execute, candidate } = fixture(new Error("ack lost"));
    const readConnectorReceipt = vi.fn(async () => true);
    expect(
      await candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({ state: "outcome_unknown" });
    expect(readConnectorReceipt).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("bounds a stalled read-only receipt probe and releases its route", async () => {
    const { candidate } = fixture();
    const readConnectorReceipt = vi.fn(() => new Promise<boolean>(() => {}));
    expect(
      await candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({ state: "outcome_unknown", code: "CHATGPT_TASK_TIMEOUT" });
    expect(readConnectorReceipt).toHaveBeenCalledTimes(1);
    expect(Reflect.get(candidate, "taskInFlight")).toBe(false);
  });

  it("preserves the first created conversation while waiting for its receipt", async () => {
    const { candidate } = fixture();
    let url = "https://chatgpt.com/";
    Reflect.get(candidate, "routeWindow").webContents.getURL = () => url;
    const readConnectorReceipt = vi
      .fn()
      .mockImplementationOnce(async () => {
        url = "https://chatgpt.com/c/00000000-0000-4000-8000-000000000007";
        return false;
      })
      .mockResolvedValue(true);
    expect(
      await candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({ state: "receipt_confirmed" });
    expect(readConnectorReceipt).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "close"] as const)(
    "releases a stalled receipt observation on %s without another send",
    async (reason) => {
      const { candidate } = fixture();
      Reflect.get(candidate, "options").taskTimeoutMs = 5_000;
      const readConnectorReceipt = vi.fn(() => new Promise<boolean>(() => {}));
      const result = candidate.runReadonlyTask(
        "connection fixture",
        [],
        { readConnectorReceipt },
        "temporary-instant",
        { name: "NEW fixture" },
      );
      await vi.waitFor(() =>
        expect(readConnectorReceipt).toHaveBeenCalledTimes(1),
      );
      if (reason === "cancel") candidate.cancelActiveTask();
      else Reflect.set(candidate, "routeWindow", null);
      expect(await result).toMatchObject({
        state: "outcome_unknown",
        code: "CHATGPT_TASK_PAGE_LOST",
      });
      expect(Reflect.get(candidate, "taskInFlight")).toBe(false);
      expect(readConnectorReceipt).toHaveBeenCalledTimes(1);
    },
  );

  it("does not grant receipt completion to an ordinary task", async () => {
    const { candidate } = fixture();
    const readConnectorReceipt = vi.fn(async () => true);
    expect(
      await candidate.runReadonlyTask(
        "ordinary fixture",
        [],
        { readConnectorReceipt },
        "ordinary",
        { name: "NEW fixture" },
      ),
    ).toMatchObject({ state: "outcome_unknown" });
    expect(readConnectorReceipt).not.toHaveBeenCalled();
  });
});

describe("saved conversation physical binding (mock Electron only)", () => {
  const conversationUrl =
    "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
  function savedRoute(qualified = true) {
    const candidate = new ChatGptRoute({
      homeUrl: "https://chatgpt.com/",
      initialUrl: conversationUrl,
      e2eOrigin: null,
      parent: () => null,
      requiredAppName: "Farol DEV",
      ...(qualified
        ? { publicOutputProfile: "message-anchors-v1" as const }
        : {}),
    });
    const session = {};
    const execute = vi.fn(async (): Promise<unknown> => ({
      state: "prepared",
      evidenceId: "fixture-evidence",
      selection: {
        model: "Test model",
        effort: "Light",
        connector: { id: "plugin_asdk_app_TEST", label: "Farol DEV" },
      },
    }));
    const surface = {
      isDestroyed: () => false,
      webContents: {
        id: 42,
        session,
        getURL: () => conversationUrl,
        executeJavaScript: execute,
      },
    };
    Reflect.set(candidate, "routeWindow", surface);
    Reflect.set(candidate, "routeSession", session);
    Reflect.set(candidate, "load", "loaded");
    Reflect.set(candidate, "routeDocumentGeneration", 7);
    const binding = candidate.savedChatFollowUpBinding()!;
    const request = {
      binding,
      selection: {
        model: "Test model",
        effort: "Light",
        connector: {
          id: "plugin_asdk_app_TEST",
          label: "Farol DEV",
        },
      },
      previous: { userId: "u1", assistantId: "a1" },
      operation: { id: "op2", state: "not-sent" as const },
      message: "Next",
      digest:
        "1ff57a29d7c42928a559a31e2e4bce3ee6ac34c2fdf30f7f063188b81822f6a7",
      evidenceId: "fixture-evidence",
      correlation: null,
    };
    return { candidate, surface, execute, request };
  }

  it("exposes physical evidence, requires a trusted binding callback and qualification before any script", async () => {
    const { candidate, request, execute } = savedRoute();
    expect(request.binding).toMatchObject({
      viewId: "42",
      viewGeneration: 1,
      documentGeneration: 7,
      conversationUrl,
      partition: "persist:farol-next-chatgpt",
    });
    expect(
      await candidate.savedChatFollowUp(request, "prepare", () => false),
    ).toMatchObject({ state: "awaiting-owner" });
    expect(execute).not.toHaveBeenCalled();
    const unqualified = savedRoute(false);
    expect(
      await unqualified.candidate.savedChatFollowUp(
        unqualified.request,
        "submit",
        () => true,
      ),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_BINDING_UNQUALIFIED",
    });
    expect(unqualified.execute).not.toHaveBeenCalled();
  });

  it.each([
    "viewId",
    "viewGeneration",
    "documentGeneration",
    "conversationId",
    "partition",
  ] as const)(
    "refuses stale %s before touching the composer",
    async (field) => {
      const { candidate, request, execute } = savedRoute();
      const binding = {
        ...request.binding,
        [field]: typeof request.binding[field] === "number" ? 99 : "other",
      };
      expect(
        (
          await candidate.savedChatFollowUp(
            { ...request, binding },
            "submit",
            () => true,
          )
        ).state,
      ).not.toBe("submitted");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("refuses a session mismatch and advances physical generation for a replaced view", () => {
    const { candidate, surface, request } = savedRoute();
    surface.webContents.session = {};
    expect(candidate.savedChatFollowUpBinding()).toBeNull();
    const replacement = {
      ...surface,
      webContents: {
        ...surface.webContents,
        session: Reflect.get(candidate, "routeSession"),
        id: 43,
      },
    };
    Reflect.set(candidate, "routeWindow", replacement);
    expect(candidate.savedChatFollowUpBinding()).toMatchObject({
      viewId: "43",
      viewGeneration: request.binding.viewGeneration + 1,
    });
  });

  it.each(["document", "view", "lease", "load"])(
    "keeps a lost %s after possible Send unknown, without replay",
    async (change) => {
      const { candidate, surface, request, execute } = savedRoute();
      let admitted = true;
      execute.mockImplementation(async () => {
        if (change === "document")
          Reflect.set(candidate, "routeDocumentGeneration", 8);
        if (change === "view")
          Reflect.set(candidate, "routeWindow", { ...surface });
        if (change === "lease") admitted = false;
        if (change === "load") Reflect.set(candidate, "load", "failed");
        return {
          state: "submitted",
          evidenceId: request.evidenceId,
          selection: request.selection,
        };
      });
      expect(
        await candidate.savedChatFollowUp(request, "submit", () => admitted),
      ).toEqual({ state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks concurrent mutation and classifies a malformed or lost Send acknowledgement as unknown", async () => {
    const { candidate, request, execute } = savedRoute();
    let finish!: (value: unknown) => void;
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = candidate.savedChatFollowUp(request, "submit", () => true);
    expect(
      await candidate.savedChatFollowUp(request, "submit", () => true),
    ).toEqual({ state: "not-sent", code: "SAVED_CHAT_OPERATION_UNSETTLED" });
    expect(execute).toHaveBeenCalledTimes(1);
    finish({ state: "submitted", selection: { model: "unknown" } });
    expect(await pending).toEqual({
      state: "unknown",
      code: "SAVED_CHAT_SEND_UNKNOWN",
    });
  });

  it("rejects stale same-URL legacy saved-chat reads, preserving first Send navigation support", async () => {
    const { candidate, execute } = savedRoute();
    execute.mockImplementation(async () => {
      Reflect.set(candidate, "routeDocumentGeneration", 8);
      return { verified: true, titleVerified: true };
    });
    expect(
      await candidate.savedChatProof(conversationUrl, "digest", "title", true),
    ).toBeNull();
    execute.mockImplementation(async () => ({ clicked: true }));
    expect(await candidate.savedChatSubmit(conversationUrl, "digest")).toEqual({
      clicked: true,
    });
  });
  it("rejects original unknown/submitted operations before any page execution", async () => {
    const { candidate, request, execute } = savedRoute();
    for (const state of ["unknown", "submitted"] as const) {
      expect(
        await candidate.savedChatFollowUp(
          { ...request, operation: { id: "op2", state } },
          "submit",
          () => true,
        ),
      ).toEqual({ state: "not-sent", code: "SAVED_CHAT_OPERATION_UNSETTLED" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("never re-executes a submit after a rejected transport, including under a replacement operation", async () => {
    const { candidate, request, execute } = savedRoute();
    execute.mockRejectedValue(new Error("Synthetic transport loss"));
    expect(
      await candidate.savedChatFollowUp(request, "submit", () => true),
    ).toEqual({ state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" });
    expect(
      (await candidate.savedChatFollowUp(request, "submit", () => true)).state,
    ).not.toBe("submitted");
    expect(
      (
        await candidate.savedChatFollowUp(
          { ...request, operation: { id: "replacement", state: "not-sent" } },
          "submit",
          () => true,
        )
      ).state,
    ).not.toBe("submitted");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("checks success response selection and observed IDs instead of trusting a typed success envelope", async () => {
    const { candidate, request, execute } = savedRoute();
    execute.mockResolvedValue({
      state: "prepared",
      evidenceId: "fixture-evidence",
      selection: { ...request.selection, effort: "Other" },
    });
    expect(
      await candidate.savedChatFollowUp(request, "prepare", () => true),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_SOURCE_UNSUPPORTED",
    });
    execute.mockResolvedValue({
      state: "observed",
      userId: "u2",
      assistantId: "a2",
      frame: { userId: "foreign", messages: [], terminal: false },
    });
    expect(
      await candidate.savedChatFollowUp(request, "observe", () => true),
    ).toEqual({
      state: "awaiting-owner",
      code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
    });
  });

  it("clears its physical dispatch fuse only for an exact not-sent response", async () => {
    const { candidate, request, execute } = savedRoute();
    execute.mockResolvedValue({
      state: "not-sent",
      code: "SAVED_CHAT_SELECTION_UNSUPPORTED",
    });
    expect(
      (await candidate.savedChatFollowUp(request, "submit", () => true)).state,
    ).toBe("not-sent");
    execute.mockResolvedValue({
      state: "submitted",
      evidenceId: request.evidenceId,
      selection: request.selection,
    });
    expect(
      (await candidate.savedChatFollowUp(request, "submit", () => true)).state,
    ).toBe("submitted");
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
