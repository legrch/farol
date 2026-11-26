import type { BrowserWindow } from "electron";
import type { ChatGptSignInBlockedDiagnostic } from "./signin";
import {
  hostOf,
  resolveChatGptWindowPresentation,
  type ChatGptWindowPresentation,
  type ResolvedChatGptWindowPresentation,
  type RouteContents,
  type RouteDownloadItem,
  type RoutePermissions,
} from "./policy";

// The hardening of the managed ChatGPT session and of every contents the route
// opens: which permissions the page may ask for, which downloads it may start,
// which navigations, redirects and popups are refused, and how the permission
// owner of the route's own contents is registered. Each handler decides from
// what it is handed and answers the same way for the same input. The route
// keeps its fields, so everything that writes one (readiness tracking, the
// popup bookkeeping) stays there behind a callback port, registered at the
// same point of the sequence as before. Nothing here retries or widens a
// refusal: a refused request stays refused.

// The session ---------------------------------------------------------------

type PermissionRequestDetails = Readonly<{
  requestingUrl: string;
  isMainFrame: boolean;
  mediaTypes?: readonly string[];
}>;

type PermissionCheckDetails = Readonly<{
  isMainFrame: boolean;
  mediaType?: string;
}>;

type DownloadEvent = Readonly<{ preventDefault(): void }>;

type DownloadItem = RouteDownloadItem &
  Readonly<{
    setSaveDialogOptions(options: { title: string; defaultPath: string }): void;
    getFilename(): string;
  }>;

// The part of an Electron `Session` the hardening installs onto.
export type RouteSessionTarget = Readonly<{
  setPermissionRequestHandler(
    handler: (
      contents: RouteContents | null,
      permission: string,
      callback: (granted: boolean) => void,
      details: PermissionRequestDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      contents: RouteContents | null,
      permission: string,
      requestingOrigin: string,
      details: PermissionCheckDetails,
    ) => boolean,
  ): void;
  on(
    event: "will-download",
    listener: (
      event: DownloadEvent,
      item: DownloadItem,
      contents: RouteContents,
      frame: Readonly<{ origin: string }> | null | undefined,
    ) => void,
  ): void;
}>;

export type RouteSessionPorts<Target extends RouteSessionTarget> = Readonly<{
  permissions: Pick<
    RoutePermissions,
    | "generation"
    | "clipboardWriteAllowed"
    | "microphoneAllowed"
    | "downloadAllowed"
  >;
  // Sessions already hardened. The route owns the set: a copy would never
  // recognise a session.
  hardened: Pick<WeakSet<Target>, "has" | "add">;
  // The system's microphone prompt and its current answer.
  askForMicrophoneAccess: () => Promise<boolean>;
  microphoneAccessStatus: () => string;
  // A permission the page asked for and was refused.
  permissionDenied: (permission: string) => void;
}>;

/**
 * Installs the permission request and check handlers and the download guard on
 * a route session, once per session. Only a clipboard write or a main-frame
 * audio-only microphone request from the route's own live ChatGPT page is ever
 * granted; the microphone answer is checked again after the system prompt.
 */
export function hardenRouteSession<Target extends RouteSessionTarget>(
  routeSession: Target,
  ports: RouteSessionPorts<Target>,
): void {
  const { permissions } = ports;
  if (ports.hardened.has(routeSession)) return;
  routeSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        permissions.clipboardWriteAllowed(
          contents,
          permission,
          details?.requestingUrl ?? "",
          details?.isMainFrame === true,
        )
      ) {
        callback(true);
        return;
      }
      if (
        permissions.microphoneAllowed(
          contents,
          permission,
          details?.requestingUrl ?? "",
          details?.isMainFrame === true,
          details != null &&
            "mediaTypes" in details &&
            details.mediaTypes?.length === 1 &&
            details.mediaTypes[0] === "audio",
        )
      ) {
        const generation = permissions.generation(contents);
        let request: Promise<boolean>;
        try {
          request = ports.askForMicrophoneAccess();
        } catch {
          callback(false);
          return;
        }
        void request.then(
          (granted) =>
            callback(
              granted &&
                generation != null &&
                permissions.generation(contents) === generation &&
                permissions.microphoneAllowed(
                  contents,
                  permission,
                  details.requestingUrl,
                  details.isMainFrame,
                  true,
                ),
            ),
          () => callback(false),
        );
        return;
      }
      ports.permissionDenied(permission);
      callback(false);
    },
  );
  routeSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      try {
        return (
          permissions.clipboardWriteAllowed(
            contents,
            permission,
            requestingOrigin,
            details?.isMainFrame === true,
          ) ||
          (permissions.microphoneAllowed(
            contents,
            permission,
            requestingOrigin,
            details?.isMainFrame === true,
            details?.mediaType === "audio",
          ) &&
            ports.microphoneAccessStatus() === "granted")
        );
      } catch {
        return false;
      }
    },
  );
  // A download the owner clicks in a visible, focused ChatGPT page gets the
  // normal macOS Save dialog (Electron shows it when no save path is set).
  // Hidden, unfocused, unmanaged, gesture-less or foreign-initiated
  // downloads (including a foreign-origin subframe) never download.
  routeSession.on("will-download", (event, item, contents, frame) => {
    if (!permissions.downloadAllowed(contents, item, frame)) {
      event.preventDefault();
      return;
    }
    try {
      item.setSaveDialogOptions({
        title: "Save download",
        defaultPath: item.getFilename(),
      });
    } catch {
      event.preventDefault();
    }
  });
  ports.hardened.add(routeSession);
}

