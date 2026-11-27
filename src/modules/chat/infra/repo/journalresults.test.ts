import { describe, expect, it } from "vitest";
import { buildHandoffRecord, messageState } from "./journalresults";
import type { ReservationRecord } from "./journalrecords";

const base = {
  requestDigest: "a".repeat(64),
  workspaceId: "ws1",
  projectId: "p1",
  workspace: {},
} as unknown as ReservationRecord;
const none = {
  threadIntent: null,
  thread: null,
  turnIntent: null,
  turn: null,
  continuation: null,
};

describe("journal results", () => {
  it("builds a reservation-only record with false intents", () => {
    const built = buildHandoffRecord(base, none);
    expect(Object.keys(built)).toEqual([
      "requestDigest",
      "workspaceId",
      "workspace",
      "projectId",
      "threadIntent",
      "turnIntent",
    ]);
    expect(built.threadIntent).toBe(false);
    expect(built.turnIntent).toBe(false);
  });

  it("carries progress ids and continuation state", () => {
    const built = buildHandoffRecord(
      {
        ...base,
        dispatchProtocol: 1,
        model: "m",
        continuedFrom: "k",
      } as ReservationRecord,
      {
        threadIntent: {},
        thread: "th",
        turnIntent: {},
        turn: "tu",
        continuation: "tu",
      },
    );
    expect(built).toMatchObject({
      dispatchProtocol: 1,
      model: "m",
      continuedFrom: "k",
      continuationVerified: true,
      threadIntent: true,
      turnIntent: true,
      threadId: "th",
      turnId: "tu",
    });
  });

  it("refuses a malformed stored id", () => {
    expect(() =>
      buildHandoffRecord(base, { ...none, thread: "bad id" }),
    ).toThrow("HANDOFF_JOURNAL_INVALID");
  });

  it("maps a message receipt to a pending or confirmed state", () => {
    expect(messageState("d", null)).toEqual({ digest: "d", turnId: null });
    expect(messageState("d", "turn1")).toEqual({
      digest: "d",
      turnId: "turn1",
    });
    expect(() => messageState("d", 5)).toThrow("HANDOFF_JOURNAL_INVALID");
  });
});
