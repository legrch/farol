import { describe, expect, it } from "vitest";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
} from "../../src/pkg/product-settings/contract";

// Wire validation only: these fixtures prove no native or provider effects.
const operationId = "11111111-1111-4111-8111-111111111111";
const buildId = "a".repeat(64);
const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" } as const;
const command = {
  kind: "connector.save-and-connect",
  operationId,
  buildId,
  tunnelId: "owner.tunnel:_-1",
  runtimeKey: "fixture-runtime-key-000000000000",
} as const;
const completed = {
  kind: command.kind,
  operationId,
  buildId,
  state: "completed",
  stoppedAt: "complete",
  credentials: "saved",
  connection: "connected",
  code: null,
  externalVerification: "not-proven",
} as const;
const attempt = {
  method: "computer.connector.open",
  requestId: "22222222-2222-4222-8222-222222222222",
  operationId: "33333333-3333-4333-8333-333333333333",
  outcome: "unknown",
} as const;
const unknown = {
  ...completed,
  state: "unknown",
  stoppedAt: "connection",
  connection: "unknown",
  code: "SETTINGS_INPUT_INVALID",
  connectorAttempt: attempt,
} as const;

describe("connector.save-and-connect command boundary", () => {
  it("accepts an exact UUIDv4/build/key command and keeps legacy configure", () => {
    expect(ProductConfigurationCommandSchema.parse(command)).toEqual(command);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId: command.tunnelId,
        runtimeKey: null,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId: command.tunnelId,
        runtimeKey: command.runtimeKey,
      }).success,
    ).toBe(true);
  });

  it.each([
    { operationId: undefined },
    { operationId: "11111111-1111-1111-8111-111111111111" },
    { operationId: "11111111-1111-4111-7111-111111111111" },
    { buildId: undefined },
    { buildId: "A".repeat(64) },
    { buildId: "a".repeat(63) },
    { tunnelId: "" },
    { tunnelId: "owner/tunnel" },
    { tunnelId: " owner" },
    { tunnelId: "a".repeat(161) },
    { runtimeKey: null },
    { runtimeKey: undefined },
    { runtimeKey: "a".repeat(19) },
    { runtimeKey: "a".repeat(513) },
    { runtimeKey: "contains whitespace 0000000000" },
    { runtimeKey: "contains\nnewline000000000000000" },
    { runtimeKey: "non-ascii-🔑-0000000000000000" },
    { retry: true },
  ])("rejects malformed or extra command fields %j", (change) => {
    expect(
      ProductConfigurationCommandSchema.safeParse({ ...command, ...change })
        .success,
    ).toBe(false);
  });

  it("uses the same key length and printable ASCII limits as configure", () => {
    for (const runtimeKey of ["!".repeat(20), "~".repeat(512)]) {
      expect(
        ProductConfigurationCommandSchema.safeParse({ ...command, runtimeKey })
          .success,
      ).toBe(true);
      expect(
        ProductConfigurationCommandSchema.safeParse({
          kind: "connector.configure",
          tunnelId: command.tunnelId,
          runtimeKey,
        }).success,
      ).toBe(true);
    }
  });
});

