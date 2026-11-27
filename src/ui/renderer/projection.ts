import type { z } from "zod";
import { shellGeometry } from "../../pkg/shell-layout/geometry";
import type { BootstrapProjectionSchema } from "../../../apps/desktop/renderer/snapshot";
import {
  canGoBack,
  canGoForward,
  currentDestination,
  type History,
} from "../../../apps/desktop/renderer/history";
import { browserPresentationAllowed } from "./command-eligibility";
import type { Destination, PreloadApi, WindowSnapshot } from "./contract";
import { ownOpenUnsettled } from "./outcome";

type Bootstrap = z.infer<typeof BootstrapProjectionSchema>;
type LaunchPage = "activity" | "browser" | "computer" | "home" | "settings";

/** The sidebar a closing overlay leaves behind. */
export function closedOverlayPatch(
  state: WindowSnapshot,
): Partial<WindowSnapshot> {
  return {
    overlay: "none",
    sidebar: state.sidebar === "overlay" ? "rail" : state.sidebar,
  };
}

/** The arguments of the host layout call for the current window state. */
export function layoutArguments(
  state: WindowSnapshot,
  compact: boolean,
): Parameters<PreloadApi["layout"]> {
  const sidebar = compact ? "rail" : state.sidebar;
  return [
    state.destination.area === "chatgpt"
      ? "browser"
      : state.destination.area === "settings" ||
          state.destination.area === "setup"
        ? "settings"
        : "activity",
    state.destination.taskId,
    state.status !== "current" &&
      !(
        state.destination.area === "chatgpt" &&
        browserPresentationAllowed(state)
      ),
    false,
    sidebar,
    state.overlay === "none"
      ? "none"
      : state.overlay === "search"
        ? "quick-switcher"
        : "task-menu",
    // Retain the existing host wire geometry; there is no resizable page list.
    shellGeometry.pageListMin,
  ];
}

/** Where a dismissed-setup window lands on launch. */
export function launchDestination(launch: LaunchPage): Partial<Destination> {
  return launch === "home"
    ? { area: "home" }
    : launch === "browser"
      ? { area: "chatgpt" }
      : launch === "computer"
        ? { area: "setup", setupStep: "folders" }
        : launch === "settings"
          ? { area: "settings", page: "general" }
          : { area: "activity" };
}

/** Incomplete setup always starts at Welcome. */
export function welcomeDestination(current: Destination): Destination {
  return { ...current, area: "setup", page: "general", setupStep: "overview" };
}

/** The window state published when navigation pushes a new destination. */
export function navigatePatch(
  state: WindowSnapshot,
  next: Destination,
  history: History,
): Partial<WindowSnapshot> {
  return {
    setupReturn:
      next.area === "setup" &&
      state.destination.area !== "setup" &&
      !state.destination.connectionCheckReturn
        ? state.destination
        : (state.setupReturn ?? null),
    destination: next,
    back: canGoBack(history),
    forward: canGoForward(history),
    ...closedOverlayPatch(state),
  };
}

/** The window state published when history travel lands on an entry. */
export function travelPatch(
  state: WindowSnapshot,
  history: History,
): Partial<WindowSnapshot> {
  return {
    destination: currentDestination(history),
    back: canGoBack(history),
    forward: canGoForward(history),
    ...closedOverlayPatch(state),
  };
}

/** Bootstrap fields adopted unless a newer event already moved them. */
export function bootstrapPatch(input: {
  data: Bootstrap;
  state: WindowSnapshot;
  browserHistoryMoved: boolean;
  browserRouteMoved: boolean;
  runtimeMoved: boolean;
  windowAtStart: WindowSnapshot["window"];
}): Partial<WindowSnapshot> {
  const { data, state } = input;
  return {
    environment: data.environment,
    ...(!input.browserHistoryMoved && data.browserHistoryState
      ? { browserHistory: data.browserHistoryState }
      : {}),
    independentSession: data.independentSession === true,
    ...(!input.browserRouteMoved && data.browserRouteState
      ? { route: data.browserRouteState.state }
      : {}),
    buildId: data.build.buildId,
    installedVersion: {
      version: data.build.version,
      buildVersion: data.build.buildVersion ?? null,
      builtAt: data.build.builtAt,
      sourceCommit: data.build.sourceCommit,
      sourceDirty: data.build.sourceDirty,
    },
    runtime: !input.runtimeMoved ? data.runtimeState : state.runtime,
    window:
      state.window === input.windowAtStart ? data.windowState : state.window,
  };
}

/** Startup status once bootstrap has been adopted. */
export function startupStatus(
  state: WindowSnapshot,
  overflow: boolean,
): "stale" | "current" {
  return overflow ||
    state.configuration?.status !== "ready" ||
    state.runtime !== "ready"
    ? "stale"
    : "current";
}

/** Whether a presentation should open the browser after navigation. */
export function browserPresentationDue(
  state: WindowSnapshot,
  disposed: boolean,
  booting: boolean,
): boolean {
  return !(
    disposed ||
    booting ||
    !browserPresentationAllowed(state) ||
    state.destination.area !== "chatgpt" ||
    (state.destination.connectionCheckReturn === true &&
      [
        "settings:connector.verify-app:",
        "settings:connector.verify-separate-app:",
      ].some((id) => state.intents[id]?.state === "pending")) ||
    state.route === "loaded" ||
    state.destination.taskId !== "" ||
    state.intents["settings:chatgpt.present-browser:"] ||
    ownOpenUnsettled(state)
  );
}
