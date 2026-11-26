import { describe, expect, it } from "vitest";
import {
  laneOf,
  reservedRequestId,
  validCallBody,
  validCallDeadline,
  wireRequestId,
} from "./lane.ts";

describe("laneOf", () => {
  it("names the four read lanes and nothing else", () => {
    expect(laneOf("chat.browser.next")).toBe("browser");
    expect(laneOf("computer.settings.store.next")).toBe("settings");
    expect(laneOf("computer.connector.health")).toBe("health");
    expect(laneOf("computer.process.audit")).toBe("audit");
    expect(laneOf("computer.connector.polling")).toBeUndefined();
    expect(laneOf("core.status")).toBeUndefined();
  });
});

describe("wire request identifiers", () => {
  it("reserves both sequenced namespaces", () => {
    expect(reservedRequestId("desktop-call:abc:1")).toBe(true);
    expect(reservedRequestId("desktop-poll-browser:abc:1")).toBe(true);
    expect(reservedRequestId("caller-1")).toBe(false);
  });

  it("builds a call or lane identifier from the nonce and sequence", () => {
    expect(wireRequestId(undefined, "nonce", 7n)).toBe("desktop-call:nonce:7");
    expect(wireRequestId("browser", "nonce", 7n)).toBe(
      "desktop-poll-browser:nonce:7",
    );
    expect(wireRequestId("audit", "nonce", 18446744073709551615n)).toBe(
      "desktop-poll-audit:nonce:18446744073709551615",
    );
  });

  it("builds identifiers that callers cannot submit", () => {
    for (const lane of [
      undefined,
      "browser",
      "settings",
      "health",
      "audit",
    ] as const)
      expect(reservedRequestId(wireRequestId(lane, "n", 1n))).toBe(true);
  });
});

describe("validCallDeadline", () => {
  it("accepts a positive budget up to thirty seconds", () => {
    expect(validCallDeadline(1, undefined)).toBe(true);
    expect(validCallDeadline(30000, undefined)).toBe(true);
    expect(validCallDeadline(2000, Date.now())).toBe(true);
  });

  it("refuses any other budget or a non-integer host deadline", () => {
    for (const timeoutMs of [0, -1, 30001, Number.NaN, Infinity])
      expect(validCallDeadline(timeoutMs, undefined)).toBe(false);
    for (const deadline of [1.5, Number.NaN, 2 ** 53, Infinity])
      expect(validCallDeadline(2000, deadline)).toBe(false);
  });
});

describe("validCallBody", () => {
  const ordinary = {
    id: "call-1",
    body: { anything: true },
    operationId: undefined,
    lane: undefined,
    polling: false,
  };

  it("leaves an ordinary call body to its module", () => {
    expect(validCallBody(ordinary)).toBe(true);
    expect(validCallBody({ ...ordinary, operationId: "operation-1" })).toBe(
      true,
    );
  });

  it("refuses an identifier outside the id grammar", () => {
    expect(validCallBody({ ...ordinary, id: "bad id!" })).toBe(false);
    expect(validCallBody({ ...ordinary, id: "" })).toBe(false);
  });

  it("requires the exact body of a read lane and no operation fence", () => {
    const lane = { ...ordinary, lane: "browser" as const };
    expect(validCallBody({ ...lane, body: { deadlineMillis: "100" } })).toBe(
      true,
    );
    expect(validCallBody({ ...lane, body: {} })).toBe(false);
    expect(
      validCallBody({
        ...lane,
        body: { deadlineMillis: "100" },
        operationId: "operation-1",
      }),
    ).toBe(false);
    expect(
      validCallBody({
        ...ordinary,
        lane: "settings",
        body: { deadlineMillis: "100" },
      }),
    ).toBe(true);
    expect(
      validCallBody({
        ...ordinary,
        lane: "audit",
        body: { operationId: "op", buildId: "build", runtimeId: "runtime" },
      }),
    ).toBe(true);
    expect(
      validCallBody({
        ...ordinary,
        lane: "audit",
        body: { deadlineMillis: "1" },
      }),
    ).toBe(false);
    expect(
      validCallBody({
        ...ordinary,
        lane: "health",
        body: { deadlineMillis: "1" },
      }),
    ).toBe(false);
  });

  it("requires a polling request body and no operation fence", () => {
    const polling = { ...ordinary, polling: true };
    const body = {
      binding: {
        buildId: "build",
        profileId: "profile",
        backendGeneration: "backend",
        runtimeId: "runtime",
        connectorGeneration: "1",
      },
      samples: { cycles: "10", errors: "0" },
    };
    expect(validCallBody({ ...polling, body })).toBe(true);
    expect(validCallBody({ ...polling, body: {} })).toBe(false);
    expect(
      validCallBody({ ...polling, body, operationId: "operation-1" }),
    ).toBe(false);
  });
});
