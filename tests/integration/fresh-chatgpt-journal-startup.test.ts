import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal";
import type { ChatGptTaskJournalRecord } from "../../src/apps/desktop/chatgpt-task-journal-record";

// Execute the actual main startup composition with the real private journal.
// Disposable files only: no Electron, Go runtime, provider or live recovery.
const main = await fs.readFile("src/apps/desktop/main.ts", "utf8");
const rootCall = main.indexOf("root: chatGptTaskJournalRoot()");
const start = main.lastIndexOf("  try {", rootCall);
const end = main.indexOf("  let chatGptInitialUrl", rootCall);
if (rootCall < 0 || start < 0 || end < 0)
  throw Error("CHATGPT_JOURNAL_STARTUP_COMPOSITION_MISSING");
const composition = main.slice(start, end);
const ackStart = main.indexOf('    case "chatgpt.ack-task-result": {');
const ackEnd = main.indexOf('    case "chatgpt.open-sign-in": {', ackStart);
if (ackStart < 0 || ackEnd < 0)
  throw Error("CHATGPT_JOURNAL_ACK_COMPOSITION_MISSING");
const acknowledgement = main.slice(ackStart, ackEnd);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-fresh-journal-"),
  );
  await fs.chmod(value, 0o700);
  roots.push(value);
  return value;
}
async function startup(directory: string, freshStartup = true) {
  const recordObservation = vi.fn(async () => ({ ok: true }));
  const state = (await vm.runInNewContext(
    `(async () => {
      let chatGptTaskJournal = null;
      let recoverableChatGptTask = null;
      let recoverableChatGptObservationPersisted = false;
      ${composition}
      return { journal: chatGptTaskJournal, retained: recoverableChatGptTask,
        observationPersisted: recoverableChatGptObservationPersisted,
        acknowledge: async (operationId) => {
          const command = { kind: "chatgpt.ack-task-result", operationId };
          switch (command.kind) { ${acknowledgement} }
        } };
    })()`,
    {
      PrivateChatGptTaskJournal,
      freshStartup,
      chatGptTaskJournalRoot: () => directory,
      configuration: { recordChatGptObservation: recordObservation },
      configurationFailure: (code: string) => ({ ok: false, code }),
      chatGptJournalObservation: (result: unknown) => result,
    },
  )) as {
    journal: PrivateChatGptTaskJournal | null;
    retained: ChatGptTaskJournalRecord | null;
    observationPersisted: boolean;
    acknowledge: (
      operationId: string,
    ) => Promise<{ ok: boolean; code: string }>;
  };
  return { ...state, recordObservation };
}

it.each([
  ["prepared", null],
  ["dispatch_intent", null],
  ["result_retained", "outcome_unknown"],
  ["result_retained", "completed"],
  ["delivery_acknowledged", "outcome_unknown"],
] as const)(
  "preserves historical %s / %s across two fresh starts",
  async (phase, state) => {
    const directory = await root();
    const file = path.join(directory, "chatgpt-task-journal.json");
    const record: ChatGptTaskJournalRecord = {
      schema: 1,
      operationId: randomUUID(),
      kind: "readonly",
      phase,
      createdAt: "2026-10-27T01:00:00.000Z",
      updatedAt: "2026-10-27T01:00:00.000Z",
      result:
        state === null
          ? null
          : {
              state,
              code:
                state === "outcome_unknown"
                  ? "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT"
                  : null,
              deltaCount: 0,
              observedCharacters: 0,
              attachmentCount: 0,
              totalBytes: 0,
              stagingCleanup: null,
            },
    };
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
    const before = await fs.stat(file, { bigint: true });
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      const fresh = await startup(directory);
      expect(await fresh.acknowledge(record.operationId)).toEqual({
        ok: false,
        code: "CHATGPT_TASK_JOURNAL_FAILED",
      });
      expect(await fs.readFile(file)).toEqual(bytes);
      const after = await fs.stat(file, { bigint: true });
      for (const key of ["ino", "size", "mtimeNs", "ctimeNs"] as const)
        expect(after[key]).toBe(before[key]);
      expect(fresh.journal).toBeNull();
      expect(fresh.retained).toBeNull();
      expect(fresh.observationPersisted).toBe(false);
      expect(fresh.recordObservation).not.toHaveBeenCalled();
    }
  },
);

it("keeps a new journal available for an explicit current operation when no history exists", async () => {
  const directory = await root();
  const fresh = await startup(directory);
  expect(fresh.journal).toBeInstanceOf(PrivateChatGptTaskJournal);
  const operationId = randomUUID();
  await fresh.journal!.prepare({ operationId, kind: "readonly" });
  expect(await fresh.journal!.load()).toMatchObject({
    operationId,
    phase: "prepared",
  });
  expect(fresh.recordObservation).not.toHaveBeenCalled();
});

it("retains the legacy restart reconciliation only on the nonfresh route", async () => {
  const directory = await root();
  const journal = new PrivateChatGptTaskJournal({ root: directory });
  const operationId = randomUUID();
  await journal.prepare({ operationId, kind: "readonly" });
  await journal.markDispatchIntent(operationId);
  const legacy = await startup(directory, false);
  expect(legacy.retained).toMatchObject({
    operationId,
    phase: "result_retained",
    result: { state: "outcome_unknown" },
  });
  expect(legacy.observationPersisted).toBe(true);
  expect(legacy.recordObservation).toHaveBeenCalledTimes(1);
});
