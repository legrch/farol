import { describe, expect, it } from "vitest";
import {
  HealthObservationExpiredError,
  PollingObservationExpiredError,
} from "./errors.ts";
import {
  diagnosticExpired,
  diagnosticObservation,
  matchesDiagnostic,
  type DiagnosticObservation,
  type HealthObservation,
  type PollingObservation,
} from "./observation.ts";
import type { Outcome } from "./wire.ts";

const binding: PollingObservation["binding"] = {
  profileId: "profile",
  backendGeneration: "backend",
  buildId: "build",
  runtimeId: "runtime",
  connectorGeneration: "1",
};

const polling: PollingObservation = {
  deadlineMillis: 10,
  binding,
  samples: { cycles: "10", errors: "0" },
};

const health: HealthObservation = {
  deadlineMillis: 10,
  binding,
  expectedInstanceId: "instance-1",
  sampleAtMillis: "42",
};

function outcome(fields: Record<string, unknown>): Outcome {
  return { status: "ok", ...fields } as unknown as Outcome;
}

describe("diagnosticObservation", () => {
  it("prefers the health observation, then polling, then none", () => {
    expect(
      diagnosticObservation({
        healthObservation: health,
        observation: polling,
      }),
    ).toEqual({ kind: "health", value: health });
    expect(diagnosticObservation({ observation: polling })).toEqual({
      kind: "polling",
      value: polling,
    });
    expect(diagnosticObservation({})).toBeNull();
  });
});

describe("diagnosticExpired", () => {
  it("names the expired observation kind", () => {
    expect(diagnosticExpired({ kind: "health", value: health })).toBeInstanceOf(
      HealthObservationExpiredError,
    );
    expect(
      diagnosticExpired({ kind: "polling", value: polling }),
    ).toBeInstanceOf(PollingObservationExpiredError);
  });
});

describe("matchesDiagnostic", () => {
  const original: DiagnosticObservation = { kind: "polling", value: polling };

  it("rejects any reply that carries an operation id", () => {
    expect(
      matchesDiagnostic(outcome({ operationId: "op", status: "ok" }), original),
    ).toBe(false);
  });

  it("accepts a refusal only when it carries no data", () => {
    expect(matchesDiagnostic(outcome({ status: "refused" }), original)).toBe(
      true,
    );
    expect(
      matchesDiagnostic(outcome({ status: "refused", data: {} }), original),
    ).toBe(false);
  });

  it("rejects an ok reply that carries a code", () => {
    expect(
      matchesDiagnostic(outcome({ status: "ok", code: "x" }), original),
    ).toBe(false);
  });

  it("accepts a polling state bound to the original binding and samples", () => {
    const state = {
      binding: { ...binding },
      state: "recent",
      observedAtMillis: "100",
      cycles: "10",
      errors: "0",
      ageSeconds: "1",
    };
    expect(matchesDiagnostic(outcome({ data: state }), original)).toBe(true);
    expect(
      matchesDiagnostic(
        outcome({
          data: { ...state, binding: { ...binding, runtimeId: "x" } },
        }),
        original,
      ),
    ).toBe(false);
    expect(
      matchesDiagnostic(
        outcome({ data: { ...state, cycles: "11" } }),
        original,
      ),
    ).toBe(false);
    // Age is present exactly when the state is recent or stale.
    expect(
      matchesDiagnostic(
        outcome({ data: { ...state, state: "unknown" } }),
        original,
      ),
    ).toBe(false);
  });

  it("accepts a health state for the original instance and sample", () => {
    const state = {
      binding: { ...binding },
      expectedInstanceId: "instance-1",
      sampleAtMillis: "42",
      state: "unobserved",
      reason: "missing_snapshot",
      localReady: false,
    };
    const expected: DiagnosticObservation = { kind: "health", value: health };
    expect(matchesDiagnostic(outcome({ data: state }), expected)).toBe(true);
    expect(
      matchesDiagnostic(
        outcome({ data: { ...state, expectedInstanceId: "other" } }),
        expected,
      ),
    ).toBe(false);
    expect(
      matchesDiagnostic(
        outcome({ data: { ...state, sampleAtMillis: "43" } }),
        expected,
      ),
    ).toBe(false);
  });

  it("rejects ok data that is not the observed state shape", () => {
    expect(
      matchesDiagnostic(outcome({ status: "ok", data: {} }), original),
    ).toBe(false);
    expect(
      matchesDiagnostic(outcome({ status: "ok", data: {} }), {
        kind: "health",
        value: health,
      }),
    ).toBe(false);
  });
});
