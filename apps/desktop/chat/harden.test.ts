import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import {
  hardenRouteContents,
  hardenRouteSession,
  type RouteContentsPorts,
  type RouteContentsTarget,
  type RouteSessionPorts,
  type RouteSessionTarget,
} from "./harden";
import {
  createRoutePermissions,
  type ChatGptWindowPresentation,
  type RouteContents,
} from "./policy";
import type { ChatGptSignInBlockedDiagnostic } from "./signin";

const HOME = "https://chatgpt.com/";
const PAGE = "https://chatgpt.com/c/1";

type Request = Parameters<
  Parameters<RouteSessionTarget["setPermissionRequestHandler"]>[0]
>;
type Check = Parameters<
  Parameters<RouteSessionTarget["setPermissionCheckHandler"]>[0]
>;
type Download = Parameters<Parameters<RouteSessionTarget["on"]>[1]>;

type PageState = {
  destroyed: boolean;
  focused: boolean;
  url: string;
  generation: number | null;
};

// One managed page: its permission owner reports `generation`, which is the
// live value a navigation or a destroy would change under a pending request.
function managedPage(initial: Partial<PageState> = {}) {
  const state: PageState = {
    destroyed: false,
    focused: true,
    url: PAGE,
    generation: 1,
    ...initial,
  };
  const contents: RouteContents = {
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    getURL: () => state.url,
  };
  return { state, contents };
}

type SessionOptions = {
  mediaAccess?: () => Promise<boolean>;
  mediaStatus?: () => string;
};

function sessionHarness(
  page: ReturnType<typeof managedPage> | null,
  options: SessionOptions = {},
) {
  const owners = new WeakMap<RouteContents, () => number | null>();
  if (page) owners.set(page.contents, () => page.state.generation);
  const log: string[] = [];
  let requestHandler:
    Parameters<RouteSessionTarget["setPermissionRequestHandler"]>[0] | null =
    null;
  let checkHandler:
    Parameters<RouteSessionTarget["setPermissionCheckHandler"]>[0] | null =
    null;
  const downloadListeners: Parameters<RouteSessionTarget["on"]>[1][] = [];
  const target: RouteSessionTarget = {
    setPermissionRequestHandler: (handler) => {
      log.push("request-handler");
      requestHandler = handler;
    },
    setPermissionCheckHandler: (handler) => {
      log.push("check-handler");
      checkHandler = handler;
    },
    on: (event, listener) => {
      log.push(event);
      downloadListeners.push(listener);
    },
  };
  const hardened = new WeakSet<RouteSessionTarget>();
  const add = vi.spyOn(hardened, "add");
  const denied: string[] = [];
  const askForMicrophoneAccess = vi.fn(
    options.mediaAccess ?? (() => Promise.resolve(true)),
  );
  const microphoneAccessStatus = vi.fn(
    options.mediaStatus ?? (() => "granted"),
  );
  const ports: RouteSessionPorts<RouteSessionTarget> = {
    permissions: createRoutePermissions(owners),
    hardened,
    askForMicrophoneAccess,
    microphoneAccessStatus,
    permissionDenied: (permission) => {
      log.push(`denied:${permission}`);
      denied.push(permission);
    },
  };
  return {
    target,
    ports,
    log,
    hardened,
    add,
    denied,
    askForMicrophoneAccess,
    microphoneAccessStatus,
    downloadListeners,
    harden: () => hardenRouteSession(target, ports),
    request(
      contents: RouteContents | null,
      permission: string,
      details: Request[3],
    ) {
      const callback = vi.fn<(granted: boolean) => void>();
      requestHandler?.(contents, permission, callback, details);
      return callback;
    },
    check(
      contents: RouteContents | null,
      permission: string,
      origin: string,
      details: Check[3],
    ) {
      return checkHandler?.(contents, permission, origin, details);
    },
    download(
      contents: RouteContents,
      item: Partial<Download[1]> & { gesture?: boolean; initiator?: string },
      frame?: Download[3],
    ) {
      const preventDefault = vi.fn();
      const setSaveDialogOptions = vi.fn(item.setSaveDialogOptions);
      downloadListeners[0]?.(
        { preventDefault },
        {
          hasUserGesture: () => item.gesture ?? true,
          getInitiatorOrigin: () => item.initiator ?? "https://chatgpt.com",
          getFilename: item.getFilename ?? (() => "report.pdf"),
          setSaveDialogOptions,
        },
        contents,
        frame,
      );
      return { preventDefault, setSaveDialogOptions };
    },
  };
}

