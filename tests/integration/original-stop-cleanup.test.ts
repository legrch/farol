import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_VERIFICATION_RECEIPT_BASENAME,
  clearAndConfirmOriginalConnectorVerificationReceipt,
  readConnectorVerificationReceipt,
} from "../../src/modules/computer/infra/mcp/connector-verification-receipt";

const parents = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;
const cleanupId = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function privateRoot() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-original-stop-cleanup-"),
  );
  roots.push(root);
  return root;
}

describe("original connector verification receipt cleanup: native readback", () => {
  it("qualifies known-absent receipt using the retained private directory, not a boolean", async () => {
    const root = await privateRoot();
    const proof = await clearAndConfirmOriginalConnectorVerificationReceipt(
      root,
      parents[0],
      cleanupId,
    );
    expect(proof).toMatchObject({
      parentOperationId: parents[0],
      effectId: cleanupId,
      priorReceiptDigest: null,
      readback: "verified-absent",
    });
    expect(proof.rootDevice).toMatch(/^[0-9]+$/u);
    expect(proof.rootInode).toMatch(/^[0-9]+$/u);
    expect(proof.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await readConnectorVerificationReceipt(root, { readOnly: true }),
    ).toBeNull();
  });

  it("removes a valid original receipt, fsyncs and separately confirms absence", async () => {
    const root = await privateRoot();
    const receipt = {
      schema: 1,
      challengeSha256: "a".repeat(64),
      callIdSha256: "b".repeat(64),
      workspaceId: "workspace",
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "participant",
      turnId: "turn",
      generation: 1,
      operation: "workspace.list",
      entryCount: 1,
      truncated: false,
      recordedAt: "2026-11-11T00:00:00.000Z",
    };
    const target = path.join(root, CONNECTOR_VERIFICATION_RECEIPT_BASENAME);
    await fs.writeFile(target, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    expect(
      await readConnectorVerificationReceipt(root, { readOnly: true }),
    ).not.toBeNull();
    const proof = await clearAndConfirmOriginalConnectorVerificationReceipt(
      root,
      parents[0],
      cleanupId,
    );
    expect(proof.priorReceiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.readback).toBe("verified-absent");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readConnectorVerificationReceipt(root, { readOnly: true }),
    ).toBeNull();
    // Parent identity is included in the original readback digest.
    const next = await clearAndConfirmOriginalConnectorVerificationReceipt(
      root,
      parents[1],
      cleanupId,
    );
    expect(next.digest).not.toBe(proof.digest);
  });

  it("does not clear an unreadable or corrupt source to synthesize success", async () => {
    const root = await privateRoot();
    const target = path.join(root, CONNECTOR_VERIFICATION_RECEIPT_BASENAME);
    await fs.writeFile(target, "{broken", { mode: 0o600 });
    await expect(
      clearAndConfirmOriginalConnectorVerificationReceipt(
        root,
        parents[0],
        cleanupId,
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("{broken");
  });

  it("rejects a symlinked receipt rather than deleting someone else's file", async () => {
    const root = await privateRoot();
    const external = path.join(root, "original");
    await fs.writeFile(external, "external", { mode: 0o600 });
    await fs.symlink(
      external,
      path.join(root, CONNECTOR_VERIFICATION_RECEIPT_BASENAME),
    );
    await expect(
      clearAndConfirmOriginalConnectorVerificationReceipt(
        root,
        parents[0],
        cleanupId,
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("external");
  });

  it("rejects malformed effect identities without a cleanup effect", async () => {
    const root = await privateRoot();
    await expect(
      clearAndConfirmOriginalConnectorVerificationReceipt(
        root,
        "wrong-parent",
        cleanupId,
      ),
    ).rejects.toThrow();
    await expect(
      clearAndConfirmOriginalConnectorVerificationReceipt(
        root,
        parents[0],
        "bad-effect",
      ),
    ).rejects.toThrow();
  });
});
