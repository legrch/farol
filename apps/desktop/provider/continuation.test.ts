import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/apps/desktop/codex-native-tool-registry";
import { validateContinuation } from "./continuation";
import { currentCallPrefix, turnKey, turnTag } from "./identity";
import { bindingFingerprint, responseRequestSchema } from "./request";

const identity = {
  sessionId: "s",
  threadId: "t",
  turnId: "u",
  rootTurnId: "r",
};
const tag = turnTag(identity);
const callId = `${currentCallPrefix(tag)}${"1".repeat(16)}`;

function request(input: unknown[], model = "m") {
  return responseRequestSchema.parse({
    model,
    stream: true,
    input,
    tools: [],
    client_metadata: {
      session_id: "s",
      thread_id: "t",
      turn_id: "u",
      root_turn_id: "r",
    },
  });
}

function issued(outputCanonical: string | null = null) {
  return {
    callId,
    itemId: "fc_1",
    name: "tool",
    namespace: null,
    encodedArguments: "{}",
    outputCanonical,
  };
}

function turn(call = issued()) {
  return {
    key: turnKey(identity),
    tag,
    binding: bindingFingerprint(request([])),
    issued: new Map([[callId, call]]),
    pending: call,
  };
}

const replay = [
  {
    type: "function_call",
    call_id: callId,
    id: "fc_1",
    name: "tool",
    arguments: "{}",
  },
  { type: "function_call_output", call_id: callId, output: "done" },
];

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return "none";
}

describe("provider continuation", () => {
  it("returns the pending call's output and its canonical form", () => {
    expect(validateContinuation(request(replay), turn())).toEqual({
      callId,
      output: "done",
      outputCanonical: canonicalJson("done"),
    });
  });

  it("refuses a different model binding", () => {
    expect(code(() => validateContinuation(request(replay, "n"), turn()))).toBe(
      "FAROL_CONTINUATION_BINDING_INVALID",
    );
  });

  it("refuses a missing output or a duplicated call", () => {
    expect(
      code(() => validateContinuation(request(replay.slice(0, 1)), turn())),
    ).toBe("FAROL_CONTINUATION_CARDINALITY_INVALID");
    expect(
      code(() => validateContinuation(request([...replay, replay[0]]), turn())),
    ).toBe("FAROL_CONTINUATION_CARDINALITY_INVALID");
  });

  it("refuses a call that differs from the one issued", () => {
    const altered = [{ ...replay[0], name: "other" }, replay[1]];
    expect(code(() => validateContinuation(request(altered), turn()))).toBe(
      "FAROL_CONTINUATION_CALL_INVALID",
    );
  });

  it("refuses an output that is not bounded text", () => {
    const altered = [replay[0], { ...replay[1], output: 5 }];
    expect(code(() => validateContinuation(request(altered), turn()))).toBe(
      "FAROL_CONTINUATION_OUTPUT_INVALID",
    );
  });

  it("refuses a replay whose earlier output changed", () => {
    const earlier = {
      ...issued(canonicalJson("before")),
      callId: `${currentCallPrefix(tag)}${"2".repeat(16)}`,
    };
    const pending = issued();
    const both = {
      ...turn(pending),
      issued: new Map([
        [earlier.callId, earlier],
        [callId, pending],
      ]),
    };
    const input = [
      { ...replay[0], call_id: earlier.callId },
      { ...replay[1], call_id: earlier.callId, output: "after" },
      ...replay,
    ];
    expect(code(() => validateContinuation(request(input), both))).toBe(
      "FAROL_CONTINUATION_REPLAY_INVALID",
    );
  });
});