const mainFrame = { requestingUrl: PAGE, isMainFrame: true };
const audioOnly = { ...mainFrame, mediaTypes: ["audio"] };

describe("hardening a route session", () => {
  it("registers the request handler, the check handler and the download guard in that order, then records the session", () => {
    const h = sessionHarness(managedPage());
    h.harden();
    expect(h.log).toEqual([
      "request-handler",
      "check-handler",
      "will-download",
    ]);
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add).toHaveBeenCalledWith(h.target);
    expect(h.hardened.has(h.target)).toBe(true);
  });

  it("hardens a session once: a second call registers nothing and keeps the first handlers", () => {
    const h = sessionHarness(managedPage());
    h.harden();
    h.harden();
    expect(h.log).toEqual([
      "request-handler",
      "check-handler",
      "will-download",
    ]);
    expect(h.add).toHaveBeenCalledOnce();
  });

  it("hardens another session separately even when the first is done", () => {
    const first = sessionHarness(managedPage());
    first.harden();
    const second = sessionHarness(managedPage());
    second.harden();
    expect(second.log).toHaveLength(3);
  });

  it("records the session only after every handler is installed", () => {
    const h = sessionHarness(managedPage());
    const failing: RouteSessionTarget = {
      ...h.target,
      setPermissionCheckHandler: () => {
        throw new Error("refused");
      },
    };
    expect(() => hardenRouteSession(failing, h.ports)).toThrow("refused");
    expect(h.add).not.toHaveBeenCalled();
  });

  describe("permission requests", () => {
    it("grants a clipboard write only from the main frame of the live managed page at its own origin", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const callback = h.request(
        page.contents,
        "clipboard-sanitized-write",
        mainFrame,
      );
      expect(callback.mock.calls).toEqual([[true]]);
      expect(h.denied).toEqual([]);
      expect(h.askForMicrophoneAccess).not.toHaveBeenCalled();
    });

    it.each([
      [
        "a subframe",
        (p: ReturnType<typeof managedPage>) => p.contents,
        { requestingUrl: PAGE, isMainFrame: false },
      ],
      [
        "a foreign requesting origin",
        (p: ReturnType<typeof managedPage>) => p.contents,
        { requestingUrl: "https://evil.example/c/1", isMainFrame: true },
      ],
      [
        "an unparseable requesting URL",
        (p: ReturnType<typeof managedPage>) => p.contents,
        { requestingUrl: "not a url", isMainFrame: true },
      ],
      ["unmanaged contents", () => managedPage().contents, mainFrame],
      ["no contents", () => null, mainFrame],
    ])("refuses a clipboard write from %s", (_name, contentsOf, details) => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const callback = h.request(
        contentsOf(page),
        "clipboard-sanitized-write",
        details,
      );
      expect(callback.mock.calls).toEqual([[false]]);
      expect(h.denied).toEqual(["clipboard-sanitized-write"]);
    });

    it("refuses a clipboard write when the managed page is destroyed or has no live generation", () => {
      for (const initial of [{ destroyed: true }, { generation: null }]) {
        const page = managedPage(initial);
        const h = sessionHarness(page);
        h.harden();
        expect(
          h.request(page.contents, "clipboard-sanitized-write", mainFrame).mock
            .calls,
        ).toEqual([[false]]);
      }
    });

    it("refuses every other permission, reports it, and answers false after the report", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      for (const permission of [
        "clipboard-read",
        "geolocation",
        "notifications",
        "display-capture",
        "midi",
        "openExternal",
        "unknown",
      ]) {
        const callback = h.request(page.contents, permission, mainFrame);
        expect(callback.mock.calls, permission).toEqual([[false]]);
      }
      expect(h.denied).toEqual([
        "clipboard-read",
        "geolocation",
        "notifications",
        "display-capture",
        "midi",
        "openExternal",
        "unknown",
      ]);
      expect(h.askForMicrophoneAccess).not.toHaveBeenCalled();
    });

    it.each([
      ["a video request", { ...mainFrame, mediaTypes: ["video"] }],
      [
        "an audio and video request",
        { ...mainFrame, mediaTypes: ["audio", "video"] },
      ],
      ["a request naming no media type", { ...mainFrame, mediaTypes: [] }],
      ["a request without media types", mainFrame],
      ["a subframe audio request", { ...audioOnly, isMainFrame: false }],
      [
        "a foreign-origin audio request",
        { ...audioOnly, requestingUrl: "https://evil.example/" },
      ],
    ])(
      "refuses the microphone for %s without asking the system",
      (_n, details) => {
        const page = managedPage();
        const h = sessionHarness(page);
        h.harden();
        const callback = h.request(page.contents, "media", details);
        expect(callback.mock.calls).toEqual([[false]]);
        expect(h.askForMicrophoneAccess).not.toHaveBeenCalled();
        expect(h.denied).toEqual(["media"]);
      },
    );

    it("refuses an audio request for any permission but media", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      expect(
        h.request(page.contents, "clipboard-read", audioOnly).mock.calls,
      ).toEqual([[false]]);
      expect(h.askForMicrophoneAccess).not.toHaveBeenCalled();
    });

    it("refuses the microphone for unmanaged or destroyed contents", () => {
      for (const contents of [
        managedPage().contents,
        managedPage({ destroyed: true }).contents,
        null,
      ]) {
        const h = sessionHarness(managedPage());
        h.harden();
        expect(h.request(contents, "media", audioOnly).mock.calls).toEqual([
          [false],
        ]);
        expect(h.askForMicrophoneAccess).not.toHaveBeenCalled();
      }
    });

    it("asks the system for an audio-only main-frame request and grants only its yes", async () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      expect(h.askForMicrophoneAccess).toHaveBeenCalledOnce();
      expect(callback).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(callback.mock.calls).toEqual([[true]]));
      expect(h.denied).toEqual([]);
    });

    it("refuses when the system says no", async () => {
      const page = managedPage();
      const h = sessionHarness(page, {
        mediaAccess: () => Promise.resolve(false),
      });
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      await vi.waitFor(() => expect(callback.mock.calls).toEqual([[false]]));
    });

    it("refuses when the system prompt rejects", async () => {
      const page = managedPage();
      const h = sessionHarness(page, {
        mediaAccess: () => Promise.reject(new Error("prompt failed")),
      });
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      await vi.waitFor(() => expect(callback.mock.calls).toEqual([[false]]));
    });

    it("refuses at once when asking the system throws", () => {
      const page = managedPage();
      const h = sessionHarness(page, {
        mediaAccess: () => {
          throw new Error("no prompt");
        },
      });
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      expect(callback.mock.calls).toEqual([[false]]);
      expect(h.denied).toEqual([]);
    });

    it("refuses a yes that arrives after the page's generation changed", async () => {
      const page = managedPage();
      let answer: (granted: boolean) => void = () => undefined;
      const h = sessionHarness(page, {
        mediaAccess: () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      });
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      page.state.generation = 2;
      answer(true);
      await vi.waitFor(() => expect(callback.mock.calls).toEqual([[false]]));
    });

    it("refuses a yes that arrives after the page lost its owner or was destroyed", async () => {
      for (const change of [
        (s: PageState) => (s.generation = null),
        (s: PageState) => (s.destroyed = true),
      ]) {
        const page = managedPage();
        let answer: (granted: boolean) => void = () => undefined;
        const h = sessionHarness(page, {
          mediaAccess: () =>
            new Promise<boolean>((resolve) => {
              answer = resolve;
            }),
        });
        h.harden();
        const callback = h.request(page.contents, "media", audioOnly);
        change(page.state);
        answer(true);
        await vi.waitFor(() => expect(callback.mock.calls).toEqual([[false]]));
      }
    });

    it("refuses a yes that arrives after the page navigated to another origin", async () => {
      const page = managedPage();
      let answer: (granted: boolean) => void = () => undefined;
      const h = sessionHarness(page, {
        mediaAccess: () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      });
      h.harden();
      const callback = h.request(page.contents, "media", audioOnly);
      page.state.url = "https://evil.example/";
      answer(true);
      await vi.waitFor(() => expect(callback.mock.calls).toEqual([[false]]));
    });
  });

  describe("permission checks", () => {
    it("answers yes for a main-frame clipboard write from the managed page", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      expect(
        h.check(
          page.contents,
          "clipboard-sanitized-write",
          "https://chatgpt.com",
          {
            isMainFrame: true,
          },
        ),
      ).toBe(true);
      expect(h.microphoneAccessStatus).not.toHaveBeenCalled();
    });

    it.each([
      ["a subframe", { isMainFrame: false }, "https://chatgpt.com"],
      ["a foreign origin", { isMainFrame: true }, "https://evil.example"],
    ])("answers no for a clipboard write from %s", (_n, details, origin) => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      expect(
        h.check(page.contents, "clipboard-sanitized-write", origin, details),
      ).toBe(false);
    });

    it("answers no for unmanaged contents, no contents and other permissions", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const details = { isMainFrame: true };
      expect(
        h.check(
          managedPage().contents,
          "clipboard-sanitized-write",
          "https://chatgpt.com",
          details,
        ),
      ).toBe(false);
      expect(
        h.check(
          null,
          "clipboard-sanitized-write",
          "https://chatgpt.com",
          details,
        ),
      ).toBe(false);
      for (const permission of [
        "geolocation",
        "notifications",
        "clipboard-read",
      ])
        expect(
          h.check(page.contents, permission, "https://chatgpt.com", details),
          permission,
        ).toBe(false);
    });

    it("answers yes for the microphone only for audio, in the main frame, with system access granted", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      expect(
        h.check(page.contents, "media", "https://chatgpt.com", {
          isMainFrame: true,
          mediaType: "audio",
        }),
      ).toBe(true);
      expect(h.microphoneAccessStatus).toHaveBeenCalledWith();
    });

    it.each(["denied", "not-determined", "restricted", "unknown", ""])(
      "answers no for the microphone when the system status is %j",
      (status) => {
        const page = managedPage();
        const h = sessionHarness(page, { mediaStatus: () => status });
        h.harden();
        expect(
          h.check(page.contents, "media", "https://chatgpt.com", {
            isMainFrame: true,
            mediaType: "audio",
          }),
        ).toBe(false);
      },
    );

    it.each([
      ["video", { isMainFrame: true, mediaType: "video" }],
      ["unknown media", { isMainFrame: true, mediaType: "unknown" }],
      ["no media type", { isMainFrame: true }],
      ["a subframe", { isMainFrame: false, mediaType: "audio" }],
    ])(
      "answers no for the microphone check of %s without reading the system",
      (_n, details) => {
        const page = managedPage();
        const h = sessionHarness(page);
        h.harden();
        expect(
          h.check(page.contents, "media", "https://chatgpt.com", details),
        ).toBe(false);
        expect(h.microphoneAccessStatus).not.toHaveBeenCalled();
      },
    );

    it("answers no for a foreign origin without reading the system", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      expect(
        h.check(page.contents, "media", "https://evil.example", {
          isMainFrame: true,
          mediaType: "audio",
        }),
      ).toBe(false);
      expect(h.microphoneAccessStatus).not.toHaveBeenCalled();
    });

    it("answers no when reading the system status throws", () => {
      const page = managedPage();
      const h = sessionHarness(page, {
        mediaStatus: () => {
          throw new Error("no status");
        },
      });
      h.harden();
      expect(
        h.check(page.contents, "media", "https://chatgpt.com", {
          isMainFrame: true,
          mediaType: "audio",
        }),
      ).toBe(false);
    });
  });

  describe("downloads", () => {
    it("offers the Save dialog, named after the file, for a click in the focused managed page", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const result = h.download(page.contents, {});
      expect(result.preventDefault).not.toHaveBeenCalled();
      expect(result.setSaveDialogOptions.mock.calls).toEqual([
        [{ title: "Save download", defaultPath: "report.pdf" }],
      ]);
    });

    it("accepts a same-origin initiating frame or no frame at all", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      for (const frame of [
        undefined,
        null,
        { origin: "https://chatgpt.com" },
      ]) {
        const result = h.download(page.contents, {}, frame);
        expect(result.preventDefault).not.toHaveBeenCalled();
      }
    });

    it.each([
      ["a download with no user gesture", { gesture: false }, undefined],
      [
        "a download started by a foreign origin",
        { initiator: "https://evil.example" },
        undefined,
      ],
      [
        "a download started in a foreign-origin subframe",
        {},
        { origin: "https://evil.example" },
      ],
    ])("cancels %s", (_n, item, frame) => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const result = h.download(page.contents, item, frame);
      expect(result.preventDefault).toHaveBeenCalledOnce();
      expect(result.setSaveDialogOptions).not.toHaveBeenCalled();
    });

    it.each([
      ["an unfocused page", { focused: false }],
      ["a destroyed page", { destroyed: true }],
      ["a page without a live generation", { generation: null }],
    ])("cancels a download from %s", (_n, initial) => {
      const page = managedPage(initial);
      const h = sessionHarness(page);
      h.harden();
      const result = h.download(page.contents, {});
      expect(result.preventDefault).toHaveBeenCalledOnce();
      expect(result.setSaveDialogOptions).not.toHaveBeenCalled();
    });

    it("cancels a download from unmanaged contents", () => {
      const h = sessionHarness(managedPage());
      h.harden();
      const result = h.download(managedPage().contents, {});
      expect(result.preventDefault).toHaveBeenCalledOnce();
    });

    it("cancels a download when the Save dialog cannot be configured", () => {
      const page = managedPage();
      const h = sessionHarness(page);
      h.harden();
      const failingDialog = h.download(page.contents, {
        setSaveDialogOptions: () => {
          throw new Error("dialog");
        },
      });
      expect(failingDialog.preventDefault).toHaveBeenCalledOnce();
      const failingName = h.download(page.contents, {
        getFilename: () => {
          throw new Error("name");
        },
      });
      expect(failingName.preventDefault).toHaveBeenCalledOnce();
      expect(failingName.setSaveDialogOptions).not.toHaveBeenCalled();
    });
  });
});

