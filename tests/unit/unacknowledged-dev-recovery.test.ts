import { describe, expect, it } from "vitest";
import {
  recoverClosedEmptyChat,
  recoverInterruptedEmptyChat,
  recoverUnacknowledgedEmptyDev,
  unacknowledgedDevQuitScope,
  type ClosedEmptyChatRecoveryInput,
} from "../../src/apps/desktop/closed-empty-chat-recovery";

// Mode guards only: any host port call is a test failure. Exact native storage,
// archive retention and fresh successor are covered by the explicit host test.
function input() {
  return {
    userData: "/synthetic/Farol Dev",
    selectionInput: { UnacknowledgedDev: true },
    expectedQuitSha256: "a".repeat(64),
    attest: async () => {
      throw Error("host must not be reached");
    },
    processesAbsent: () => {
      throw Error("host must not be reached");
    },
    desktopState: async () => {
      throw Error("host must not be reached");
    },
  } as unknown as ClosedEmptyChatRecoveryInput & { expectedQuitSha256: string };
}

describe("unacknowledged empty Dev mode boundaries", () => {
  it.each(["Farol", "Farol", "Farol Dev Review"])(
    "refuses profile %s before host effects",
    async (name) => {
      await expect(
        recoverUnacknowledgedEmptyDev({
          ...input(),
          userData: `/synthetic/${name}`,
        }),
      ).rejects.toThrow("UNACKNOWLEDGED_DEV_RECOVERY_SELECTION_INVALID");
    },
  );
  it("requires the explicit new mode, exact failed Quit and no original ACK selection", async () => {
    const base = input();
    for (const selected of [
      {
        ...base,
        selectionInput: {
          ...base.selectionInput,
          UnacknowledgedDev: undefined,
        },
      },
      { ...base, expectedQuitSha256: "bad" },
      {
        ...base,
        selectionInput: {
          ...base.selectionInput,
          Interrupted: { OriginalHandoffID: "old", ExpectedACKDigest: [1] },
        },
      },
    ]) {
      await expect(
        recoverUnacknowledgedEmptyDev(selected as typeof base),
      ).rejects.toThrow("UNACKNOWLEDGED_DEV_RECOVERY_SELECTION_INVALID");
    }
  });
  it("does not change ordinary or acknowledged recovery eligibility", async () => {
    await expect(recoverClosedEmptyChat(input())).rejects.toThrow(
      "EMPTY_CHAT_RECOVERY_SELECTION_INVALID",
    );
    await expect(recoverInterruptedEmptyChat(input())).rejects.toThrow(
      "INTERRUPTED_CHAT_RECOVERY_SELECTION_INVALID",
    );
  });
});

describe("unacknowledged Dev with a previous clean Quit", () => {
  const run = {
    schema: 1,
    pid: 44374,
    startedAt: "2026-10-08T14:41:58.367Z",
    bootTime: 1790674646000,
    processStart: "Thu Oct  8 15:41:57 2026",
  };
  const quit = {
    schema: 1,
    at: "2026-10-08T14:39:05.070Z",
    drained: true,
    unconfirmed: [],
  };
  it("preserves the older confirmation without settling the newer run", () => {
    expect(unacknowledgedDevQuitScope(run, quit)).toBe("previous-confirmed");
    expect(quit).toEqual({
      schema: 1,
      at: "2026-10-08T14:39:05.070Z",
      drained: true,
      unconfirmed: [],
    });
  });
  it("retains the existing exact failed-Quit mode", () => {
    expect(
      unacknowledgedDevQuitScope(run, {
        ...quit,
        at: "2026-10-08T14:42:05.070Z",
        drained: false,
        unconfirmed: ["go-core", "connector"],
      }),
    ).toBe("current-unconfirmed");
  });
  it.each([
    { ...quit, at: run.startedAt },
    { ...quit, at: "2026-10-08T14:42:00.000Z" },
    { ...quit, at: "invalid" },
    { ...quit, drained: true, unconfirmed: ["connector"] },
    { ...quit, drained: false, unconfirmed: [] },
    { ...quit, drained: false, unconfirmed: ["go-core"] },
    { ...quit, extra: "unclassified" },
    null,
  ])("refuses mismatched or unclassified Quit %j", (value) => {
    expect(() => unacknowledgedDevQuitScope(run, value)).toThrow(
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    );
  });
  it.each([
    { ...run, startedAt: "invalid" },
    { ...run, startedAt: "2026-10-08T14:39:00.000Z" },
    { ...run, pid: 0 },
    { ...run, extra: "unclassified" },
    null,
  ])("refuses invalid or mismatched run %j", (value) => {
    expect(() => unacknowledgedDevQuitScope(value, quit)).toThrow(
      "INTERRUPTED_CHAT_RECOVERY_QUIT_CHANGED",
    );
  });
});
