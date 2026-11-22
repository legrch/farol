import type { QuitStage } from "../../../src/apps/desktop/quit-drain";

// What the "Farol is quitting" window shows, derived only from the drain's
// own stage events. Each closer is tracked by its index, so two closers with
// one name are never confirmed by the first to finish. Names outside the
// fixed map read as "Local helper"; nothing here is guessed.

export type QuitProgressState = Readonly<{
  step: "idle" | "preparing" | "stopping" | "recording" | "exiting";
  closers: ReadonlyMap<
    number,
    Readonly<{
      name: string;
      progress: "pending" | "confirmed" | "failed" | "timed-out";
    }>
  >;
}>;

type MutableQuitProgress = {
  step: QuitProgressState["step"];
  closers: Map<
    number,
    { name: string; progress: "pending" | "confirmed" | "failed" | "timed-out" }
  >;
};

/** A fresh progress model owned by one window; never shared. */
export function createQuitProgress(): QuitProgressState {
  const state: MutableQuitProgress = { step: "idle", closers: new Map() };
  return state;
}

/**
 * Applies one stage in constant time by updating the window's own model in
 * place; the display snapshot is built only when the window renders.
 */
export function reduceQuitProgress(
  current: QuitProgressState,
  stage: QuitStage,
): QuitProgressState {
  const state = current as MutableQuitProgress;
  switch (stage.stage) {
    case "preparation-begin":
      state.step = "preparing";
      break;
    case "preparation-end":
    case "collect-end":
      state.step = "stopping";
      break;
    case "closer-begin":
      state.step = "stopping";
      state.closers.set(stage.closer, {
        name: stage.name,
        progress: "pending",
      });
      break;
    case "closer-end":
      state.closers.set(stage.closer, {
        name: stage.name,
        progress: stage.result,
      });
      break;
    case "record-begin":
      state.step = "recording";
      break;
    case "exit-requested":
      state.step = "exiting";
      break;
    default:
      break;
  }
  return state;
}

const CATEGORY: Readonly<Record<string, string>> = {
  "installed-updater": "Update",
  connector: "ChatGPT connection",
  "saved-chat-bridge": "ChatGPT connection",
  "go-core": "Farol core",
  "hub-stop": "Farol core",
  "model-endpoint": "Local model endpoint",
  "agent-check": "Agent check",
  "product-agent": "Agent",
  "host-check": "Connection check",
  "route-b": "Local helper",
  "caller-relay": "Local helper",
};

export function quitProgressCategory(name: string): string {
  return CATEGORY[name] ?? "Local helper";
}

/** Plain lines for the window: what is still running, grouped. */
export function presentQuitProgress(
  state: QuitProgressState,
  secondsLeft: number,
): Readonly<{ title: string; lines: readonly string[]; footer: string }> {
  const waiting = new Map<string, number>();
  const failed = new Set<string>();
  for (const closer of state.closers.values()) {
    const category = quitProgressCategory(closer.name);
    if (closer.progress === "pending")
      waiting.set(category, (waiting.get(category) ?? 0) + 1);
    else if (closer.progress !== "confirmed") failed.add(category);
  }
  const lines: string[] = [];
  if (state.step === "preparing") lines.push("Preparing the update");
  for (const [category, count] of waiting)
    lines.push(
      count > 1
        ? `${category} (${count}) is stopping`
        : `${category} is stopping`,
    );
  for (const category of failed)
    if (!waiting.has(category))
      lines.push(`${category} did not confirm it stopped`);
  if (state.step === "recording") lines.push("Saving the quit record");
  const left = Math.max(0, Math.ceil(secondsLeft));
  return {
    title: "Farol is quitting",
    lines: lines.length ? lines : ["Finishing up"],
    footer: `Farol closes on its own within ${left} s. Nothing you started is repeated.`,
  };
}
