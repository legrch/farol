import type { ComputerConnectorHealthState } from "./bridge/wire.ts";
import {
  unavailableConnectionStatus,
  type ConnectionStatusView,
} from "./renderer/connection-status.ts";

const labels: Record<ComputerConnectorHealthState["state"], string> = {
  recent_transport: "Recent server polling",
  checking: "Checking connection",
  reconnecting: "Reconnecting",
  unavailable: "Server transport unavailable",
  unobserved: "Connection observation unavailable",
  action_required: "Connection needs attention",
  stopped: "Stopped by owner",
};
const markers: Record<
  ComputerConnectorHealthState["state"],
  ConnectionStatusView["marker"]
> = {
  recent_transport: "✓",
  checking: "…",
  reconnecting: "↻",
  unavailable: "!",
  unobserved: "?",
  action_required: "!",
  stopped: "–",
};
const instant = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    number > 8_640_000_000_000_000
  )
    return null;
  return new Date(number).toISOString();
};

// Expires cached presentation only; it cannot authorize recovery or change Go's
// observation, an operation result, the original lifetime or permission.
export function connectionStatusView(
  value: ComputerConnectorHealthState | null,
  now: number,
  current: boolean,
): Omit<ConnectionStatusView, "revision"> {
  if (!value || !current || !Number.isSafeInteger(now) || now <= 0)
    return unavailableConnectionStatus;
  const observed = Number(value.observedAtMillis),
    until = Number(value.validUntilMillis);
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(until) ||
    observed > now ||
    now >= until
  )
    return unavailableConnectionStatus;
  const lastPoll = instant(value.lastPollSuccessMillis);
  const accepted = instant(value.lastResponseAcceptedMillis);
  const retry = instant(value.nextRetryMillis);
  const local = value.localReady
    ? "Local helper ready."
    : "Local helper not ready.";
  const poll = lastPoll
    ? "Last successful server poll: " + lastPoll + "."
    : "No successful server poll observed.";
  const reason =
    value.reason === "authorization_required"
      ? "Check connection credentials and permissions."
      : value.reason === "http_unavailable"
        ? "The server returned an unavailable response."
        : value.reason === "transport_unavailable"
          ? "A transport request failed or timed out."
          : value.reason === "waiting_without_success" ||
              value.reason === "waiting_with_stale_success"
            ? "Waiting for the current server poll."
            : value.reason.startsWith("backpressured")
              ? "Waiting for current work to drain."
              : "";
  return {
    state: value.state,
    marker: markers[value.state],
    label: labels[value.state],
    attention: ![
      "recent_transport",
      "checking",
      "reconnecting",
      "stopped",
    ].includes(value.state),
    detail: [
      local,
      poll,
      reason,
      retry && Number(value.nextRetryMillis) > now
        ? "Next helper retry: " + retry + "."
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    delivery: accepted
      ? "Last accepted response upload: " +
        accepted +
        ". This historical observation does not confirm current attachment."
      : "No accepted response upload observed. External attachment has not been confirmed.",
  };
}

type StatusPorts<T> = Readonly<{
  capture(): T | null;
  current(original: T): boolean;
  observe(original: T): Promise<ComputerConnectorHealthState | null>;
  now(): number;
  monotonic(): number;
}>;

// This cache owns presentation only. It cannot execute or restart a connector.
// Invalidation also fences a response already in flight across sleep or Quit.
export class ConnectionStatusTracker<T> {
  private epoch = 0;
  private suspended = false;
  private closed = false;
  private inFlight: Promise<void> | null = null;
  private inFlightEpoch: number | null = null;
  private repeatRequested = false;
  private retained: Readonly<{
    original: T;
    value: ComputerConnectorHealthState;
    wall: number;
    monotonic: number;
    expires: number;
  }> | null = null;
  constructor(private readonly ports: StatusPorts<T>) {}
  invalidate(): void {
    this.epoch++;
    this.retained = null;
    this.repeatRequested = false;
  }
  suspend(): void {
    this.suspended = true;
    this.invalidate();
  }
  resume(): void {
    this.suspended = false;
    this.invalidate();
  }
  close(): void {
    this.closed = true;
    this.invalidate();
  }
  view(): Omit<ConnectionStatusView, "revision"> {
    try {
      return this.currentView();
    } catch {
      this.retained = null;
      return unavailableConnectionStatus;
    }
  }
  private currentView(): Omit<ConnectionStatusView, "revision"> {
    const saved = this.retained;
    if (!saved || this.closed || this.suspended)
      return unavailableConnectionStatus;
    const wall = this.ports.now(),
      mono = this.ports.monotonic();
    if (
      !Number.isFinite(mono) ||
      mono < saved.monotonic ||
      mono >= saved.expires ||
      Math.abs(wall - saved.wall - (mono - saved.monotonic)) > 1000 ||
      !this.ports.current(saved.original)
    ) {
      this.retained = null;
      return unavailableConnectionStatus;
    }
    return connectionStatusView(saved.value, wall, true);
  }
  sample(): Promise<void> {
    if (this.closed || this.suspended) return Promise.resolve();
    if (this.inFlight) {
      if (this.inFlightEpoch !== this.epoch) this.repeatRequested = true;
      return this.inFlight;
    }
    const epoch = this.epoch;
    let original: T | null;
    let wall: number, mono: number;
    try {
      original = this.ports.capture();
      if (!original || !this.ports.current(original)) {
        this.retained = null;
        return Promise.resolve();
      }
      wall = this.ports.now();
      mono = this.ports.monotonic();
    } catch {
      this.retained = null;
      return Promise.resolve();
    }
    const captured = original;
    const operation = (async () => {
      try {
        const value = await this.ports.observe(captured);
        if (this.epoch !== epoch || this.closed || this.suspended) return;
        this.retained = null;
        const endWall = this.ports.now(),
          endMono = this.ports.monotonic();
        if (
          !value ||
          !this.ports.current(captured) ||
          !Number.isFinite(mono) ||
          !Number.isFinite(endMono) ||
          endMono < mono ||
          Math.abs(endWall - wall - (endMono - mono)) > 1000
        )
          return;
        const until = Number(value.validUntilMillis),
          observed = Number(value.observedAtMillis);
        if (!Number.isSafeInteger(until) || !Number.isSafeInteger(observed))
          return;
        // Bound validity by the original request's budget as well as the
        // producer snapshot. A wall-clock jump cannot prolong a cached green.
        const expires =
          mono + Math.max(0, Math.min(until - wall, until - observed));
        this.retained = {
          original: captured,
          value,
          wall,
          monotonic: mono,
          expires,
        };
      } catch {
        if (this.epoch === epoch) this.retained = null;
      }
    })();
    this.inFlight = operation;
    this.inFlightEpoch = epoch;
    void operation.finally(() => {
      if (this.inFlight !== operation) return;
      this.inFlight = null;
      this.inFlightEpoch = null;
      const repeat = this.repeatRequested;
      this.repeatRequested = false;
      if (repeat && !this.closed && !this.suspended) void this.sample();
    });
    return operation;
  }
}
