import type { PreviewWindowMode } from "./window-placement";

export type WindowAllClosedAction = "keep-running" | "quit";
export type PresentationAction =
  "show-and-focus" | "show-inactive" | "remain-hidden";

export function windowAllClosedAction(
  platform: NodeJS.Platform,
): WindowAllClosedAction {
  return platform === "darwin" ? "keep-running" : "quit";
}

export function presentationAction(
  mode: PreviewWindowMode,
): PresentationAction {
  if (mode === "hidden") return "remain-hidden";
  if (mode === "secondary-visible") return "show-inactive";
  return "show-and-focus";
}
