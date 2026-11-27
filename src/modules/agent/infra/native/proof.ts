import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function workspaceProof(
  input: Readonly<{
    assignmentId: string;
    authorityId: string;
    participantId: string;
  }>,
): string {
  return sha256(
    JSON.stringify([
      "farol-agent-workspace-probe-v1",
      input.assignmentId,
      input.authorityId,
      input.participantId,
    ]),
  );
}

export function computerProof(
  input: Readonly<{
    assignmentId: string;
    authorityId: string;
    participantId: string;
  }>,
): string {
  return sha256(
    JSON.stringify([
      "farol-agent-computer-v1",
      input.assignmentId,
      input.authorityId,
      input.participantId,
    ]),
  );
}
