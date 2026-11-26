/** Closed classification for all observed result codes and outcome kinds.
 * Inventory is checked against TS contracts/producers and Go result owners by
 * operations-outcomes.test.ts. No suffix/substring inference runs in observers.
 * A code describes its own evidence; an explicit unknown or pending state still
 * dominates a known terminal code. Unlisted values are always unknown.
 */
import { doneCodes } from "./donecodes";
import { failedCodes } from "./failedcodes";
import { pendingCodes } from "./pendingcodes";
import { refusedChatCodes } from "./refusedchat";
import { refusedHostCodes } from "./refusedhost";
import { refusedTaskCodes } from "./refusedtask";
import { refusedUpdateCodes } from "./refusedupdate";
import { unknownCodes } from "./unknowncodes";

export const operationCodesByOutcome = {
  done: [...doneCodes],
  refused: [
    ...refusedChatCodes,
    ...refusedHostCodes,
    ...refusedUpdateCodes,
    ...refusedTaskCodes,
  ],
  failed: [...failedCodes],
  unknown: [...unknownCodes],
  pending: [...pendingCodes],
} as const;

export type OperationOutcome = keyof typeof operationCodesByOutcome;
export type OperationOutcomeCode =
  (typeof operationCodesByOutcome)[OperationOutcome][number];
const outcomes = new Map<string, OperationOutcome>(
  Object.entries(operationCodesByOutcome).flatMap(([outcome, codes]) =>
    codes.map((code) => [code, outcome as OperationOutcome] as const),
  ),
);
export function mappedOperationOutcome(
  value: unknown,
): OperationOutcome | undefined {
  return typeof value === "string" ? outcomes.get(value) : undefined;
}
export const mappedOperationCodes = Object.keys(
  Object.fromEntries(outcomes),
) as OperationOutcomeCode[];
