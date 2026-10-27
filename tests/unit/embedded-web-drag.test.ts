import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { preventEmbeddedWindowDrag } from "../../src/apps/desktop/embedded-web-drag";

it("disables page-provided window drag for every embedded document", async () => {
  const events = new EventEmitter();
  const insertCSS = vi.fn(async () => "style");
  const isDestroyed = vi.fn(() => false);
  const contents = Object.assign(events, { insertCSS, isDestroyed });
  preventEmbeddedWindowDrag(contents as unknown as WebContents);
  events.emit("dom-ready");
  events.emit("dom-ready");
  expect(insertCSS).toHaveBeenCalledTimes(2);
  expect(insertCSS).toHaveBeenCalledWith(
    "* { -webkit-app-region: no-drag !important; }",
    { cssOrigin: "user" },
  );
  isDestroyed.mockReturnValue(true);
  events.emit("dom-ready");
  expect(insertCSS).toHaveBeenCalledTimes(2);
});
