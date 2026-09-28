import { expect, it } from "vitest";
import { observeClaudePrint } from "../../src/modules/chat/domain/claude-print-stream";
const expected = {
  sessionId: "019b0000-0000-4000-8000-000000000020",
  cwd: "/fixture/writer",
  model: "fixture-model",
};
const init = {
  type: "system",
  subtype: "init",
  session_id: expected.sessionId,
  cwd: expected.cwd,
  model: expected.model,
  permissionMode: "default",
};
const result = {
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: expected.sessionId,
  result: "Done",
  permission_denials: [],
};
const text = (...events: unknown[]) =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";
it.each(["assistant", "user", "stream_event", "system", "rate_limit_event"])(
  "bounded %s event can be omitted before result",
  (type) => {
    expect(
      observeClaudePrint(
        text(init, { type, session_id: expected.sessionId }, result),
        expected,
        true,
      ),
    ).toMatchObject({ result: { lifecycle: "completed", text: "Done" } });
  },
);
it("partial in-flight final line is not a terminal result", () => {
  expect(observeClaudePrint(text(init) + '{"type":', expected, false)).toEqual({
    model: expected.model,
    result: null,
  });
  expect(
    observeClaudePrint(text(init) + '{"type":', expected, true),
  ).toBeNull();
});
it.each([
  null,
  [],
  0,
  "event",
  {},
  { type: "foreign" },
  { type: "assistant", session_id: "foreign" },
  init,
])("malformed/foreign/duplicate event %j fails closed", (event) => {
  expect(observeClaudePrint(text(init, event), expected, true)).toBeNull();
});
it.each([
  { session_id: "foreign" },
  { is_error: "false" },
  { subtype: null },
  { permission_denials: null },
  { permission_denials: [null] },
  { permission_denials: Array(51).fill({}) },
  { result: 42 },
  { result: "\0" },
  { result: "🧭".repeat(8193) },
  { subtype: "future_success" },
  { is_error: true, subtype: "future_error" },
])("invalid result %j is unknown", (change) => {
  expect(
    observeClaudePrint(text(init, { ...result, ...change }), expected, true),
  ).toBeNull();
});
it.each([
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
])("%s is failure, no false completed or billing proof", (subtype) => {
  const { result: _unused, ...withoutText } = result;
  expect(
    observeClaudePrint(
      text(init, { ...withoutText, is_error: true, subtype }),
      expected,
      true,
    ),
  ).toMatchObject({ result: { lifecycle: "failed", text: "" } });
});
it("NUL, oversized stream, blank or malformed frames, uninitialized result refuse", () => {
  for (const value of [
    "\0",
    "x".repeat(65537),
    "\n",
    "bad\n",
    text(result),
    text(init, result, { type: "assistant" }),
  ])
    expect(observeClaudePrint(value, expected, true)).toBeNull();
});