describe("connector setup result cross-field boundary", () => {
  it("requires original protocol UUIDs even when no outer attempt is supplied", () => {
    for (const connectorSetup of [
      { ...unknown, operationId: "11111111-1111-1111-8111-111111111111" },
      {
        ...unknown,
        connectorAttempt: { ...attempt, requestId: "invented-request" },
      },
      {
        ...unknown,
        connectorAttempt: { ...attempt, operationId: "invented-operation" },
      },
    ])
      expect(
        ProductConfigurationResultSchema.safeParse({
          ok: false,
          error: unknown.code,
          snapshot,
          connectorSetup,
        }).success,
      ).toBe(false);
  });
  it("retains typed completed and unknown receipts in both result branches", () => {
    const success = { ok: true, snapshot, connectorSetup: completed };
    expect(ProductConfigurationResultSchema.parse(success)).toEqual(success);
    // A failed settings fence cannot downgrade the original unknown Go open.
    const failure = {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: unknown,
    };
    expect(ProductConfigurationResultSchema.parse(failure)).toEqual(failure);
    expect(
      ProductConfigurationResultSchema.parse({
        ...failure,
        connectorAttempt: attempt,
      }),
    ).toEqual({ ...failure, connectorAttempt: attempt });
  });

  it("accepts known credential refusal and both new setup codes", () => {
    for (const code of [
      "CONNECTOR_SETUP_BINDING_CHANGED",
      "CONNECTOR_SETUP_STEP_UNCONFIRMED",
    ] as const) {
      const uncertain = code === "CONNECTOR_SETUP_STEP_UNCONFIRMED";
      const connectorSetup = {
        ...completed,
        state: uncertain ? "unknown" : "refused",
        stoppedAt: "credential-admission",
        credentials: "not-started",
        connection: "not-started",
        code,
      };
      expect(
        ProductConfigurationResultSchema.safeParse({
          ok: false,
          error: code,
          snapshot,
          connectorSetup,
        }).success,
      ).toBe(true);
    }
  });

  it.each([
    { ok: true, snapshot, connectorSetup: unknown },
    {
      ok: false,
      error: "CONNECTOR_START_FAILED",
      snapshot,
      connectorSetup: completed,
    },
    {
      ok: false,
      error: "CONNECTOR_START_FAILED",
      snapshot,
      connectorSetup: unknown,
    },
    {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: { ...unknown, state: "refused", connection: "refused" },
    },
    {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: unknown,
      connectorAttempt: { ...attempt, outcome: "known" },
    },
    {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: unknown,
      connectorAttempt: { ...attempt, requestId: operationId },
    },
    {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: unknown,
      connectorAttempt: { ...attempt, operationId },
    },
    {
      ok: false,
      error: unknown.code,
      snapshot,
      connectorSetup: { ...unknown, connectorAttempt: undefined },
      connectorAttempt: attempt,
    },
    {
      ok: true,
      snapshot,
      connectorSetup: { ...completed, runtimeKey: command.runtimeKey },
    },
    {
      ok: true,
      snapshot,
      connectorSetup: { ...completed, externalVerification: "verified" },
    },
    {
      ok: true,
      snapshot,
      connectorSetup: { ...completed, connection: "not-started" },
    },
    { ok: true, snapshot, connectorSetup: null },
  ])("rejects inconsistent or unsafe receipt %j", (result) => {
    expect(ProductConfigurationResultSchema.safeParse(result).success).toBe(
      false,
    );
  });

  it("rejects an outer attempt when the receipt has no attempt", () => {
    const connectorSetup = { ...unknown };
    Reflect.deleteProperty(connectorSetup, "connectorAttempt");
    expect(
      ProductConfigurationResultSchema.safeParse({
        ok: false,
        error: unknown.code,
        snapshot,
        connectorSetup,
        connectorAttempt: attempt,
      }).success,
    ).toBe(false);
  });

  it("never evaluates receipt accessors or retains hidden secret fields", () => {
    let reads = 0;
    const connectorSetup = { ...completed };
    Object.defineProperty(connectorSetup, "runtimeKey", {
      enumerable: true,
      get() {
        reads++;
        return command.runtimeKey;
      },
    });
    expect(
      ProductConfigurationResultSchema.safeParse({
        ok: true,
        snapshot,
        connectorSetup,
      }).success,
    ).toBe(false);
    expect(reads).toBe(0);
    expect(
      JSON.stringify(
        ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot,
          connectorSetup: completed,
        }),
      ),
    ).not.toContain(command.runtimeKey);
  });

  it("keeps receipt-free legacy successes and failures supported", () => {
    expect(
      ProductConfigurationResultSchema.safeParse({ ok: true, snapshot })
        .success,
    ).toBe(true);
    expect(
      ProductConfigurationResultSchema.safeParse({
        ok: false,
        error: "CONNECTOR_STOP_REQUIRED",
        snapshot,
      }).success,
    ).toBe(true);
  });
});
