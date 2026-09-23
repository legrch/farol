import { describe, expect, it } from "vitest";

import {
  checkConnectorAttachment,
  connectorReceiptBindingIsCurrent,
  ConnectorVerificationReceiptSchema,
  type ConnectorVerificationReceipt,
} from "../../src/modules/computer/infra/mcp/connector-verification-receipt";

// S35-TA-6. Whether a connector counts as attached was decided inside
// `main.ts`, which exports nothing and which no test loads, so the decision
// could not be exercised at all — a test could only restate it and assert on
// the copy. It is a local trust boundary: a wrong "attached" here accepts a
// connector the owner never verified, or one verified against a workspace or
// a Computer generation that no longer applies.
//
// Every row below is one way a receipt can fail to be THIS connector's answer
// to THIS challenge, and each fails on its own with every other field valid,
// so a passing row cannot be explained by something else also being wrong.

const RUNTIME_ID = "0199c0de-0000-4000-8000-0000000000aa";
const GENERATION = 7;
const CHALLENGE_SHA = "a".repeat(64);
const PREPARED_AT = "2026-09-20T12:00:00.000Z";
const RECORDED_AT = "2026-09-20T12:00:05.000Z";
const WORKSPACE_ID = "workspace-primary";

/** A receipt parsed by the real schema: no hand-built shape bypasses it. */
function receiptOf(
  overrides: Partial<ConnectorVerificationReceipt> = {},
): ConnectorVerificationReceipt {
  return ConnectorVerificationReceiptSchema.parse({
    schema: 1,
    ownerId: "owner-desktop",
    sessionId: `secure-mcp-session-${RUNTIME_ID}`,
    taskId: `secure-mcp-task-${RUNTIME_ID}`,
    taskEpoch: GENERATION,
    participantId: `secure-mcp-main-${RUNTIME_ID}`,
    turnId: `secure-mcp-turn-${RUNTIME_ID}`,
    generation: GENERATION,
    challengeSha256: CHALLENGE_SHA,
    callIdSha256: "b".repeat(64),
    workspaceId: WORKSPACE_ID,
    operation: "workspace.list",
    entryCount: 3,
    truncated: false,
    recordedAt: RECORDED_AT,
    ...overrides,
  });
}

function check(
  overrides: Partial<ConnectorVerificationReceipt> = {},
  context: Partial<{
    challengeSha256: string;
    preparedAt: string;
    computerGeneration: number;
    approvedWorkspaceIds: readonly string[];
    expectedWorkspaceId: string;
  }> = {},
) {
  return checkConnectorAttachment({
    receipt: receiptOf(overrides),
    challenge: {
      challengeSha256: context.challengeSha256 ?? CHALLENGE_SHA,
      preparedAt: context.preparedAt ?? PREPARED_AT,
    },
    computerGeneration: context.computerGeneration ?? GENERATION,
    approvedWorkspaceIds: context.approvedWorkspaceIds ?? [WORKSPACE_ID],
    expectedWorkspaceId: context.expectedWorkspaceId,
  });
}

