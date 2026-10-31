import { expect, it, vi } from "vitest";
import {
  operationCodesByOutcome,
  mappedOperationOutcome,
  type OperationOutcomeCode,
} from "../../apps/desktop/renderer/operation-outcomes";
import {
  operationResult,
  observeOperation,
} from "../../apps/desktop/operations/observe";
import { createTotalOperationsRecorder } from "../../apps/desktop/operations/recorder";
import { recordedModelTurn } from "../../apps/desktop/operations/model-turn";
import { declaredOperationOutcomes } from "./operations-outcome-inventory";
import type { ProductConfigurationResult } from "../../src/pkg/product-settings/contract";
import type { ProductTaskCommandResult } from "../../src/modules/chat/contract/product-task";
import type { ReadonlyComputerCallResponse } from "../../src/modules/computer/contract/readonly-computer-contract";
import type { MutableComputerCallResponse } from "../../src/modules/computer/contract/mutable-computer-contract";
import type { BackendLifecycleObservation } from "../../apps/desktop/bridge/client";

type Mapped<T> = Exclude<T, OperationOutcomeCode> extends never ? true : false;
// Compiler coverage comes from the actual inferred contracts, including enums
// imported from other files, rather than depending only on literal extraction.
const closedContractCoverage: [
  Mapped<BackendLifecycleObservation["code"]>,
  Mapped<Extract<ProductConfigurationResult, { ok: false }>["error"]>,
  Mapped<Extract<ProductTaskCommandResult, { ok: false }>["error"]>,
  Mapped<Extract<ReadonlyComputerCallResponse, { ok: false }>["error"]["code"]>,
  Mapped<Extract<MutableComputerCallResponse, { ok: false }>["error"]["code"]>,
] = [true, true, true, true, true];

const metadata = { source: "You", kind: "general.update", target: {} } as const;

it.each([
  "PROCESS_PREPARATION_DEADLINE",
  "PROCESS_PREPARATION_SCOPE_REFUSED",
  "PROCESS_PREPARATION_POLICY_MISMATCH",
  "PROCESS_PREPARATION_AUTHORIZATION_CHANGED",
  "PROCESS_CONTROL_LIFETIME_MISMATCH",
  "UPDATE_HELPER_LIFETIME_UNAVAILABLE",
  "helper_lifetime_unavailable",
])("records known preparation refusal %s without promoting UNKNOWN", (code) => {
  expect(operationResult({ status: "refused", code })).toEqual({
    outcome: "refused",
    code,
  });
  expect(operationResult({ status: "outcome_unknown", code })).toEqual({
    outcome: "unknown",
    code,
  });
  expect(operationResult({ status: "unknown", code })).toEqual({
    outcome: "unknown",
    code,
  });
});

it("observes a preparation refusal without altering the original reply", async () => {
  const record = vi.fn();
  const reply = {
    status: "refused",
    error: { code: "PROCESS_PREPARATION_DEADLINE" },
  };
  const original = Promise.resolve(reply);
  expect(
    observeOperation(
      { record },
      { ...metadata, kind: "computer_shell_start" },
      () => original,
    ),
  ).toBe(original);
  expect(await original).toBe(reply);
  expect(record.mock.calls[0]?.slice(1, 3)).toEqual([
    "refused",
    "PROCESS_PREPARATION_DEADLINE",
  ]);
});

it.each([
  ["computer_shell_read", { state: "running" }],
  ["computer_shell_cancel", { status: "requested" }],
] as const)(
  "records a completed %s observation without claiming command completion",
  async (kind, data) => {
    const record = vi.fn();
    const value = { status: "ok", data };
    const original = Promise.resolve(value);
    expect(
      observeOperation({ record }, { ...metadata, kind }, () => original),
    ).toBe(original);
    expect(await original).toBe(value);
    expect(record.mock.calls[0]?.[1]).toBe("done");
    expect(operationResult(value).outcome).toBe("pending");
    const unknown = Promise.resolve({
      ...value,
      code: "PROCESS_OUTCOME_UNKNOWN",
    });
    await observeOperation({ record }, { ...metadata, kind }, () => unknown);
    expect(record.mock.calls.at(-1)?.[1]).toBe("unknown");
  },
);

