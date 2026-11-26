import { canonicalJson } from "../../../src/apps/desktop/codex-native-tool-registry";
import { currentCallEntry, outputText, turnKey } from "./identity";
import {
  bindingFingerprint,
  identityFromRequest,
  type ResponseRequest,
} from "./request";
import { record } from "./shape";

// Checks that the input of a continuation request replays every tool call the
// turn issued, byte for byte, and carries a bounded output for the pending
// one. It reads; the turn alone changes state.

type Issued = Readonly<{
  callId: string;
  itemId: string;
  name: string;
  namespace: string | null;
  encodedArguments: string;
  outputCanonical: string | null;
}>;

export type ContinuationTurn<T extends Issued> = Readonly<{
  key: string;
  tag: string;
  binding: string;
  issued: ReadonlyMap<string, T>;
  pending: T;
}>;

export function validateContinuation<T extends Issued>(
  data: ResponseRequest,
  turn: ContinuationTurn<T>,
): Readonly<{ callId: string; output: string; outputCanonical: string }> {
  if (turnKey(identityFromRequest(data)) !== turn.key) {
    throw new Error("FAROL_CONTINUATION_IDENTITY_INVALID");
  }
  if (bindingFingerprint(data) !== turn.binding) {
    throw new Error("FAROL_CONTINUATION_BINDING_INVALID");
  }
  if (!Array.isArray(data.input)) {
    throw new Error("FAROL_CONTINUATION_INPUT_INVALID");
  }
  const calls = new Map<string, Record<string, unknown>>();
  const outputs = new Map<string, Record<string, unknown>>();
  for (const item of data.input) {
    if (!currentCallEntry(item, turn.tag) || !record(item)) continue;
    const callId = String(item.call_id);
    const target = item.type === "function_call" ? calls : outputs;
    if (target.has(callId)) {
      throw new Error("FAROL_CONTINUATION_CARDINALITY_INVALID");
    }
    target.set(callId, item);
  }
  if (calls.size !== turn.issued.size || outputs.size !== turn.issued.size) {
    throw new Error("FAROL_CONTINUATION_CARDINALITY_INVALID");
  }
  let pendingOutput: string | null = null;
  let pendingCanonical: string | null = null;
  for (const [callId, issued] of turn.issued) {
    const call = calls.get(callId);
    const output = outputs.get(callId);
    if (
      !call ||
      !output ||
      call.id !== issued.itemId ||
      call.name !== issued.name ||
      call.arguments !== issued.encodedArguments ||
      (call.namespace ?? null) !== issued.namespace
    ) {
      throw new Error("FAROL_CONTINUATION_CALL_INVALID");
    }
    const normalized = outputText(output.output);
    if (normalized === null) {
      throw new Error("FAROL_CONTINUATION_OUTPUT_INVALID");
    }
    const canonical = canonicalJson(output.output);
    if (issued === turn.pending) {
      pendingOutput = normalized;
      pendingCanonical = canonical;
    } else if (issued.outputCanonical !== canonical) {
      throw new Error("FAROL_CONTINUATION_REPLAY_INVALID");
    }
  }
  if (pendingOutput === null || pendingCanonical === null) {
    throw new Error("FAROL_CONTINUATION_OUTPUT_INVALID");
  }
  return {
    callId: turn.pending.callId,
    output: pendingOutput,
    outputCanonical: pendingCanonical,
  };
}
