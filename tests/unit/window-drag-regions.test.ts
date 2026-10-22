import fs from "node:fs";
import { expect, it } from "vitest";
import { ABOUT_PANEL_CSS } from "../../src/ui/about-panel-document";
it.each([
  ["shell", "src/ui/renderer/shell.tsx", "src/ui/renderer/shell.css"],
  [
    "recovery",
    "apps/desktop/renderer/recovery/view.tsx",
    "apps/desktop/renderer/recovery/view.css",
  ],
])(
  "%s declares a title drag region with interactive controls excluded",
  (kind, view, css) => {
    expect(fs.readFileSync(view!, "utf8")).toContain(
      `data-window-drag-region="${kind}"`,
    );
    const style = fs.readFileSync(css!, "utf8");
    expect(style).toContain("-webkit-app-region: drag");
    expect(style).toContain("-webkit-app-region: no-drag");
  },
);
it("About declares draggable top chrome with controls excluded", () => {
  expect(ABOUT_PANEL_CSS).toContain("-webkit-app-region:drag");
  expect(ABOUT_PANEL_CSS).toContain("-webkit-app-region:no-drag");
});
it("embedded provider and sign-in popup window kinds retain native draggable titlebars", () => {
  const source = fs.readFileSync("src/apps/desktop/chatgpt-route.ts", "utf8");
  expect(source.match(/titleBarStyle: "default"/gu)).toHaveLength(2);
  expect(source.match(/frame: true/gu)?.length).toBeGreaterThanOrEqual(2);
});
