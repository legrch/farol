import type { ShellAction } from "../../../src/pkg/ipc/shell-state";
import type { Destination } from "../../../src/ui/renderer/contract";
import { home } from "./snapshot";

/** The most destinations one window remembers; the oldest entry falls off. */
export const historyLimit = 100;

export type SectionNavigationAction = Extract<
  ShellAction,
  { action: "navigate-section" }
>;

/**
 * Window-local navigation memory: visited destinations in order and the index
 * the window is showing. Never backend authority and never persisted.
 */
export type History = Readonly<{
  entries: readonly Destination[];
  cursor: number;
}>;

export type HistoryAction =
  /** Visit a new destination: forward entries are dropped. */
  | Readonly<{ kind: "push"; destination: Destination }>
  /** Step back (-1) or forward (1); out of range leaves the history as is. */
  | Readonly<{ kind: "travel"; direction: -1 | 1 }>
  /** Rewrite the shown entry in place without adding navigation. */
  | Readonly<{ kind: "replace"; destination: Destination }>
  /** Fill blank task placeholders left by startup without adding navigation. */
  | Readonly<{ kind: "adopt-task"; taskId: string }>;

export const initialHistory: History = { entries: [home], cursor: 0 };

/** Pure transition. A refused move returns the same `history` reference. */
export function reduceHistory(
  history: History,
  action: HistoryAction,
): History {
  switch (action.kind) {
    case "push": {
      const entries = [
        ...history.entries.slice(0, history.cursor + 1),
        action.destination,
      ];
      if (entries.length > historyLimit) entries.shift();
      return { entries, cursor: entries.length - 1 };
    }
    case "travel": {
      const cursor = history.cursor + action.direction;
      if (cursor < 0 || cursor >= history.entries.length) return history;
      return { entries: history.entries, cursor };
    }
    case "replace": {
      const entries = [...history.entries];
      entries[history.cursor] = action.destination;
      return { entries, cursor: history.cursor };
    }
    case "adopt-task": {
      if (!history.entries.some((entry) => entry.taskId === "")) return history;
      return {
        entries: history.entries.map((entry) =>
          entry.taskId === "" ? { ...entry, taskId: action.taskId } : entry,
        ),
        cursor: history.cursor,
      };
    }
  }
}

export function currentDestination(history: History): Destination {
  const destination = history.entries[history.cursor];
  if (destination === undefined) throw new Error("HISTORY_CURSOR_OUT_OF_RANGE");
  return destination;
}

export function canGoBack(history: History): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: History): boolean {
  return history.cursor < history.entries.length - 1;
}

/**
 * Resolve a partial navigation request against the destination being shown.
 * Key order is part of the result: callers compare destinations as JSON.
 */
export function resolveDestination(
  current: Destination,
  request: Partial<Destination>,
): Destination {
  if (request.area === undefined && request.page !== undefined)
    request = { ...request, area: "settings" };
  const next: Destination = {
    area: request.area ?? current.area,
    page: request.page ?? current.page,
    taskId: request.taskId ?? current.taskId,
  };
  if (next.area === "chatgpt" && request.connectionCheckReturn === true)
    Object.assign(next, { connectionCheckReturn: true });
  const homeView = request.homeView ?? current.homeView;
  const activityId = Object.hasOwn(request, "activityId")
    ? request.activityId
    : current.activityId;
  if (activityId !== undefined) Object.assign(next, { activityId });
  const workspaceId = Object.hasOwn(request, "workspaceId")
    ? request.workspaceId
    : request.area === undefined && request.page === undefined
      ? current.workspaceId
      : undefined;
  if (homeView) Object.assign(next, { homeView });
  const homeSelection = Object.hasOwn(request, "homeSelection")
    ? request.homeSelection
    : request.homeView && request.homeView !== current.homeView
      ? null
      : current.homeSelection;
  if (homeSelection !== undefined) Object.assign(next, { homeSelection });
  if (next.area === "setup") {
    const setupStep =
      request.setupStep ??
      (current.area === "setup" ? current.setupStep : undefined) ??
      "overview";
    Object.assign(next, { setupStep, page: "general" });
  }
  if (
    next.area === "setup" &&
    next.setupStep === "folders" &&
    workspaceId !== undefined
  )
    Object.assign(next, { workspaceId });
  return next;
}

/** The navigation request a host section action stands for. */
export function sectionDestination(
  action: SectionNavigationAction,
): Partial<Destination> {
  return {
    area:
      action.section === "home"
        ? "home"
        : action.section === "browser"
          ? "chatgpt"
          : action.section === "activity"
            ? "activity"
            : action.section === "computer" || action.section === "setup"
              ? "setup"
              : "settings",
    ...(action.section === "computer"
      ? { setupStep: "folders" as const }
      : action.section === "setup"
        ? { setupStep: "overview" as const }
        : {}),
    page: "general",
    taskId: action.taskId,
  };
}
