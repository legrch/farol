import { isDeepStrictEqual } from "node:util";
import type { BrowserTarget } from "../bridge/wire.ts";
import type {
  PhysicalBinding,
  PhysicalGuard,
  PhysicalPartition,
} from "../chatgpt-physical-api.ts";
import { sameOwnedView, sameView, validBinding } from "./check.ts";

/** Live session facts a guard reads on every call; it owns none of them. */
export type GuardView = Readonly<{
  partition: PhysicalPartition;
  e2eOrigin: string | null;
  // The exact assignment is still the current one and the deadline holds.
  current: () => boolean;
  origin: () => PhysicalBinding | undefined;
  physical: () => PhysicalBinding | undefined;
  cid: () => string | undefined;
  failed: () => boolean;
}>;

/**
 * Trusted callback for every physical effect after Prepare. The binding must
 * stay the prepared view; Home may adopt its first conversation only when the
 * caller permits that transition.
 */
export function sessionGuard(
  view: GuardView,
  transition = false,
): PhysicalGuard {
  return (b) => {
    if (!view.current() || !validBinding(b, view.partition, view.e2eOrigin))
      return false;
    const origin = view.origin();
    if (!origin) return false;
    if (!sameView(origin, b)) return false;
    if (view.cid()) return isDeepStrictEqual(view.physical(), b);
    if (origin.phase === "conversation") return isDeepStrictEqual(origin, b);
    return (
      isDeepStrictEqual(origin, b) || (transition && b.phase === "conversation")
    );
  };
}

/**
 * Guard for Prepare itself: one navigation of the dedicated view, including its
 * exact before-navigation binding, to the requested target. A URL change
 * requires a new document epoch. No other destination/view or regressing
 * document is permitted, and one rejection fences the guard for good.
 */
export function prepareGuard(
  view: GuardView,
  target: Pick<BrowserTarget, "mode" | "conversationId">,
  prior?: PhysicalBinding,
): PhysicalGuard {
  let initial: PhysicalBinding | undefined = prior
    ? structuredClone(prior)
    : undefined;
  let rejected = false;
  let targetEpoch: number | undefined;
  return (b) => {
    if (
      rejected ||
      view.failed() ||
      !view.current() ||
      !validBinding(b, view.partition, view.e2eOrigin)
    ) {
      rejected = true;
      return false;
    }
    const origin = view.origin();
    if (origin) return isDeepStrictEqual(origin, b);
    if (!initial) initial = structuredClone(b);
    const onTarget =
      target.mode === "new-saved"
        ? b.phase === "home"
        : b.phase === "conversation" &&
          b.conversationId === target.conversationId;
    const unchanged = isDeepStrictEqual(b, initial);
    const allowed =
      sameOwnedView(initial, b) &&
      b.documentGeneration >= initial.documentGeneration &&
      (targetEpoch === undefined ||
        (onTarget && b.documentGeneration === targetEpoch)) &&
      (unchanged ||
        (onTarget &&
          (b.url === initial.url ||
            b.documentGeneration > initial.documentGeneration)));
    if (!allowed) rejected = true;
    if (
      allowed &&
      onTarget &&
      b.documentGeneration !== initial.documentGeneration
    )
      targetEpoch = b.documentGeneration;
    return allowed;
  };
}
