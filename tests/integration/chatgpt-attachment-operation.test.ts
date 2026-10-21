import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  discardChatGptAttachments,
  stageChatGptAttachments,
  verifyStagedChatGptAttachments,
  type StagedChatGptAttachments,
} from "../../src/apps/desktop/chatgpt-attachment-staging";

// The fourth "whole operation" continuity case, alongside
// context-continuity-operation.test.ts: attachment staging failing
// part-way, as an operation rather than a single function call. Every
// assertion here reads real, persisted filesystem state back through a
// fresh call or a freshly constructed object, never the value or thrown
// error the failing call itself produced, because a process that actually
// restarted would have nothing else to read from. The only seams used are
// ones the production code genuinely has: a real content-shape rejection
// (ATTACHMENT_DUPLICATE_NAME) that fires after real bytes already landed,
// and a real OS permission failure (chmod, not an fs mock) on the exact
// directory the code needs write access to in order to remove or reuse an
// operation. No hook was added to the module to make either possible.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-attachment-operation-"),
  );
  roots.push(root);
  return root;
}

describe("ChatGPT attachment staging as a whole operation", () => {
  it("removes every already-landed file when a later file in the same operation fails for a real reason, and lets a fresh attempt under the same operation id land correctly right after", async () => {
    const root = await temporaryRoot();
    const stagingRoot = path.join(root, "staging");
    const sourcesA = path.join(root, "sources-a");
    const sourcesB = path.join(root, "sources-b");
    await fs.mkdir(sourcesA);
    await fs.mkdir(sourcesB);

    // Two distinct files that will really land on disk, then a third
    // whose basename collides with the first: a genuine
    // ATTACHMENT_DUPLICATE_NAME the code already guards, not a seam
    // invented for this test.
    const first = path.join(sourcesA, "brief.txt");
    const second = path.join(sourcesA, "notes.md");
    const colliding = path.join(sourcesB, "brief.txt");
    await fs.writeFile(first, "First landed file.\n", { mode: 0o600 });
    await fs.writeFile(second, "Second landed file.\n", { mode: 0o600 });
    await fs.writeFile(colliding, "Different bytes, same name.\n", {
      mode: 0o600,
    });

    const operationId = randomUUID();
    const operationRoot = path.join(stagingRoot, operationId);

    await expect(
      stageChatGptAttachments({
        root: stagingRoot,
        operationId,
        paths: [first, second, colliding],
      }),
    ).rejects.toThrow("ATTACHMENT_DUPLICATE_NAME");

    // Fresh reads of the real directory, not the thrown error and not a
    // return value (there is none): the two files that genuinely landed
    // before the third one failed must be gone too, for that task.
    await expect(fs.stat(operationRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readdir(stagingRoot)).resolves.toEqual([]);

    // The failed attempt does not poison the operation id: a fresh call
    // that still carries it stages the two valid files correctly.
    const retried = await stageChatGptAttachments({
      root: stagingRoot,
      operationId,
      paths: [first, second],
    });
    expect(retried.attachments.map((attachment) => attachment.name)).toEqual([
      "brief.txt",
      "notes.md",
    ]);

    // Independent verification: read the bytes back from disk directly
    // and recompute their digests, rather than trusting the object the
    // call that wrote them handed back.
    for (const [source, attachment] of [
      [first, retried.attachments[0]!],
      [second, retried.attachments[1]!],
    ] as const) {
      const expectedBytes = await fs.readFile(source);
      const onDisk = await fs.readFile(attachment.stagedPath);
      expect(onDisk).toEqual(expectedBytes);
      expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
        attachment.sha256,
      );
    }
  }, 30_000);

  it("records an operation whose discard could not be completed as unresolved on disk, refuses to silently replay it under the same id, and still lands a genuinely new attempt", async () => {
    const root = await temporaryRoot();
    const stagingRoot = path.join(root, "staging");
    const sources = path.join(root, "sources");
    await fs.mkdir(sources);
    const sourcePath = path.join(sources, "receipt.txt");
    await fs.writeFile(sourcePath, "Receipt contents.\n", { mode: 0o600 });

    const operationId = randomUUID();
    const operationRoot = path.join(stagingRoot, operationId);
    const staged = await stageChatGptAttachments({
      root: stagingRoot,
      operationId,
      paths: [sourcePath],
    });
    const expectedBytes = await fs.readFile(sourcePath);

    // The real seam: removing a file requires write+execute on the
    // directory that holds it. Revoke exactly that permission on the
    // operation directory itself — no fs mock, no test-only hook — so the
    // caller's own cleanup call hits a genuine OS permission failure
    // instead of finishing either way.
    await fs.chmod(operationRoot, 0o500);
    try {
      await expect(
        discardChatGptAttachments(stagingRoot, operationId),
      ).rejects.toMatchObject({ code: "EACCES" });

      // Whether the copy was actually removed is exactly what that failed
      // discard leaves unknown to a caller that only looked at the thrown
      // error. Read the real, persisted directory contents through a
      // fresh fs call, and re-verify through a newly constructed object
      // (not the one `stageChatGptAttachments` returned): the file is
      // still there, byte for byte, so it must not be treated as gone.
      const survivingBytes = await fs.readFile(
        staged.attachments[0]!.stagedPath,
      );
      expect(survivingBytes).toEqual(expectedBytes);
      const freshView: StagedChatGptAttachments = {
        operationId,
        attachments: [{ ...staged.attachments[0]! }],
      };
      await expect(
        verifyStagedChatGptAttachments(freshView),
      ).resolves.toBeUndefined();

      // The unresolved operation id must never be silently reused: a
      // fresh staging call carrying the same id is refused outright,
      // because its directory still exists and still holds state whose
      // discard never confirmed as completed.
      await expect(
        stageChatGptAttachments({
          root: stagingRoot,
          operationId,
          paths: [sourcePath],
        }),
      ).rejects.toThrow("ATTACHMENT_OPERATION_CONFLICT");

      // The only sanctioned way forward is an explicit new attempt under
      // a new id, landing independently of the stuck one.
      const nextOperationId = randomUUID();
      const retried = await stageChatGptAttachments({
        root: stagingRoot,
        operationId: nextOperationId,
        paths: [sourcePath],
      });
      expect(retried.operationId).toBe(nextOperationId);
      const freshBytes = await fs.readFile(retried.attachments[0]!.stagedPath);
      expect(freshBytes).toEqual(expectedBytes);

      // The stuck operation is exactly as it was: unresolved, never
      // silently folded into the new attempt and never silently discarded
      // by it either.
      const stillStuckBytes = await fs.readFile(
        staged.attachments[0]!.stagedPath,
      );
      expect(stillStuckBytes).toEqual(expectedBytes);
    } finally {
      // Restore permissions so the real cleanup code — and this suite's
      // own afterEach — can actually remove the fixture.
      await fs.chmod(operationRoot, 0o700);
    }
  }, 30_000);
});
