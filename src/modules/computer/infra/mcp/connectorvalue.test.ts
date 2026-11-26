import { describe, expect, it } from "vitest";
import {
  connectorReceiptValue,
  connectorRecordFailureCode,
} from "./connectorvalue";

describe("connector verification value", () => {
  it("keeps the receipt fields in order and only the task correlation", () => {
    const value = connectorReceiptValue({
      recorded: { receipt: { challengeSha256: "c" }, receiptSha256: "r" },
      binding: { taskId: "t", participantId: "p", turnId: "u", generation: 1 },
      workspaceId: "w",
      entryCount: 2,
      truncated: false,
    });
    expect(Object.keys(value)).toEqual([
      "ok",
      "challengeSha256",
      "receiptSha256",
      "workspaceId",
      "operation",
      "entryCount",
      "truncated",
      "correlation",
    ]);
    expect(value.correlation).toEqual({
      taskId: "t",
      participantId: "p",
      turnId: "u",
      generation: 1,
    });
  });
});

describe("connector record failure code", () => {
  it("keeps the two known refusals", () => {
    for (const code of [
      "CONNECTOR_VERIFICATION_ALREADY_RECORDED",
      "CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH",
    ])
      expect(connectorRecordFailureCode(new Error(code))).toBe(code);
  });

  it("maps everything else to the receipt failure", () => {
    expect(connectorRecordFailureCode(new Error("x"))).toBe(
      "CONNECTOR_VERIFICATION_RECEIPT_FAILED",
    );
    expect(
      connectorRecordFailureCode("CONNECTOR_VERIFICATION_ALREADY_RECORDED"),
    ).toBe("CONNECTOR_VERIFICATION_RECEIPT_FAILED");
  });
});
