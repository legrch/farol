import { validate, type Json } from "./wire.ts";

// Read-only requests that keep their own wire sequence and expiry rules.
export type ReadLane = "browser" | "settings" | "health" | "audit";

export function laneOf(method: string): ReadLane | undefined {
  return method === "chat.browser.next"
    ? "browser"
    : method === "computer.settings.store.next"
      ? "settings"
      : method === "computer.connector.health"
        ? "health"
        : method === "computer.process.audit"
          ? "audit"
          : undefined;
}

// Wire IDs are private to the client: callers may not choose one that could
// collide with the sequenced namespace, or be mistaken for another lane.
export function reservedRequestId(id: string): boolean {
  return id.startsWith("desktop-poll-") || id.startsWith("desktop-call:");
}

export function wireRequestId(
  lane: ReadLane | undefined,
  nonce: string,
  sequence: bigint,
): string {
  return lane === undefined
    ? `desktop-call:${nonce}:${sequence}`
    : `desktop-poll-${lane}:${nonce}:${sequence}`;
}

// Trusted host budget only; never sent as transport or provider authority.
export function validCallDeadline(
  timeoutMs: number,
  deadlineAtMillis: number | undefined,
): boolean {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
    return false;
  return (
    deadlineAtMillis === undefined || Number.isSafeInteger(deadlineAtMillis)
  );
}

// A read-only lane or polling observation never carries an operation fence and
// its body must be exactly the request its method defines.
export function validCallBody(
  input: Readonly<{
    id: string;
    body: Json;
    operationId: string | undefined;
    lane: ReadLane | undefined;
    polling: boolean;
  }>,
): boolean {
  const { id, body, operationId, lane, polling } = input;
  if (!validate("id", id)) return false;
  if (
    polling &&
    (operationId !== undefined ||
      !validate("ComputerConnectorPollingRequest", body))
  )
    return false;
  if (lane === undefined) return true;
  if (operationId !== undefined) return false;
  return validate(
    lane === "browser"
      ? "BrowserNext"
      : lane === "settings"
        ? "SettingsStoreNext"
        : lane === "audit"
          ? "ComputerProcessAuditRequest"
          : "ComputerConnectorHealthRequest",
    body,
  );
}
