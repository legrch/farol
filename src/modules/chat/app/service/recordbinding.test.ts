import { describe, expect, it } from "vitest";
import type {
  HandoffMessage,
  HandoffRecord,
  HandoffRequest,
  HandoffTitleRequest,
  HandoffWorkspace,
} from "../port/handoff";
import {
  adoptConflict,
  adoptRecorded,
  continuationExpected,
  continuationReplay,
  knownOrUnknown,
  messageBindingChanged,
  messageReplay,
  replayedRequest,
  reservationConflict,
  reservationRaced,
  sameContinuation,
  titleBindingChanged,
  titleReplay,
  unsubmittedAction,
  withResolvedEffort,
} from "./recordbinding";

const workspace = (): HandoffWorkspace => ({
  root: "/work/root",
  device: "1",
  inode: "2",
  gitCommonDirectory: "/work/root/.git",
  project: {
    root: "/work/root/app",
    device: "1",
    inode: "3",
    gitCommonDirectory: "/work/root/.git",
  },
  execution: { sandbox: "workspace-write", approvalPolicy: "on-request" },
});

type RecordOverrides = {
  -readonly [K in keyof HandoffRecord]?: HandoffRecord[K] | undefined;
};

// An explicit `undefined` removes the field, as an absent journal value would.
const record = (overrides: RecordOverrides = {}): HandoffRecord => {
  const base: Record<string, unknown> = {
    requestDigest: "d1",
    workspaceId: "w1",
    workspace: workspace(),
    projectId: "p1",
    model: "m1",
    reasoningEffort: "high",
    threadId: "t1",
    turnId: "u1",
    threadIntent: true,
    turnIntent: true,
    ...overrides,
  };
  for (const [name, value] of Object.entries(base))
    if (value === undefined) delete base[name];
  return base as HandoffRecord;
};

const request = (overrides: Partial<HandoffRequest> = {}): HandoffRequest => ({
  key: "k1",
  workspaceId: "w1",
  projectId: "p1",
  message: "hi",
  model: "m1",
  ...overrides,
});

describe("continuation binding", () => {
  const binding = {
    configSha256: "a".repeat(64),
    selection: {
      harness: "codex" as const,
      modelAlias: "alias",
      model: "m1",
      effort: "high",
    },
  };

  it("derives the child record from the parent", () => {
    const parent = record({ modelBinding: binding });
    const expected = continuationExpected(
      parent,
      "m1",
      workspace(),
      "d2",
      "parent-key",
      true,
    );
    expect(expected).toMatchObject({
      requestDigest: "d2",
      dispatchProtocol: 1,
      continuedFrom: "parent-key",
      model: "m1",
      reasoningEffort: "high",
      modelBinding: binding,
    });
    expect(
      continuationExpected(record(), "m1", workspace(), "d2", "p", false),
    ).not.toHaveProperty("dispatchProtocol");
    expect(
      continuationExpected(record(), "m1", workspace(), "d2", "p", false),
    ).not.toHaveProperty("modelBinding");
  });

  it("matches a child only on every bound field", () => {
    const expected = continuationExpected(
      record(),
      "m1",
      workspace(),
      "d2",
      "p",
      false,
    );
    const child = record({ requestDigest: "d2", continuedFrom: "p" });
    expect(sameContinuation(child, expected, workspace())).toBe(true);
    expect(
      sameContinuation(
        record({ ...child, model: "m2" }),
        expected,
        workspace(),
      ),
    ).toBe(false);
    expect(
      sameContinuation(
        record({ ...child, continuedFrom: "x" }),
        expected,
        workspace(),
      ),
    ).toBe(false);
    expect(
      sameContinuation(
        record({ ...child, reasoningEffort: undefined }),
        expected,
        workspace(),
      ),
    ).toBe(false);
  });

  it("replays only a verified child on the parent thread", () => {
    expect(
      continuationReplay(record({ turnId: undefined }), "t1", "k"),
    ).toBeNull();
    expect(
      continuationReplay(record({ continuationVerified: true }), "t1", "k"),
    ).toEqual({
      status: "dispatched",
      dispatchId: "k",
      threadId: "t1",
      turnId: "u1",
    });
    expect(continuationReplay(record(), "t1", "k")).toEqual({
      status: "outcome_unknown",
      dispatchId: "k",
    });
    expect(
      continuationReplay(record({ continuationVerified: true }), "t2", "k")
        ?.status,
    ).toBe("outcome_unknown");
  });
});

