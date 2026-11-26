import { describe, expect, it } from "vitest";
import {
  BridgeError,
  HealthObservationExpiredError,
  PollingObservationExpiredError,
  RequestNotSentError,
} from "./errors.ts";

describe("bridge errors", () => {
  it("carries its state and code as the message", () => {
    const error = new BridgeError("unknown", "response_timeout");
    expect(error).toBeInstanceOf(Error);
    expect(error.state).toBe("unknown");
    expect(error.code).toBe("response_timeout");
    expect(error.message).toBe("response_timeout");
  });

  it("refuses an expired observation without claiming it was unevaluated", () => {
    const polling = new PollingObservationExpiredError();
    const health = new HealthObservationExpiredError();
    expect([polling.state, polling.code]).toEqual([
      "refused",
      "connector_polling_expired",
    ]);
    expect([health.state, health.code]).toEqual([
      "refused",
      "connector_health_expired",
    ]);
    expect(polling).toBeInstanceOf(BridgeError);
    expect(health).toBeInstanceOf(BridgeError);
  });

  it("keeps a local refusal before write distinct by code", () => {
    const backpressure = new RequestNotSentError();
    expect([backpressure.state, backpressure.code]).toEqual([
      "unavailable",
      "backpressure",
    ]);
    const expired = new RequestNotSentError("request_deadline_expired");
    expect([expired.state, expired.code]).toEqual([
      "refused",
      "request_deadline_expired",
    ]);
  });
});
