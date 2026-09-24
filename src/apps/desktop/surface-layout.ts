export type SurfaceSection = "browser" | "computer" | "activity" | "settings";

export type SidebarMode = "full" | "rail" | "overlay";

export type ShellOverlay =
  "none" | "sidebar" | "task-menu" | "quick-switcher" | "context-preview";

export const shellGeometry = Object.freeze({
  autoRailBelow: 980,
  sidebarFull: 216,
  sidebarRail: 72,
  windowBar: 52,
  taskStrip: 54,
  dossier: 72,
  devStatusStrip: 25,
  devCheckBanner: 58,
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
  compactDevBrowser?: boolean;
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
      : input.compactDevBrowser
        ? 0
        : shellGeometry.taskStrip + shellGeometry.dossier) +
    (input.compactDevBrowser && input.checkFeedbackVisible
      ? shellGeometry.devCheckBanner
      : 0);
  const bottomReserved =
    input.compactDevBrowser && input.browserChromeVisible !== false
      ? shellGeometry.devStatusStrip
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
