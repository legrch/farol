import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setupAction,
  connectMac,
  disconnectMac,
} from "./current-react-setup.mjs";

afterEach(() => vi.restoreAllMocks());

// The former Settings receipt observer is retired. No native UI is executed;
// this check prevents obsolete journeys from silently passing or dispatching.
describe("retired Settings/Setup receipt journeys", () => {
  it.each([
    "Add workspace…",
    "Verify workspace",
    "Save & connect",
    "Connect this Mac",
    "Check connection",
    "Check attachment",
    "Save file permissions",
    "Stop connection",
    "Disconnect",
  ])(
    "refuses %s with an explicit retirement reason before any page access",
    async (name) => {
      await expect(setupAction(null, name)).rejects.toThrow(
        new RegExp(`E2E_JOURNEY_RETIRED:${name}: .+`),
      );
    },
  );
  it("continues to reject unknown actions without a generic success fallback", async () => {
    await expect(setupAction(null, "invented-action")).rejects.toThrow(
      "SETUP_ACTION_UNSUPPORTED:invented-action",
    );
  });
});

// Scripted page/state boundary only. No Electron, profile or native filesystem.
function pageFixture(snapshots) {
  const click = vi.fn(async () => {});
  const waitFor = vi.fn(async () => {});
  const control = {
    click,
    waitFor,
    getByRole: vi.fn(() => control),
    locator: vi.fn(() => control),
    filter: vi.fn(() => control),
  };
  return {
    click,
    page: {
      locator: vi.fn(() => control),
      getByText: vi.fn(() => control),
      evaluate: vi.fn(async () => ({
        configuration: { status: "ready", settings: snapshots.shift() },
      })),
    },
  };
}
function state(workspaces = [], runtime = null) {
  return {
    setup: {
      computer: { outcomeUnknown: false },
      connect: { outcomeUnknown: false },
    },
    computer: { workspaces },
    connectors: { secureMcp: { runtime } },
  };
}
describe("current Setup one-shot helpers", () => {
  it("confirms a newly selected workspace's own fresh check and row", async () => {
    const existing = {
      workspaceId: "existing",
      root: "/synthetic/old",
      accessCheck: { checkId: "old" },
    };
    const added = {
      workspaceId: "new",
      root: "/synthetic/new",
      accessCheck: { checkId: "new" },
    };
    const h = pageFixture([state([existing]), state([existing, added])]);
    await setupAction(h.page, "+ Add workspace");
    expect(h.click).toHaveBeenCalledTimes(1);
    expect(h.page.getByText).toHaveBeenCalledWith(added.root, { exact: true });
  });
  it("rejects a stale access check without clicking again", async () => {
    const unchanged = state([
      {
        workspaceId: "existing",
        root: "/synthetic/old",
        accessCheck: { checkId: "old" },
      },
    ]);
    const h = pageFixture([unchanged, unchanged]);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(15_001);
    await expect(setupAction(h.page, "Check access")).rejects.toThrow(
      "SETUP_ACTION_UNCONFIRMED:Check access",
    );
    expect(h.click).toHaveBeenCalledTimes(1);
  });
  it("requires a stopped runtime before Connect and confirms its new runtime", async () => {
    const running = state([], { state: "ready" });
    const h = pageFixture([state(), running]);
    await connectMac(h.page);
    expect(h.click).toHaveBeenCalledTimes(1);
    const prior = pageFixture([running]);
    await expect(connectMac(prior.page)).rejects.toThrow(
      "SETUP_CONNECT_REQUIRES_STOPPED_RUNTIME",
    );
    expect(prior.click).not.toHaveBeenCalled();
  });
  it("does not repeat an unknown Disconnect", async () => {
    const unknown = state([], { state: "outcome_unknown" });
    unknown.setup.connect.outcomeUnknown = true;
    const h = pageFixture([state([], { state: "ready" }), unknown]);
    await expect(disconnectMac(h.page)).rejects.toThrow(
      "SETUP_DISCONNECT_OUTCOME_UNKNOWN",
    );
    expect(h.click).toHaveBeenCalledTimes(1);
  });
});
