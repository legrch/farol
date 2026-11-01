import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
import { recoverDeepTestAttempts } from "../../src/apps/desktop/deep-test-recovery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
it("recovers only new flat attempts, preserving old records and unknown outcomes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-deep-test-"));
  roots.push(root);
  const legacy = new PrivateChatGptTaskJournal({ root });
  await legacy.prepare({ operationId: randomUUID(), kind: "readonly" });
  const oldBytes = await fs.readFile(
    path.join(root, "chatgpt-task-journal.json"),
  );
  const id = randomUUID();
  const current = new PrivateChatGptTaskJournal({
    root,
    deepTestOperationId: id,
  });
  await current.prepare({ operationId: id, kind: "readonly" });
  await current.markDispatchIntent(id);
  let leaseCalls = 0;
  const lease = async <T>(work: () => Promise<T>): Promise<T> => {
    leaseCalls++;
    return work();
  };
  expect(await recoverDeepTestAttempts(root, lease)).toMatchObject([
    {
      operationId: id,
      result: {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
      },
    },
  ]);
  expect(leaseCalls).toBe(1);
  expect(
    await fs.readFile(path.join(root, "chatgpt-task-journal.json")),
  ).toEqual(oldBytes);
  const before = await fs.readFile(path.join(root, `deep-test-${id}.json`));
  expect(await recoverDeepTestAttempts(root, lease)).toHaveLength(1);
  expect(await fs.readFile(path.join(root, `deep-test-${id}.json`))).toEqual(
    before,
  );
});
