import {
  clampPageListWidth,
  isCompactShell,
  shellRailWidth,
  shellGeometry,
} from "../../pkg/shell-layout/geometry";
export { shellGeometry } from "../../pkg/shell-layout/geometry";

export type SurfaceSection = "browser" | "computer" | "activity" | "settings";

export type SidebarMode = "full" | "rail" | "overlay";

export type ShellOverlay =
  "none" | "sidebar" | "task-menu" | "quick-switcher" | "context-preview";

export function deriveSurfaceLayout(input: {
  width: number;
  height: number;
  sidebar: SidebarMode;
  sidebarWidth?: number;
  overlay: ShellOverlay;
  section: SurfaceSection;
  setupOpen: boolean;
  runtimeReady: boolean;
  selectedTaskPresent: boolean;
  browserChromeVisible?: boolean;
  compactBrowser?: boolean;
  checkFeedbackVisible?: boolean;
}) {
  const autoRail = isCompactShell(input.width);
  const railWidth = shellRailWidth(input.width);
  const sidebarWidth =
    autoRail || input.sidebar !== "full"
      ? railWidth
      : railWidth +
        clampPageListWidth(input.sidebarWidth ?? shellGeometry.pageListDefault);
  const pageTop = shellGeometry.windowBar;
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
      height: Math.max(1, input.height - pageTop),
    },
  } as const;
}
