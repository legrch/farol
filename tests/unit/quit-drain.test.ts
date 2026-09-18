import { describe, expect, it, vi } from "vitest";

import {
  createQuitDrain,
  drainOwnedChildren,
  type OwnedCloser,
} from "../../src/apps/desktop/quit-drain";

describe("LIF-09 quit drains owned children before claiming they stopped", () => {
  it("reports drained only when every child confirmed its exit", async () => {
    await expect(
      drainOwnedChildren(
        [
          { name: "agent-host", close: async () => undefined },
          { name: "route-b", close: async () => undefined },
        ],
        1_000,
      ),
    ).resolves.toEqual({ drained: true, unconfirmed: [] });
  });

  it("names a child that ignores termination or fails to close", async () => {
    const receipt = await drainOwnedChildren(
      [
        { name: "agent-host", close: () => new Promise<void>(() => undefined) },
        {
          name: "relay",
          close: async () => {
            throw new Error("CODEX_APP_SERVER_SHUTDOWN_UNCONFIRMED");
          },
        },
        { name: "route-b", close: async () => undefined },
      ],
      20,
    );

    expect(receipt).toEqual({
      drained: false,
      unconfirmed: ["agent-host", "relay"],
    });
  });

  describe("LIF-09/Q-08 quit as the product composes it", () => {
    function event() {
      let prevented = 0;
      return {
        preventDefault: () => {
          prevented += 1;
        },
        prevented: () => prevented,
      };
    }

    it("holds the first quit, drains every child collected once, records the receipt, then quits for real", async () => {
      const closed: string[] = [];
      let releaseLate!: () => void;
      const late = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const registered: OwnedCloser[] = [
        {
          name: "host-check",
          close: async () => {
            closed.push("host-check");
          },
        },
        {
          name: "product-agent",
          close: async () => {
            await late;
            closed.push("product-agent");
          },
        },
      ];
      const receipts: unknown[] = [];
      let quits = 0;
      let collects = 0;
      const drain = createQuitDrain({
        deadlineMs: 5_000,
        collect: () => {
          collects += 1;
          return [...registered];
        },
        record: async (receipt) => {
          receipts.push(receipt);
        },
        quit: () => {
          quits += 1;
        },
      });
      const first = event();
      drain.onBeforeQuit(first);
      expect(first.prevented()).toBe(1);
      expect(drain.state()).toBe("draining");
      // A child that unregisters itself while quit is under way is still
      // drained: the set was read once.
      registered.length = 0;
      // A second quit while draining is held too and starts nothing new.
      const second = event();
      drain.onBeforeQuit(second);
      expect(second.prevented()).toBe(1);
      expect(collects).toBe(1);
      expect(quits).toBe(0);
      releaseLate();
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(closed).toEqual(["host-check", "product-agent"]);
      expect(receipts).toEqual([{ drained: true, unconfirmed: [] }]);
      expect(quits).toBe(1);
      // After the drain the real quit is not intercepted.
      const third = event();
      drain.onBeforeQuit(third);
      expect(third.prevented()).toBe(0);
      expect(quits).toBe(1);
    });

    it("names a child that failed to close or outlived the deadline, records that, and still quits", async () => {
      const receipts: unknown[] = [];
      let quits = 0;
      const drain = createQuitDrain({
        deadlineMs: 20,
        collect: () => [
          {
            name: "route-b",
            close: async () => undefined,
          },
          {
            name: "connector",
            close: async () => {
              throw new Error("CONNECTOR_STOP_FAILED");
            },
          },
          {
            name: "agent-check",
            close: () => new Promise<void>(() => undefined),
          },
        ],
        record: async (receipt) => {
          receipts.push(receipt);
        },
        quit: () => {
          quits += 1;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(receipts).toEqual([
        { drained: false, unconfirmed: ["connector", "agent-check"] },
      ]);
      expect(quits).toBe(1);
    });

    it("quits no later than the drain deadline even when the receipt record never settles", async () => {
      let quits = 0;
      const startedAt = Date.now();
      let quitAt = 0;
      const drain = createQuitDrain({
        deadlineMs: 30,
        collect: () => [{ name: "route-b", close: async () => undefined }],
        record: () => new Promise<void>(() => undefined),
        quit: () => {
          quits += 1;
          quitAt = Date.now() - startedAt;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"), {
        timeout: 500,
      });
      expect(quits).toBe(1);
      expect(quitAt).toBeLessThan(300);
    });

    it("quits even when the diagnostic receipt cannot be written", async () => {
      let quits = 0;
      const drain = createQuitDrain({
        deadlineMs: 1_000,
        collect: () => [{ name: "route-b", close: async () => undefined }],
        record: async () => {
          throw new Error("EROFS");
        },
        quit: () => {
          quits += 1;
        },
      });
      drain.onBeforeQuit(event());
      await vi.waitFor(() => expect(drain.state()).toBe("done"));
      expect(quits).toBe(1);
    });
  });
});
