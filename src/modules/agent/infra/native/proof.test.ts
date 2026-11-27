import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { computerProof, sha256, workspaceProof } from "./proof";

const ids = {
  assignmentId: "assignment-a",
  authorityId: "authority-a",
  participantId: "participant-a",
};

describe("native agent proofs", () => {
  it("hashes to lowercase hex sha256", () => {
    expect(sha256("abc")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
  });

  it("binds each proof to its domain label and identifiers", () => {
    expect(workspaceProof(ids)).toBe(
      sha256(
        JSON.stringify([
          "farol-agent-workspace-probe-v1",
          "assignment-a",
          "authority-a",
          "participant-a",
        ]),
      ),
    );
    expect(computerProof(ids)).toBe(
      sha256(
        JSON.stringify([
          "farol-agent-computer-v1",
          "assignment-a",
          "authority-a",
          "participant-a",
        ]),
      ),
    );
    expect(workspaceProof(ids)).not.toBe(computerProof(ids));
    expect(workspaceProof({ ...ids, participantId: "other" })).not.toBe(
      workspaceProof(ids),
    );
  });
});
