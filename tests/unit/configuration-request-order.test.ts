import { describe, expect, it } from "vitest";

import {
  ConfigurationRequestOrder,
  shouldAdoptConfigurationSnapshot,
} from "../../src/ui/configuration-request-order";

describe("configuration request order", () => {
  it("keeps an older completion from owning feedback after a newer request starts", () => {
    const order = new ConfigurationRequestOrder();
    const backgroundDiscovery = order.begin();
    const ownerAction = order.begin();

    expect(order.isLatest(backgroundDiscovery)).toBe(false);
    expect(order.isLatest(ownerAction)).toBe(true);
  });

  it("adopts only current-or-newer settings snapshots", () => {
    const current = {
      status: "ready" as const,
      settings: { revision: 4 },
    };

    expect(
      shouldAdoptConfigurationSnapshot(current, {
        status: "ready",
        settings: { revision: 3 },
      }),
    ).toBe(false);
    expect(
      shouldAdoptConfigurationSnapshot(current, {
        status: "ready",
        settings: { revision: 5 },
      }),
    ).toBe(true);
  });
});
