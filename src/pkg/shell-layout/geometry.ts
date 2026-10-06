/** Shared CSS-pixel geometry for the renderer and native browser surfaces. */
export const shellGeometry = Object.freeze({
  autoRailBelow: 980,
  sidebarRail: 56,
  pageListDefault: 180,
  pageListMin: 152,
  pageListMax: 288,
  windowBar: 58,
});

export function clampPageListWidth(width: number): number {
  if (!Number.isFinite(width)) return shellGeometry.pageListDefault;
  return Math.min(
    shellGeometry.pageListMax,
    Math.max(shellGeometry.pageListMin, Math.round(width)),
  );
}
