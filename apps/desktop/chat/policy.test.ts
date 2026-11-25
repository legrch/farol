import { describe, expect, it, vi } from "vitest";
import {
  appBindingFailureCode,
  classifyChatGptProviderError,
  createRoutePermissions,
  hostOf,
  isChatGptPage,
  resolveChatGptWindowPresentation,
  type ChatGptWindowPresentation,
  type RouteContents,
} from "./policy";

type Contents = Readonly<{
  destroyed: boolean;
  focused: boolean;
  url: string;
}>;

function contentsOf(state: Partial<Contents> = {}): RouteContents {
  const { destroyed, focused, url }: Contents = {
    destroyed: false,
    focused: true,
    url: "https://chatgpt.com/c/1",
    ...state,
  };
  return {
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    getURL: () => url,
  };
}

function permissionsFor(
  contents: RouteContents,
  generation: number | null = 1,
) {
  const owners = new WeakMap<RouteContents, () => number | null>();
  owners.set(contents, () => generation);
  return createRoutePermissions(owners);
}

describe("the provider error class", () => {
  it("reads a usage, message or rate limit as usage_limited", () => {
    for (const text of [
      "You've reached your usage limit",
      "Message limit reached",
      "Rate limit exceeded",
      "limit has been reached",
      "Too many requests",
      "TOO MANY REQUESTS",
    ])
      expect(classifyChatGptProviderError(text)).toBe("usage_limited");
  });

  it("calls everything else generic, including the empty text", () => {
    expect(classifyChatGptProviderError("Something went wrong")).toBe(
      "generic",
    );
    expect(classifyChatGptProviderError("")).toBe("generic");
  });
});

describe("the app binding failure code", () => {
  it("maps every blocked reason to its own code", () => {
    expect(appBindingFailureCode("missing")).toBe(
      "CHATGPT_APP_SELECTION_MISSING",
    );
    expect(appBindingFailureCode("ambiguous")).toBe(
      "CHATGPT_APP_SELECTION_AMBIGUOUS",
    );
    expect(appBindingFailureCode("conflict")).toBe(
      "CHATGPT_APP_SELECTION_CONFLICT",
    );
    expect(appBindingFailureCode("draft_present")).toBe(
      "CHATGPT_COMPOSER_DRAFT_PRESENT",
    );
    expect(appBindingFailureCode("selection_not_observed")).toBe(
      "CHATGPT_APP_SELECTION_LOST",
    );
  });
});

describe("the host of a URL", () => {
  it("is the hostname, without port, path or credentials", () => {
    expect(hostOf("https://chatgpt.com/c/1?x=1")).toBe("chatgpt.com");
    expect(hostOf("http://127.0.0.1:8080/a")).toBe("127.0.0.1");
    expect(hostOf("https://user:pw@auth.openai.com/x")).toBe("auth.openai.com");
  });

  it("is (unknown) for text that is not a URL or has no host", () => {
    expect(hostOf("not a url")).toBe("(unknown)");
    expect(hostOf("")).toBe("(unknown)");
    expect(hostOf("about:blank")).toBe("(unknown)");
  });
});

describe("a ChatGPT page", () => {
  const home = "https://chatgpt.com/";

  it("is ChatGPT's or OpenAI's own host or any subdomain of them", () => {
    for (const url of [
      "https://chatgpt.com/c/1",
      "https://www.chatgpt.com/",
      "https://a.b.chatgpt.com/",
      "https://openai.com/",
      "https://auth.openai.com/log-in",
    ])
      expect(isChatGptPage(url, home)).toBe(true);
  });

  it("is the home page's own host even when it is a test origin", () => {
    expect(
      isChatGptPage("http://127.0.0.1:9000/c/1", "http://127.0.0.1:9000/"),
    ).toBe(true);
  });

  it("is never an identity provider, a look-alike or an unreadable URL", () => {
    for (const url of [
      "https://accounts.google.com/",
      "https://appleid.apple.com/",
      "https://login.microsoftonline.com/",
      "https://notchatgpt.com/",
      "https://chatgpt.com.evil.test/",
      "https://evilopenai.com/",
      "garbage",
    ])
      expect(isChatGptPage(url, home)).toBe(false);
  });

  it("does not take two unreadable URLs as the same host", () => {
    expect(isChatGptPage("garbage", "also garbage")).toBe(true);
  });
});

