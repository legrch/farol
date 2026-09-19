import { describe, expect, it } from "vitest";
import {
  defaultTrafficLightPosition,
  rectsIntersect,
  sidebarToggleLeft,
  sidebarToggleRect,
  trafficLightRect,
} from "../../src/ui/window-chrome-geometry";

describe("sidebar toggle vs. traffic-light geometry", () => {
  it("never intersects the traffic lights at the app's configured position", () => {
    const toggle = sidebarToggleRect(defaultTrafficLightPosition);
    const lights = trafficLightRect(defaultTrafficLightPosition);
    expect(rectsIntersect(toggle, lights)).toBe(false);
  });

  it("never intersects when no live position has been reported yet (null)", () => {
    const toggle = sidebarToggleRect(null);
    const lights = trafficLightRect(null);
    expect(rectsIntersect(toggle, lights)).toBe(false);
    // null falls back to the same default the app configures, so the two
    // computations agree with a live report of that same position.
    expect(sidebarToggleLeft(null)).toBe(
      sidebarToggleLeft(defaultTrafficLightPosition),
    );
  });

  it("stays clear across a range of reported traffic-light origins", () => {
    for (const position of [
      { x: 0, y: 0 },
      { x: 7, y: 10 },
      { x: 14, y: 18 },
      { x: 20, y: 24 },
      { x: 40, y: 30 },
    ]) {
      const toggle = sidebarToggleRect(position);
      const lights = trafficLightRect(position);
      expect(rectsIntersect(toggle, lights)).toBe(false);
    }
  });

  it("keeps at least a 28x28 hit target", () => {
    const toggle = sidebarToggleRect(defaultTrafficLightPosition);
    expect(toggle.width).toBeGreaterThanOrEqual(28);
    expect(toggle.height).toBeGreaterThanOrEqual(28);
  });

  it("rectsIntersect reports true for overlapping rects", () => {
    expect(
      rectsIntersect(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 5, y: 5, width: 10, height: 10 },
      ),
    ).toBe(true);
    expect(
      rectsIntersect(
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 10, y: 10, width: 10, height: 10 },
      ),
    ).toBe(false);
  });
});
