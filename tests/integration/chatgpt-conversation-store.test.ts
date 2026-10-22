import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateChatGptConversationStore } from "../../src/apps/desktop/chatgpt-conversation-store";

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
    path.join(os.tmpdir(), "farol-chatgpt-conversation-"),
  );
  roots.push(root);
  return root;
}

describe("private ChatGPT conversation store", () => {
  it("retains one content-free conversation binding across restart", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const store = new PrivateChatGptConversationStore(
      { root },
      { now: () => 1_000 },
    );
    await store.retain({
      operationId,
      conversationUrl:
        "https://chatgpt.com/c/12345678-abcd-4abc-8abc-123456789012",
    });

    const restarted = new PrivateChatGptConversationStore({ root });
    await expect(restarted.load()).resolves.toEqual({
      schema: 1,
      state: "retained",
      operationId,
      conversationUrl:
        "https://chatgpt.com/c/12345678-abcd-4abc-8abc-123456789012",
      reason: null,
      updatedAt: "1970-01-01T00:00:01.000Z",
    });
    const serialized = await fs.readFile(
      path.join(root, "chatgpt-conversation.json"),
      "utf8",
    );
    expect(serialized).not.toMatch(
      /prompt canary|answer canary|Bearer|cookie|token/iu,
    );
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(root, "chatgpt-conversation.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("persists an unresolved tombstone when the submitted chat URL is unknown", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const store = new PrivateChatGptConversationStore({ root });

    await store.markUnresolved(operationId);

    await expect(store.load()).resolves.toMatchObject({
      state: "unresolved",
      operationId,
      conversationUrl: null,
      reason: "CHATGPT_CONVERSATION_URL_UNAVAILABLE",
    });
  });

  it("clears only a safe private binding and preserves atomic prior state", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const stable = new PrivateChatGptConversationStore({ root });
    await stable.retain({
      operationId,
      conversationUrl: "https://chatgpt.com/c/12345678",
    });
    const interrupted = new PrivateChatGptConversationStore(
      { root },
      { beforeCommit: vi.fn().mockRejectedValue(new Error("disk full")) },
    );
    await expect(interrupted.markUnresolved(randomUUID())).rejects.toThrow(
      "disk full",
    );
    await expect(stable.load()).resolves.toMatchObject({
      state: "retained",
      operationId,
    });

    await stable.clear();
    await expect(stable.load()).resolves.toBeNull();
  });

  it("rejects symbolic-link state without touching its target", async () => {
    const root = await temporaryRoot();
    const stateRoot = path.join(root, "state");
    const outside = path.join(root, "outside.json");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    await fs.writeFile(outside, "preserve\n", { mode: 0o600 });
    await fs.symlink(
      outside,
      path.join(stateRoot, "chatgpt-conversation.json"),
    );
    const store = new PrivateChatGptConversationStore({ root: stateRoot });

    await expect(store.load()).rejects.toThrow(
      "CHATGPT_CONVERSATION_STATE_UNSAFE",
    );
    await expect(store.clear()).rejects.toThrow(
      "CHATGPT_CONVERSATION_STATE_UNSAFE",
    );
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("preserve\n");
  });
});
