import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  authorizeComputerRequest,
  type ComputerGrant,
  type ComputerRequest,
} from "../../src/modules/computer/domain/access";

const grant: ComputerGrant = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  generation: 4,
  capability: "fixture.inspect",
  expiresAt: 2_000,
};

const request: ComputerRequest = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 4,
  callId: "call-a",
  operation: "fixture.inspect",
  target: "synthetic://workspace/status",
};

describe("Computer access", () => {
  it("admits only the exact bounded fixture capability", () => {
    expect(authorizeComputerRequest(grant, request, 1_000)).toMatchObject({
      ok: true,
    });
    expect(
      authorizeComputerRequest(
        grant,
        { ...request, target: "file:///Users/example" },
        1_000,
      ),
    ).toMatchObject({ ok: false, error: { code: "COMPUTER_TARGET_DENIED" } });
  });

  it("rejects every foreign owner before execution", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => value !== grant.ownerId),
        (ownerId) =>
          authorizeComputerRequest(grant, { ...request, ownerId }, 1_000).ok ===
          false,
      ),
    );
  });

  it("rejects stale generations and expired grants", () => {
    expect(
      authorizeComputerRequest(grant, { ...request, generation: 3 }, 1_000),
    ).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_STALE_GENERATION" },
    });
    expect(authorizeComputerRequest(grant, request, 2_001)).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_GRANT_EXPIRED" },
    });
  });
});