describe("connector attachment verdict", () => {
  it("S35-TA-6 accepts this runtime's receipt for this challenge at the current generation", () => {
    expect(check()).toEqual({ attached: true });
  });

  it("rejects another approved workspace when app verification requested a specific one", () => {
    expect(
      check(
        {},
        {
          approvedWorkspaceIds: [WORKSPACE_ID, "workspace-selected"],
          expectedWorkspaceId: "workspace-selected",
        },
      ),
    ).toEqual({ attached: false, reason: "workspace-not-requested" });
  });

  it("accepts the requested workspace when another approved grant exists", () => {
    expect(
      check(
        {},
        {
          approvedWorkspaceIds: [WORKSPACE_ID, "workspace-other"],
          expectedWorkspaceId: WORKSPACE_ID,
        },
      ),
    ).toEqual({ attached: true });
  });

  // THE REPLAY CASE. A receipt recorded before the challenge it claims to
  // answer cannot be an answer to it: it is an older receipt replayed against
  // a newer challenge, and the digests matching proves only that whoever
  // replayed it held the old one. Everything else about this receipt is valid.
  it("S35-TA-6 rejects a receipt recorded before the challenge it claims to answer", () => {
    expect(check({ recordedAt: "2026-09-20T11:59:59.000Z" })).toEqual({
      attached: false,
      reason: "recorded-before-challenge",
    });
  });

  it("S35-TA-6 accepts a receipt recorded at the very instant the challenge was prepared", () => {
    // The boundary is "before", not "at or before": a receipt recorded in the
    // same millisecond is not a replay, and refusing it would make a fast
    // machine fail a verification it actually performed.
    expect(check({ recordedAt: PREPARED_AT })).toEqual({ attached: true });
  });

  const rows: ReadonlyArray<
    Readonly<{
      name: string;
      receipt?: Partial<ConnectorVerificationReceipt>;
      context?: Parameters<typeof check>[1];
      reason: Extract<ReturnType<typeof check>, { attached: false }>["reason"];
    }>
  > = [
    {
      name: "a receipt answering a different challenge",
      context: { challengeSha256: "c".repeat(64) },
      reason: "challenge-mismatch",
    },
    {
      name: "a receipt whose task epoch is not the current generation",
      receipt: { taskEpoch: GENERATION - 1 },
      reason: "binding-not-current",
    },
    {
      name: "a receipt whose generation is not the current one",
      receipt: { generation: GENERATION - 1 },
      reason: "binding-not-current",
    },
    {
      name: "the owner advancing the Computer generation after the receipt was written",
      context: { computerGeneration: GENERATION + 1 },
      reason: "binding-not-current",
    },
    {
      name: "a participant that is not this product's connector participant",
      receipt: { participantId: "main-route-a" },
      reason: "binding-not-current",
    },
    {
      name: "a participant whose runtime id is not a v4 UUID",
      receipt: { participantId: "secure-mcp-main-not-a-uuid" },
      reason: "binding-not-current",
    },
    {
      name: "a session that names a different runtime than the participant",
      receipt: {
        sessionId: "secure-mcp-session-0199c0de-0000-4000-8000-0000000000bb",
      },
      reason: "binding-not-current",
    },
    {
      name: "a task that names a different runtime than the participant",
      receipt: {
        taskId: "secure-mcp-task-0199c0de-0000-4000-8000-0000000000bb",
      },
      reason: "binding-not-current",
    },
    {
      name: "a turn that names a different runtime than the participant",
      receipt: {
        turnId: "secure-mcp-turn-0199c0de-0000-4000-8000-0000000000bb",
      },
      reason: "binding-not-current",
    },
    {
      name: "an owner this product never issues receipts for",
      receipt: { ownerId: "owner-someone-else" },
      reason: "binding-not-current",
    },
    {
      name: "a workspace the owner has not approved",
      context: { approvedWorkspaceIds: ["workspace-other"] },
      reason: "workspace-not-approved",
    },
    {
      name: "no approved workspaces at all",
      context: { approvedWorkspaceIds: [] },
      reason: "workspace-not-approved",
    },
  ];

  for (const row of rows) {
    it(`S35-TA-6 rejects ${row.name}`, () => {
      expect(check(row.receipt, row.context)).toEqual({
        attached: false,
        reason: row.reason,
      });
    });
  }

  it("S35-TA-6 rejects a challenge whose prepared time cannot be read, rather than treating it as long ago", () => {
    // An unreadable `preparedAt` makes the replay comparison meaningless.
    // `Date.parse` gives NaN, and every comparison against NaN is false — so
    // an implementation that only asked `recordedAt < preparedAt` would let
    // it through. The verdict must refuse instead of falling open.
    expect(check({}, { preparedAt: "not-a-timestamp" })).toEqual({
      attached: false,
      reason: "challenge-time-unreadable",
    });
  });

  it("S35-TA-6 the binding check alone accepts only the current generation", () => {
    const receipt = receiptOf();
    expect(connectorReceiptBindingIsCurrent(receipt, GENERATION)).toBe(true);
    expect(connectorReceiptBindingIsCurrent(receipt, GENERATION + 1)).toBe(
      false,
    );
  });
});
