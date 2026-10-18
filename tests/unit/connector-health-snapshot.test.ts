import { describe, expect, it } from "vitest";
import { parseConnectorHealthSnapshot } from "../../src/modules/computer/infra/connector-health-snapshot";

// In-memory examples of the Lead-settled v0.0.16 aggregate schema only.
// These fixtures provide no native, HTTP, provider, or installed evidence.
const snapshotAt = "2026-10-18T12:00:00.123456789Z";
const snapshotMillis = Date.parse("2026-10-18T12:00:00.123Z");
const startedAt = "2026-10-18T11:00:00Z";
const startedMillis = Date.parse(startedAt);

function pollingFixture(): Record<string, unknown> {
  return {
    status: "ok",
    state: "polling",
    limited: false,
    observed_at: snapshotAt,
    details: {
      last_attempt: "2026-10-18T11:59:59.5Z",
      last_success: "2026-10-18T11:59:58Z",
      last_error: "2026-10-18T11:50:00Z",
      next_retry: "2026-10-18T12:00:02Z",
      consecutive_failures: 0,
      current_poll_age_seconds: 0.625,
      configured_wait_seconds: 25,
      effective_wait_seconds: 24.5,
      deadline_seconds: 30,
      failure_category: "http_error",
      http_status: 503,
    },
  };
}

function deliveryFixture(): Record<string, unknown> {
  return {
    status: "degraded",
    state: "uploading",
    limited: false,
    observed_at: snapshotAt,
    details: {
      in_progress: 1,
      attempts: 4,
      retries: 2,
      accepted: 1,
      completed: 2,
      terminal_failures: 0,
      last_accepted: "2026-10-18T11:59:55Z",
      last_completed: "2026-10-18T11:59:56Z",
      last_failure: "2026-10-18T11:59:57Z",
      disposition: "not_observed",
      failure_category: "network_error",
      http_status: 0,
    },
  };
}

function envelope(
  components: unknown = {
    control_plane: pollingFixture(),
    response_delivery: deliveryFixture(),
  },
): Record<string, unknown> {
  return {
    schema_version: 1,
    live: true,
    ready: true,
    snapshot_at: snapshotAt,
    runtime: {
      instance_id: "runtime_1-abc",
      started_at: startedAt,
      lifecycle: "running",
      limited: false,
    },
    components,
    truncated: false,
  };
}

function details(component: Record<string, unknown>): Record<string, unknown> {
  return component.details as Record<string, unknown>;
}

function freezeInput(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freezeInput(child);
  Object.freeze(value);
}

