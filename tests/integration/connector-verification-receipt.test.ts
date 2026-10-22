import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateConnectorVerificationRecorder,
  readConnectorVerificationReceipt,
} from "../../src/modules/computer/infra/mcp/connector-verification-receipt";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function receiptRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-connector-receipt-"),
  );
  roots.push(root);
  return path.join(root, "private");
}

describe("connector verification receipt", () => {
  it("does not create or repair a root during a bounded read-only probe", async () => {
    const root = await receiptRoot();
    await expect(
      readConnectorVerificationReceipt(root, { readOnly: true }),
    ).resolves.toBeNull();
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.mkdir(root, { mode: 0o700 });
    // Create the deliberately unsafe fixture explicitly: the caller's umask
    // may otherwise turn mkdir(0755) into a safe 0700 directory.
    await fs.chmod(root, 0o755);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
    await expect(
      readConnectorVerificationReceipt(root, { readOnly: true }),
    ).rejects.toThrow("CONNECTOR_VERIFICATION_RECEIPT_UNSAFE");
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
  });

  it("accepts one exact challenge and writes one content-free private receipt", async () => {
    const root = await receiptRoot();
    const challenge = "00000000-0000-4000-8000-000000000001";
    const challengeSha256 = createHash("sha256")
      .update(challenge)
      .digest("hex");
    const recorder = new PrivateConnectorVerificationRecorder(
      { root, challengeSha256 },
      { now: () => 1_789_516_800_000 },
    );

    expect(recorder.accepts(challenge)).toBe(true);
    expect(recorder.accepts("00000000-0000-4000-8000-000000000002")).toBe(
      false,
    );
    const recorded = await recorder.record({
      challenge,
      binding: {
        ownerId: "owner-desktop",
        sessionId: "session-route-a",
        taskId: "task-route-a",
        taskEpoch: 7,
        participantId: "main-route-a",
        turnId: "turn-route-a",
        generation: 7,
      },
      callId: "remote-call-123",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      entryCount: 4,
      truncated: false,
    });

    expect(recorded.receipt).toEqual({
      schema: 1,
      challengeSha256,
      ownerId: "owner-desktop",
      sessionId: "session-route-a",
      taskId: "task-route-a",
      taskEpoch: 7,
      participantId: "main-route-a",
      turnId: "turn-route-a",
      generation: 7,
      callIdSha256: createHash("sha256")
        .update("remote-call-123")
        .digest("hex"),
      workspaceId: "00000000-0000-4000-8000-000000000003",
      operation: "workspace.list",
      entryCount: 4,
      truncated: false,
      recordedAt: "2026-09-16T00:00:00.000Z",
    });
    expect(recorded.receiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readConnectorVerificationReceipt(root)).toEqual(
      recorded.receipt,
    );
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(root, "connector-verification-receipt.json")))
        .mode & 0o777,
    ).toBe(0o600);
    expect(JSON.stringify(recorded.receipt)).not.toMatch(
      /remote-call-123|Users\/|entry name/iu,
    );

    await expect(
      recorder.record({
        challenge,
        binding: {
          ownerId: "owner-desktop",
          sessionId: "session-route-a",
          taskId: "task-route-a",
          taskEpoch: 7,
          participantId: "main-route-a",
          turnId: "turn-route-a",
          generation: 7,
        },
        callId: "remote-call-456",
        workspaceId: "00000000-0000-4000-8000-000000000003",
        entryCount: 4,
        truncated: false,
      }),
    ).rejects.toThrow("CONNECTOR_VERIFICATION_ALREADY_RECORDED");
  });

  it("refuses a wrong challenge without creating a receipt", async () => {
    const root = await receiptRoot();
    const challenge = "00000000-0000-4000-8000-000000000001";
    const recorder = new PrivateConnectorVerificationRecorder({
      root,
      challengeSha256: createHash("sha256").update(challenge).digest("hex"),
    });

    await expect(
      recorder.record({
        challenge: "00000000-0000-4000-8000-000000000002",
        binding: {
          ownerId: "owner-desktop",
          sessionId: "session-route-a",
          taskId: "task-route-a",
          taskEpoch: 7,
          participantId: "main-route-a",
          turnId: "turn-route-a",
          generation: 7,
        },
        callId: "remote-call-123",
        workspaceId: "00000000-0000-4000-8000-000000000003",
        entryCount: 4,
        truncated: false,
      }),
    ).rejects.toThrow("CONNECTOR_VERIFICATION_CHALLENGE_MISMATCH");
    await expect(readConnectorVerificationReceipt(root)).resolves.toBeNull();
  });
});
