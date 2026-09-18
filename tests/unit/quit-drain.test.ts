import { describe, expect, it } from "vitest";

import { drainOwnedChildren } from "../../src/apps/desktop/quit-drain";

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
});
