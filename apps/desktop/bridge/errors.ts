export class BridgeError extends Error {
  constructor(
    readonly state: "unavailable" | "unknown" | "refused" | "unsupported",
    readonly code: string,
  ) {
    super(code);
  }
}
// The original pure observation settled after its host budget. Discarding that
// result does not claim it was never evaluated, renew authority or permit replay.
export class PollingObservationExpiredError extends BridgeError {
  constructor() {
    super("refused", "connector_polling_expired");
  }
}
export class HealthObservationExpiredError extends BridgeError {
  constructor() {
    super("refused", "connector_health_expired");
  }
}
// A local refusal before stdin.write, not a remote outcome or a pipe error.
// Keep this distinct from an identically named provider/protocol failure.
export class RequestNotSentError extends BridgeError {
  constructor(
    code: "backpressure" | "request_deadline_expired" = "backpressure",
  ) {
    super(code === "backpressure" ? "unavailable" : "refused", code);
  }
}
