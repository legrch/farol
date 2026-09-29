import { describe, expect, it } from "vitest";

import {
  ConfigurationRequestOrder,
  shouldAdoptConfigurationSnapshot,
  configurationEvidenceRevision,
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

it("does not label an older model refresh with a newer task configuration", async () => {
  const order = new ConfigurationRequestOrder();
  const oldRequest = order.begin();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current = { status: "ready" as const, settings: { revision: 4 } };
  let displayed = { revision: 4, alias: "old" };
  const oldResponse = (async () => {
    await delayed;
    const revision = configurationEvidenceRevision(
      current,
      { status: "ready", settings: { revision: 4 } },
      order.isLatest(oldRequest),
    );
    if (revision !== null) displayed = { revision, alias: "old" };
  })();
  const newRequest = order.begin();
  current = { status: "ready", settings: { revision: 5 } };
  const revision = configurationEvidenceRevision(
    current,
    current,
    order.isLatest(newRequest),
  );
  if (revision !== null) displayed = { revision, alias: "new" };
  release();
  await oldResponse;
  expect(displayed).toEqual({ revision: 5, alias: "new" });
});
it("does not overwrite a newer model refresh even at the same settings revision", () => {
  const order = new ConfigurationRequestOrder();
  const old = order.begin();
  order.begin();
  const snapshot = { status: "ready" as const, settings: { revision: 5 } };
  expect(
    configurationEvidenceRevision(snapshot, snapshot, order.isLatest(old)),
  ).toBeNull();
  expect(
    configurationEvidenceRevision(snapshot, { status: "error" }, true),
  ).toBeNull();
});