// The contents -------------------------------------------------------------

type Listener = (...args: never[]) => void;

type ContentsOptions = {
  tracked?: boolean;
  owns?: boolean;
  generation?: number;
  homeUrl?: () => string;
  url?: string;
  presentation?: ChatGptWindowPresentation;
  requiredAppName?: string;
  title?: string;
  allow?: (url: string) => boolean;
};

const popupPreferences = { partition: "p", sandbox: true } as const;

function contentsHarness(options: ContentsOptions = {}) {
  const state = {
    owns: options.owns ?? true,
    generation: options.generation ?? 7,
    url: options.url ?? PAGE,
    title: options.title ?? "ChatGPT",
    openerOwned: true,
  };
  const log: string[] = [];
  const listeners = new Map<string, Listener[]>();
  let windowOpen:
    Parameters<RouteContentsTarget["setWindowOpenHandler"]>[0] | null = null;
  const contents: RouteContentsTarget = {
    isDestroyed: () => false,
    isFocused: () => true,
    getURL: () => state.url,
    on: (event: string, listener: Listener) => {
      log.push(event);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    setWindowOpenHandler: (handler) => {
      log.push("window-open");
      windowOpen = handler;
    },
  };
  const owners = new WeakMap<RouteContentsTarget, () => number | null>();
  const originalSet = owners.set.bind(owners);
  vi.spyOn(owners, "set").mockImplementation((key, value) => {
    log.push("owner");
    return originalSet(key, value);
  });
  const blocked: ChatGptSignInBlockedDiagnostic[] = [];
  const history = vi.fn();
  const trackReadiness = vi.fn(() => {
    log.push("readiness");
  });
  const adopt = vi.fn<(popup: BrowserWindow) => void>();
  const refuse = vi.fn<(popup: BrowserWindow) => void>();
  const ports: RouteContentsPorts<RouteContentsTarget> = {
    allowedUrl:
      options.allow ??
      ((url) => {
        try {
          return new URL(url).origin === "https://chatgpt.com";
        } catch {
          return false;
        }
      }),
    blocked: (diagnostic) => blocked.push(diagnostic),
    tracking:
      options.tracked === false
        ? null
        : {
            owns: () => state.owns,
            publishHistory: history,
            homeUrl: options.homeUrl ?? (() => HOME),
            documentGeneration: () => state.generation,
            owners,
            trackReadiness,
          },
    popups: {
      presentation: () => options.presentation,
      requiredAppName: () => options.requiredAppName,
      title: () => state.title,
      webPreferences: () => popupPreferences,
      openerOwned: () => state.openerOwned,
      refuse,
      adopt,
    },
  };
  hardenRouteContents(contents, ports);
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? [])
      (listener as (...rest: unknown[]) => void)(...args);
  };
  return {
    state,
    contents,
    owners,
    log,
    blocked,
    history,
    trackReadiness,
    adopt,
    refuse,
    listeners,
    emit,
    windowOpen: (url: string) => {
      if (windowOpen === null) throw new Error("no window-open handler");
      return windowOpen({ url });
    },
    navigate(event: "will-navigate" | "will-redirect", url: string) {
      const preventDefault = vi.fn();
      emit(event, { preventDefault }, url);
      return preventDefault.mock.calls.length;
    },
  };
}

