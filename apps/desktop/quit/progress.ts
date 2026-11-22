import type { QuitStage } from "../../../src/apps/desktop/quit-drain";

// What the "Farol is quitting" window shows, derived only from the drain's
// own stage events. Each closer is tracked by its index, so two closers with
// one name are never confirmed by the first to finish. Names outside the
// fixed map read as "Local helper"; nothing here is guessed.

export type QuitProgressState = Readonly<{
  phase: "idle" | "preparing" | "stopping" | "recording" | "exiting";
  closers: ReadonlyMap<
    number,
    Readonly<{
      name: string;
      state: "pending" | "confirmed" | "failed" | "late";
    }>
  >;
}>;

export const initialQuitProgress: QuitProgressState = Object.freeze({
  phase: "idle",
  closers: new Map(),
});

export function reduceQuitProgress(
  state: QuitProgressState,
  stage: QuitStage,
): QuitProgressState {
  switch (stage.stage) {
    case "preparation-begin":
      return { ...state, phase: "preparing" };
    case "preparation-end":
    case "collect-end":
      return { ...state, phase: "stopping" };
    case "closer-begin": {
      const closers = new Map(state.closers);
      closers.set(stage.closer, { name: stage.name, state: "pending" });
      return { phase: "stopping", closers };
    }
    case "closer-end": {
      const closers = new Map(state.closers);
      closers.set(stage.closer, { name: stage.name, state: stage.outcome });
      return { ...state, closers };
    }
    case "record-begin":
      return { ...state, phase: "recording" };
    case "exit-requested":
      return { ...state, phase: "exiting" };
    default:
      return state;
  }
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
    if (closer.state === "pending")
      waiting.set(category, (waiting.get(category) ?? 0) + 1);
    else if (closer.state !== "confirmed") failed.add(category);
  }
  const lines: string[] = [];
  if (state.phase === "preparing") lines.push("Preparing the update");
  for (const [category, count] of waiting)
    lines.push(
      count > 1
        ? `${category} (${count}) is stopping`
        : `${category} is stopping`,
    );
  for (const category of failed)
    if (!waiting.has(category))
      lines.push(`${category} did not confirm it stopped`);
  if (state.phase === "recording") lines.push("Saving the quit record");
  const left = Math.max(0, Math.ceil(secondsLeft));
  return {
    title: "Farol is quitting",
    lines: lines.length ? lines : ["Finishing up"],
    footer: `Farol closes on its own within ${left} s. Nothing you started is repeated.`,
  };
}
