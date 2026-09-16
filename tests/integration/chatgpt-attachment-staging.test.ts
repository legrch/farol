import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_CHATGPT_ATTACHMENT_BYTES,
  cleanupChatGptAttachmentStaging,
  discardChatGptAttachments,
  stageChatGptAttachments,
  verifyStagedChatGptAttachments,
} from "../../src/apps/desktop/chatgpt-attachment-staging";

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
    path.join(os.tmpdir(), "farol-next-attachment-stage-"),
  );
  roots.push(root);
  return root;
}

describe("ChatGPT attachment staging", () => {
  it("copies exact image and text bytes into a private operation", async () => {
    const root = await temporaryRoot();
    const sources = path.join(root, "sources");
    const stagingRoot = path.join(root, "staging");
    await fs.mkdir(sources);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const text = Buffer.from("Bounded attachment fixture\n", "utf8");
    const imagePath = path.join(sources, "evidence.png");
    const textPath = path.join(sources, "notes.md");
    await fs.writeFile(imagePath, png, { mode: 0o644 });
    await fs.writeFile(textPath, text, { mode: 0o600 });
    const operationId = randomUUID();

    const staged = await stageChatGptAttachments({
      root: stagingRoot,
      operationId,
      paths: [imagePath, textPath],
    });

    expect(staged.attachments).toEqual([
      {
        name: "evidence.png",
        mimeType: "image/png",
        bytes: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
        stagedPath: path.join(stagingRoot, operationId, "evidence.png"),
      },
      {
        name: "notes.md",
        mimeType: "text/markdown",
        bytes: text.byteLength,
        sha256: createHash("sha256").update(text).digest("hex"),
        stagedPath: path.join(stagingRoot, operationId, "notes.md"),
      },
    ]);
    expect(await fs.readFile(staged.attachments[0]!.stagedPath)).toEqual(png);
    expect(await fs.readFile(staged.attachments[1]!.stagedPath)).toEqual(text);
    expect((await fs.stat(stagingRoot)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(stagingRoot, operationId))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await fs.stat(staged.attachments[0]!.stagedPath)).mode & 0o777,
    ).toBe(0o600);
    await expect(
      verifyStagedChatGptAttachments(staged),
    ).resolves.toBeUndefined();

    await fs.writeFile(staged.attachments[1]!.stagedPath, "changed\n");
    await expect(verifyStagedChatGptAttachments(staged)).rejects.toThrow(
      "ATTACHMENT_REFERENCE_CHANGED",
    );

    await discardChatGptAttachments(stagingRoot, operationId);
    await expect(
      fs.stat(path.join(stagingRoot, operationId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails explicitly when a staged reference disappears", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "source.txt");
    await fs.writeFile(source, "present\n", { mode: 0o600 });
    const staged = await stageChatGptAttachments({
      root: path.join(root, "staging"),
      operationId: randomUUID(),
      paths: [source],
    });
    await fs.rm(staged.attachments[0]!.stagedPath);

    await expect(verifyStagedChatGptAttachments(staged)).rejects.toThrow(
      "ATTACHMENT_REFERENCE_MISSING",
    );
  });

  it("rejects symlinks, unsupported bytes and oversized files", async () => {
    const root = await temporaryRoot();
    const stagingRoot = path.join(root, "staging");
    const textPath = path.join(root, "safe.txt");
    const linkPath = path.join(root, "linked.txt");
    const binaryPath = path.join(root, "opaque.bin");
    const oversizedPath = path.join(root, "oversized.txt");
    await fs.writeFile(textPath, "safe\n", { mode: 0o600 });
    await fs.symlink(textPath, linkPath);
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]), {
      mode: 0o600,
    });
    await fs.writeFile(oversizedPath, "x", { mode: 0o600 });
    await fs.truncate(oversizedPath, MAX_CHATGPT_ATTACHMENT_BYTES + 1);

    await expect(
      stageChatGptAttachments({
        root: stagingRoot,
        operationId: randomUUID(),
        paths: [linkPath],
      }),
    ).rejects.toThrow("ATTACHMENT_SOURCE_UNSAFE");
    await expect(
      stageChatGptAttachments({
        root: stagingRoot,
        operationId: randomUUID(),
        paths: [binaryPath],
      }),
    ).rejects.toThrow("ATTACHMENT_TYPE_UNSUPPORTED");
    await expect(
      stageChatGptAttachments({
        root: stagingRoot,
        operationId: randomUUID(),
        paths: [oversizedPath],
      }),
    ).rejects.toThrow("ATTACHMENT_TOO_LARGE");
  });

  it("removes a partial operation and only cleans UUID staging children", async () => {
    const root = await temporaryRoot();
    const stagingRoot = path.join(root, "staging");
    const safePath = path.join(root, "safe.txt");
    const binaryPath = path.join(root, "opaque.bin");
    await fs.writeFile(safePath, "safe\n", { mode: 0o600 });
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]), {
      mode: 0o600,
    });
    const failedOperation = randomUUID();

    await expect(
      stageChatGptAttachments({
        root: stagingRoot,
        operationId: failedOperation,
        paths: [safePath, binaryPath],
      }),
    ).rejects.toThrow("ATTACHMENT_TYPE_UNSUPPORTED");
    await expect(
      fs.stat(path.join(stagingRoot, failedOperation)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const staleOperation = randomUUID();
    await fs.mkdir(path.join(stagingRoot, staleOperation), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(
      path.join(stagingRoot, staleOperation, "stale.txt"),
      "stale\n",
    );
    await fs.writeFile(path.join(stagingRoot, "foreign-canary"), "keep\n");

    await cleanupChatGptAttachmentStaging(stagingRoot);

    await expect(
      fs.stat(path.join(stagingRoot, staleOperation)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(stagingRoot, "foreign-canary"), "utf8"),
    ).resolves.toBe("keep\n");
  });
});
