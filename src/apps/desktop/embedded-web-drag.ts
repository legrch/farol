import type { WebContents } from "electron";

// A page embedded in Farol is content, not native window chrome. Some pages
// declare Electron draggable regions themselves; neutralize those regions in
// the embedded document without touching the host toolbar or standalone windows.
export function preventEmbeddedWindowDrag(contents: WebContents): void {
  contents.on("dom-ready", () => {
    if (contents.isDestroyed()) return;
    void contents
      .insertCSS("* { -webkit-app-region: no-drag !important; }", {
        cssOrigin: "user",
      })
      .catch(() => {
        process.stderr.write("FAROL_EMBEDDED_DRAG_STYLE_UNAVAILABLE\n");
      });
  });
}
