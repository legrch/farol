import { describe, expect, it } from "vitest";
import { BridgeError } from "../bridge/client.ts";
import { acceptRetirementAck, acceptRetirementPrepared } from "./retirement";

const digest = "a".repeat(64);
const other = "b".repeat(64);

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BridgeError ? error.code : "other";
  }
  return undefined;
}

describe("acceptRetirementPrepared", () => {
  it("returns a matching publication", () => {
    const data = { handoffId: "h", receiptDigest: digest };
    expect(acceptRetirementPrepared("h", { status: "ok", data })).toBe(data);
  });
  it("refuses a non-ok or malformed reply as unconfirmed", () => {
    expect(
      codeOf(() => acceptRetirementPrepared("h", { status: "error" })),
    ).toBe("core_retirement_prepare_unconfirmed");
    expect(
      codeOf(() =>
        acceptRetirementPrepared("h", { status: "ok", data: { x: 1 } }),
      ),
    ).toBe("core_retirement_prepare_unconfirmed");
  });
  it("refuses a crossed handoff or bad digest", () => {
    const data = { handoffId: "g", receiptDigest: digest };
    expect(
      codeOf(() => acceptRetirementPrepared("h", { status: "ok", data })),
    ).toBe("core_retirement_publication_crossed");
  });
});

describe("acceptRetirementAck", () => {
  const publication = { handoffId: "h", receiptDigest: digest };
  it("returns a matching ack", () => {
    const data = { ...publication, ackDigest: other };
    expect(acceptRetirementAck(publication, { status: "ok", data })).toBe(data);
  });
  it("refuses unconfirmed and crossed acks", () => {
    expect(
      codeOf(() => acceptRetirementAck(publication, { status: "error" })),
    ).toBe("core_retirement_ack_unconfirmed");
    const crossed = { ...publication, receiptDigest: other, ackDigest: other };
    expect(
      codeOf(() =>
        acceptRetirementAck(publication, { status: "ok", data: crossed }),
      ),
    ).toBe("core_retirement_ack_crossed");
  });
});
