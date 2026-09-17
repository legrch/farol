import { describe, expect, it } from "vitest";
import { ProductAgentSessionReservation } from "../../src/apps/desktop/product-agent-session-reservation";

describe("Product Agent session reservation", () => {
  it("shares one opening operation with an exact follower", async () => {
    const sessions = new ProductAgentSessionReservation<string>();
    let release!: (value: string) => void;
    let opens = 0;
    const first = sessions.open("task-a:assignment-a", async () => {
      opens += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const follower = sessions.open("task-a:assignment-a", async () => {
      opens += 1;
      return "duplicate";
    });

    expect(follower).toBe(first);
    await Promise.resolve();
    expect(opens).toBe(1);
    release("session-a");
    await expect(Promise.all([first, follower])).resolves.toEqual([
      "session-a",
      "session-a",
    ]);
  });

  it("refuses a different assignment until the opening operation settles", async () => {
    const sessions = new ProductAgentSessionReservation<string>();
    let release!: (value: string) => void;
    const first = sessions.open(
      "task-a:assignment-a",
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    await expect(
      sessions.open("task-b:assignment-b", async () => "session-b"),
    ).rejects.toThrow("PRODUCT_AGENT_SESSION_BUSY");
    release("session-a");
    await expect(first).resolves.toBe("session-a");
    await expect(
      sessions.open("task-b:assignment-b", async () => "session-b"),
    ).resolves.toBe("session-b");
  });

  it("releases a failed reservation for a later exact retry", async () => {
    const sessions = new ProductAgentSessionReservation<string>();
    await expect(
      sessions.open("task-a:assignment-a", async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    await expect(
      sessions.open("task-a:assignment-a", async () => "session-a"),
    ).resolves.toBe("session-a");
  });
});
