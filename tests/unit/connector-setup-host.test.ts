import { describe, expect, it, vi } from "vitest";
import {
  ConnectorSetupReplies,
  runAdmittedConnectorSetup,
} from "../../apps/desktop/connector-setup-host";
import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition";
import { settings } from "../renderer/fixture";
import type {
  ProductConfigurationResult,
  ProductConfigurationSnapshot,
} from "../../src/pkg/product-settings/contract";

// Controlled owner ports only. Native key/process/external verification are separate.
const identity = {
  operationId: "465a9d2b-2080-4324-8d68-190efb462e01",
  buildId: "3".repeat(64),
};
function harness() {
  let current: ProductConfigurationSnapshot = {
    status: "ready",
    settings: settings(),
  };
  const snapshot = () => structuredClone(current);
  const fail = (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ): Extract<ProductConfigurationResult, { ok: false }> => ({
    ok: false,
    error,
    snapshot: snapshot(),
  });
  const ports = {
    current: snapshot,
    admission: vi.fn(
      () =>
        ({
          ok: true as const,
          snapshot: snapshot(),
        }) as ProductConfigurationResult,
    ),
    save: vi.fn(async (): Promise<ProductConfigurationResult> => {
      if (current.status !== "ready") throw Error();
      current.settings.connectors.secureMcp.generation++;
      current.settings.connectors.secureMcp.credential = "stored";
      current.settings.connectors.secureMcp.tunnelId = "synthetic-tunnel";
      return { ok: true, snapshot: snapshot() };
    }),
    start: vi.fn(async (): Promise<ProductConfigurationResult> => {
      if (current.status !== "ready") throw Error();
      const connector = current.settings.connectors.secureMcp;
      connector.runtime = {
        state: "ready",
        buildId: identity.buildId,
        connectorGeneration: connector.generation,
        computerGeneration: current.settings.computer.generation,
        runtimeGeneration: "a".repeat(64),
        observedAt: "2026-10-08T09:00:00.000Z",
      };
      return {
        ok: true,
        snapshot: snapshot(),
        evidence: {
          kind: "connector.runtime",
          state: "ready",
          buildId: identity.buildId,
          computerGeneration: current.settings.computer.generation,
          runtimeGeneration: "a".repeat(64),
        },
      };
    }),
  };
  const run = () =>
    runAdmittedConnectorSetup(identity, "synthetic-tunnel", ports);
  return {
    ports,
    run,
    fail,
    change: (
      mutate: (
        value: Extract<ProductConfigurationSnapshot, { status: "ready" }>,
      ) => void,
    ) => {
      if (current.status === "ready") mutate(current);
    },
  };
}
describe("admitted credential/start owner composition", () => {
  it("accepts only original saved generation and actual local runtime evidence", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.ok).toBe(true);
    expect(result.connectorSetup).toMatchObject({
      credentials: "saved",
      connection: "connected",
      externalVerification: "not-proven",
    });
    expect(h.ports.save).toHaveBeenCalledTimes(1);
    expect(h.ports.start).toHaveBeenCalledTimes(1);
  });
  it("retains a pre-write unavailable receipt without reading absent Settings", async () => {
    const h = harness();
    h.ports.admission.mockReturnValue({
      ok: false,
      error: "SETTINGS_UNAVAILABLE",
      snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
    });
    h.ports.current = () => {
      throw Error("no Settings owner");
    };
    expect((await h.run()).connectorSetup).toMatchObject({
      state: "refused",
      credentials: "not-started",
      code: "SETTINGS_UNAVAILABLE",
    });
    expect(h.ports.save).not.toHaveBeenCalled();
  });
  it("does not publish a key after pre-write refusal", async () => {
    const h = harness();
    h.ports.admission.mockReturnValue(h.fail("CONNECTOR_STOP_REQUIRED"));
    expect((await h.run()).connectorSetup).toMatchObject({
      stoppedAt: "credential-admission",
      credentials: "not-started",
    });
    expect(h.ports.save).not.toHaveBeenCalled();
    expect(h.ports.start).not.toHaveBeenCalled();
  });
  it.each([
    "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
    "SETTINGS_WRITE_FAILED",
  ] as const)("retains %s after save and never starts", async (error) => {
    const h = harness();
    h.ports.save.mockResolvedValue(h.fail(error));
    expect((await h.run()).connectorSetup).toMatchObject({
      state: "unknown",
      credentials: "unknown",
      connection: "not-started",
    });
    expect(h.ports.start).not.toHaveBeenCalled();
  });
  it.each([
    "CONNECTOR_START_FAILED",
    "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  ] as const)("keeps saved credentials after %s", async (error) => {
    const h = harness();
    h.ports.start.mockResolvedValue(h.fail(error));
    expect((await h.run()).connectorSetup).toMatchObject({
      credentials: "saved",
      connection: error === "CONNECTOR_START_FAILED" ? "refused" : "unknown",
    });
  });
  it("carries original Go-open UNKNOWN IDs", async () => {
    const h = harness();
    const connectorAttempt = {
      method: "computer.connector.open" as const,
      requestId: identity.operationId,
      operationId: "55555555-5555-4555-8555-555555555555",
      outcome: "unknown" as const,
    };
    h.ports.start.mockResolvedValue({
      ...h.fail("CONNECTOR_START_FAILED"),
      connectorAttempt,
    });
    const result = await h.run();
    expect(result.connectorSetup).toMatchObject({
      state: "unknown",
      credentials: "saved",
      connectorAttempt,
    });
    expect(result).toHaveProperty("connectorAttempt", connectorAttempt);
  });
  it.each(["connector", "computer", "identity"])(
    "refuses changed %s authority after the original save result",
    async (kind) => {
      const h = harness();
      const save = h.ports.save.getMockImplementation()!;
      h.ports.save.mockImplementation(async () => {
        const result = await save();
        h.change((value) => {
          if (kind === "connector")
            value.settings.connectors.secureMcp.generation++;
          else if (kind === "computer") value.settings.computer.generation++;
          else
            value.settings.computer.computerId =
              "66666666-6666-4666-8666-666666666666";
        });
        return result;
      });
      expect((await h.run()).connectorSetup).toMatchObject({
        stoppedAt: "connection-admission",
        credentials: "saved",
        connection: "not-started",
        code: "CONNECTOR_SETUP_BINDING_CHANGED",
      });
      expect(h.ports.start).not.toHaveBeenCalled();
    },
  );
  it.each(["Quit", "update"])(
    "refuses start when %s closes admission during save",
    async () => {
      const h = harness();
      const save = h.ports.save.getMockImplementation()!;
      h.ports.save.mockImplementation(async () => {
        const result = await save();
        h.ports.admission.mockReturnValue(
          h.fail("AUTHORITY_CHANGE_IN_PROGRESS"),
        );
        return result;
      });
      expect((await h.run()).connectorSetup).toMatchObject({
        credentials: "saved",
        connection: "not-started",
        code: "AUTHORITY_CHANGE_IN_PROGRESS",
      });
      expect(h.ports.start).not.toHaveBeenCalled();
    },
  );
  it("cannot turn generic ok or wrong-build evidence into a connection", async () => {
    for (const wrongBuild of [false, true]) {
      const h = harness();
      h.ports.start.mockResolvedValue({
        ok: true,
        snapshot: h.ports.current(),
        ...(wrongBuild
          ? {
              evidence: {
                kind: "connector.runtime",
                state: "ready",
                buildId: "b".repeat(64),
                runtimeGeneration: "a".repeat(64),
                computerGeneration: 1,
              },
            }
          : {}),
      });
      expect((await h.run()).connectorSetup).toMatchObject({
        state: "unknown",
        credentials: "saved",
        connection: "unknown",
      });
    }
  });
  it("retains the real authority reservation across save/start awaits", async () => {
    const h = harness(),
      owner = new AuthorityTransitionReservation();
    const save = h.ports.save.getMockImplementation()!,
      start = h.ports.start.getMockImplementation()!;
    h.ports.save.mockImplementation(async () => {
      await Promise.resolve();
      expect(owner.tryReserve("connector-start")).toBeNull();
      return save();
    });
    h.ports.start.mockImplementation(async () => {
      await Promise.resolve();
      expect(owner.tryReserve("authority-change")).toBeNull();
      return start();
    });
    const result = await owner.withReservation("authority-change", h.run);
    expect(result.admitted).toBe(true);
    expect(owner.current()).toBeNull();
  });
  it("does not expose a thrown secret or repeat a later effect", async () => {
    const h = harness();
    h.ports.save.mockRejectedValue(Error("synthetic-private-key"));
    const result = await h.run();
    expect(result.connectorSetup?.credentials).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    expect(h.ports.start).not.toHaveBeenCalled();
  });
});

