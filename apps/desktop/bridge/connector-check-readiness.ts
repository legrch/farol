import { setTimeout as delay } from "node:timers/promises";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";

/** Loading is not authentication. Observe the same page until its current
 * authenticated document is ready; this loop never sends a provider message.
 */
export async function waitForConnectorCheckReadiness(
  route: Pick<
    ChatGptRoute,
    "open" | "observeSignInStatus" | "isCurrentSignInStatus"
  >,
  current: () => boolean,
  timing = {
    now: () => performance.now(),
    wait: (ms: number) => delay(ms),
    timeoutMs: 20_000,
  },
): Promise<boolean> {
  const deadline = timing.now() + timing.timeoutMs;
  if (!current() || (await route.open()).status !== "opened") return false;
  while (current() && timing.now() < deadline) {
    const observed = await route.observeSignInStatus();
    if (!current() || timing.now() >= deadline) return false;
    if (
      observed.state === "authenticated" &&
      route.isCurrentSignInStatus(observed)
    )
      return true;
    if (observed.state === "signed_out") return false;
    await timing.wait(150);
  }
  return false;
}