describe("the route permission generation", () => {
  it("is the owner's current generation for a live contents", () => {
    const contents = contentsOf();
    expect(permissionsFor(contents, 7).generation(contents)).toBe(7);
  });

  it("is null for no contents, a destroyed one, an unowned one or a throwing owner", () => {
    const owned = contentsOf();
    const permissions = permissionsFor(owned);
    expect(permissions.generation(null)).toBeNull();
    expect(permissions.generation(contentsOf())).toBeNull();
    const destroyed = contentsOf({ destroyed: true });
    expect(permissionsFor(destroyed).generation(destroyed)).toBeNull();
    const owners = new WeakMap<RouteContents, () => number | null>();
    owners.set(owned, () => {
      throw new Error("owner gone");
    });
    expect(createRoutePermissions(owners).generation(owned)).toBeNull();
  });

  it("follows the owner at each call", () => {
    const contents = contentsOf();
    let generation: number | null = 1;
    const owners = new WeakMap<RouteContents, () => number | null>();
    owners.set(contents, () => generation);
    const permissions = createRoutePermissions(owners);
    expect(permissions.generation(contents)).toBe(1);
    generation = 2;
    expect(permissions.generation(contents)).toBe(2);
    generation = null;
    expect(permissions.generation(contents)).toBeNull();
  });
});

describe("a download", () => {
  const origin = "https://chatgpt.com";
  const item = (
    init: Partial<{ gesture: boolean; initiator: string }> = {},
  ) => ({
    hasUserGesture: () => init.gesture ?? true,
    getInitiatorOrigin: () => init.initiator ?? origin,
  });

  it("is the owner's when they clicked it in the focused managed page", () => {
    const contents = contentsOf();
    const { downloadAllowed } = permissionsFor(contents);
    expect(downloadAllowed(contents, item())).toBe(true);
    expect(downloadAllowed(contents, item(), { origin })).toBe(true);
  });

  it("is refused without contents, without an item or for a destroyed contents", () => {
    const contents = contentsOf();
    const { downloadAllowed } = permissionsFor(contents);
    expect(downloadAllowed(null, item())).toBe(false);
    expect(downloadAllowed(undefined, item())).toBe(false);
    expect(downloadAllowed(contents, null)).toBe(false);
    expect(downloadAllowed(contents, undefined)).toBe(false);
    const destroyed = contentsOf({ destroyed: true });
    expect(permissionsFor(destroyed).downloadAllowed(destroyed, item())).toBe(
      false,
    );
  });

  it("is refused for a contents this route does not own", () => {
    const { downloadAllowed } = permissionsFor(contentsOf());
    expect(downloadAllowed(contentsOf(), item())).toBe(false);
    const contents = contentsOf();
    expect(
      permissionsFor(contents, null).downloadAllowed(contents, item()),
    ).toBe(false);
  });

  it("is refused when the page is not focused or the click was no gesture", () => {
    const unfocused = contentsOf({ focused: false });
    expect(permissionsFor(unfocused).downloadAllowed(unfocused, item())).toBe(
      false,
    );
    const contents = contentsOf();
    expect(
      permissionsFor(contents).downloadAllowed(
        contents,
        item({ gesture: false }),
      ),
    ).toBe(false);
  });

  it("is refused when another origin started it, or the frame is foreign", () => {
    const contents = contentsOf();
    const { downloadAllowed } = permissionsFor(contents);
    expect(
      downloadAllowed(contents, item({ initiator: "https://evil.test" })),
    ).toBe(false);
    expect(
      downloadAllowed(contents, item(), { origin: "https://evil.test" }),
    ).toBe(false);
    expect(downloadAllowed(contents, item(), null)).toBe(true);
  });

  it("is refused for an opaque page origin or a URL that cannot be read", () => {
    const opaque = contentsOf({ url: "about:blank" });
    expect(
      permissionsFor(opaque).downloadAllowed(
        opaque,
        item({ initiator: "null" }),
      ),
    ).toBe(false);
    const broken = contentsOf({ url: "garbage" });
    expect(permissionsFor(broken).downloadAllowed(broken, item())).toBe(false);
  });

  it("is refused, not thrown, when the page or the item throws", () => {
    const contents = contentsOf();
    const throwing = {
      hasUserGesture: () => {
        throw new Error("gone");
      },
      getInitiatorOrigin: () => origin,
    };
    expect(permissionsFor(contents).downloadAllowed(contents, throwing)).toBe(
      false,
    );
  });
});

