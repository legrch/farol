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
function pageFixture(snapshots, pendingSamples = []) {
  const click = vi.fn(async () => {});
  const waitFor = vi.fn(async () => {});
  const control = {
    click,
    waitFor,
    getByRole: vi.fn((_role, options) =>
      options.name === "Connecting…"
        ? { count: async () => pendingSamples.shift() ?? 0 }
        : control,
    ),
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
  it("targets the requested workspace row when more than one is present", async () => {
    const target = {
      workspaceId: "target",
      root: "/synthetic/target",
      accessCheck: { checkId: "target-before" },
    };
    const other = {
      workspaceId: "other",
      root: "/synthetic/other",
      accessCheck: { checkId: "other-before" },
    };
    const h = pageFixture([
      state([other, target]),
      state([other, { ...target, accessCheck: { checkId: "target-after" } }]),
    ]);
    await setupAction(h.page, "Check access", {
      workspaceId: target.workspaceId,
    });
    expect(h.click).toHaveBeenCalledTimes(1);
    expect(h.page.getByText).toHaveBeenCalledTimes(2);
    for (const call of h.page.getByText.mock.calls)
      expect(call).toEqual([target.root, { exact: true }]);
  });
  it.each([undefined, "missing"])(
    "refuses an ambiguous or missing workspace target (%s) before a click",
    async (workspaceId) => {
      const h = pageFixture([
        state([
          { workspaceId: "one", root: "/synthetic/one" },
          { workspaceId: "two", root: "/synthetic/two" },
        ]),
      ]);
      await expect(
        setupAction(h.page, "Check access", { workspaceId }),
      ).rejects.toThrow(
        workspaceId === undefined
          ? "SETUP_WORKSPACE_TARGET_REQUIRED"
          : "SETUP_WORKSPACE_TARGET_MISSING:missing",
      );
      expect(h.click).not.toHaveBeenCalled();
      expect(h.page.evaluate).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["other", "new"])(
    "does not credit a fresh check from an unrelated %s workspace",
    async (source) => {
      const target = {
        workspaceId: "target",
        root: "/synthetic/target",
        accessCheck: { checkId: "target-before" },
      };
      const other = {
        workspaceId: source,
        root: `/synthetic/${source}`,
        accessCheck: { checkId: "other-before" },
      };
      const h = pageFixture([
        state(source === "other" ? [target, other] : [target]),
        state([target, { ...other, accessCheck: { checkId: "other-after" } }]),
      ]);
      vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(15_001);
      await expect(
        setupAction(h.page, "Check access", {
          workspaceId: target.workspaceId,
        }),
      ).rejects.toThrow("SETUP_ACTION_UNCONFIRMED:Check access");
      expect(h.click).toHaveBeenCalledTimes(1);
      expect(h.page.evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it("does not credit a changed root under the target workspace ID", async () => {
    const target = {
      workspaceId: "target",
      root: "/synthetic/original",
      accessCheck: { checkId: "before" },
    };
    const h = pageFixture([
      state([target]),
      state([
        {
          ...target,
          root: "/synthetic/replacement",
          accessCheck: { checkId: "after" },
        },
      ]),
    ]);
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
  it("waits for its original Connect to settle across its credential fence without another click", async () => {
    const pending = state();
    pending.setup.connect.outcomeUnknown = true;
    const h = pageFixture(
      [state(), pending, state([], { state: "ready" })],
      [1, 1, 0, 0],
    );
    await connectMac(h.page);
    expect(h.click).toHaveBeenCalledTimes(1);
    expect(h.page.evaluate).toHaveBeenCalledTimes(3);
  });
  it("does not credit early readiness when the original Connect settles unknown", async () => {
    const unknown = state();
    unknown.setup.connect.outcomeUnknown = true;
    const h = pageFixture(
      [state(), state([], { state: "ready" }), unknown],
      [1, 1, 0, 0],
    );
    await expect(connectMac(h.page)).rejects.toThrow(
      "SETUP_CONNECT_OUTCOME_UNKNOWN",
    );
    expect(h.click).toHaveBeenCalledTimes(1);
  });
  it("bounds observation of an unresolved original Connect without another click", async () => {
    const pending = state();
    pending.setup.connect.outcomeUnknown = true;
    const h = pageFixture([state(), pending], [1, 1]);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(15001);
    await expect(connectMac(h.page)).rejects.toThrow(
      "SETUP_CONNECT_ORIGINAL_PENDING",
    );
    expect(h.click).toHaveBeenCalledTimes(1);
  });
  it.each([
    "connect",
    "computer",
    "hosts",
    "verify",
    "runtime",
    "pending-edit",
  ])(
    "rejects an independent %s unknown fence before any later stopped sample",
    async (source) => {
      const unknown = state([], { state: "ready" });
      if (source === "runtime")
        unknown.connectors.secureMcp.runtime.state = "outcome_unknown";
      else if (source === "pending-edit") unknown.computer.pendingEdit = {};
      else unknown.setup[source] = { outcomeUnknown: true };
      const h = pageFixture([state([], { state: "ready" }), unknown, state()]);
      await expect(disconnectMac(h.page)).rejects.toThrow(
        "SETUP_DISCONNECT_OUTCOME_UNKNOWN",
      );
      expect(h.click).toHaveBeenCalledTimes(1);
      expect(h.page.evaluate).toHaveBeenCalledTimes(2);
    },
  );
  it("does not click Disconnect when the saved runtime is already unknown", async () => {
    const h = pageFixture([state([], { state: "outcome_unknown" })]);
    await expect(disconnectMac(h.page)).rejects.toThrow();
    expect(h.click).not.toHaveBeenCalled();
  });
});
