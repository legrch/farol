import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createConnectorSaveAndConnect } from "../../apps/desktop/connector-save-and-connect";
import type { ConnectorSetupPorts } from "../../apps/desktop/connector-save-and-connect";
import {
  connectorSetupCodes,
  connectorSetupStepResult,
  readConnectorSetupReceipt,
} from "../../src/pkg/product-settings/connector-setup-receipt";
import type {
  ConnectorSetupIdentity,
  ConnectorSetupReceipt,
} from "../../src/pkg/product-settings/connector-setup-receipt";

// Pure host-adapter/receipt tests. No Electron, credential store, native start,
// profile or actual connector is invoked. Integration and live proof are separate.
const identity: ConnectorSetupIdentity = {
  operationId: "465a9d2b-2080-4324-8d68-190efb462e01",
  buildId: "a".repeat(64),
};
const ok = () => ({ state: "completed", code: null });
const refusal = () => ({
  state: "refused",
  code: "AUTHORITY_CHANGE_IN_PROGRESS",
});
const uncertain = () => ({
  state: "unknown",
  code: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
});
const originalAttempt = () => ({
  method: "computer.connector.open",
  requestId: "original-request",
  operationId: "original-operation",
  outcome: "unknown",
});
function harness(overrides: Partial<ConnectorSetupPorts> = {}) {
  const calls: string[] = [];
  const ports: ConnectorSetupPorts = {
    async admit(step, captured) {
      calls.push(`admit:${step}`);
      assert.deepEqual(captured, identity);
      return ok();
    },
    async saveCredentials(captured) {
      calls.push("save");
      assert.deepEqual(captured, identity);
      return ok();
    },
    async connect(captured) {
      calls.push("connect");
      assert.deepEqual(captured, identity);
      return ok();
    },
    ...overrides,
  };
  const operation = createConnectorSaveAndConnect(identity, ports);
  return { calls, ports, operation };
}
function expected(
  extra: Partial<ConnectorSetupReceipt> = {},
): ConnectorSetupReceipt {
  return {
    kind: "connector.save-and-connect",
    ...identity,
    state: "completed",
    stoppedAt: "complete",
    credentials: "saved",
    connection: "connected",
    code: null,
    externalVerification: "not-proven",
    ...extra,
  };
}