describe("parseConnectorHealthSnapshot", () => {
  it("normalizes only the documented aggregate polling and delivery fields", () => {
    expect(parseConnectorHealthSnapshot(envelope())).toEqual({
      snapshotAtMillis: snapshotMillis,
      runtimeInstanceId: "runtime_1-abc",
      runtimeStartedAtMillis: startedMillis,
      runtimeLifecycle: "running",
      runtimeLimited: false,
      live: true,
      ready: true,
      truncated: false,
      controlPlane: {
        status: "ok",
        state: "polling",
        limited: false,
        observedAtMillis: snapshotMillis,
        details: {
          lastAttemptMillis: Date.parse("2026-10-18T11:59:59.500Z"),
          lastSuccessMillis: Date.parse("2026-10-18T11:59:58Z"),
          lastErrorMillis: Date.parse("2026-10-18T11:50:00Z"),
          nextRetryMillis: Date.parse("2026-10-18T12:00:02Z"),
          consecutiveFailures: 0,
          currentPollAgeSeconds: 0.625,
          configuredWaitSeconds: 25,
          effectiveWaitSeconds: 24.5,
          deadlineSeconds: 30,
          failureCategory: "http_error",
          httpStatus: 503,
        },
      },
      responseDelivery: {
        status: "degraded",
        state: "uploading",
        limited: false,
        observedAtMillis: snapshotMillis,
        details: {
          inProgress: 1,
          attempts: 4,
          retries: 2,
          accepted: 1,
          completed: 2,
          terminalFailures: 0,
          lastAcceptedMillis: Date.parse("2026-10-18T11:59:55Z"),
          lastCompletedMillis: Date.parse("2026-10-18T11:59:56Z"),
          lastFailureMillis: Date.parse("2026-10-18T11:59:57Z"),
          disposition: "not_observed",
          failureCategory: "network_error",
          httpStatus: null,
        },
      },
    });
  });

  it.each([undefined, null, false, 1, "{}", [], {}, { schema_version: 2 }])(
    "rejects empty or unsupported envelopes: %s",
    (input) => {
      expect(parseConnectorHealthSnapshot(input)).toBeNull();
    },
  );

  it.each(["schema_version", "live", "ready", "snapshot_at", "runtime"])(
    "requires critical envelope field %s",
    (key) => {
      const input = envelope();
      delete input[key];
      expect(parseConnectorHealthSnapshot(input)).toBeNull();
    },
  );

  it.each([
    ["schema_version", "1"],
    ["schema_version", true],
    ["live", 1],
    ["ready", "true"],
    ["snapshot_at", 1],
    ["runtime", []],
    ["runtime", null],
    ["truncated", 1],
    ["truncated", null],
    ["truncated", undefined],
  ])("rejects malformed envelope %s = %s", (key, value) => {
    expect(
      parseConnectorHealthSnapshot({ ...envelope(), [key as string]: value }),
    ).toBeNull();
  });

  it.each([
    ["instance_id", ""],
    ["instance_id", "a".repeat(129)],
    ["instance_id", "runtime/name"],
    ["instance_id", "runtime\n"],
    ["instance_id", "runtimé"],
    ["instance_id", 1],
    ["started_at", null],
    ["lifecycle", "stopped"],
    ["limited", "false"],
    ["limited", null],
    ["limited", undefined],
  ])("rejects malformed runtime %s = %s", (key, value) => {
    const input = envelope();
    input.runtime = {
      ...(input.runtime as Record<string, unknown>),
      [key as string]: value,
    };
    expect(parseConnectorHealthSnapshot(input)).toBeNull();
  });

  it.each(["instance_id", "started_at", "lifecycle"])(
    "requires runtime field %s",
    (key) => {
      const input = envelope();
      delete (input.runtime as Record<string, unknown>)[key];
      expect(parseConnectorHealthSnapshot(input)).toBeNull();
    },
  );

  it("preserves omitted components and flag defaults without inventing details", () => {
    const input = envelope();
    delete input.components;
    delete input.truncated;
    delete (input.runtime as Record<string, unknown>).limited;
    expect(parseConnectorHealthSnapshot(input)).toMatchObject({
      runtimeLimited: false,
      truncated: false,
      controlPlane: null,
      responseDelivery: null,
    });
    for (const components of [
      null,
      [],
      "invalid",
      {},
      { future_component: { status: "ok" } },
    ]) {
      expect(parseConnectorHealthSnapshot(envelope(components))).toMatchObject({
        controlPlane: null,
        responseDelivery: null,
      });
    }
  });

  it.each(["starting", "running", "draining"])(
    "parses runtime lifecycle %s without policy",
    (lifecycle) => {
      const input = envelope();
      input.live = false;
      input.ready = false;
      input.truncated = true;
      input.runtime = {
        instance_id: "a".repeat(128),
        started_at: "9999-01-01T00:00:00Z",
        lifecycle,
        limited: true,
      };
      input.snapshot_at = "9999-12-31T23:59:59.999999999Z";
      const parsed = parseConnectorHealthSnapshot(input);
      expect(parsed).toMatchObject({
        live: false,
        ready: false,
        truncated: true,
        runtimeLimited: true,
        runtimeLifecycle: lifecycle,
      });
      expect(parsed?.snapshotAtMillis).toBe(
        Date.parse("9999-12-31T23:59:59.999Z"),
      );
    },
  );

  it.each([
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["2026-10-18T12:00:00.1Z", "2026-10-18T12:00:00.100Z"],
    ["2026-10-18T12:00:00.12Z", "2026-10-18T12:00:00.120Z"],
    ["2026-10-18T12:00:00.1239Z", "2026-10-18T12:00:00.123Z"],
    ["2026-10-18t12:00:00.000000001z", "2026-10-18T12:00:00.000Z"],
    ["2026-10-18T12:00:00.123456789+00:00", "2026-10-18T12:00:00.123Z"],
    ["1970-01-01T00:00:00.001Z", "1970-01-01T00:00:00.001Z"],
  ])("parses UTC RFC3339 %s and truncates fractions", (input, expected) => {
    expect(
      parseConnectorHealthSnapshot({ ...envelope(), snapshot_at: input })
        ?.snapshotAtMillis,
    ).toBe(Date.parse(expected));
  });

  const invalidDates = [
    "2026-02-29T12:00:00Z",
    "2024-02-30T12:00:00Z",
    "2100-02-29T00:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:60Z",
    "2026-01-01T12:00:00",
    "2026-01-01 12:00:00Z",
    "2026-01-01T12:00:00+01:00",
    "2026-01-01T12:00:00-00:00",
    "2026-01-01T12:00:00.Z",
    "2026-01-01T12:00:00.1234567890Z",
    "2026-01-01T12:00:00Z\n",
    "1970-01-01T00:00:00Z",
    "1970-01-01T00:00:00.000000001Z",
    "1969-12-31T23:59:59Z",
    "0000-01-01T00:00:00Z",
    "+10000-01-01T00:00:00Z",
    "not a date",
  ];
  it.each(invalidDates)(
    "rejects invalid or nonpositive envelope timestamp %s",
    (value) => {
      const input = envelope();
      input.snapshot_at = value;
      expect(parseConnectorHealthSnapshot(input)).toBeNull();
      input.snapshot_at = snapshotAt;
      (input.runtime as Record<string, unknown>).started_at = value;
      expect(parseConnectorHealthSnapshot(input)).toBeNull();
    },
  );

  it.each([
    "starting",
    "polling",
    "idle",
    "backoff",
    "backpressured",
    "stopped",
  ])("keeps allowlisted polling state %s", (state) => {
    expect(
      parseConnectorHealthSnapshot(
        envelope({ control_plane: { ...pollingFixture(), state } }),
      )?.controlPlane?.state,
    ).toBe(state);
  });

  it.each(["ok", "degraded", "unknown", "disabled"])(
    "keeps component status %s without classifying",
    (status) => {
      const parsed = parseConnectorHealthSnapshot(
        envelope({
          control_plane: { ...pollingFixture(), status, limited: true },
          response_delivery: { ...deliveryFixture(), status, limited: true },
        }),
      );
      expect(parsed?.controlPlane).toMatchObject({ status, limited: true });
      expect(parsed?.responseDelivery).toMatchObject({ status, limited: true });
    },
  );

  it.each([
    null,
    [],
    {},
    { ...pollingFixture(), state: "future_state" },
    { ...pollingFixture(), status: "healthy" },
    { ...pollingFixture(), limited: "false" },
    { ...pollingFixture(), limited: null },
    { ...pollingFixture(), limited: undefined },
    { ...pollingFixture(), observed_at: "2026-02-30T12:00:00Z" },
  ])(
    "withholds malformed or unsupported polling components: %s",
    (control_plane) => {
      const parsed = parseConnectorHealthSnapshot(
        envelope({ control_plane, response_delivery: deliveryFixture() }),
      );
      expect(parsed?.controlPlane).toBeNull();
      expect(parsed?.responseDelivery).not.toBeNull();
    },
  );

  it("withholds components missing their required limited flag", () => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    delete control_plane.limited;
    delete response_delivery.limited;
    expect(
      parseConnectorHealthSnapshot(
        envelope({ control_plane, response_delivery }),
      ),
    ).toMatchObject({ controlPlane: null, responseDelivery: null });
  });

  it("keeps bounded future delivery states and sparse optional data", () => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    delete control_plane.observed_at;
    response_delivery.observed_at = null;
    response_delivery.state = "future_delivery_v2";
    for (const key of [
      "last_attempt",
      "last_success",
      "last_error",
      "next_retry",
      "failure_category",
      "http_status",
    ])
      delete details(control_plane)[key];
    for (const key of [
      "last_accepted",
      "last_completed",
      "last_failure",
      "failure_category",
      "http_status",
    ])
      delete details(response_delivery)[key];
    details(response_delivery).disposition = "future_disposition_v2";
    const parsed = parseConnectorHealthSnapshot(
      envelope({ control_plane, response_delivery }),
    );
    expect(parsed?.controlPlane).toMatchObject({
      limited: false,
      observedAtMillis: null,
      details: {
        lastAttemptMillis: null,
        lastSuccessMillis: null,
        lastErrorMillis: null,
        nextRetryMillis: null,
        failureCategory: null,
        httpStatus: null,
      },
    });
    expect(parsed?.responseDelivery).toMatchObject({
      state: "future_delivery_v2",
      observedAtMillis: null,
      details: {
        lastAcceptedMillis: null,
        lastCompletedMillis: null,
        lastFailureMillis: null,
        disposition: "future_disposition_v2",
        failureCategory: null,
        httpStatus: null,
      },
    });
  });

  it.each([
    "",
    "a".repeat(33),
    "private error text",
    "http://private.invalid",
    "upload\n",
    "uplöad",
    1,
    null,
  ])("withholds invalid delivery identifiers %s", (value) => {
    const response_delivery = deliveryFixture();
    response_delivery.state = value;
    expect(
      parseConnectorHealthSnapshot(envelope({ response_delivery }))
        ?.responseDelivery,
    ).toBeNull();
    response_delivery.state = "uploading";
    details(response_delivery).disposition = value;
    expect(
      parseConnectorHealthSnapshot(envelope({ response_delivery }))
        ?.responseDelivery?.details,
    ).toBeNull();
  });

  it("does not infer acceptance from completion, 404, or disposition", () => {
    const response_delivery = deliveryFixture();
    Object.assign(details(response_delivery), {
      accepted: 0,
      completed: 4,
      http_status: 404,
      disposition: "completed",
    });
    delete details(response_delivery).last_accepted;
    expect(
      parseConnectorHealthSnapshot(envelope({ response_delivery }))
        ?.responseDelivery?.details,
    ).toMatchObject({
      accepted: 0,
      completed: 4,
      httpStatus: 404,
      disposition: "completed",
      lastAcceptedMillis: null,
    });
  });

  const invalidCounters = [
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    -Infinity,
    "1",
    true,
    null,
    undefined,
  ];
  for (const key of [
    "consecutive_failures",
    "in_progress",
    "attempts",
    "retries",
    "accepted",
    "completed",
    "terminal_failures",
  ]) {
    it.each(invalidCounters)(
      `withholds details for invalid counter ${key}: %s`,
      (value) => {
        const control_plane = pollingFixture();
        const response_delivery = deliveryFixture();
        const target =
          key === "consecutive_failures" ? control_plane : response_delivery;
        details(target)[key] = value;
        const parsed = parseConnectorHealthSnapshot(
          envelope({ control_plane, response_delivery }),
        );
        expect(
          (key === "consecutive_failures"
            ? parsed?.controlPlane
            : parsed?.responseDelivery
          )?.details,
        ).toBeNull();
      },
    );
    it(`does not fabricate missing counter ${key}`, () => {
      const control_plane = pollingFixture();
      const response_delivery = deliveryFixture();
      delete details(
        key === "consecutive_failures" ? control_plane : response_delivery,
      )[key];
      const parsed = parseConnectorHealthSnapshot(
        envelope({ control_plane, response_delivery }),
      );
      expect(
        (key === "consecutive_failures"
          ? parsed?.controlPlane
          : parsed?.responseDelivery
        )?.details,
      ).toBeNull();
    });
  }

  for (const key of [
    "current_poll_age_seconds",
    "configured_wait_seconds",
    "effective_wait_seconds",
    "deadline_seconds",
  ]) {
    it.each([
      -1,
      Number.MAX_SAFE_INTEGER / 1_000 + 1,
      NaN,
      Infinity,
      "1",
      null,
      undefined,
    ])(`withholds invalid duration ${key}: %s`, (value) => {
      const control_plane = pollingFixture();
      details(control_plane)[key] = value;
      expect(
        parseConnectorHealthSnapshot(envelope({ control_plane }))?.controlPlane
          ?.details,
      ).toBeNull();
    });
  }

  it("accepts exact safe numeric boundaries without narrowing counters", () => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    details(control_plane).consecutive_failures = Number.MAX_SAFE_INTEGER;
    for (const key of [
      "current_poll_age_seconds",
      "configured_wait_seconds",
      "effective_wait_seconds",
      "deadline_seconds",
    ])
      details(control_plane)[key] = Number.MAX_SAFE_INTEGER / 1_000;
    for (const key of [
      "in_progress",
      "attempts",
      "retries",
      "accepted",
      "completed",
      "terminal_failures",
    ])
      details(response_delivery)[key] = Number.MAX_SAFE_INTEGER;
    const parsed = parseConnectorHealthSnapshot(
      envelope({ control_plane, response_delivery }),
    );
    expect(parsed?.controlPlane?.details?.consecutiveFailures).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parsed?.controlPlane?.details?.deadlineSeconds).toBe(
      Number.MAX_SAFE_INTEGER / 1_000,
    );
    expect(parsed?.responseDelivery?.details?.accepted).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  for (const key of [
    "last_attempt",
    "last_success",
    "last_error",
    "next_retry",
    "last_accepted",
    "last_completed",
    "last_failure",
  ]) {
    it.each(["2026-02-30T12:00:00Z", 1, false, undefined])(
      `withholds malformed optional timestamp ${key}: %s`,
      (value) => {
        const control_plane = pollingFixture();
        const response_delivery = deliveryFixture();
        const polling = [
          "last_attempt",
          "last_success",
          "last_error",
          "next_retry",
        ].includes(key);
        details(polling ? control_plane : response_delivery)[key] = value;
        const parsed = parseConnectorHealthSnapshot(
          envelope({ control_plane, response_delivery }),
        );
        expect(
          (polling ? parsed?.controlPlane : parsed?.responseDelivery)?.details,
        ).toBeNull();
      },
    );
  }

  it.each([
    "http_error",
    "timeout",
    "canceled",
    "network_error",
    "request_error",
    "future_error",
    null,
  ])("normalizes failure category %s for both components", (value) => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    details(control_plane).failure_category = value;
    details(response_delivery).failure_category = value;
    const parsed = parseConnectorHealthSnapshot(
      envelope({ control_plane, response_delivery }),
    );
    expect(parsed?.controlPlane?.details?.failureCategory).toBe(
      value === "future_error" ? null : value,
    );
    expect(parsed?.responseDelivery?.details?.failureCategory).toBe(
      value === "future_error" ? null : value,
    );
  });

  it.each([100, 200, 401, 403, 429, 503, 504, 599, 0, null])(
    "normalizes optional HTTP status %s",
    (value) => {
      const control_plane = pollingFixture();
      const response_delivery = deliveryFixture();
      details(control_plane).http_status = value;
      details(response_delivery).http_status = value;
      const parsed = parseConnectorHealthSnapshot(
        envelope({ control_plane, response_delivery }),
      );
      expect(parsed?.controlPlane?.details?.httpStatus).toBe(
        value === 0 ? null : value,
      );
      expect(parsed?.responseDelivery?.details?.httpStatus).toBe(
        value === 0 ? null : value,
      );
    },
  );

  it.each([
    ["http_status", 99],
    ["http_status", 600],
    ["http_status", 200.5],
    ["http_status", "200"],
    ["http_status", Infinity],
    ["http_status", NaN],
    ["failure_category", {}],
    ["failure_category", 1],
  ])("withholds details for malformed optional %s: %s", (key, value) => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    details(control_plane)[key as string] = value;
    details(response_delivery)[key as string] = value;
    const parsed = parseConnectorHealthSnapshot(
      envelope({ control_plane, response_delivery }),
    );
    expect(parsed?.controlPlane?.details).toBeNull();
    expect(parsed?.responseDelivery?.details).toBeNull();
  });

  it.each([null, [], "invalid", {}])(
    "keeps component identity but withholds malformed details %s",
    (value) => {
      const control_plane = pollingFixture();
      control_plane.details = value;
      const parsed = parseConnectorHealthSnapshot(envelope({ control_plane }));
      expect(parsed?.controlPlane).toMatchObject({
        status: "ok",
        state: "polling",
        details: null,
      });
    },
  );

  it("ignores extra fields at every level and never aliases or mutates input", () => {
    const control_plane = pollingFixture();
    const response_delivery = deliveryFixture();
    const input = envelope({
      control_plane,
      response_delivery,
      private_component: { raw_error: "DO_NOT_RETAIN" },
    });
    input.url = "DO_NOT_RETAIN";
    input.reason_code = "DO_NOT_RETAIN";
    (input.runtime as Record<string, unknown>).credentials = "DO_NOT_RETAIN";
    control_plane.raw_error = "DO_NOT_RETAIN";
    details(control_plane).tool_name = "DO_NOT_RETAIN";
    response_delivery.url = "DO_NOT_RETAIN";
    details(response_delivery).private = { secret: "DO_NOT_RETAIN" };
    const original = JSON.stringify(input);
    const parsed = parseConnectorHealthSnapshot(input);
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(input)).toBe(original);
    expect(JSON.stringify(parsed)).not.toContain("DO_NOT_RETAIN");
    expect(parsed).not.toBe(input);
    expect(parsed?.controlPlane).not.toBe(control_plane);
    expect(parsed?.controlPlane?.details).not.toBe(control_plane.details);
    expect(parsed?.responseDelivery).not.toBe(response_delivery);
    expect(parsed?.responseDelivery?.details).not.toBe(
      response_delivery.details,
    );
    for (const value of [
      parsed,
      parsed?.controlPlane,
      parsed?.controlPlane?.details,
      parsed?.responseDelivery,
      parsed?.responseDelivery?.details,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    details(control_plane).last_success = "2026-10-18T12:10:00Z";
    details(response_delivery).accepted = 999;
    expect(parsed?.controlPlane?.details?.lastSuccessMillis).toBe(
      Date.parse("2026-10-18T11:59:58Z"),
    );
    expect(parsed?.responseDelivery?.details?.accepted).toBe(1);
    const frozen = envelope();
    freezeInput(frozen);
    expect(parseConnectorHealthSnapshot(frozen)).toEqual(
      parseConnectorHealthSnapshot(envelope()),
    );
  });

  it("ignores inherited fields and accessors without invoking them", () => {
    const input = envelope();
    Object.defineProperty(input, "private", {
      get: () => {
        throw new Error("must not read extra fields");
      },
    });
    expect(parseConnectorHealthSnapshot(input)).not.toBeNull();
    Object.defineProperty(input, "live", {
      get: () => {
        throw new Error("must not invoke accessors");
      },
    });
    expect(parseConnectorHealthSnapshot(input)).toBeNull();
    expect(parseConnectorHealthSnapshot(Object.create(envelope()))).toBeNull();
    const components = Object.create({ control_plane: pollingFixture() });
    expect(
      parseConnectorHealthSnapshot(envelope(components))?.controlPlane,
    ).toBeNull();
  });

  it("never throws for inaccessible objects and withholds only malformed typed evidence", () => {
    const inaccessible = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("inaccessible");
        },
      },
    );
    expect(parseConnectorHealthSnapshot(inaccessible)).toBeNull();
    const control_plane = pollingFixture();
    control_plane.details = inaccessible;
    expect(
      parseConnectorHealthSnapshot(envelope({ control_plane }))?.controlPlane
        ?.details,
    ).toBeNull();
    expect(
      parseConnectorHealthSnapshot(envelope({ control_plane: inaccessible }))
        ?.controlPlane,
    ).toBeNull();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(parseConnectorHealthSnapshot(revoked.proxy)).toBeNull();
  });
});
