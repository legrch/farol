import { describe, expect, it, vi } from "vitest";
import { ConnectorSetupReplies } from "../connector-setup-host";
import { ReadAccountCommands } from "../read-account-commands";
import { createConfigurationObserved } from "./observed";
import type { ConfigurationObservedPorts } from "./observed";

describe("configuration observed", () => {
  it("delegates unknown input to the new-product request", async () => {
    const configureNewProductRequest = vi.fn(
      async () => ({ ok: true }) as never,
    );
    const ports: ConfigurationObservedPorts = {
      deepTestAcknowledgements: new Map(),
      deepTestRequests: new Map(),
      configureNewProductRequest,
      configurationFailure: vi.fn((error) => ({ ok: false, error }) as never),
      cancelStartupConnectorResume: vi.fn(),
      suppressConnectorTransportCurrent: vi.fn(),
      invalidateConnectorTransport: vi.fn(),
      connectorSetupReplies: new ConnectorSetupReplies(),
      configureSaveAndConnect: vi.fn(async () => ({ ok: true }) as never),
      connectorSetupRefusal: vi.fn(async () => ({ ok: false }) as never),
      directChatStart: () => null,
      goReadonlyConversation: () => null,
      readonlyAccountCommands: new ReadAccountCommands(),
    };
    const observed = createConfigurationObserved(ports);
    await observed.configureProductObserved({ kind: "unknown" });
    expect(configureNewProductRequest).toHaveBeenCalled();
  });
});
