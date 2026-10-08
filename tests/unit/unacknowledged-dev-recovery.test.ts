import { describe, expect, it } from "vitest";
import {
  recoverClosedEmptyChat,
  recoverInterruptedEmptyChat,
  recoverUnacknowledgedEmptyDev,
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
  it.each(["Farol", "Farol Next", "Farol Dev Review"])(
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
