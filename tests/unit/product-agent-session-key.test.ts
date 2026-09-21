import { describe, expect, it } from "vitest";

import { productAgentSessionKey } from "../../src/apps/desktop/product-agent-session-key";
import type { ProductAgentInput } from "../../src/apps/desktop/product-agent-store";

// S35-Q1. The reservation this key addresses hands a second open the first
// one's promise when the keys match, and refuses it when they do not. So a
// field missing from the key is a field two callers can differ in while
// sharing one session handle — and `scheduleExpiry`, the one that decides
// whether the session's 30-minute reservation is armed at all, was missing.

const input: ProductAgentInput = {
  taskId: "00000000-0000-4000-8000-00000000a001",
  sessionId: "00000000-0000-4000-8000-00000000a002",
  assignmentId: "00000000-0000-4000-8000-00000000a003",
  authorityId: "00000000-0000-4000-8000-00000000a004",
  parentParticipantId: "00000000-0000-4000-8000-00000000a005",
  agentParticipantId: "00000000-0000-4000-8000-00000000a006",
  taskEpoch: 7,
  generation: 1,
  workspaceId: "00000000-0000-4000-8000-00000000a007",
  scope: { mode: "subtree", root: "/workspace/farol", paths: [] },
  excludedPaths: ["/workspace/farol/.env"],
  objective: "Read the repository guide.",
  computerGeneration: 7,
  executableSha256: "1".repeat(64),
  schemaSha256: "3".repeat(64),
  buildId: "5".repeat(64),
  expiresAt: 20_000,
  createdAt: "2026-09-21T09:00:00.000Z",
} as unknown as ProductAgentInput;

function key(
  overrides: Partial<ProductAgentInput> = {},
  scheduleExpiry = true,
): string {
  return productAgentSessionKey({ ...input, ...overrides }, scheduleExpiry);
}

describe("S35-Q1 product agent session key", () => {
  it("is the same for a genuine retry of the same request", () => {
    expect(key()).toBe(key());
  });

  it("separates the fields that make it a different assignment", () => {
    const distinct = new Set([
      key(),
      key({ taskId: "00000000-0000-4000-8000-00000000b001" }),
      key({ assignmentId: "00000000-0000-4000-8000-00000000b003" }),
      key({ executableSha256: "2".repeat(64) }),
      key({ schemaSha256: "4".repeat(64) }),
      key({ buildId: "6".repeat(64) }),
      key({ computerGeneration: 8 }),
      key({
        scope: { mode: "subtree", root: "/workspace/farol/vnext", paths: [] },
      } as Partial<ProductAgentInput>),
      key({ excludedPaths: [] } as Partial<ProductAgentInput>),
    ]);

    expect(distinct.size).toBe(9);
  });

  it("separates an open that arms the reservation from one that does not", () => {
    // `executeProductAgent` opens with the expiry armed;
    // `cancelProductAgentTask` opens without it. Sharing one handle would
    // give a running Agent a reservation nothing is tracking.
    expect(key({}, true)).not.toBe(key({}, false));
  });

  it("is stable for each expiry choice on its own", () => {
    expect(key({}, true)).toBe(key({}, true));
    expect(key({}, false)).toBe(key({}, false));
  });
});