// The contents ---------------------------------------------------------------

// The part of an Electron `WebContents` the hardening installs onto.
export type RouteContentsTarget = RouteContents &
  Readonly<{
    on(
      event: "did-navigate" | "did-navigate-in-page" | "did-finish-load",
      listener: () => void,
    ): void;
    on(
      event: "will-navigate" | "will-redirect",
      listener: (
        event: Readonly<{ preventDefault(): void }>,
        url: string,
      ) => void,
    ): void;
    on(
      event: "did-create-window",
      listener: (popup: BrowserWindow) => void,
    ): void;
    setWindowOpenHandler(
      handler: (
        details: Readonly<{ url: string }>,
      ) => Electron.WindowOpenHandlerResponse,
    ): void;
  }>;

// Present only for the contents the route itself drives: the popups a page
// opens are hardened without it.
export type RouteContentsTracking<Contents extends RouteContentsTarget> =
  Readonly<{
    owns: (contents: Contents) => boolean;
    publishHistory: () => void;
    homeUrl: () => string;
    documentGeneration: () => number;
    // The route's permission-owner map: a copy would never find a contents.
    owners: Pick<WeakMap<Contents, () => number | null>, "set">;
    // Navigation readiness, load state and the app submission gate. They write
    // route fields other route methods write, so the route registers them,
    // between the redirect guard and the popup handler as before.
    trackReadiness: () => void;
  }>;

export type RoutePopupPorts = Readonly<{
  presentation: () => ChatGptWindowPresentation | undefined;
  requiredAppName: () => string | undefined;
  title: () => string;
  webPreferences: () => Electron.WebPreferences;
  // The opener is the route's own surface, not a retired or displaced one.
  openerOwned: () => boolean;
  // The popup's bookkeeping, its own hardening and its presentation.
  adopt: (popup: BrowserWindow) => void;
}>;

export type RouteContentsPorts<Contents extends RouteContentsTarget> =
  Readonly<{
    allowedUrl: (url: string) => boolean;
    blocked: (diagnostic: ChatGptSignInBlockedDiagnostic) => void;
    tracking: RouteContentsTracking<Contents> | null;
    popups: RoutePopupPorts;
  }>;

/**
 * Installs the navigation, redirect and popup guards on a contents. A URL the
 * allowlist refuses is cancelled and reported; a popup is created only for an
 * allowed URL whose window presentation resolves, and only as a sandboxed
 * remote-content window.
 */
export function hardenRouteContents<Contents extends RouteContentsTarget>(
  contents: Contents,
  ports: RouteContentsPorts<Contents>,
): void {
  const { tracking, popups } = ports;
  if (tracking !== null) {
    const publishHistory = () => {
      if (tracking.owns(contents)) tracking.publishHistory();
    };
    contents.on("did-navigate", publishHistory);
    contents.on("did-navigate-in-page", publishHistory);
    contents.on("did-finish-load", publishHistory);
  }
  if (tracking !== null)
    tracking.owners.set(contents, () =>
      tracking.owns(contents) &&
      new URL(contents.getURL()).origin === new URL(tracking.homeUrl()).origin
        ? tracking.documentGeneration()
        : null,
    );
  const allowed = ports.allowedUrl;
  contents.on("will-navigate", (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      ports.blocked({
        kind: "navigation-blocked",
        host: hostOf(url),
      });
    }
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowed(url)) {
      event.preventDefault();
      ports.blocked({
        kind: "navigation-blocked",
        host: hostOf(url),
      });
    }
  });
  if (tracking !== null) tracking.trackReadiness();
  contents.setWindowOpenHandler(({ url }) => {
    if (!popups.openerOwned()) return { action: "deny" };
    if (!allowed(url)) {
      ports.blocked({ kind: "popup-blocked", host: hostOf(url) });
      return { action: "deny" };
    }
    const requested = { width: 720, height: 760 } as const;
    let presentation: ResolvedChatGptWindowPresentation;
    try {
      presentation = resolveChatGptWindowPresentation(
        popups.presentation(),
        requested,
      );
    } catch {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        title: `Sign in · ${popups.title()}`,
        frame: true,
        titleBarStyle: "default",
        width: requested.width,
        height: requested.height,
        ...(presentation.bounds ?? {}),
        ...(popups.presentation() === undefined &&
        popups.requiredAppName() === undefined
          ? {}
          : { show: false }),
        backgroundColor: "#111216",
        webPreferences: popups.webPreferences(),
      },
    };
  });
  contents.on("did-create-window", (popup) => popups.adopt(popup));
}
