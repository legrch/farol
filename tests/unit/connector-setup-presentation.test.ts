import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { connectorSetupPresentation } from "../../src/ui/connector-setup-presentation";
import { createConnectorSaveAndConnect } from "../../apps/desktop/connector-save-and-connect";
import type { ConnectorSetupIdentity } from "../../src/pkg/product-settings/connector-setup-receipt";
const identity: ConnectorSetupIdentity = {
  operationId: "465a9d2b-2080-4324-8d68-190efb462e01",
  buildId: "a".repeat(64),
};
const ok = () => ({ state: "completed", code: null });
function flow(
  failure?: "save" | "connection" | "connection-admission",
  unknown = false,
) {
  const refused = () => ({
    state: unknown ? "unknown" : "refused",
    code: "CONNECTOR_START_FAILED",
  });
  return createConnectorSaveAndConnect(identity, {
    async admit(step) {
      return step === "connection" && failure === "connection-admission"
        ? refused()
        : ok();
    },
    async saveCredentials() {
      return failure === "save" ? refused() : ok();
    },
    async connect() {
      return failure === "connection" ? refused() : ok();
    },
  });
}
describe("partial Save & connect presentation", () => {
  it("does not mistake local success for external Computer readiness", async () => {
    const receipt = await flow().run();
    const view = connectorSetupPresentation(receipt, identity);
    assert.equal(view.status, "local-ready");
    assert.equal(view.next, "verify-attachment");
    assert.match(view.description, /Verify Farol in ChatGPT/u);
    assert.equal(view.credentialResult, "saved");
    assert.ok(Object.isFrozen(view));
  });
  for (const stage of ["save", "connection", "connection-admission"] as const) {
    for (const unknown of [false, true]) {
      it(`retains ${stage} ${unknown ? "UNKNOWN" : "refusal"} across serialized readback`, async () => {
        const receipt = await flow(stage, unknown).run();
        const first = connectorSetupPresentation(receipt, identity);
        const later = connectorSetupPresentation(
          JSON.parse(JSON.stringify(receipt)),
          identity,
        );
        assert.deepEqual(first, later);
        assert.equal(
          first.credentialResult,
          stage === "save" ? "not-confirmed" : "saved",
        );
        assert.equal(
          first.next,
          unknown
            ? "observe-original"
            : stage === "save"
              ? "review-settings"
              : "inspect-connection",
        );
        assert.equal(first.status, unknown ? "unconfirmed" : "needs-attention");
        assert.equal(first.code, "CONNECTOR_START_FAILED");
      });
    }
  }
  it("does not claim that a refused start produced no process", async () => {
    const view = connectorSetupPresentation(
      await flow("connection").run(),
      identity,
    );
    assert.match(view.description, /did not complete/u);
    assert.doesNotMatch(view.description, /not started|no process|retry/iu);
  });
  it("can describe a connection step never dispatched after admission refusal", async () => {
    const view = connectorSetupPresentation(
      await flow("connection-admission").run(),
      identity,
    );
    assert.match(view.description, /not started/u);
  });
  it("rejects results from a different request, build or malformed envelope", async () => {
    const receipt = await flow().run();
    for (const value of [
      null,
      {},
      { ...receipt, runtimeKey: "private" },
      { ...receipt, operationId: "bbb33c88-b1bb-4cce-b55d-ef55e6b6daa5" },
      { ...receipt, buildId: "b".repeat(64) },
    ]) {
      const view = connectorSetupPresentation(value, identity);
      assert.equal(view.status, "unconfirmed");
      assert.equal(view.credentialResult, "not-confirmed");
      assert.equal(view.next, "observe-original");
      assert.equal(JSON.stringify(view).includes("private"), false);
    }
  });
  it("does not take a supplied technical code as user-facing free text", async () => {
    const receipt = await flow("connection").run();
    const view = connectorSetupPresentation(
      { ...receipt, code: "SECRET_TOKEN_DATA" },
      identity,
    );
    assert.equal(view.status, "unconfirmed");
    assert.equal(view.code, null);
    assert.equal(JSON.stringify(view).includes("SECRET_TOKEN_DATA"), false);
  });
});
