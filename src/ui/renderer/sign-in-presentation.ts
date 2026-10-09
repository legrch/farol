import { dependencyFences } from "./command-eligibility";
import type { Intent, WindowSnapshot } from "./contract";

/** Current page sign-in presentation; never account identity or effect authority. */
export function signInPresentation(
  snapshot: WindowSnapshot,
  local: readonly Intent[] = [],
) {
  const fences = dependencyFences(snapshot, "chat", local);
  const observation = snapshot.signInObservation;
  const current =
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    snapshot.configuration?.status === "ready" &&
    snapshot.update.phase !== "applying" &&
    Boolean(snapshot.buildId) &&
    observation?.buildId === snapshot.buildId;
  const signedIn =
    current &&
    !fences.unknown &&
    !fences.pending &&
    observation?.pending === false &&
    observation.state === "authenticated" &&
    observation.binding !== null;
  const pending = fences.pending || (current && observation?.pending === true);
  const unknown =
    fences.unknown ||
    (!pending &&
      !signedIn &&
      !(
        current &&
        observation?.state === "signed_out" &&
        observation.binding !== null
      ));
  return {
    signedIn,
    pending,
    unknown,
    outcomeUnknown: fences.unknown,
    label: fences.unknown
      ? "Outcome unknown"
      : pending
        ? "Checking sign-in…"
        : signedIn
          ? "Signed in"
          : unknown
            ? "Current sign-in is unknown"
            : "Signed out",
  } as const;
}
