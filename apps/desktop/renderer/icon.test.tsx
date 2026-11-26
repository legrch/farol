import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import {
  designIconPath,
  designIconViewBox,
} from "../../../src/ui/renderer/design-icons";
import { Icon } from "./icon";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Icon", () => {
  it("draws the named design icon as a decorative svg", () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Icon, { name: "search" })));
    const svg = host.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe(designIconViewBox);
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe(
      designIconPath("search"),
    );
    act(() => root.unmount());
  });
});
