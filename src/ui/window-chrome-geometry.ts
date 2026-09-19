/**
 * Geometry for the two things that live in the same top-left corner of the
 * main window: macOS's native traffic-light buttons (red/yellow/close) and
 * the sidebar toggle. Both `shell.ts` (to compute the toggle's CSS
 * position) and the native e2e harness (to assert the two never overlap)
 * need the same numbers, so this is their one shared, pure source.
 *
 * Electron's `BrowserWindow.getWindowButtonPosition()` reports only the
 * traffic-light group's configured origin (`{x, y}`), not its rendered
 * size — there is no API for that. `trafficLightCluster` is macOS's
 * standard three-button cluster size at the default (non-"large") scale,
 * used with the app's own fixed `trafficLightPosition: {x: 14, y: 18}`
 * (main.ts). If a future macOS release ever changes that rendered size,
 * this constant is the one place to correct it.
 */

export type TrafficLightPosition = Readonly<{ x: number; y: number }>;

export const defaultTrafficLightPosition: TrafficLightPosition = Object.freeze({
  x: 14,
  y: 18,
});

export const trafficLightCluster = Object.freeze({
  width: 52,
  height: 16,
});

// The minimum clear space to keep between the traffic-light cluster's right
// edge and the sidebar toggle's left edge, so the two hit-test regions
// never overlap even if macOS's own click-target padding around the dots
// extends a little past their visible edges.
export const trafficLightClearance = 12;

export const sidebarToggleSize = Object.freeze({ width: 34, height: 34 });
export const sidebarToggleTop = 9;

export type Rect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export function trafficLightRect(position: TrafficLightPosition | null): Rect {
  const origin = position ?? defaultTrafficLightPosition;
  return {
    x: origin.x,
    y: Math.max(0, origin.y - trafficLightCluster.height / 2),
    width: trafficLightCluster.width,
    height: trafficLightCluster.height,
  };
}

// The toggle's `left` (in px): far enough right of the traffic-light
// cluster to guarantee `rectsIntersect(trafficLightRect(position),
// sidebarToggleRect(position))` is always false, for every reported
// position — not just the one the app configures.
export function sidebarToggleLeft(
  position: TrafficLightPosition | null,
): number {
  const cluster = trafficLightRect(position);
  return cluster.x + cluster.width + trafficLightClearance;
}

export function sidebarToggleRect(position: TrafficLightPosition | null): Rect {
  return {
    x: sidebarToggleLeft(position),
    y: sidebarToggleTop,
    ...sidebarToggleSize,
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
