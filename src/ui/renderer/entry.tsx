import { parseNavigationShortcuts } from "../../pkg/ipc/navigation-shortcuts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Services } from "./services";
import { WindowController } from "./controller";
import { Shell } from "./shell";
import type { PreloadApi, Appearance } from "./contract";
const api = (window as unknown as { farolNext: PreloadApi }).farolNext;
const controller = new WindowController(
  api,
  (value) => {
    try {
      localStorage.setItem("farol.appearance.v1", JSON.stringify(value));
    } catch {
      /* Preference persistence does not grant authority. */
    }
  },
  (value) => {
    try {
      localStorage.setItem(
        "farol.next.navigation-shortcuts.v1",
        JSON.stringify(value),
      );
    } catch {
      /* Retain active preference. */
    }
  },
  () => window.matchMedia("(max-width: 979px)").matches,
);
try {
  const stored: unknown = JSON.parse(
    localStorage.getItem("farol.appearance.v1") ?? "null",
  );
  if (
    stored &&
    typeof stored === "object" &&
    "theme" in stored &&
    "accent" in stored &&
    "font" in stored &&
    ["light", "graphite", "system"].includes(String(stored.theme)) &&
    ["iris", "cobalt", "amber"].includes(String(stored.accent)) &&
    ["geist", "system"].includes(String(stored.font))
  )
    controller.appearance({
      theme: stored.theme as Appearance["theme"],
      accent: stored.accent as Appearance["accent"],
      font: stored.font as Appearance["font"],
    });
} catch {
  /* Retain valid defaults. */
}
const host = document.getElementById("root");
if (!host) throw new Error("RENDERER_ROOT_MISSING");
const root = createRoot(host);
root.render(
  <StrictMode>
    <Services value={controller}>
      <Shell />
    </Services>
  </StrictMode>,
);
void controller.start().then(async () => {
  try {
    const stored = parseNavigationShortcuts(
      JSON.parse(
        localStorage.getItem("farol.next.navigation-shortcuts.v1") ?? "null",
      ),
    );
    if (stored) await controller.shortcuts(stored);
  } catch {
    /* Invalid preferences do not activate shortcuts. */
  }
});
window.addEventListener(
  "pagehide",
  () => {
    root.unmount();
    controller.dispose();
  },
  { once: true },
);
