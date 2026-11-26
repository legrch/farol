import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { PublicTurnFrameSchema } from "../../../src/apps/desktop/chatgpt-public-turn";
import type {
  PhysicalBinding,
  PhysicalCorrelation,
  PhysicalFailure,
  PhysicalPrevious,
  PhysicalSelection,
} from "../chatgpt-physical-api";
import type { observedSchema } from "./request";

type Frame = z.infer<typeof PublicTurnFrameSchema>;

export const same = isDeepStrictEqual;

export const refuse = (reason: string): PhysicalFailure => ({
  state: "refused",
  code: reason,
});

export const unknown = (reason: string): PhysicalFailure => ({
  state: "unknown",
  code: reason,
});

export const sameView = (a: PhysicalBinding, b: PhysicalBinding): boolean =>
  a.viewId === b.viewId &&
  a.viewGeneration === b.viewGeneration &&
  a.documentGeneration === b.documentGeneration &&
  a.partition === b.partition;

/** Observed labels must equal the declared controls; unknown only when optional. */
export const selectionMatches = (
  selection: PhysicalSelection,
  observed: z.infer<typeof observedSchema>,
): boolean => {
  const expected = [
    selection.controls.modelLabel,
    selection.controls.effortLabel,
    selection.controls.modeLabel,
    selection.controls.connector?.label ?? null,
  ];
  const facts = [
    observed.modelLabel,
    observed.effortLabel,
    observed.modeLabel,
    observed.connectorLabel,
  ];
  const required = [
    true,
    selection.requiredControls.effort,
    selection.requiredControls.mode,
    selection.requiredControls.connector,
  ];
  return facts.every((fact, n) =>
    fact.state === "observed"
      ? expected[n] !== null && fact.value === expected[n]
      : !required[n],
  );
};

export const fullTerminal = (frame: Frame): boolean =>
  frame.terminal &&
  frame.messages.length > 0 &&
  frame.messages.at(-1)?.channel === "answer" &&
  frame.messages.every(
    (message) =>
      message.complete &&
      message.text !== null &&
      (message.segments === undefined ||
        message.segments.every(
          (segment) => segment.complete && segment.text !== null,
        )),
  );

export type CorrelationBasis = Readonly<{
  correlation: PhysicalCorrelation;
  baselineUserIds: readonly string[];
  previous: PhysicalPrevious;
}>;

/** Whether a new correlation and frame extend the already adopted identity. */
export const validCorrelation = (
  basis: CorrelationBasis,
  correlation: PhysicalCorrelation,
  frame: Frame | null,
): boolean => {
  if (
    basis.correlation.userTurnId !== null &&
    correlation.userTurnId !== basis.correlation.userTurnId
  )
    return false;
  if (
    basis.correlation.replyId !== null &&
    correlation.replyId !== basis.correlation.replyId
  )
    return false;
  if (
    correlation.userTurnId !== null &&
    (basis.baselineUserIds.includes(correlation.userTurnId) ||
      correlation.userTurnId === basis.previous?.userTurnId)
  )
    return false;
  if (
    correlation.replyId !== null &&
    (correlation.userTurnId === null ||
      correlation.replyId === basis.previous?.replyId)
  )
    return false;
  if (
    frame &&
    (frame.userId !== correlation.userTurnId ||
      frame.messages[0]?.id !== correlation.replyId ||
      correlation.userTurnId === null ||
      correlation.replyId === null)
  )
    return false;
  if (frame) {
    const parents = new Set([frame.userId]);
    for (const message of frame.messages) {
      if (
        parents.has(message.id) ||
        (message.parentId !== null &&
          message.parentId !== undefined &&
          !parents.has(message.parentId))
      )
        return false;
      parents.add(message.id);
    }
    if (frame.terminal && !fullTerminal(frame)) return false;
  }
  return frame !== null || correlation.replyId === null;
};
