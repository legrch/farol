export type SurfaceSection = "browser" | "computer" | "activity" | "settings";

export type SidebarMode = "full" | "rail" | "overlay";

export type ShellOverlay =
  "none" | "sidebar" | "task-menu" | "quick-switcher" | "context-preview";

export const shellGeometry = Object.freeze({
  autoRailBelow: 980,
  sidebarFull: 294,
  sidebarRail: 62,
  windowBar: 58,
  taskStrip: 0,
  dossier: 0,
  browserStatusStrip: 0,
  checkFeedbackBanner: 0,
});

export function deriveSurfaceLayout(input: {
  width: number;
  height: number;
  sidebar: SidebarMode;
  overlay: ShellOverlay;
  section: SurfaceSection;
  setupOpen: boolean;
  runtimeReady: boolean;
  selectedTaskPresent: boolean;
  browserChromeVisible?: boolean;
  compactBrowser?: boolean;
  checkFeedbackVisible?: boolean;
}) {
  const autoRail = input.width < shellGeometry.autoRailBelow;
  const sidebarWidth =
    autoRail || input.sidebar !== "full"
      ? shellGeometry.sidebarRail
      : shellGeometry.sidebarFull;
  const pageTop =
    shellGeometry.windowBar +
    (input.browserChromeVisible === false
      ? 0
      : input.compactBrowser
        ? 0
        : shellGeometry.taskStrip + shellGeometry.dossier) +
    (input.compactBrowser && input.checkFeedbackVisible
      ? shellGeometry.checkFeedbackBanner
      : 0);
  const bottomReserved =
    input.compactBrowser && input.browserChromeVisible !== false
      ? shellGeometry.browserStatusStrip
      : 0;
  return {
    sidebarWidth,
    autoRail,
    pageVisible:
      input.runtimeReady &&
      input.selectedTaskPresent &&
      input.section === "browser" &&
      !input.setupOpen &&
      input.overlay === "none",
    pageBounds: {
      x: sidebarWidth,
      y: pageTop,
      width: Math.max(1, input.width - sidebarWidth),
      height: Math.max(1, input.height - pageTop - bottomReserved),
    },
  } as const;
}
