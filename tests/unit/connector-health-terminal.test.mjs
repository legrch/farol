import { admissionFixture } from "../support/desktop-admission";
import { createConfigurationConnector } from "../../apps/desktop/configuration/connector";
import { connectorHealth } from "../../apps/desktop/connector/supervisor.ts";
import { connectorHost } from "../support/connector-host.ts";
import { expect, it, vi } from "vitest";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract.ts";

// Call the actual imported handler and supervisor with scripted mechanics.
// These partial JS ports exercise health only; no native child, tunnel,
// state writer or provider is reached by this regression fixture.
const generation = "a".repeat(64);
function harness(observation, healthy = false) {
  const snapshot = {
    status: "ready",
    settings: {
      ...guidedSettingsFixture(),
      computer: { ...guidedSettingsFixture().computer, generation: 7 },
      connectors: {
        secureMcp: {
          ...guidedSettingsFixture().connectors.secureMcp,
          generation: 3,
          runtime: {
            ...guidedSettingsFixture().connectors.secureMcp.runtime,
            state: "ready",
            buildId: fixtureBuildId,
            computerGeneration: 7,
            connectorGeneration: 3,
            runtimeGeneration: generation,
          },
        },
      },
    },
  };
  const context = {
    operationsStore: () => ({ record() {} }),
    command: { kind: "connector.check-health" },
    secureMcpConnectorRuntime: {
      checkHealth: vi.fn(async () => healthy),
      getTunnelObservation: vi.fn(() => observation),
      isRunning: vi.fn(() => true),
      observePolling: vi.fn(async () => ({
        runtimeGeneration: generation,
        samples: {
          cycles: "12",
          errors: "1",
          lastSuccessMillis: "123456789",
        },
      })),
    },
    desktopGoCore: {
      backendAvailable: true,
      observeComputerConnectorPolling: vi.fn(async (samples) => ({
        binding: {
          buildId: fixtureBuildId,
          profileId: "profile",
          backendGeneration: "backend-generation",
          runtimeId: "runtime",
          connectorGeneration: "3",
        },
        state: "recent",
        observedAtMillis: "123456790",
        ...samples,
      })),
    },
    connectorTaskAdmission: false,
    configuration: { snapshot: vi.fn(() => snapshot) },
    buildIdentity: { buildId: fixtureBuildId },
    recordConnectorRuntime: vi.fn(async () => null),
    configurationFailure: (error) => {
      // The host branch uses a deliberately partial snapshot double. Validate
      // its outgoing error against the real contract with a valid error snapshot.
      const result = ProductConfigurationResultSchema.parse({
        ok: false,
        error,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      });
      return { ok: result.ok, error: result.error };
    },
  };
  // The branch calls the supervisor's observer under the name main.ts binds.
  context.observedConnectorHealth = connectorHealth(
    connectorHost(context),
  ).observedConnectorHealth;
  const ports = admissionFixture(context);
  const handler = createConfigurationConnector({
    ...ports,
    configuration: () => context.configuration,
    secureMcpConnectorRuntime: () => context.secureMcpConnectorRuntime,
    desktopGoCore: () => context.desktopGoCore,
    buildIdentity: () => context.buildIdentity,
  });
  const handle = () =>
    handler.configureAdmittedConnector({
      kind: "connector.check-health",
    });
  return { handle, context, snapshot };
}

it("retains exact-generation terminal UNKNOWN instead of publishing unreachable", async () => {
  const h = harness({
    state: "outcome_unknown",
    runtimeGeneration: generation,
  });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "outcome_unknown",
    generation,
    7,
  );
  expect(h.context.connectorTaskAdmission).toBe(false);
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).not.toHaveBeenCalled();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).not.toHaveBeenCalled();
});

it("classifies the dead tunnel without asserting anchor or process-group closure", async () => {
  const h = harness({ state: "exited", runtimeGeneration: generation });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_TUNNEL_EXITED",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "unreachable",
    generation,
    7,
  );
  expect(h.context.connectorTaskAdmission).toBe(false);
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).not.toHaveBeenCalled();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).not.toHaveBeenCalled();
});

it("does not publish a different runtime's terminal observation into current Settings", async () => {
  const h = harness({ state: "exited", runtimeGeneration: "b".repeat(64) });
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
  });
  expect(h.context.recordConnectorRuntime).not.toHaveBeenCalled();
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).not.toHaveBeenCalled();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).not.toHaveBeenCalled();
});

it("does not hide UNKNOWN behind a successful asynchronous health probe", async () => {
  const h = harness(
    { state: "outcome_unknown", runtimeGeneration: generation },
    true,
  );
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "outcome_unknown",
    generation,
    7,
  );
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).not.toHaveBeenCalled();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).not.toHaveBeenCalled();
});

it("does not hide a late tunnel exit behind a successful health probe", async () => {
  const h = harness({ state: "exited", runtimeGeneration: generation }, true);
  expect(await h.handle()).toEqual({
    ok: false,
    error: "CONNECTOR_TUNNEL_EXITED",
  });
  expect(h.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
    "unreachable",
    generation,
    7,
  );
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).not.toHaveBeenCalled();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).not.toHaveBeenCalled();
});

it("does not turn a healthy current endpoint into a terminal operation", async () => {
  const h = harness(null, true);
  expect(await h.handle()).toMatchObject({
    ok: true,
    evidence: {
      kind: "connector.polling",
      runtimeGeneration: generation,
      connectorGeneration: "3",
      computerGeneration: 7,
      buildId: fixtureBuildId,
    },
  });
  expect(h.context.recordConnectorRuntime).not.toHaveBeenCalled();
  expect(
    h.context.secureMcpConnectorRuntime.observePolling,
  ).toHaveBeenCalledExactlyOnceWith();
  expect(
    h.context.desktopGoCore.observeComputerConnectorPolling,
  ).toHaveBeenCalledExactlyOnceWith({
    cycles: "12",
    errors: "1",
    lastSuccessMillis: "123456789",
  });
});
