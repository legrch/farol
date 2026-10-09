/** Shared CSS-pixel geometry for the renderer and native browser surfaces. */
export const shellGeometry = Object.freeze({
  compactMaxWidth: 850,
  sidebarRail: 62,
  compactRail: 58,
  pageListDefault: 232,
  pageListMin: 152,
  pageListMax: 288,
  windowBar: 58,
});

/** The approved compact layout includes the 850px boundary. */
export function isCompactShell(width: number): boolean {
  return width <= shellGeometry.compactMaxWidth;
}

export function shellRailWidth(width: number): number {
  return isCompactShell(width)
    ? shellGeometry.compactRail
    : shellGeometry.sidebarRail;
}

export function clampPageListWidth(width: number): number {
  if (!Number.isFinite(width)) return shellGeometry.pageListDefault;
  return Math.min(
    shellGeometry.pageListMax,
    Math.max(shellGeometry.pageListMin, Math.round(width)),
  );
}
