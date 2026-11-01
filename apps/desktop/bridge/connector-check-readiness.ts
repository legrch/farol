import { setTimeout as delay } from "node:timers/promises";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";

/** Loading is not authentication. Observe the same page until its current
 * authenticated document is ready; this loop never sends a provider message.
 */
export async function waitForConnectorCheckReadiness(
  route: Pick<
    ChatGptRoute,
    | "open"
    | "observeSignInStatus"
    | "isCurrentSignInStatus"
    | "hasPendingReadinessDocument"
  >,
  current: () => boolean,
  timing: {
    now: () => number;
    wait: (ms: number) => Promise<unknown>;
    timeoutMs: number;
    deadlineAt?: number;
  } = {
    now: () => performance.now(),
    wait: (ms: number) => delay(ms),
    timeoutMs: 20_000,
  },
): Promise<boolean> {
  const deadline = timing.deadlineAt ?? timing.now() + timing.timeoutMs;
  if (!current() || !Number.isFinite(deadline) || timing.now() >= deadline)
    return false;
  const opened = await route.open();
  // Only ordinary browser hydration can remain observable after a transient
  // loading result. A failed/protected surface is never admitted this way.
  if (opened.status !== "opened" && !route.hasPendingReadinessDocument())
    return false;
  while (current() && timing.now() < deadline) {
    const observed = await route.observeSignInStatus();
    if (!current() || timing.now() >= deadline) return false;
    if (
      observed.state === "authenticated" &&
      route.isCurrentSignInStatus(observed)
    )
      return true;
    // A login control may precede session hydration. This original pure-read
    // budget can observe a later state; only a new current positive admits Send.
    await timing.wait(Math.min(150, Math.max(0, deadline - timing.now())));
  }
  return false;
}

/** One original preflight, one temporary navigation, no provider submission. */
export async function prepareConnectorCheckDocument(
  route: Pick<
    ChatGptRoute,
    | "open"
    | "openTemporaryChat"
    | "observeSignInStatus"
    | "isCurrentSignInStatus"
    | "hasPendingReadinessDocument"
  >,
  current: () => boolean,
  timing = {
    now: () => performance.now(),
    wait: (ms: number) => delay(ms),
    timeoutMs: 20_000,
  },
): Promise<
  | { ready: true }
  | {
      ready: false;
      stage:
        | "initial-readiness"
        | "binding-invalidated"
        | "temporary-navigation"
        | "temporary-readiness";
    }
> {
  const bounded = { ...timing, deadlineAt: timing.now() + timing.timeoutMs };
  if (!(await waitForConnectorCheckReadiness(route, current, bounded)))
    return {
      ready: false,
      stage: current() ? "initial-readiness" : "binding-invalidated",
    };
  if (!current()) return { ready: false, stage: "binding-invalidated" };
  if (timing.now() >= bounded.deadlineAt)
    return { ready: false, stage: "initial-readiness" };
  if ((await route.openTemporaryChat()).status !== "opened")
    return { ready: false, stage: "temporary-navigation" };
  return (await waitForConnectorCheckReadiness(route, current, bounded))
    ? { ready: true }
    : {
        ready: false,
        stage: current() ? "temporary-readiness" : "binding-invalidated",
      };
}
