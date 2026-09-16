export type SurfaceSection = "browser" | "computer" | "activity" | "settings";

export type SidebarMode = "full" | "rail" | "overlay";

export type ShellOverlay = "none" | "sidebar" | "task-menu" | "quick-switcher";

export const shellGeometry = Object.freeze({
  autoRailBelow: 980,
  sidebarFull: 216,
  sidebarRail: 72,
  windowBar: 52,
  taskStrip: 54,
  dossier: 72,
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
}) {
  const autoRail = input.width < shellGeometry.autoRailBelow;
  const sidebarWidth =
    autoRail || input.sidebar !== "full"
      ? shellGeometry.sidebarRail
      : shellGeometry.sidebarFull;
  const pageTop =
    shellGeometry.windowBar + shellGeometry.taskStrip + shellGeometry.dossier;
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