describe("a clipboard write", () => {
  const permission = "clipboard-sanitized-write";

  it("is allowed to the owned page's own main frame", () => {
    const contents = contentsOf();
    const { clipboardWriteAllowed } = permissionsFor(contents);
    expect(
      clipboardWriteAllowed(
        contents,
        permission,
        "https://chatgpt.com/x",
        true,
      ),
    ).toBe(true);
  });

  it("is refused for another permission, a subframe, no contents or another origin", () => {
    const contents = contentsOf();
    const { clipboardWriteAllowed } = permissionsFor(contents);
    const url = "https://chatgpt.com/x";
    expect(clipboardWriteAllowed(contents, "clipboard-read", url, true)).toBe(
      false,
    );
    expect(clipboardWriteAllowed(contents, permission, url, false)).toBe(false);
    expect(clipboardWriteAllowed(null, permission, url, true)).toBe(false);
    expect(
      clipboardWriteAllowed(contents, permission, "https://evil.test/", true),
    ).toBe(false);
    expect(clipboardWriteAllowed(contents, permission, "garbage", true)).toBe(
      false,
    );
  });

  it("is refused for a destroyed or unowned contents", () => {
    const destroyed = contentsOf({ destroyed: true });
    expect(
      permissionsFor(destroyed).clipboardWriteAllowed(
        destroyed,
        permission,
        "https://chatgpt.com/",
        true,
      ),
    ).toBe(false);
    expect(
      permissionsFor(contentsOf()).clipboardWriteAllowed(
        contentsOf(),
        permission,
        "https://chatgpt.com/",
        true,
      ),
    ).toBe(false);
  });
});

describe("the microphone", () => {
  const url = "https://chatgpt.com/x";

  it("is allowed to the owned page's main frame for an audio-only request", () => {
    const contents = contentsOf();
    const { microphoneAllowed } = permissionsFor(contents);
    expect(microphoneAllowed(contents, "media", url, true, true)).toBe(true);
  });

  it("is refused for video, another permission, a subframe or no contents", () => {
    const contents = contentsOf();
    const { microphoneAllowed } = permissionsFor(contents);
    expect(microphoneAllowed(contents, "media", url, true, false)).toBe(false);
    expect(microphoneAllowed(contents, "geolocation", url, true, true)).toBe(
      false,
    );
    expect(microphoneAllowed(contents, "media", url, false, true)).toBe(false);
    expect(microphoneAllowed(null, "media", url, true, true)).toBe(false);
  });

  it("is refused for another origin, an unreadable URL, or an unowned or destroyed contents", () => {
    const contents = contentsOf();
    const { microphoneAllowed } = permissionsFor(contents);
    expect(
      microphoneAllowed(contents, "media", "https://evil.test/", true, true),
    ).toBe(false);
    expect(microphoneAllowed(contents, "media", "garbage", true, true)).toBe(
      false,
    );
    const destroyed = contentsOf({ destroyed: true });
    expect(
      permissionsFor(destroyed).microphoneAllowed(
        destroyed,
        "media",
        url,
        true,
        true,
      ),
    ).toBe(false);
    expect(
      permissionsFor(contents, null).microphoneAllowed(
        contents,
        "media",
        url,
        true,
        true,
      ),
    ).toBe(false);
  });

  it("asks the owner again at each call, so a replaced generation is seen by the caller", () => {
    const contents = contentsOf();
    const generation = vi.fn<() => number | null>(() => 1);
    const owners = new WeakMap<RouteContents, () => number | null>();
    owners.set(contents, generation);
    const { microphoneAllowed } = createRoutePermissions(owners);
    microphoneAllowed(contents, "media", url, true, true);
    microphoneAllowed(contents, "media", url, true, true);
    expect(generation).toHaveBeenCalledTimes(2);
  });
});