describe("original host IPC reply retention", () => {
  it.each(["known", "unknown"])(
    "joins original %s across repeated IPC and protects retained result bytes",
    async (outcome) => {
      const replies = new ConnectorSetupReplies(),
        h = harness();
      const dispatch = vi.fn(async () =>
        h.fail(
          outcome === "unknown"
            ? "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
            : "CONNECTOR_START_FAILED",
        ),
      );
      const refuse = vi.fn(async () =>
        h.fail("CONNECTOR_SETUP_BINDING_CHANGED"),
      );
      const first = replies.run(
        identity.operationId,
        "digest",
        dispatch,
        refuse,
      );
      const second = replies.run(
        identity.operationId,
        "digest",
        dispatch,
        refuse,
      );
      const result = await first;
      expect(await second).toEqual(result);
      result.snapshot = { status: "error", error: "SETTINGS_READ_FAILED" };
      expect(
        (await replies.run(identity.operationId, "digest", dispatch, refuse))
          .snapshot.status,
      ).toBe("ready");
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(refuse).not.toHaveBeenCalled();
      await replies.run(
        identity.operationId,
        "different-digest",
        dispatch,
        refuse,
      );
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(refuse).toHaveBeenCalledWith("CONNECTOR_SETUP_BINDING_CHANGED");
    },
  );
  it("keeps a lost original dispatch unknown without retry", async () => {
    const replies = new ConnectorSetupReplies(),
      h = harness();
    const dispatch = vi.fn(async () => {
      throw Error("lost reply");
    });
    const refuse = async () => h.fail("CONNECTOR_START_FAILED");
    for (let i = 0; i < 2; i++)
      await expect(
        replies.run(identity.operationId, "digest", dispatch, refuse),
      ).rejects.toThrow("lost reply");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("refuses bounded exhaustion without evicting the first unknown", async () => {
    const replies = new ConnectorSetupReplies(),
      h = harness();
    const dispatch = vi.fn(async () =>
      h.fail("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"),
    );
    const refuse = vi.fn(async () => h.fail("CONNECTOR_START_FAILED"));
    for (let i = 0; i < 1024; i++)
      await replies.run(String(i), "digest", dispatch, refuse);
    await replies.run("full", "digest", dispatch, refuse);
    expect(dispatch).toHaveBeenCalledTimes(1024);
    expect(refuse).toHaveBeenCalledWith("CONNECTOR_START_FAILED");
    await replies.run("0", "digest", dispatch, refuse);
    expect(dispatch).toHaveBeenCalledTimes(1024);
  });
});