describe("one admitted Save & connect request", () => {
  it("runs only two ordered effects and never claims external verification", async () => {
    const h = harness();
    assert.equal(h.calls.length, 0);
    const result = await h.operation.run();
    assert.deepEqual(result, expected());
    assert.deepEqual(h.calls, [
      "admit:credentials",
      "save",
      "admit:connection",
      "connect",
    ]);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(readConnectorSetupReceipt(result), result);
  });
  it("joins the same promise before and after completion", async () => {
    const h = harness();
    const first = h.operation.run();
    assert.equal(h.operation.run(), first);
    const result = await first;
    assert.equal(h.operation.run(), first);
    assert.equal(await h.operation.run(), result);
    assert.equal(h.calls.length, 4);
  });
  it("installs the latch before a callback can re-enter", async () => {
    let joined: Promise<ConnectorSetupReceipt> | undefined;
    const h = harness({
      async admit() {
        joined = h.operation.run();
        return ok();
      },
    });
    const original = h.operation.run();
    await original;
    assert.equal(joined, original);
    assert.deepEqual(h.calls, ["save", "connect"]);
  });
  for (const state of ["refused", "unknown"] as const) {
    for (const stoppedAt of [
      "credential-admission",
      "credentials",
      "connection-admission",
      "connection",
    ] as const) {
      it(`retains ${state} at ${stoppedAt} with no later effect`, async () => {
        const calls: string[] = [];
        const bad = () => (state === "refused" ? refusal() : uncertain());
        const h = harness({
          async admit(step) {
            const at =
              step === "credentials"
                ? "credential-admission"
                : "connection-admission";
            calls.push(at);
            return at === stoppedAt ? bad() : ok();
          },
          async saveCredentials() {
            calls.push("credentials");
            return stoppedAt === "credentials" ? bad() : ok();
          },
          async connect() {
            calls.push("connection");
            return stoppedAt === "connection" ? bad() : ok();
          },
        });
        const first = h.operation.run();
        const result = await first;
        assert.deepEqual(
          result,
          expected({
            state,
            stoppedAt,
            credentials:
              stoppedAt === "credential-admission"
                ? "not-started"
                : stoppedAt === "credentials"
                  ? state
                  : "saved",
            connection: stoppedAt === "connection" ? state : "not-started",
            code:
              state === "refused"
                ? "AUTHORITY_CHANGE_IN_PROGRESS"
                : "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
          }),
        );
        const sequence = [
          "credential-admission",
          "credentials",
          "connection-admission",
          "connection",
        ];
        assert.deepEqual(
          calls,
          sequence.slice(0, sequence.indexOf(stoppedAt) + 1),
        );
        assert.equal(h.operation.run(), first);
        assert.deepEqual(readConnectorSetupReceipt(result), result);
      });
    }
  }
  it("keeps credentials saved after a post-save binding change", async () => {
    const h = harness({
      async admit(step) {
        return step === "connection"
          ? { state: "refused", code: "CONNECTOR_SETUP_BINDING_CHANGED" }
          : ok();
      },
    });
    const result = await h.operation.run();
    assert.equal(result.credentials, "saved");
    assert.equal(result.connection, "not-started");
    assert.equal(result.code, "CONNECTOR_SETUP_BINDING_CHANGED");
    assert.deepEqual(h.calls, ["save"]);
  });
  it("preserves the exact original Go attempt and does not call connect twice", async () => {
    const attempt = originalAttempt();
    const h = harness({
      async connect() {
        return {
          state: "refused",
          code: "CONNECTOR_START_FAILED",
          connectorAttempt: attempt,
        };
      },
    });
    const result = await h.operation.run();
    assert.equal(result.state, "unknown");
    assert.equal(result.credentials, "saved");
    assert.deepEqual(result.connectorAttempt, originalAttempt());
    attempt.operationId = "later-operation";
    assert.equal(result.connectorAttempt?.operationId, "original-operation");
    assert.ok(Object.isFrozen(result.connectorAttempt));
    assert.deepEqual(readConnectorSetupReceipt(result), result);
  });
  for (const point of ["admission", "save", "connect"] as const) {
    it(`does not disclose or rethrow a secret from ${point}`, async () => {
      const secret = "runtime-key-must-never-be-retained";
      const fail = async () => {
        throw new Error(secret);
      };
      const h = harness(
        point === "admission"
          ? { admit: fail }
          : point === "save"
            ? { saveCredentials: fail }
            : { connect: fail },
      );
      const result = await h.operation.run();
      assert.equal(result.state, "unknown");
      assert.equal(result.code, "CONNECTOR_SETUP_STEP_UNCONFIRMED");
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(h.calls.includes("connect"), false);
    });
  }
  it("also retains an original synchronous throw as unknown", async () => {
    const h = harness({
      saveCredentials() {
        throw new Error("hidden payload");
      },
    });
    assert.equal((await h.operation.run()).credentials, "unknown");
    assert.equal(h.calls.includes("connect"), false);
  });
  it("captures identity and method references before the first await", async () => {
    const mutable = { ...identity };
    const h = harness();
    const operation = createConnectorSaveAndConnect(mutable, h.ports);
    mutable.operationId = "6".repeat(36);
    (h.ports as { connect: ConnectorSetupPorts["connect"] }).connect =
      async () => {
        throw new Error("must not run");
      };
    assert.deepEqual(await operation.run(), expected());
  });
  it("does not race a timeout or start while the original save is unresolved", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const h = harness({ saveCredentials: () => pending });
    const original = h.operation.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(h.calls, ["admit:credentials"]);
    assert.equal(h.operation.run(), original);
    finish(uncertain());
    assert.equal((await original).connection, "not-started");
    assert.deepEqual(h.calls, ["admit:credentials"]);
  });
  for (const stage of ["admission", "save"] as const) {
    it(`rejects a connector-open attempt attached to ${stage}`, async () => {
      const mixed = async () => ({
        state: "refused",
        code: "CONNECTOR_START_FAILED",
        connectorAttempt: originalAttempt(),
      });
      const h = harness(
        stage === "admission" ? { admit: mixed } : { saveCredentials: mixed },
      );
      const result = await h.operation.run();
      assert.equal(result.code, "CONNECTOR_SETUP_STEP_UNCONFIRMED");
      assert.equal(result.connectorAttempt, undefined);
      assert.deepEqual(readConnectorSetupReceipt(result), result);
    });
  }
});