describe("the window presentation", () => {
  const requested = { width: 720, height: 760 } as const;
  const placed = (
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
    size?: "exact" | "fit",
  ): ChatGptWindowPresentation => ({
    mode: "secondary-visible",
    ...(size ? { size } : {}),
    place: () => bounds,
  });

  it("shows and focuses a window when the owner chose no presentation", () => {
    expect(resolveChatGptWindowPresentation(undefined, requested)).toEqual({
      bounds: null,
      reveal: "show",
      focus: true,
    });
  });

  it("keeps a hidden presentation hidden and unfocused", () => {
    expect(
      resolveChatGptWindowPresentation({ mode: "hidden" }, requested),
    ).toEqual({ bounds: null, reveal: "remain-hidden", focus: false });
  });

  it("places an exact window at the requested size without focus", () => {
    const bounds = { x: -1920, y: 40, width: 720, height: 760 };
    expect(resolveChatGptWindowPresentation(placed(bounds), requested)).toEqual(
      { bounds, reveal: "show-inactive", focus: false },
    );
    expect(
      resolveChatGptWindowPresentation(placed(bounds, "exact"), requested),
    ).toEqual({ bounds, reveal: "show-inactive", focus: false });
  });

  it("asks the place function for the requested size", () => {
    const place = vi.fn(() => ({ x: 0, y: 0, width: 720, height: 760 }));
    resolveChatGptWindowPresentation(
      { mode: "secondary-visible", place },
      requested,
    );
    expect(place).toHaveBeenCalledWith(requested);
  });

  it("refuses an exact placement of any other size", () => {
    for (const bounds of [
      { x: 0, y: 0, width: 719, height: 760 },
      { x: 0, y: 0, width: 720, height: 761 },
    ])
      expect(() =>
        resolveChatGptWindowPresentation(placed(bounds), requested),
      ).toThrow("CHATGPT_WINDOW_PLACEMENT_INVALID");
  });

  it("refuses a placement with a non-integer or non-finite coordinate", () => {
    for (const bounds of [
      { x: 0.5, y: 0, width: 720, height: 760 },
      { x: 0, y: Number.NaN, width: 720, height: 760 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 760 },
      { x: 0, y: 0, width: 720, height: 760.5 },
      { x: 2 ** 53, y: 0, width: 720, height: 760 },
    ])
      expect(() =>
        resolveChatGptWindowPresentation(placed(bounds), requested),
      ).toThrow("CHATGPT_WINDOW_PLACEMENT_INVALID");
  });

  it("lets a fit window be smaller than requested, down to 720 by 560", () => {
    const bounds = { x: 10, y: 20, width: 720, height: 560 };
    expect(
      resolveChatGptWindowPresentation(placed(bounds, "fit"), requested),
    ).toEqual({ bounds, reveal: "show-inactive", focus: false });
    const same = { x: 0, y: 0, width: 720, height: 760 };
    expect(
      resolveChatGptWindowPresentation(placed(same, "fit"), requested).bounds,
    ).toEqual(same);
  });

  it("refuses a fit window that is too small or larger than requested", () => {
    for (const bounds of [
      { x: 0, y: 0, width: 719, height: 760 },
      { x: 0, y: 0, width: 720, height: 559 },
      { x: 0, y: 0, width: 721, height: 760 },
      { x: 0, y: 0, width: 720, height: 761 },
    ])
      expect(() =>
        resolveChatGptWindowPresentation(placed(bounds, "fit"), requested),
      ).toThrow("CHATGPT_WINDOW_PLACEMENT_INVALID");
  });
});
