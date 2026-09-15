import type { PreviewWindowMode } from "./window-placement";

export type WindowAllClosedAction = "keep-running" | "quit";
export type PresentationAction =
  "show-and-focus" | "show-inactive" | "remain-hidden";
export type WindowOpenOutcome = "opened" | "failed";

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

export async function containWindowOpenFailure(
  open: () => Promise<void>,
  recover: () => void,
): Promise<WindowOpenOutcome> {
  try {
    await open();
    return "opened";
  } catch {
    try {
      recover();
    } catch {
      // Best-effort UI cleanup must not turn a reopen failure into an
      // unhandled main-process rejection. The next activation may retry.
    }
    return "failed";
  }
}