it("does not turn a rejected promise carrying a success code into done", async () => {
  const record = vi.fn();
  const error = { kind: "completed", code: "PHYSICAL_SEND_ACKNOWLEDGED" };
  const original = Promise.reject(error);
  expect(observeOperation({ record }, metadata, () => original)).toBe(original);
  await expect(original).rejects.toBe(error);
  expect(record.mock.calls[0]!.slice(1, 3)).toEqual([
    "unknown",
    "PHYSICAL_SEND_ACKNOWLEDGED",
  ]);
});

it.each([0, 1, 999, NaN, Infinity, 200.5])(
  "does not interpret an invalid numeric status %s as HTTP success",
  (status) => {
    expect(operationResult({ status })).toEqual({
      outcome: "unknown",
      code: "OPERATION_CODE_UNMAPPED",
    });
  },
);

it("counts lost unknown observations after normalizing an unlisted code", async () => {
  const recorder = createTotalOperationsRecorder({
    record: () => Promise.reject(Error("disk unavailable")),
  });
  recorder.record(metadata, "done", "UNLISTED_RESULT_CODE", 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(recorder.diagnostics()).toEqual({
    unmappedCodes: 1,
    writeFailures: 1,
    droppedEntries: 1,
    unrecordedUncertainEntries: 1,
  });
});

it("cannot complete a model turn after conflicting terminal frames or a lost stream", async () => {
  const record = vi.fn();
  const recorder = createTotalOperationsRecorder({ record });
  const frames = [
    { event: "response.failed", data: { error: "UNLISTED_FRAME_CODE" } },
    { event: "response.completed", data: {} },
  ];
  await recordedModelTurn(recorder, async () => ({ ok: true, events: frames }))(
    { body: {}, headers: {} },
  );
  const original = Error("opaque stream failure");
  const result = await recordedModelTurn(recorder, async () => ({
    ok: true,
    stream: (async function* () {
      yield frames[1]!;
      throw original;
    })(),
  }))({ body: {}, headers: {} });
  if (!result.ok || !("stream" in result)) throw Error("fixture");
  const consume = async () => {
    for await (const frame of result.stream) expect(frame).toBe(frames[1]);
  };
  await expect(consume()).rejects.toBe(original);
  expect(
    record.mock.calls.map(([, outcome, code]) => ({ outcome, code })),
  ).toEqual([
    { outcome: "unknown", code: "OPERATION_CODE_UNMAPPED" },
    { outcome: "unknown", code: "MODEL_TERMINAL_UNCONFIRMED" },
  ]);
  expect(recorder.diagnostics().unmappedCodes).toBe(1);
});

it("maps every declared TS contract/producer code and Go result kind exactly once", () => {
  expect(closedContractCoverage).toEqual([true, true, true, true, true]);
  const declared = declaredOperationOutcomes();
  const entries = Object.values(operationCodesByOutcome).flat();
  expect(new Set(entries).size).toBe(entries.length);
  const unmapped = [...declared].filter(
    ([code]) => mappedOperationOutcome(code) === undefined,
  );
  expect(
    unmapped.map(([code, sources]) => ({ code, sources: [...sources] })),
  ).toEqual([]);
  // Ensure the inventory reaches each required owner, rather than testing the
  // mapping against a duplicate hand-maintained list of its own keys.
  expect(declared.get("PROCESS_PREPARATION_DEADLINE")).toContain(
    "boot/connectorprocess.go",
  );
  expect(declared.get("PROCESS_CONTROL_LIFETIME_MISMATCH")).toContain(
    "boot/connectorprocesswire.go",
  );
  expect(declared.get("CHATGPT_CONVERSATION_UNCONFIRMED")).toContain(
    "src/pkg/product-settings/contract.ts",
  );
  expect(declared.get("TASK_CANCEL_FAILED")).toContain(
    "src/modules/chat/contract/product-task.ts",
  );
  expect(declared.get("outcome_unknown")).toContain(
    "modules/computer/domain/mutation/state.go",
  );
  expect(declared.get("completed")).toContain(
    "modules/chat/domain/turn/turn.go",
  );
  expect(declared.get("UPDATE_HANDOFF_UNKNOWN")).toContain(
    "modules/release/domain/update.go",
  );
  expect(declared.get("chat_browser_send_reply_unknown")).toContain(
    "apps/desktop/go-chat-browser.ts",
  );
  expect(declared.get("refused")).toContain("apps/desktop/bridge/wire.ts");
});

it("never assigns a terminal class to codes that declare uncertain outcomes", () => {
  for (const code of declaredOperationOutcomes().keys()) {
    if (/unknown|unconfirmed|lost|indeterminate/iu.test(code))
      expect(mappedOperationOutcome(code), code).toBe("unknown");
  }
});

it("keeps self-test uncertainty and redaction metadata distinct", () => {
  for (const code of [
    "self_test_original_unconfirmed",
    "SELF_TEST_START_UNCONFIRMED",
    "FAROL_PROCESS_AUDIT_DRAIN_UNCONFIRMED",
  ])
    expect(operationResult({ status: "done", code })).toEqual({
      outcome: "unknown",
      code,
    });
  expect(operationResult({ phase: "settling" }).outcome).toBe("pending");
  expect(declaredOperationOutcomes().has("filtered-truncated")).toBe(false);
  expect(mappedOperationOutcome("filtered-truncated")).toBeUndefined();
});

it("uses the same mapping for string errors, object errors, Go kinds and nested receipts", () => {
  for (const [outcome, codes] of Object.entries(operationCodesByOutcome)) {
    for (const code of codes) {
      for (const value of [
        { error: code },
        { error: { code } },
        { error: { kind: code } },
        { kind: code },
        { outcome: code },
        { code },
        { evidence: { code } },
        { data: { phase: code } },
        { data: { failure: { code } } },
      ]) {
        const result = operationResult(value);
        expect(result.outcome, JSON.stringify(value)).toBe(
          outcome === "done" && "error" in value ? "unknown" : outcome,
        );
      }
    }
  }
});

it.each(["done", "refused", "failed", "pending", "unknown"])(
  "preserves unconfirmed evidence over a contradictory %s assertion",
  (status) => {
    for (const code of operationCodesByOutcome.unknown) {
      for (const value of [
        { ok: false, error: code, status },
        { ok: true, error: { kind: "refused", code }, status },
        { status, evidence: { state: code } },
        { status, data: { outcome: code } },
      ])
        expect(operationResult(value).outcome, code).toBe("unknown");
    }
    expect(
      operationResult({ status, connectorAttempt: { outcome: "unknown" } })
        .outcome,
    ).toBe("unknown");
    expect(
      operationResult({ status, connectorSetup: { state: "outcome_unknown" } })
        .outcome,
    ).toBe("unknown");
  },
);

it.each([
  { ok: false, error: "CHATGPT_CONVERSATION_UNCONFIRMED" },
  { ok: true, error: { code: "CHATGPT_CONVERSATION_UNCONFIRMED" } },
  { status: "refused", error: "CHATGPT_CONVERSATION_UNCONFIRMED" },
  { status: 500, error: "CHATGPT_CONVERSATION_UNCONFIRMED" },
])("preserves the exact configuration regression code %#", (value) => {
  expect(operationResult(value)).toEqual({
    outcome: "unknown",
    code: "CHATGPT_CONVERSATION_UNCONFIRMED",
  });
});

it("counts unlisted codes without retaining their content, through both recorder methods", async () => {
  const record = vi.fn();
  const finish = vi.fn();
  const recorder = createTotalOperationsRecorder({
    record,
    begin: () => finish,
  });
  for (const status of ["done", "refused", "failed"]) {
    const value = { status, ok: false, error: "PRIVATE_UNLISTED_ERROR" };
    const original = Promise.resolve(value);
    expect(observeOperation(recorder, metadata, () => original)).toBe(original);
    expect(await original).toBe(value);
  }
  recorder.record(metadata, "done", "PRIVATE_UNLISTED_ERROR", 0);
  recorder.begin(metadata)("refused", "CHATGPT_CONVERSATION_UNCONFIRMED", 0);
  expect(
    finish.mock.calls.slice(0, 3).map(([outcome, code]) => ({ outcome, code })),
  ).toEqual(
    Array.from({ length: 3 }, () => ({
      outcome: "unknown",
      code: "OPERATION_CODE_UNMAPPED",
    })),
  );
  expect(record).toHaveBeenCalledWith(metadata, "unknown", "provider_error", 0);
  expect(finish).toHaveBeenLastCalledWith(
    "unknown",
    "CHATGPT_CONVERSATION_UNCONFIRMED",
    0,
  );
  expect(recorder.diagnostics().unmappedCodes).toBe(4);
  expect(JSON.stringify([record.mock.calls, finish.mock.calls])).not.toContain(
    "PRIVATE_",
  );
});

it.each([
  { status: "future-state", ok: true },
  { status: "refused", error: { kind: "future-kind" } },
  { status: "failed", code: "FUTURE_FAILED" },
  { ok: true, reason: "FUTURE_DONE" },
  { status: "ok", data: { code: "FUTURE_REFUSED" } },
  { error: 17 },
  { ok: false },
])(
  "never guesses terminal success or refusal for unclassified input %#",
  (value) => {
    expect(operationResult(value).outcome).toBe("unknown");
  },
);

it.each([
  [{ status: "accepted" }, "pending"],
  [{ status: "refused", error: "SETUP_INCOMPLETE" }, "refused"],
  [{ status: 503 }, "failed"],
  [{ status: 403 }, "refused"],
  [{ ok: true, evidence: { state: "running" } }, "pending"],
  [{ ok: true }, "done"],
] as const)("keeps known settlement semantics %#", (value, outcome) => {
  expect(operationResult(value).outcome).toBe(outcome);
});

it.each([
  "CHATGPT_CONVERSATION_UNCONFIRMED",
  "TURN_OUTCOME_UNKNOWN",
  "PRIVATE_UNLISTED_ERROR",
])(
  "uses the shared mapping for failed model frames and handler reasons: %s",
  async (code) => {
    const record = vi.fn();
    const recorder = createTotalOperationsRecorder({ record });
    await recordedModelTurn(recorder, async () => ({
      ok: true,
      events: [{ event: "response.failed", data: { error: code } }],
    }))({ body: {}, headers: {} });
    await recordedModelTurn(recorder, async () => ({
      ok: false,
      reason: code,
    }))({ body: {}, headers: {} });
    expect(record.mock.calls.map(([, outcome]) => outcome)).toEqual([
      "unknown",
      "unknown",
    ]);
  },
);

it("does not infer successful shutdown from an unqualified child-close code", () => {
  expect(operationResult({ code: "backend_child_closed" })).toEqual({
    outcome: "unknown",
    code: "backend_child_closed",
  });
});

it.each(["unknown", "outcome_unknown", "pending"])(
  "retains %s even with the qualified backend exit code",
  (state) => {
    expect(
      operationResult({ code: "backend_requested_clean_exit", state }).outcome,
    ).toBe(state === "pending" ? "pending" : "unknown");
  },
);
it("recognizes the producer-qualified backend requested clean exit code", () => {
  expect(operationResult({ code: "backend_requested_clean_exit" })).toEqual({
    outcome: "done",
    code: "backend_requested_clean_exit",
  });
});

it("does not turn a nondispatch assessment into a successful operation", () => {
  for (const code of ["SAFE_TO_APPLY", "observing", "preparing"]) {
    expect(mappedOperationOutcome(code)).toBe("unknown");
    expect(operationResult({ outcome: code })).toMatchObject({
      outcome: "unknown",
    });
    expect(operationResult({ code })).toEqual({ outcome: "unknown", code });
  }
});