describe("hardening a route contents", () => {
  it("registers history, the owner, both guards, readiness, the popup handler and the popup hook in the original order", () => {
    const h = contentsHarness();
    expect(h.log).toEqual([
      "did-navigate",
      "did-navigate-in-page",
      "did-finish-load",
      "owner",
      "will-navigate",
      "will-redirect",
      "readiness",
      "window-open",
      "did-create-window",
    ]);
  });

  it("installs only the guards and the popup handling on contents the route does not drive", () => {
    const h = contentsHarness({ tracked: false });
    expect(h.log).toEqual([
      "will-navigate",
      "will-redirect",
      "window-open",
      "did-create-window",
    ]);
    expect(h.trackReadiness).not.toHaveBeenCalled();
    expect(h.owners.has(h.contents)).toBe(false);
  });

  describe("navigation guards", () => {
    it.each(["will-navigate", "will-redirect"] as const)(
      "lets an allowed %s through without a report",
      (event) => {
        const h = contentsHarness();
        expect(h.navigate(event, "https://chatgpt.com/c/2")).toBe(0);
        expect(h.blocked).toEqual([]);
      },
    );

    it.each(["will-navigate", "will-redirect"] as const)(
      "cancels a refused %s once and reports its host",
      (event) => {
        const h = contentsHarness();
        expect(h.navigate(event, "https://evil.example/path?q=1")).toBe(1);
        expect(h.blocked).toEqual([
          { kind: "navigation-blocked", host: "evil.example" },
        ]);
      },
    );

    it("reports an unparseable refused URL as an unknown host", () => {
      const h = contentsHarness();
      expect(h.navigate("will-navigate", "javascript:alert(1)")).toBe(1);
      expect(h.navigate("will-redirect", "not a url")).toBe(1);
      expect(h.blocked).toEqual([
        { kind: "navigation-blocked", host: "(unknown)" },
        { kind: "navigation-blocked", host: "(unknown)" },
      ]);
    });

    it("asks the allowlist about the exact URL it is handed", () => {
      const seen: string[] = [];
      const h = contentsHarness({
        allow: (url) => {
          seen.push(url);
          return false;
        },
      });
      h.navigate("will-navigate", "https://a.example/");
      h.navigate("will-redirect", "https://b.example/");
      expect(seen).toEqual(["https://a.example/", "https://b.example/"]);
    });

    it("guards contents the route does not drive the same way", () => {
      const h = contentsHarness({ tracked: false });
      expect(h.navigate("will-navigate", "https://evil.example/")).toBe(1);
      expect(h.navigate("will-redirect", "https://chatgpt.com/")).toBe(0);
    });
  });

  describe("history and the permission owner", () => {
    it.each(["did-navigate", "did-navigate-in-page", "did-finish-load"])(
      "publishes the history on %s only while the route owns the contents",
      (event) => {
        const h = contentsHarness();
        h.emit(event);
        expect(h.history).toHaveBeenCalledTimes(1);
        h.state.owns = false;
        h.emit(event);
        expect(h.history).toHaveBeenCalledTimes(1);
      },
    );

    it("registers the permission owner for the route's contents with the live document generation", () => {
      const h = contentsHarness();
      const owner = h.owners.get(h.contents);
      expect(owner?.()).toBe(7);
      h.state.generation = 8;
      expect(owner?.()).toBe(8);
    });

    it("reports no generation once the route stops owning the contents", () => {
      const h = contentsHarness();
      h.state.owns = false;
      expect(h.owners.get(h.contents)?.()).toBeNull();
    });

    it("reports no generation when the page left the home origin", () => {
      const h = contentsHarness();
      h.state.url = "https://accounts.example/login";
      expect(h.owners.get(h.contents)?.()).toBeNull();
      h.state.url = "http://chatgpt.com/";
      expect(h.owners.get(h.contents)?.()).toBeNull();
      h.state.url = "https://chatgpt.com:8443/";
      expect(h.owners.get(h.contents)?.()).toBeNull();
    });

    it("compares against the home URL read at the time of the question", () => {
      let home = HOME;
      const h = contentsHarness({ homeUrl: () => home });
      const owner = h.owners.get(h.contents);
      expect(owner?.()).toBe(7);
      home = "https://other.example/";
      expect(owner?.()).toBeNull();
    });

    it("lets an unreadable URL throw to the permission layer, which refuses it", () => {
      const h = contentsHarness({ homeUrl: () => "not a url" });
      const owner = h.owners.get(h.contents);
      expect(() => owner?.()).toThrow();
      const permissions = createRoutePermissions(h.owners);
      expect(permissions.generation(h.contents)).toBeNull();
    });
  });

  describe("popups", () => {
    it("denies every popup from an opener that is not the route's own surface", () => {
      const h = contentsHarness();
      h.state.openerOwned = false;
      expect(h.windowOpen("https://chatgpt.com/auth")).toEqual({
        action: "deny",
      });
      expect(h.blocked).toEqual([]);
    });

    it("refuses a popup to an off-allowlist URL and reports its host", () => {
      const h = contentsHarness();
      expect(h.windowOpen("https://evil.example/x")).toEqual({
        action: "deny",
      });
      expect(h.windowOpen("not a url")).toEqual({ action: "deny" });
      expect(h.blocked).toEqual([
        { kind: "popup-blocked", host: "evil.example" },
        { kind: "popup-blocked", host: "(unknown)" },
      ]);
    });

    it("allows an allowlisted popup as a sandboxed remote-content window that shows when the platform decides", () => {
      const h = contentsHarness({ title: "Farol" });
      expect(h.windowOpen("https://chatgpt.com/auth")).toEqual({
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "Sign in · Farol",
          frame: true,
          titleBarStyle: "default",
          width: 720,
          height: 760,
          backgroundColor: "#111216",
          webPreferences: popupPreferences,
        },
      });
      expect(h.blocked).toEqual([]);
    });

    it("reads the title when the popup opens, not when the contents is hardened", () => {
      const h = contentsHarness({ title: "First" });
      h.state.title = "Second";
      const response = h.windowOpen("https://chatgpt.com/auth");
      expect(response).toMatchObject({
        overrideBrowserWindowOptions: { title: "Sign in · Second" },
      });
    });

    it("opens the popup hidden when a window presentation is set", () => {
      const h = contentsHarness({ presentation: { mode: "hidden" } });
      expect(h.windowOpen("https://chatgpt.com/auth")).toMatchObject({
        action: "allow",
        overrideBrowserWindowOptions: { show: false },
      });
    });

    it("opens the popup hidden when the route is bound to an app", () => {
      const h = contentsHarness({ requiredAppName: "Farol" });
      expect(h.windowOpen("https://chatgpt.com/auth")).toMatchObject({
        action: "allow",
        overrideBrowserWindowOptions: { show: false },
      });
    });

    it("places a secondary-display popup at the exact bounds, hidden", () => {
      const h = contentsHarness({
        presentation: {
          mode: "secondary-visible",
          place: () => ({ x: -1200, y: 40, width: 720, height: 760 }),
        },
      });
      expect(h.windowOpen("https://chatgpt.com/auth")).toMatchObject({
        action: "allow",
        overrideBrowserWindowOptions: {
          x: -1200,
          y: 40,
          width: 720,
          height: 760,
          show: false,
        },
      });
    });

    it.each([
      [
        "placement throws",
        () => {
          throw new Error("no display");
        },
      ],
      [
        "placement is the wrong size",
        () => ({ x: 0, y: 0, width: 600, height: 760 }),
      ],
      [
        "placement is not an integer",
        () => ({ x: 0.5, y: 0, width: 720, height: 760 }),
      ],
    ])("refuses the popup when %s", (_n, place) => {
      const h = contentsHarness({
        presentation: { mode: "secondary-visible", place },
      });
      expect(h.windowOpen("https://chatgpt.com/auth")).toEqual({
        action: "deny",
      });
      expect(h.blocked).toEqual([]);
    });

    it("decides the allowlist before the presentation", () => {
      const place = vi.fn(() => ({ x: 0, y: 0, width: 720, height: 760 }));
      const h = contentsHarness({
        presentation: { mode: "secondary-visible", place },
      });
      expect(h.windowOpen("https://evil.example/")).toEqual({ action: "deny" });
      expect(place).not.toHaveBeenCalled();
    });

    it("hands each created window to the route, and only the window", () => {
      const h = contentsHarness();
      const popup = {} as BrowserWindow;
      h.emit("did-create-window", popup, { url: "https://chatgpt.com/auth" });
      expect(h.adopt.mock.calls).toEqual([[popup]]);
    });

    it("hands a created window whose opener lost authority to the route's refusal, never to adoption", () => {
      const h = contentsHarness();
      h.state.openerOwned = false;
      const popup = {} as BrowserWindow;
      h.emit("did-create-window", popup);
      expect(h.refuse.mock.calls).toEqual([[popup]]);
      expect(h.adopt).not.toHaveBeenCalled();
    });
  });
});
