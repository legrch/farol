import { describe, expect, it } from "vitest";

import { savedChatPreviewQualified } from "../../src/apps/desktop/saved-chat-preview-admission";

const ready = {
  environment: "dev",
  ownerOptIn: "1",
  outcomeUnknown: false,
  partition: "persist:farol-dev-chatgpt",
  buildId: "a".repeat(64),
  verification: {
    profile: "chatgpt.next-partition/1",
    runtimeGeneration: `persist:farol-dev-chatgpt:${"a".repeat(64)}`,
    buildId: "a".repeat(64),
    protocol: "chatgpt-page-readiness/1",
  },
};

describe("saved-chat preview publication", () => {
  it("requires explicit owner opt-in and a current verified Next account route", () => {
    expect(savedChatPreviewQualified(ready)).toBe(true);
    expect(
      savedChatPreviewQualified({ ...ready, environment: "preview" }),
    ).toBe(true);
    for (const invalid of [
      { ownerOptIn: undefined },
      { ownerOptIn: "true" },
      { environment: "other" },
      { outcomeUnknown: true },
      { verification: null },
      { verification: { ...ready.verification, buildId: "b".repeat(64) } },
      { verification: { ...ready.verification, runtimeGeneration: "old" } },
      {
        verification: {
          ...ready.verification,
          protocol: "chatgpt-page-task-recovery/1",
        },
      },
    ]) {
      expect(savedChatPreviewQualified({ ...ready, ...invalid })).toBe(false);
    }
  });
});
