import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: electronMock.fromPartition },
}));

import {
  ChatGptRoute,
  type ChatGptRouteSurfaceFactory,
} from "../../src/apps/desktop/chatgpt-route";

// The route's host allowlist (`chatgpt-page-policy.ts`) is what keeps the
// managed ChatGPT session — which carries the owner's signed-in cookies —
// from reaching the rest of the web. That module only states the rule;
// `ChatGptRoute.hardenContents` is the code that enforces it, on
// `will-navigate`, `will-redirect` and `setWindowOpenHandler`. A unit test
// of the predicate alone cannot see a consumer that stops asking it, and a
// predicate test written around one shape of typo-domain cannot see the
// allowlist widened around it. So this drives the real production events
// through a real route, with the URLs a weakened allowlist would admit.

// Each entry names the weakening that would let that URL through. Any one of
// them reaching the network means the owner's ChatGPT session was carried to
// a host Farol never approved.
const refusedByPolicy = [
  // `host.endsWith(".chatgpt.com")` widened to `host.endsWith("chatgpt.com")`.
  "https://evilchatgpt.com/",
  // The same widening, spelled as a registrable-suffix confusion.
  "https://chatgpt.com.evil.test/",
  // `host.endsWith(".openai.com")` widened to `host.endsWith("openai.com")`.
  "https://notopenai.com/",
  // The exact sign-in host set turned into a suffix match.
  "https://evil.accounts.google.com/",
  "https://accounts.google.com.evil.test/",
  // The HTTPS requirement dropped, which also strips transport secrecy from
  // the session cookies the route carries.
  "http://chatgpt.com/",
  // Credentials in the URL re-admitted: the host is genuinely ChatGPT, and
  // the URL still hands a secret to whatever answers.
  "https://owner:secret@chatgpt.com/",
  // The E2E loopback fixture admitted without a fixture origin configured.
  "http://127.0.0.1:43123/chatgpt",
  // Non-HTTP schemes, which the allowlist must refuse before any host check.
  "file:///etc/passwd",
  "javascript:alert(1)",
] as const;

const permittedByPolicy = [
  "https://chatgpt.com/",
  "https://auth.openai.com/authorize",
  "https://accounts.google.com/o/oauth2/auth",
] as const;

const guardedNavigationEvents = ["will-navigate", "will-redirect"] as const;

type RouteContents = EventEmitter & {
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
};

function surface() {
  let url = "about:blank";
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => url,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
  });
  return {
    kind: "window" as const,
    webContents: contents,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(async (nextUrl: string) => {
      url = nextUrl;
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
}

async function openedRoute(
  e2eOrigin: string | null = null,
): Promise<{ contents: RouteContents; windowOpenHandler: WindowOpenHandler }> {
  const candidate = surface();
  const home =
    e2eOrigin === null ? "https://chatgpt.com/" : `${e2eOrigin}/chatgpt`;
  const route = new ChatGptRoute({
    homeUrl: home,
    initialUrl: home,
    e2eOrigin,
    parent: () => null,
    surfaceFactory: (() => candidate) as unknown as ChatGptRouteSurfaceFactory,
  });
  await expect(route.open()).resolves.toEqual({ status: "opened" });
  const handler = candidate.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
  expect(handler).toBeTypeOf("function");
  return {
    contents: candidate.webContents,
    windowOpenHandler: handler as WindowOpenHandler,
  };
}

type WindowOpenHandler = (details: { url: string }) => { action: string };

function navigationRefused(contents: RouteContents, url: string): boolean[] {
  return guardedNavigationEvents.map((event) => {
    const prevented = vi.fn();
    contents.emit(event, { preventDefault: prevented }, url);
    return prevented.mock.calls.length > 0;
  });
}

beforeEach(() => {
  const routeSession = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  });
  electronMock.fromPartition.mockReset();
  electronMock.fromPartition.mockReturnValue(routeSession);
});

describe("ChatGPT route network egress allowlist", () => {
  it("refuses every off-allowlist navigation, redirect and popup", async () => {
    const { contents, windowOpenHandler } = await openedRoute();

    for (const url of refusedByPolicy) {
      expect(
        { url, refused: navigationRefused(contents, url) },
        `${url} must be refused on both guarded navigation events`,
      ).toEqual({ url, refused: [true, true] });
      expect(
        windowOpenHandler({ url }),
        `${url} must not open a popup`,
      ).toEqual({ action: "deny" });
    }
  });

  it("still carries the approved sign-in set through the same guards", async () => {
    const { contents, windowOpenHandler } = await openedRoute();

    for (const url of permittedByPolicy) {
      expect(
        { url, refused: navigationRefused(contents, url) },
        `${url} is part of the approved sign-in set`,
      ).toEqual({ url, refused: [false, false] });
      expect(windowOpenHandler({ url }).action).toBe("allow");
    }
  });

  it("admits the E2E fixture only at its exact loopback origin", async () => {
    const fixture = "http://127.0.0.1:43123";
    const { contents, windowOpenHandler } = await openedRoute(fixture);

    expect(
      navigationRefused(contents, `${fixture}/chatgpt/c/farol-next-e2e`),
    ).toEqual([false, false]);

    for (const url of [
      // Port widened away from the port the E2E runner actually bound.
      "http://127.0.0.1:43124/chatgpt",
      // Origin compared by host name rather than by origin.
      "http://localhost:43123/chatgpt",
      // Port dropped from the comparison.
      "http://127.0.0.1/chatgpt",
      // Scheme widened: a fixture origin is loopback HTTP and nothing else.
      "https://127.0.0.1:43123/chatgpt",
    ]) {
      expect(
        { url, refused: navigationRefused(contents, url) },
        `${url} is not the configured fixture origin`,
      ).toEqual({ url, refused: [true, true] });
      expect(windowOpenHandler({ url })).toEqual({ action: "deny" });
    }
  });
});
