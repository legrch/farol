import type { WebContents } from "electron";
import { chatGptUsageLimitPattern } from "../../../src/apps/desktop/chatgpt/scripts";

// The route's pure decisions: which downloads and permissions the managed
// ChatGPT page may have, how a window is presented, which host a URL names,
// whether a page is ChatGPT's own, how a provider error reads and which code a
// blocked app binding becomes. None of them touches Electron beyond the
// `WebContents` they are handed, and each answers the same way for the same
// input.

export type ChatGptProviderErrorKind = "usage_limited" | "generic";

export function classifyChatGptProviderError(
  text: string,
): ChatGptProviderErrorKind {
  return chatGptUsageLimitPattern.test(text) ? "usage_limited" : "generic";
}

export function appBindingFailureCode(
  reason:
    | "missing"
    | "ambiguous"
    | "conflict"
    | "draft_present"
    | "selection_not_observed",
):
  | "CHATGPT_APP_SELECTION_MISSING"
  | "CHATGPT_APP_SELECTION_AMBIGUOUS"
  | "CHATGPT_APP_SELECTION_CONFLICT"
  | "CHATGPT_APP_SELECTION_LOST"
  | "CHATGPT_COMPOSER_DRAFT_PRESENT" {
  if (reason === "ambiguous") return "CHATGPT_APP_SELECTION_AMBIGUOUS";
  if (reason === "conflict") return "CHATGPT_APP_SELECTION_CONFLICT";
  if (reason === "draft_present") return "CHATGPT_COMPOSER_DRAFT_PRESENT";
  if (reason === "selection_not_observed") return "CHATGPT_APP_SELECTION_LOST";
  return "CHATGPT_APP_SELECTION_MISSING";
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

// The Return-to-Farol control is only ever added to ChatGPT's own pages. An
// identity provider's page (Google, Apple, Microsoft) is never modified: a
// sign-in or MFA step there runs exactly as the provider serves it, and the
// window's title and close button still return the owner to Farol.
export function isChatGptPage(url: string, homeUrl: string): boolean {
  const host = hostOf(url);
  return (
    host === hostOf(homeUrl) ||
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com")
  );
}

// The contents the route currently owns, as the permission generation its
// owner reports. The route keeps the map: a copy would never find a contents.
export type RoutePermissionOwners = Pick<
  WeakMap<WebContents, () => number | null>,
  "get"
>;

export type RouteDownloadItem = Readonly<{
  hasUserGesture(): boolean;
  getInitiatorOrigin(): string;
}>;

export type RoutePermissions = Readonly<{
  generation(contents: WebContents | null): number | null;
  downloadAllowed(
    contents: WebContents | null | undefined,
    item: RouteDownloadItem | null | undefined,
    frame?: Readonly<{ origin: string }> | null,
  ): boolean;
  clipboardWriteAllowed(
    contents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean;
  microphoneAllowed(
    contents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
    audioOnly: boolean,
  ): boolean;
}>;

export function createRoutePermissions(
  owners: RoutePermissionOwners,
): RoutePermissions {
  function generation(contents: WebContents | null): number | null {
    try {
      return contents && !contents.isDestroyed()
        ? (owners.get(contents)?.() ?? null)
        : null;
    } catch {
      return null;
    }
  }

  // A download is the owner's only when they clicked it in the focused managed
  // ChatGPT page. The download URL is deliberately not checked: ChatGPT serves
  // files from its own file hosts. What is bound is who started it: Chromium's
  // user gesture, the initiating document's origin, and (while it still
  // exists) the initiating frame, all equal to the managed page's own origin.
  function downloadAllowed(
    contents: WebContents | null | undefined,
    item: RouteDownloadItem | null | undefined,
    frame?: Readonly<{ origin: string }> | null,
  ): boolean {
    try {
      if (
        contents == null ||
        item == null ||
        contents.isDestroyed() ||
        generation(contents) == null ||
        !contents.isFocused() ||
        !item.hasUserGesture()
      )
        return false;
      const origin = new URL(contents.getURL()).origin;
      return (
        origin !== "null" &&
        item.getInitiatorOrigin() === origin &&
        (frame == null || frame.origin === origin)
      );
    } catch {
      return false;
    }
  }

  function clipboardWriteAllowed(
    contents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean {
    if (permission !== "clipboard-sanitized-write" || !contents || !isMainFrame)
      return false;
    try {
      return (
        !contents.isDestroyed() &&
        generation(contents) != null &&
        new URL(requestingUrl).origin === new URL(contents.getURL()).origin
      );
    } catch {
      return false;
    }
  }

  function microphoneAllowed(
    contents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
    audioOnly: boolean,
  ): boolean {
    if (permission !== "media" || !audioOnly || !contents || !isMainFrame)
      return false;
    try {
      return (
        !contents.isDestroyed() &&
        generation(contents) != null &&
        new URL(requestingUrl).origin === new URL(contents.getURL()).origin
      );
    } catch {
      return false;
    }
  }

  return {
    generation,
    downloadAllowed,
    clipboardWriteAllowed,
    microphoneAllowed,
  };
}

export type ChatGptWindowPresentation =
  | Readonly<{ mode: "hidden" }>
  | Readonly<{
      mode: "secondary-visible";
      size?: "exact" | "fit";
      place(
        requested: Readonly<{ width: number; height: number }>,
      ): Readonly<{ x: number; y: number; width: number; height: number }>;
    }>;

type ChatGptWindowBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ResolvedChatGptWindowPresentation =
  | Readonly<{ bounds: null; reveal: "show"; focus: true }>
  | Readonly<{ bounds: null; reveal: "remain-hidden"; focus: false }>
  | Readonly<{
      bounds: ChatGptWindowBounds;
      reveal: "show-inactive";
      focus: false;
    }>;

export function resolveChatGptWindowPresentation(
  presentation: ChatGptWindowPresentation | undefined,
  requested: Readonly<{ width: number; height: number }>,
): ResolvedChatGptWindowPresentation {
  if (presentation === undefined) {
    return { bounds: null, reveal: "show", focus: true };
  }
  if (presentation.mode === "hidden") {
    return { bounds: null, reveal: "remain-hidden", focus: false };
  }
  const bounds = presentation.place(requested);
  if (
    !Number.isSafeInteger(bounds.x) ||
    !Number.isSafeInteger(bounds.y) ||
    !Number.isSafeInteger(bounds.width) ||
    !Number.isSafeInteger(bounds.height) ||
    (presentation.size === "fit"
      ? bounds.width < 720 ||
        bounds.height < 560 ||
        bounds.width > requested.width ||
        bounds.height > requested.height
      : bounds.width !== requested.width || bounds.height !== requested.height)
  ) {
    throw new Error("CHATGPT_WINDOW_PLACEMENT_INVALID");
  }
  return { bounds, reveal: "show-inactive", focus: false };
}
