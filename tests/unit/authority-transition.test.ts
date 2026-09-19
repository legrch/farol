import { describe, expect, it } from "vitest";

import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("F3-1b authority transition reservation", () => {
  it("lets exactly one of an interleaved authority change and connector start proceed", async () => {
    const reservation = new AuthorityTransitionReservation();
    const commitGate = deferred();
    const effects: string[] = [];

    // An authority change is admitted, then awaits (a picker, a listing, the
    // settings write) before it commits.
    const change = reservation.withReservation("authority-change", async () => {
      effects.push("change-admitted");
      await commitGate.promise;
      effects.push("change-committed");
      return "changed";
    });
    // A connector start arrives in that window.
    const start = await reservation.withReservation(
      "connector-start",
      async () => {
        effects.push("connector-started");
        return "started";
      },
    );
    commitGate.resolve();

    expect(start).toEqual({ admitted: false, heldBy: "authority-change" });
    await expect(change).resolves.toEqual({
      admitted: true,
      value: "changed",
    });
    expect(effects).toEqual(["change-admitted", "change-committed"]);
    expect(reservation.current()).toBeNull();
  });

  it("refuses an authority change while an Agent admission holds the reservation", async () => {
    const reservation = new AuthorityTransitionReservation();
    const admission = reservation.tryReserve("agent-admission");
    expect(admission).not.toBeNull();
    await expect(
      reservation.withReservation("authority-change", async () => "changed"),
    ).resolves.toEqual({ admitted: false, heldBy: "agent-admission" });
    admission?.release();
    await expect(
      reservation.withReservation("authority-change", async () => "changed"),
    ).resolves.toEqual({ admitted: true, value: "changed" });
  });

  it("releases after a failed transition and ignores a second release", async () => {
    const reservation = new AuthorityTransitionReservation();
    await expect(
      reservation.withReservation("authority-change", async () => {
        throw new Error("settings write failed");
      }),
    ).rejects.toThrow("settings write failed");
    expect(reservation.current()).toBeNull();

    const first = reservation.tryReserve("connector-start");
    first?.release();
    const second = reservation.tryReserve("authority-change");
    first?.release();
    expect(reservation.current()).toBe("authority-change");
    second?.release();
    expect(reservation.current()).toBeNull();
  });
});