describe("closed step and receipt parsing", () => {
  const uncertainCodes = new Set([
    "SETTINGS_WRITE_FAILED",
    "CONNECTOR_STOP_UNCONFIRMED",
    "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
    "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    "CONNECTOR_SETUP_STEP_UNCONFIRMED",
  ]);
  for (const code of connectorSetupCodes) {
    it(`classifies ${code} without weakening uncertainty`, () => {
      assert.deepEqual(connectorSetupStepResult({ state: "refused", code }), {
        state: uncertainCodes.has(code) ? "unknown" : "refused",
        code,
      });
      assert.deepEqual(connectorSetupStepResult({ state: "unknown", code }), {
        state: "unknown",
        code,
      });
    });
  }
  const malformed: unknown[] = [
    null,
    undefined,
    false,
    [],
    "completed",
    42,
    {},
    { state: "completed" },
    { state: "completed", code: "CONNECTOR_START_FAILED" },
    { state: "applied", code: null },
    { state: "pending", code: null },
    { state: "completed", code: null, secret: "must-not-leak" },
    { state: "refused", code: "UNREVIEWED_UNKNOWN_CODE" },
    { state: "unknown", code: "secret value" },
    {
      state: "unknown",
      code: "CONNECTOR_SETUP_STEP_UNCONFIRMED",
      connectorAttempt: null,
    },
    {
      state: "unknown",
      code: "CONNECTOR_SETUP_STEP_UNCONFIRMED",
      connectorAttempt: { ...originalAttempt(), secret: "must-not-leak" },
    },
    { state: "completed", code: null, connectorAttempt: originalAttempt() },
    new Error("must-not-leak"),
    new Date(0),
    Object.create({ state: "completed", code: null }),
  ];
  malformed.forEach((value, index) => {
    it(`rejects malformed step ${index} and stops before connect`, async () => {
      const h = harness({
        async saveCredentials() {
          return value;
        },
      });
      const result = await h.operation.run();
      assert.equal(result.credentials, "unknown");
      assert.equal(result.connection, "not-started");
      assert.equal(result.code, "CONNECTOR_SETUP_STEP_UNCONFIRMED");
      assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
      assert.deepEqual(readConnectorSetupReceipt(result), result);
    });
  });
  it("does not execute accessors while parsing", () => {
    let invoked = false;
    const hostile = {
      get state() {
        invoked = true;
        throw new Error("secret");
      },
      code: null,
    };
    assert.equal(connectorSetupStepResult(hostile).state, "unknown");
    assert.equal(invoked, false);
    assert.equal(
      readConnectorSetupReceipt({
        ...expected(),
        get credentials() {
          invoked = true;
          return "saved";
        },
      }),
      null,
    );
    assert.equal(invoked, false);
  });
  it("refuses symbols, non-enumerable fields and null/extra attempt fields", () => {
    const symbol = { ...ok(), [Symbol("secret")]: "hidden" };
    assert.equal(connectorSetupStepResult(symbol).state, "unknown");
    const hidden = Object.defineProperty(ok(), "secret", { value: "private" });
    assert.equal(connectorSetupStepResult(hidden).state, "unknown");
    assert.equal(
      readConnectorSetupReceipt({ ...expected(), connectorAttempt: undefined }),
      null,
    );
  });
  it("never coerces a receipt fact object into text", () => {
    let coerced = false;
    const value = {
      ...expected(),
      credentials: {
        toString() {
          coerced = true;
          return "saved";
        },
      },
    };
    assert.equal(readConnectorSetupReceipt(value), null);
    assert.equal(coerced, false);
  });
  it("accepts plain null-prototype records and clones them", () => {
    const value = Object.assign(Object.create(null), expected());
    const parsed = readConnectorSetupReceipt(value);
    assert.deepEqual(parsed, expected());
    value.connection = "unknown";
    assert.equal(parsed?.connection, "connected");
  });
  it("rejects every missing required receipt field", () => {
    for (const key of Object.keys(expected())) {
      const value = { ...expected() } as Record<string, unknown>;
      delete value[key];
      assert.equal(readConnectorSetupReceipt(value), null, key);
    }
  });
  it("rejects receipt secrets, invalid identity and fake external proof", () => {
    for (const extra of [
      { runtimeKey: "secret" },
      { source: { key: "secret" } },
      { operationId: "" },
      { operationId: "not-an-id" },
      { buildId: "not-a-digest" },
      { externalVerification: "verified" },
      { kind: "connector.runtime" },
    ])
      assert.equal(
        readConnectorSetupReceipt({ ...expected(), ...extra }),
        null,
      );
  });
  it("rejects invalid supplied identities before invoking any port", () => {
    const h = harness();
    for (const input of [
      null,
      {},
      [],
      { ...identity, operationId: "bad" },
      { ...identity, buildId: "g".repeat(64) },
      { ...identity, runtimeKey: "secret" },
      { ...identity, operationId: "00000000-0000-0000-0000-000000000000" },
    ])
      assert.throws(
        () =>
          createConnectorSaveAndConnect(
            input as ConnectorSetupIdentity,
            h.ports,
          ),
        /^Error: CONNECTOR_SETUP_IDENTITY_INVALID$/u,
      );
    assert.deepEqual(h.calls, []);
  });
  it("validates all stage/state/fact combinations rather than fixing them up", () => {
    let accepted = 0;
    const facts = ["not-started", "saved", "refused", "unknown"];
    const connections = ["not-started", "connected", "refused", "unknown"];
    for (const stoppedAt of [
      "credential-admission",
      "credentials",
      "connection-admission",
      "connection",
      "complete",
    ]) {
      for (const state of ["completed", "refused", "unknown"]) {
        for (const credentials of facts)
          for (const connection of connections) {
            const value = {
              ...expected(),
              stoppedAt,
              state,
              credentials,
              connection,
              code: state === "completed" ? null : "CONNECTOR_START_FAILED",
            };
            const success =
              state === "completed" &&
              stoppedAt === "complete" &&
              credentials === "saved" &&
              connection === "connected";
            const terminal =
              state !== "completed" &&
              ((stoppedAt === "credential-admission" &&
                credentials === "not-started" &&
                connection === "not-started") ||
                (stoppedAt === "credentials" &&
                  credentials === state &&
                  connection === "not-started") ||
                (stoppedAt === "connection-admission" &&
                  credentials === "saved" &&
                  connection === "not-started") ||
                (stoppedAt === "connection" &&
                  credentials === "saved" &&
                  connection === state));
            const parsed = readConnectorSetupReceipt(value);
            assert.equal(
              parsed !== null,
              success || terminal,
              JSON.stringify(value),
            );
            if (parsed) accepted++;
          }
      }
    }
    assert.equal(accepted, 9);
  });
  it("cannot relabel a known UNKNOWN code or original Go UNKNOWN as refused", () => {
    const value = expected({
      state: "refused",
      stoppedAt: "connection",
      connection: "refused",
      code: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    assert.equal(readConnectorSetupReceipt(value), null);
    assert.equal(
      readConnectorSetupReceipt({
        ...value,
        code: "CONNECTOR_START_FAILED",
        connectorAttempt: originalAttempt(),
      }),
      null,
    );
  });
});
