import { describe, expect, it } from "vitest";
import {
  CodexTaskSelectionSchema,
  ProductConfigurationCommandSchema,
} from "../../src/pkg/product-settings/contract.ts";

// Pure Settings values only; no provider membership or native proof.
const threadId = "0e4b2463-5506-47d5-a1a0-b4b84e941301";
const turnId = "turn-exact_1";
const command = {
  kind: "host.configure-codex-tasks",
  socketPath: "/fixture/codex.sock",
  expectedCodexHome: "/fixture/codex-home",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  projectRoot: "/fixture/project",
  sandbox: "read-only",
  approvalPolicy: "on-request",
};
const saved = {
  transport: "codex-shared-proxy/v1",
  socketPath: command.socketPath,
  expectedCodexHome: command.expectedCodexHome,
  workspaceId: command.workspaceId,
  projectId: command.projectId,
  projectRoot: command.projectRoot,
  projectIdentity: { device: "1", inode: "2" },
  gitCommonDirectory: "/fixture/project/.git",
  execution: {
    sandbox: command.sandbox,
    approvalPolicy: command.approvalPolicy,
  },
  harness: "codex",
  computerGeneration: 1,
  hostGeneration: 1,
  approvedAt: "2026-10-04T10:00:00.000Z",
  expiresAt: Date.parse("2026-10-04T11:00:00.000Z"),
};

describe("Codex exact read selection Settings contract", () => {
  it.each([
    {},
    { observeThreadId: threadId },
    { observeThreadId: threadId, observeTurnId: turnId },
    { observeThreadId: threadId, observeTurnId: "a".repeat(120) },
  ])(
    "uses the same backward-compatible command/save selection %j",
    (reference) => {
      expect(
        ProductConfigurationCommandSchema.parse({ ...command, ...reference }),
      ).toEqual({ ...command, ...reference });
      expect(
        CodexTaskSelectionSchema.parse({ ...saved, ...reference }),
      ).toEqual({ ...saved, ...reference });
    },
  );

  it.each([
    { observeTurnId: turnId },
    { observeThreadId: undefined, observeTurnId: turnId },
    { observeThreadId: null, observeTurnId: turnId },
    { observeThreadId: "thread/path", observeTurnId: turnId },
    { observeThreadId: "not-a-thread", observeTurnId: turnId },
    ...[
      "",
      " ",
      "turn later",
      "turn/path",
      "turn.path",
      "turn:1",
      "turn\n",
      "turn\0",
      "türn",
      "a".repeat(121),
      null,
      1,
    ].map((observeTurnId) => ({ observeThreadId: threadId, observeTurnId })),
  ])(
    "refuses malformed/partial reference identically in command/save %j",
    (reference) => {
      expect(
        ProductConfigurationCommandSchema.safeParse({
          ...command,
          ...reference,
        }).success,
      ).toBe(false);
      expect(
        CodexTaskSelectionSchema.safeParse({ ...saved, ...reference }).success,
      ).toBe(false);
    },
  );

  it("roundtrips exact IDs unchanged without normalizing or inventing proof", () => {
    const reference = { observeThreadId: threadId, observeTurnId: turnId };
    const selected = ProductConfigurationCommandSchema.parse({
      ...command,
      ...reference,
    });
    expect(selected).toMatchObject(reference);
    const stored = CodexTaskSelectionSchema.parse(
      JSON.parse(JSON.stringify({ ...saved, ...reference })),
    );
    expect(stored).toEqual({ ...saved, ...reference });
    for (const extra of [
      { latestTurn: true },
      { reference: { threadId, turnId } },
      { retained: true },
      { resultEvidence: "provider_history" },
    ]) {
      expect(
        ProductConfigurationCommandSchema.safeParse({
          ...command,
          ...reference,
          ...extra,
        }).success,
      ).toBe(false);
      expect(
        CodexTaskSelectionSchema.safeParse({ ...saved, ...reference, ...extra })
          .success,
      ).toBe(false);
    }
  });
});
