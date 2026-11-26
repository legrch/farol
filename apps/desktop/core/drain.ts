import { BridgeError } from "../bridge/client.ts";
import { validate } from "../bridge/wire.ts";

type Reply = Readonly<{ status: string; data?: unknown }>;

// Pure shape checks of a fresh session's status, close and terminal reports.
export function interruptedCommandOf(result: Reply): boolean {
  if (result.status !== "ok" || !validate("CoreFreshStatus", result.data))
    throw new BridgeError("unavailable", "invalid_fresh_status");
  return (result.data as { interruptedCommand: boolean }).interruptedCommand;
}

export function confirmFreshDrained(result: Reply): void {
  const data = result.data as { drained?: unknown } | undefined;
  if (
    result.status !== "ok" ||
    !validate("CoreFreshClosed", result.data) ||
    data?.drained !== true
  )
    throw new BridgeError("unknown", "fresh_session_drain_unconfirmed");
}

export function confirmFreshTerminal(
  terminal: Readonly<{
    exitCode: number | null;
    signal: unknown;
    forced: boolean;
  }>,
): void {
  if (terminal.exitCode !== 0 || terminal.signal !== null || terminal.forced)
    throw new BridgeError("unknown", "fresh_session_terminal_unconfirmed");
}
