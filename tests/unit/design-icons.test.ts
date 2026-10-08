import { describe, expect, it } from "vitest";
import {
  designIconPath,
  designIconViewBox,
} from "../../src/ui/renderer/design-icons";

describe("approved Farol design glyphs", () => {
  it("uses the reference viewBox, not a twenty-four-unit reinterpretation", () => {
    expect(designIconViewBox).toBe("0 0 20 20");
  });
  it("uses Setup sliders rather than a completion checkmark", () => {
    expect(designIconPath("setup")).toBe("M3 6h14M3 14h14M7 3v6M13 11v6");
    expect(designIconPath("setup")).not.toBe(designIconPath("check"));
  });
  it.each([
    ["chatgpt", "chat"],
    ["computer", "mac"],
    ["attention", "warning"],
    ["workspaces", "folders"],
  ])("preserves the existing %s route as a %s glyph alias", (route, icon) => {
    expect(designIconPath(route)).toBe(designIconPath(icon));
  });
  it("does not draw the same gear for every Settings page", () => {
    const names = [
      "general",
      "appearance",
      "folders",
      "computer",
      "connection",
      "model",
      "shortcuts",
      "updates",
      "diagnostics",
    ];
    expect(new Set(names.map(designIconPath)).size).toBe(names.length);
    for (const name of names)
      expect(designIconPath(name)).not.toBe(designIconPath("settings"));
  });
  it.each(["missing", "__proto__", "constructor", "toString", ""])(
    "returns a safe reference fallback for %s",
    (name) => {
      expect(designIconPath(name)).toBe(designIconPath("general"));
    },
  );
  it("retains the exact computed reference gear, with finite points inside its grid", () => {
    const expected = Array.from({ length: 32 }, (_, index) => {
      const angle = (index * Math.PI) / 16 - Math.PI / 16;
      const radius = index % 4 < 2 ? 8.3 : 6.8;
      return `${10 + radius * Math.cos(angle)},${10 + radius * Math.sin(angle)}`;
    });
    expect(designIconPath("settings")).toBe(
      "M" +
        expected.join("L") +
        "Z M12.6 10a2.6 2.6 0 1 0-5.2 0 2.6 2.6 0 0 0 5.2 0",
    );
    expect(designIconPath("settings")).not.toMatch(/NaN|Infinity/);
  });
});
