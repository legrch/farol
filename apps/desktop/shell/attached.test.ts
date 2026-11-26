import { describe, expect, it, vi } from "vitest";
import type { ConnectionStatusCapture } from "../connector/capture";
import { menuBarAttached, type MenuBarAttachedPorts } from "./attached";

const gates = vi.hoisted(() => ({ uncertain: false, attachment: true }));
vi.mock("../../../src/pkg/product-settings/connector-uncertainty", () => ({
  connectorRuntimeUncertain: () => gates.uncertain,
}));
vi.mock("../../../src/apps/desktop/connector-app-receipt-wait", () => ({
  currentConnectorAttachment: () => (gates.attachment ? {} : null),
}));

// The attached predicate over recording owners: every condition must hold, and
// each owner is read in the order the menu bar always read them.

const running = { kind: "running", original: {} } as ConnectionStatusCapture;

function settings(
  overrides: { pendingEdit?: unknown; outcomeUnknown?: boolean } = {},
) {
  return {
    computer: { pendingEdit: overrides.pendingEdit ?? null },
    setup: { computer: { outcomeUnknown: overrides.outcomeUnknown ?? false } },
  };
}

function ports(
  log: string[],
  overrides: Partial<MenuBarAttachedPorts> = {},
  snapshot: unknown = { status: "ready", settings: settings() },
) {
  const owners: MenuBarAttachedPorts = {
    captureConnectionStatus: () => {
      log.push("capture");
      return running;
    },
    connectionStatusCurrent: () => true,
    configuration: () => ({ snapshot: () => snapshot }) as never,
    workspaceMutationOccupied: () => false,
    buildId: "build-1",
    ...overrides,
  };
  return owners;
}

describe("menuBarAttached", () => {
  it("is attached only for a recent transport with every condition met", () => {
    gates.uncertain = false;
    gates.attachment = true;
    const attached = menuBarAttached(ports([]));
    expect(attached("recent_transport")).toBe(true);
    expect(attached("offline" as never)).toBe(false);
  });

  it("captures the connection before it reads the configuration", () => {
    const log: string[] = [];
    menuBarAttached(
      ports(log, { configuration: () => (log.push("config"), null) }),
    )("recent_transport");
    expect(log).toEqual(["capture", "config"]);
  });

  it.each([
    ["no running capture", { captureConnectionStatus: () => null }],
    ["a stale capture", { connectionStatusCurrent: () => false }],
    [
      "an occupied workspace mutation",
      { workspaceMutationOccupied: () => true },
    ],
    ["no configuration", { configuration: () => null }],
  ])("is not attached with %s", (_name, overrides) => {
    gates.uncertain = false;
    gates.attachment = true;
    expect(menuBarAttached(ports([], overrides))("recent_transport")).toBe(
      false,
    );
  });

  it("is not attached for a pending edit, unknown outcome, uncertain runtime or missing attachment", () => {
    gates.uncertain = false;
    gates.attachment = true;
    const pending = ports(
      [],
      {},
      {
        status: "ready",
        settings: settings({ pendingEdit: {} }),
      },
    );
    expect(menuBarAttached(pending)("recent_transport")).toBe(false);
    const unknown = ports(
      [],
      {},
      {
        status: "ready",
        settings: settings({ outcomeUnknown: true }),
      },
    );
    expect(menuBarAttached(unknown)("recent_transport")).toBe(false);
    gates.uncertain = true;
    expect(menuBarAttached(ports([]))("recent_transport")).toBe(false);
    gates.uncertain = false;
    gates.attachment = false;
    expect(menuBarAttached(ports([]))("recent_transport")).toBe(false);
  });
});
