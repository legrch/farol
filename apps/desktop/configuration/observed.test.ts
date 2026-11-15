import { describe, expect, it, vi } from "vitest";
import { ConnectorSetupReplies } from "../connector-setup-host";
import { ReadAccountCommands } from "../read-account-commands";
import { createConfigurationObserved } from "./observed";
import type { ConfigurationObservedPorts } from "./observed";
import { ProductConfigurationResultSchema } from "../../../src/pkg/product-settings/contract";

function successResult() {
  return ProductConfigurationResultSchema.parse({
    ok: true,
    snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
  });
}

function failureResult(error: string) {
  return ProductConfigurationResultSchema.parse({
    ok: false,
    error,
    snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
  });
}

describe("configuration observed", () => {
  function makePorts(overrides: Partial<ConfigurationObservedPorts> = {}) {
    const ports: ConfigurationObservedPorts = {
      deepTestAcknowledgements: new Map(),
      deepTestRequests: new Map(),
      configureNewProductRequest: vi.fn(async () => successResult()),
      configurationFailure: vi.fn((error) => failureResult(error)),
      cancelStartupConnectorResume: vi.fn(),
      suppressConnectorTransportCurrent: vi.fn(),
      invalidateConnectorTransport: vi.fn(),
      connectorSetupReplies: new ConnectorSetupReplies(),
      configureSaveAndConnect: vi.fn(async () => successResult()),
      connectorSetupRefusal: vi.fn(async () =>
        failureResult("CONNECTOR_START_FAILED"),
      ),
      directChatStart: () => null,
      goReadonlyConversation: () => null,
      readonlyAccountCommands: new ReadAccountCommands(),
      ...overrides,
    } as unknown as ConfigurationObservedPorts;
    return ports;
  }

  it("delegates unknown input to the new-product request", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({ kind: "unknown" });
    expect(configureNewProductRequest).toHaveBeenCalled();
  });

  it("joins an acknowledged deep test with the same operation id", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    const first = observed.configureProductObserved({
      kind: "chatgpt.ack-deep-test",
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    const second = observed.configureProductObserved({
      kind: "chatgpt.ack-deep-test",
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(await first).toEqual(await second);
    expect(configureNewProductRequest).toHaveBeenCalledTimes(1);
  });

  it("retains an acknowledged deep test whose result is conversation unconfirmed", async () => {
    const configureNewProductRequest = vi.fn(async () =>
      failureResult("CHATGPT_CONVERSATION_UNCONFIRMED"),
    );
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({
      kind: "chatgpt.ack-deep-test",
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    await observed.configureProductObserved({
      kind: "chatgpt.ack-deep-test",
      operationId: "22222222-2222-4222-8222-222222222222",
    });
    expect(configureNewProductRequest).toHaveBeenCalledTimes(1);
  });

  it("joins a deep-test request with matching task and test", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    const first = observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "33333333-3333-4333-8333-333333333333",
      taskId: "task-1",
      test: "deep",
    });
    const second = observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "33333333-3333-4333-8333-333333333333",
      taskId: "task-1",
      test: "deep",
    });
    expect(await first).toEqual(await second);
    expect(configureNewProductRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a deep-test request whose task changes", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "44444444-4444-4444-8444-444444444444",
      taskId: "task-1",
      test: "deep",
    });
    const result = await observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "44444444-4444-4444-8444-444444444444",
      taskId: "task-2",
      test: "deep",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "CHATGPT_CONVERSATION_REFUSED",
    });
    expect(configureNewProductRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses a deep-test request whose test changes", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({ configureNewProductRequest });
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "55555555-5555-4555-8555-555555555555",
      taskId: "task-1",
      test: "deep",
    });
    const result = await observed.configureProductObserved({
      kind: "chatgpt.run-deep-test",
      operationId: "55555555-5555-4555-8555-555555555555",
      taskId: "task-1",
      test: "connection",
    });
    expect(result).toMatchObject({
      ok: false,
      error: "CHATGPT_CONVERSATION_REFUSED",
    });
  });

  it("calls cancel and suppression callbacks in order for connector.stop", async () => {
    const order: string[] = [];
    const cancelStartupConnectorResume = vi.fn(() => order.push("cancel"));
    const suppressConnectorTransportCurrent = vi.fn(() =>
      order.push("suppress"),
    );
    const invalidateConnectorTransport = vi.fn(() => order.push("invalidate"));
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({
      cancelStartupConnectorResume,
      suppressConnectorTransportCurrent,
      invalidateConnectorTransport,
      configureNewProductRequest,
    });
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({
      kind: "connector.stop",
    });
    expect(order).toEqual(["cancel", "suppress"]);
    expect(configureNewProductRequest).toHaveBeenCalled();
  });

  it("refuses a changed connector setup fingerprint", async () => {
    const configureNewProductRequest = vi.fn(async () => successResult());
    const ports = makePorts({
      configureNewProductRequest,
      connectorSetupRefusal: vi.fn(async () =>
        failureResult("CONNECTOR_SETUP_BINDING_CHANGED"),
      ),
    });
    const observed = createConfigurationObserved(ports);
    const first = await observed.configureProductObserved({
      kind: "connector.save-and-connect",
      operationId: "66666666-6666-4666-8666-666666666666",
      buildId: "a".repeat(64),
      tunnelId: "tunnel",
      runtimeKey: "b".repeat(20),
    });
    const second = await observed.configureProductObserved({
      kind: "connector.save-and-connect",
      operationId: "66666666-6666-4666-8666-666666666666",
      buildId: "a".repeat(64),
      tunnelId: "tunnel-changed",
      runtimeKey: "b".repeat(20),
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: false,
      error: "CONNECTOR_SETUP_BINDING_CHANGED",
    });
  });
});
