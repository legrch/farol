import { describe, expect, it } from "vitest";
import {
  knownMethod,
  methodKinds,
  validate,
  type TaskCreate,
  type TaskDispatch,
  type TaskMutation,
  type TaskObservationRequest,
} from "../../apps/desktop/bridge/wire.ts";

// Generated shared-wire vectors only. No provider, native runtime or admission.
const create: TaskCreate = { message: "A controlled source task" };
const result: TaskDispatch = {
  taskId: "selected task",
  dispatchId: "create-1",
  reference: { threadId: "thread@provider", turnId: "turn-1" },
  lifecycle: "completed",
  pending: false,
  retained: true,
  text: "Retained controlled answer",
  resultEvidence: "task_journal",
  delivery: "not_observed",
};

describe("selected Task common wire", () => {
  it("classifies selected actions without inventing native capabilities", () => {
    expect(methodKinds["task.create"]).toBe("effect");
    expect(methodKinds["task.continue"]).toBe("effect");
    expect(methodKinds["task.resume"]).toBe("effect");
    for (const method of [
      "task.resolve",
      "task.observe",
      "task.status",
      "task.result",
      "task.operation.status",
      "task.observation.read",
    ] as const)
      expect(methodKinds[method]).toBe("read");
    for (const method of ["task.message", "task.cancel", "task.invoke"])
      expect(knownMethod(method)).toBe(false);
  });
  it("does not let a create body supply selection or authority", () => {
    expect(validate("TaskCreate", create)).toBe(true);
    for (const field of [
      "operationId",
      "taskId",
      "ownerId",
      "taskEpoch",
      "provider",
      "model",
      "grant",
      "root",
    ])
      expect(validate("TaskCreate", { ...create, [field]: "other" })).toBe(
        false,
      );
    expect(validate("TaskCreate", { message: "" })).toBe(false);
    expect(validate("TaskCreate", { message: "x".repeat(65537) })).toBe(false);
  });
  it("requires an exact parent dispatch and bounds retained observations", () => {
    expect(
      validate("TaskContinue", {
        dispatchId: "create-1",
        message: "Follow up",
      }),
    ).toBe(true);
    expect(validate("TaskContinue", { message: "Latest task" })).toBe(false);
    expect(
      validate("TaskResume", { dispatchId: "create-1", message: "Resume" }),
    ).toBe(true);
    expect(validate("TaskResume", { message: "Latest session" })).toBe(false);
    expect(
      validate("TaskResume", {
        dispatchId: "create-1",
        message: "Resume",
        sessionId: "caller-selected",
      }),
    ).toBe(false);
    expect(validate("TaskDispatchRequest", {})).toBe(false);
    const observation: TaskObservationRequest = {
      dispatchId: "create-1",
      cursor: {
        streamId: "stream-1",
        generation: "9007199254740993",
        sequence: "18446744073709551615",
      },
      limit: 32,
      includeResult: false,
    };
    expect(validate("TaskObservationRequest", observation)).toBe(true);
    for (const limit of [0, 33, 1.5])
      expect(
        validate("TaskObservationRequest", { ...observation, limit }),
      ).toBe(false);
    for (const generation of [1, "01", "-1", "18446744073709551616"])
      expect(
        validate("TaskObservationRequest", {
          ...observation,
          cursor: { ...observation.cursor, generation },
        }),
      ).toBe(false);
  });
  it("preserves Task-owned opaque identifiers and retained result evidence", () => {
    expect(validate("TaskDispatch", result)).toBe(true);
    expect(
      validate("TaskDispatch", { ...result, taskId: "other\nidentity" }),
    ).toBe(false);
    expect(validate("TaskDispatch", { ...result, lifecycle: "idle" })).toBe(
      false,
    );
    expect(
      validate("TaskDispatch", { ...result, resultEvidence: "assumed" }),
    ).toBe(false);
    expect(validate("TaskDispatch", { ...result, delivery: "rendered" })).toBe(
      false,
    );
    expect(
      validate("TaskDispatch", { ...result, text: "x".repeat(65537) }),
    ).toBe(false);
    expect(
      validate("TaskDispatch", {
        ...result,
        reference: { ...result.reference, accessToken: "not-allowed" },
      }),
    ).toBe(false);
  });
  it("keeps unknown receipts distinct and diagnostics bounded", () => {
    const unknown: TaskMutation = {
      operationId: "lost-create",
      taskId: "selected task",
      receipt: {
        state: "outcome_unknown",
        code: "TASK_OUTCOME_UNKNOWN",
        reference: { threadId: "known-thread" },
        result: "",
        cancelRequested: false,
      },
    };
    expect(validate("TaskMutation", unknown)).toBe(true);
    expect(
      validate("TaskMutation", {
        ...unknown,
        receipt: { ...unknown.receipt, state: "retryable" },
      }),
    ).toBe(false);
    expect(
      validate("TaskMutation", {
        ...unknown,
        receipt: { ...unknown.receipt, code: "private\ndiagnostic" },
      }),
    ).toBe(false);
  });
});
