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
  installManualAppGateScript,
  classifyChatGptProviderError,
  prepareTaskScript,
  resolveChatGptWindowPresentation,
  verifyChatGptAppScript,
  type ChatGptRouteSurfaceFactory,
  type ChatGptSignInOutcomeDiagnostic,
  type ChatGptSignInBlockedDiagnostic,
} from "../../src/apps/desktop/chatgpt-route";

const prepared = {
  ready: true,
  baselineAssistantCount: 0,
  baselineUserCount: 0,
  baselineMessageIds: [],
} as const;

const attachment: StagedChatGptAttachment = {
  name: "evidence.md",
  mimeType: "text/markdown",
  bytes: 8,
  sha256: "a".repeat(64),
  stagedPath: "/private/tmp/evidence.md",
};

function route(): ChatGptRoute {
  return new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
  });
}

function routedExecutor(
  executeJavaScript: ReturnType<typeof vi.fn>,
  activity: unknown,
) {
  return vi.fn((script: string, userGesture: boolean) =>
    script.includes("const running = [")
      ? Promise.resolve(activity)
      : Reflect.apply(executeJavaScript as unknown as Function, undefined, [
          script,
          userGesture,
        ]),
  );
}

function taskRoute(
  executeJavaScript: ReturnType<typeof vi.fn>,
  activity: unknown = { running: false },
): ChatGptRoute {
  const candidate = route();
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  vi.spyOn(candidate, "observe").mockResolvedValue({
    state: "authenticated",
    code: null,
  });
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
  vi.spyOn(candidate, "observe").mockResolvedValue({
    state: "authenticated",
    code: null,
  });
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
): ChatGptRoute {
  const candidate = new ChatGptRoute({
    homeUrl: "https://chatgpt.com/",
    initialUrl: "https://chatgpt.com/",
    e2eOrigin: null,
    parent: () => null,
    taskPollMs: 1,
    taskTimeoutMs,
  });
  vi.spyOn(candidate, "open").mockResolvedValue({ status: "opened" });
  vi.spyOn(candidate, "observe").mockResolvedValue({
    state: "authenticated",
    code: null,
  });
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

describe("ChatGPT route submission boundary", () => {
  it("opens the rich ChatGPT app picker through native editing", async () => {
    const expectedHref = "https://chatgpt.com/c/native-picker";
    const nativeInputs: string[] = [];
    let pickerVisible = false;
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
      replaceChildren(): void {}
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
          pickerVisible = true;
          return true;
        },
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
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
      vm.runInContext(bindChatGptAppScript("Farol Dev", expectedHref), context),
    ).resolves.toEqual({ state: "bound" });
    expect(nativeInputs).toEqual(["@Farol Dev"]);
  });

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
    vi.spyOn(candidate, "observe").mockResolvedValue({
      state: "authenticated",
      code: null,
    });
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
    vi.spyOn(candidate, "observe").mockResolvedValue({
      state: "authenticated",
      code: null,
    });
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
    vi.spyOn(candidate, "observe").mockResolvedValue({
      state: "authenticated",
      code: null,
    });
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
    vi.spyOn(candidate, "observe").mockResolvedValue({
      state: "authenticated",
      code: null,
    });
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
        return candidate === this;
      }
      getAttribute(_name: string): string | null {
        return null;
      }
      querySelectorAll(_selector: string): readonly StubElement[] {
        return [];
      }
      cloneNode(): StubElement {
        const clone = new (this.constructor as new () => StubElement)();
        clone.textContent = this.textContent;
        clone.innerText = this.innerText;
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
    const composerText =
      options.draft ??
      (options.chipTextInComposer ? (selectedAppName ?? "") : "");
    composer.innerText = composerText;
    composer.textContent = composerText;
    const send = new HTMLButtonElement();
    const appChip = new HTMLElement();
    appChip.textContent = selectedAppName ?? "";
    const appLink = new HTMLElement();
    appLink.textContent = selectedAppName ?? "";
    appLink.getAttribute = (name: string) =>
      name === "href"
        ? "/plugins/plugin_asdk_app_6ab3b56de6d48191beec1e050abb549a"
        : null;
    composer.querySelectorAll = (selector: string) =>
      selector.includes('a[href*="/plugins/plugin_asdk_app_"]')
        ? options.chipTextInComposer && selectedAppName !== undefined
          ? [appLink]
          : []
        : selectedAppName === undefined
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
        if (selector.includes("send-button") || selector.includes("Send")) {
          return send;
        }
        return null;
      },
      querySelectorAll: (): readonly unknown[] => [],
      createTextNode: (text: string) => ({ text }),
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
