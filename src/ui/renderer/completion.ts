import { setupCompletionAllowed } from "../setup-completion";
import { commandAllowed } from "./command-eligibility";
import type { WindowSnapshot } from "./contract";

/**
 * The generation key for automatic setup completion, or null while the
 * confirmed checks do not (or no longer) allow completing setup.
 */
export function setupCompletionKey(
  state: WindowSnapshot,
  disposed: boolean,
): string | null {
  if (
    disposed ||
    state.configuration?.status !== "ready" ||
    state.configuration.settings.setup.journey.dismissed ||
    !commandAllowed(state, "setup.progress") ||
    !setupCompletionAllowed(state.configuration.settings, {
      buildId: state.buildId ?? "",
      current:
        state.status === "current" &&
        state.runtime === "ready" &&
        state.update.phase !== "applying",
      signInObservation: state.signInObservation,
      signInCheck: state.setupSignInCheck ?? null,
    })
  )
    return null;
  const settings = state.configuration.settings;
  return `${state.buildId}:${settings.computer.generation}:${settings.connectors.secureMcp.generation}`;
}

/** The document observation that proved sign-in, or null without one. */
export function setupCompletionProof(state: WindowSnapshot): string | null {
  const binding = state.signInObservation?.binding;
  if (!binding) return null;
  return `${binding.documentGeneration}:${binding.sequence}`;
}
