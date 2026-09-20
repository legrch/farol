import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
import { MAX_CHATGPT_TASK_JOURNAL_BYTES } from "../../src/apps/desktop/chatgpt-task-journal-record";

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
    path.join(os.tmpdir(), "farol-next-chatgpt-journal-"),
  );
  roots.push(root);
  return root;
}

describe("private ChatGPT task journal", () => {
  it("turns a restart after dispatch intent into one retained unknown result", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    let now = 1_000;
    const first = new PrivateChatGptTaskJournal({ root }, { now: () => now });
    await first.prepare({ operationId, kind: "readonly" });
    now = 2_000;
    await first.markDispatchIntent(operationId);

    const restarted = new PrivateChatGptTaskJournal(
      { root },
      { now: () => 3_000 },
    );
    const recovered = await restarted.reconcileAfterRestart();

    expect(recovered).toMatchObject({
      operationId,
      kind: "readonly",
      phase: "result_retained",
      result: {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
        deltaCount: 0,
        observedCharacters: 0,
      },
    });
    await expect(
      restarted.prepare({ operationId: randomUUID(), kind: "attachment" }),
    ).rejects.toThrow("CHATGPT_TASK_JOURNAL_ACTIVE");
  });

  it("redelivers a retained result until the renderer acknowledges it", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const first = new PrivateChatGptTaskJournal({ root });
    await first.prepare({ operationId, kind: "attachment" });
    await first.markDispatchIntent(operationId);
    await first.retainResult(operationId, {
      state: "completed",
      code: null,
      deltaCount: 3,
      observedCharacters: 147,
      attachmentCount: 2,
      totalBytes: 95,
      stagingCleanup: "removed",
    });

    const restarted = new PrivateChatGptTaskJournal({ root });
    const recovered = await restarted.reconcileAfterRestart();
    expect(recovered).toMatchObject({
      operationId,
      phase: "result_retained",
      result: { state: "completed", attachmentCount: 2 },
    });
    await restarted.acknowledgeDelivery(operationId);
    await expect(restarted.reconcileAfterRestart()).resolves.toBeNull();

    const serialized = await fs.readFile(
      path.join(root, "chatgpt-task-journal.json"),
      "utf8",
    );
    expect(serialized).not.toMatch(
      /prompt canary|answer canary|\/Users\/private|Bearer|cookie|token/iu,
    );
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect(
      (await fs.stat(path.join(root, "chatgpt-task-journal.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("drops an unsubmitted prepared preview after restart", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const first = new PrivateChatGptTaskJournal({ root });
    await first.prepare({ operationId, kind: "readonly" });

    const restarted = new PrivateChatGptTaskJournal({ root });
    await expect(restarted.reconcileAfterRestart()).resolves.toBeNull();
    await expect(
      restarted.prepare({ operationId: randomUUID(), kind: "readonly" }),
    ).resolves.toBeUndefined();
  });

  it("preserves the prior phase when an atomic commit fails", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const stable = new PrivateChatGptTaskJournal({ root });
    await stable.prepare({ operationId, kind: "readonly" });
    const beforeCommit = vi.fn().mockRejectedValue(new Error("disk full"));
    const interrupted = new PrivateChatGptTaskJournal(
      { root },
      { beforeCommit },
    );

    await expect(interrupted.markDispatchIntent(operationId)).rejects.toThrow(
      "disk full",
    );
    const loaded = await stable.load();
    expect(loaded).toMatchObject({ phase: "prepared", operationId });
  });

  it("refuses a journal past its decode bound before parsing it, even when the padded content is a valid record", async () => {
    const root = await temporaryRoot();
    const operationId = randomUUID();
    const journal = new PrivateChatGptTaskJournal({ root });
    await journal.prepare({ operationId, kind: "readonly" });
    const statePath = path.join(root, "chatgpt-task-journal.json");
    const record = await fs.readFile(statePath, "utf8");
    const paddedTo = (bytes: number) =>
      `${" ".repeat(bytes - Buffer.byteLength(record))}${record}`;

    expect(MAX_CHATGPT_TASK_JOURNAL_BYTES).toBe(64 * 1_024);
    await fs.writeFile(statePath, paddedTo(65 * 1_024), { mode: 0o600 });
    await expect(journal.load()).rejects.toThrow(
      "CHATGPT_TASK_JOURNAL_CORRUPT",
    );
    await fs.writeFile(statePath, paddedTo(MAX_CHATGPT_TASK_JOURNAL_BYTES), {
      mode: 0o600,
    });
    await expect(journal.load()).resolves.toMatchObject({
      operationId,
      phase: "prepared",
    });
  });

  it("rejects a symbolic-link journal", async () => {
    const root = await temporaryRoot();
    const outside = path.join(root, "outside.json");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    await fs.writeFile(outside, "preserve\n", { mode: 0o600 });
    await fs.symlink(
      outside,
      path.join(stateRoot, "chatgpt-task-journal.json"),
    );
    const journal = new PrivateChatGptTaskJournal({ root: stateRoot });

    await expect(journal.load()).rejects.toThrow("CHATGPT_TASK_JOURNAL_UNSAFE");
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("preserve\n");
  });
});
