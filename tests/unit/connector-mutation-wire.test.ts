import { expect, it } from "vitest";
import { validate } from "../../apps/desktop/bridge/wire.ts";

// Canonical generated schema only. No peer, filesystem or provider calls.
it.each([0, 128, 129, 256, 257])(
  "keeps the declared edit limit separate from generic arrays at %i",
  (count) => {
    const edits = Array.from({ length: count }, () => ({
      oldText: "old",
      newText: "new",
    }));
    const request = {
      execution: {
        ownerId: "owner",
        sessionId: "session",
        taskId: "task",
        taskEpoch: "1",
        participantId: "participant",
        turnId: "turn",
        generation: "1",
      },
      callId: "call",
      workspaceId: "workspace",
      relativePath: "note.md",
      expectedSHA256: "a".repeat(64),
      edits,
    };
    expect(validate("ComputerConnectorEdit", request)).toBe(
      count > 0 && count <= 256,
    );
    expect(validate("ComputerTextEdit[]", edits)).toBe(count <= 128);
    expect(validate("ComputerConnectorEdit", request, 32)).toBe(false);
    if (count > 0 && count <= 256) {
      const malformed = {
        ...request,
        edits: [...edits.slice(1), { oldText: "", newText: "new" }],
      };
      expect(validate("ComputerConnectorEdit", malformed)).toBe(false);
    }
  },
);
