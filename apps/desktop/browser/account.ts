import { ChatGptAccountObservationSchema } from "../chatgpt-account-probe.ts";
import type { BrowserAccountObservation } from "../bridge/wire.ts";
import { fail } from "./check.ts";

/**
 * Admit the independent page account observation carried by a witness. It must
 * be a fresh observed fact for the exact document of this verification.
 */
export function account(
  raw: unknown,
  documentUrl: string,
  startedAt: number,
  now: () => number,
): BrowserAccountObservation {
  const parsed = ChatGptAccountObservationSchema.safeParse(raw);
  if (!parsed.success || parsed.data.state !== "observed")
    fail("chat_browser_account_unavailable");
  const fact = parsed.data,
    at = now();
  if (
    fact.documentUrl !== documentUrl ||
    fact.observedAtMillis < startedAt ||
    fact.observedAtMillis > at ||
    at - fact.observedAtMillis >= 5000 ||
    fact.expiresAtMillis <= at
  )
    fail("chat_browser_account_unavailable");
  return {
    state: "observed",
    source: fact.source,
    principalKey: fact.accountKey,
    observedAtMillis: String(fact.observedAtMillis),
    expiresAtMillis: String(fact.expiresAtMillis),
  };
}