describe("message and title binding", () => {
  const message = (
    overrides: Partial<HandoffMessage> = {},
  ): HandoffMessage => ({
    key: "m",
    dispatchId: "d",
    workspaceId: "w1",
    projectId: "p1",
    message: "x",
    model: "m1",
    ...overrides,
  });

  it("lets a steer omit but never change the effort", () => {
    expect(messageBindingChanged(record(), message())).toBe(false);
    expect(
      messageBindingChanged(record(), message({ reasoningEffort: "high" })),
    ).toBe(false);
    expect(
      messageBindingChanged(record(), message({ reasoningEffort: "low" })),
    ).toBe(true);
    expect(messageBindingChanged(record(), message({ model: "m2" }))).toBe(
      true,
    );
    expect(messageBindingChanged(record(), message({ projectId: "p2" }))).toBe(
      true,
    );
  });

  it("refuses a title for another workspace or project", () => {
    const title: HandoffTitleRequest = {
      key: "k",
      dispatchId: "d",
      workspaceId: "w1",
      projectId: "p1",
      title: "T",
      expectedTitle: null,
    };
    expect(titleBindingChanged(record(), title)).toBe(false);
    expect(titleBindingChanged(record(), { ...title, workspaceId: "w2" })).toBe(
      true,
    );
    expect(titleBindingChanged(record(), { ...title, projectId: "p2" })).toBe(
      true,
    );
  });

  it("replays a recorded message as steered, unknown or a conflict", () => {
    expect(
      messageReplay({ digest: "a", turnId: "u1" }, "a", record(), "d"),
    ).toEqual({ status: "steered", dispatchId: "d", turnId: "u1" });
    expect(
      messageReplay({ digest: "a", turnId: "u9" }, "a", record(), "d"),
    ).toEqual({ status: "outcome_unknown", dispatchId: "d" });
    expect(
      messageReplay({ digest: "b", turnId: "u1" }, "a", record(), "d"),
    ).toEqual({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
  });

  it("replays a recorded title only for the same digest and thread", () => {
    const title: HandoffTitleRequest = {
      key: "k",
      dispatchId: "d",
      workspaceId: "w1",
      projectId: "p1",
      title: "T",
      expectedTitle: null,
    };
    const unknown = { status: "outcome_unknown", dispatchId: "d" } as const;
    expect(
      titleReplay(
        { digest: "a", threadId: "t1" },
        "a",
        record(),
        title,
        unknown,
      ),
    ).toEqual({
      status: "recorded",
      dispatchId: "d",
      title: "T",
      proof: "historical",
    });
    expect(
      titleReplay(
        { digest: "a", threadId: "t2" },
        "a",
        record(),
        title,
        unknown,
      ),
    ).toBe(unknown);
    expect(
      titleReplay(
        { digest: "b", threadId: "t1" },
        "a",
        record(),
        title,
        unknown,
      ),
    ).toEqual({ status: "refused", code: "HANDOFF_KEY_CONFLICT" });
  });
});

describe("reservations", () => {
  it("conflicts on any differing digest, binding or workspace", () => {
    expect(reservationConflict(record(), "d1", request(), workspace())).toBe(
      false,
    );
    expect(reservationConflict(record(), "d2", request(), workspace())).toBe(
      true,
    );
    expect(
      reservationConflict(
        record(),
        "d1",
        request({ projectId: "p2" }),
        workspace(),
      ),
    ).toBe(true);
    const moved = { ...workspace(), root: "/other" };
    expect(reservationConflict(record(), "d1", request(), moved)).toBe(true);
  });

  it("detects a catalogue-bound winner that differs from this request", () => {
    const issued = record({
      modelCatalogue: { modelId: "m1", observedAt: 1, scope: "s" },
    });
    expect(reservationRaced(issued, request({ reasoningEffort: "high" }))).toBe(
      false,
    );
    expect(reservationRaced(issued, request({ reasoningEffort: "low" }))).toBe(
      true,
    );
    expect(reservationRaced(record(), request({ model: "m2" }))).toBe(false);
  });
});

describe("adoption", () => {
  const adopt = {
    key: "k",
    threadId: "t1",
    turnId: "u1",
    workspaceId: "w1",
    projectId: "p1",
  };
  const adopted = record({ adopted: true });

  it("accepts an adopted record for the same thread and turn", () => {
    expect(adoptConflict(adopted, "d1", adopt, workspace())).toBe(false);
    expect(adoptConflict(record(), "d1", adopt, workspace())).toBe(true);
    expect(adoptConflict(adopted, "d2", adopt, workspace())).toBe(true);
    expect(
      adoptConflict(adopted, "d1", { ...adopt, threadId: "t2" }, workspace()),
    ).toBe(true);
    expect(
      adoptConflict(
        record({ adopted: true, threadId: undefined, turnId: undefined }),
        "d1",
        adopt,
        workspace(),
      ),
    ).toBe(false);
  });

  it("requires the durable record to carry both identifiers", () => {
    expect(adoptRecorded(adopted, adopt)).toBe(true);
    expect(adoptRecorded(null, adopt)).toBe(false);
    expect(adoptRecorded(record(), adopt)).toBe(false);
    expect(adoptRecorded(record({ adopted: true, turnId: "u2" }), adopt)).toBe(
      false,
    );
  });
});

describe("request rebinding", () => {
  it("rewrites the request and model-binding effort together", () => {
    const binding = {
      configSha256: "a".repeat(64),
      selection: {
        harness: "codex" as const,
        modelAlias: "alias",
        model: "m1",
        effort: undefined,
      },
    };
    const bound = withResolvedEffort(
      request({ modelBinding: binding }),
      "medium",
    );
    expect(bound.reasoningEffort).toBe("medium");
    expect(bound.modelBinding?.selection.effort).toBe("medium");
    expect(withResolvedEffort(request(), "low")).not.toHaveProperty(
      "modelBinding",
    );
  });

  it("prefers the journal's issued binding on replay", () => {
    expect(
      replayedRequest(
        request({ model: "m2", reasoningEffort: "low" }),
        record(),
      ),
    ).toMatchObject({ model: "m1", reasoningEffort: "high" });
    expect(
      replayedRequest(
        request({ model: "m2", reasoningEffort: "low" }),
        record({ model: undefined, reasoningEffort: undefined }),
      ),
    ).toMatchObject({ model: "m2", reasoningEffort: "low" });
  });
});

describe("unsubmittedAction", () => {
  it("never publishes once an effect is possible", () => {
    expect(unsubmittedAction(true, true, true, 1)).toBe("none");
    expect(unsubmittedAction(true, false, true, 1)).toBe("none");
  });

  it("consumes the turn on cancellation unless already consumed", () => {
    expect(unsubmittedAction(false, true, true, 1)).toBe("consume-turn");
    expect(unsubmittedAction(false, true, false, 1)).toBe("none");
  });

  it("records a refusal only for a live attempt", () => {
    expect(unsubmittedAction(false, false, true, 3)).toBe("record-refusal");
    expect(unsubmittedAction(false, false, true, 0)).toBe("record-refusal");
    expect(unsubmittedAction(false, false, true, undefined)).toBe("none");
  });
});

describe("knownOrUnknown", () => {
  it("dispatches only with both durable identifiers", () => {
    expect(knownOrUnknown("k", record())).toEqual({
      status: "dispatched",
      dispatchId: "k",
      threadId: "t1",
      turnId: "u1",
    });
    expect(knownOrUnknown("k", record({ turnId: undefined }))).toEqual({
      status: "outcome_unknown",
      dispatchId: "k",
    });
    expect(knownOrUnknown("k", null).status).toBe("outcome_unknown");
  });
});
