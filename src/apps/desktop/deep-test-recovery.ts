import {
  PrivateChatGptTaskJournal,
  type ChatGptTaskJournalRecord,
} from "./chatgpt-task-journal";
import { readFlatDeepTestRecords } from "./legacy-activation-obligations";

/** Reconcile only this feature's own named attempts, never the legacy journal. */
export async function recoverDeepTestAttempts(
  root: string,
  underLease: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<readonly ChatGptTaskJournalRecord[]> {
  const scan = await readFlatDeepTestRecords(root);
  if (scan.status === "unreadable")
    throw new Error("DEEP_TEST_RECOVERY_UNAVAILABLE");
  if (scan.status === "absent") return [];
  const outstanding: ChatGptTaskJournalRecord[] = [];
  for (const record of scan.value) {
    if (record.phase === "delivery_acknowledged") continue;
    const journal = new PrivateChatGptTaskJournal({
      root,
      deepTestOperationId: record.operationId,
    });
    const recovered = await underLease(() => journal.reconcileAfterRestart());
    if (recovered) outstanding.push(recovered);
  }
  return outstanding;
}
