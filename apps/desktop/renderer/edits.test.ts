import { describe, expect, it } from "vitest";
import type { ProductConfigurationEvidence } from "../../../src/pkg/product-settings/contract";
import type { WindowSnapshot } from "../../../src/ui/renderer/contract";
import { settings } from "../../../tests/renderer/fixture";
import {
  createEditRegistry,
  receiptMatchesSnapshot,
  sameEditOwner,
  samePendingEdit,
  settledEditState,
  settlesAcknowledgedEdit,
  type EditOwner,
  type ObservationInput,
} from "./edits";
import { initial, type EditReceipt, type ObservedEdit } from "./snapshot";

type Preview = EditReceipt["preview"];
type Mutation = Extract<
  ProductConfigurationEvidence,
  { kind: "computer.workspace-mutation" }
>;
type Ready = Extract<
  NonNullable<WindowSnapshot["configuration"]>,
  { status: "ready" }
>;

const buildId = "3".repeat(64);
const operationId = "op-1";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const preview: Preview = {
  kind: "computer.workspace-edit-preview",
  operationId,
  workspaceId,
  relativePath: "file.txt",
  bytes: 10,
  beforeSha256: "b".repeat(64),
  expiresAt: "2026-10-04T20:05:00.000Z",
};
const mutation: Mutation = {
  kind: "computer.workspace-mutation",
  operationId,
  workspaceId,
  relativePath: "file.txt",
  operation: "edit",
  bytes: 12,
  replacements: 1,
  beforeSha256: preview.beforeSha256,
  afterSha256: "c".repeat(64),
  resultRetention: "durable",
  redelivered: false,
};
const owner: EditOwner = {
  buildId,
  computerId: "11111111-1111-4111-8111-111111111111",
  generation: 1,
};

function configuration(revision: number, pending: boolean): Ready {
  const value = settings(revision);
  value.computer.pendingEdit = pending
    ? {
        operationId,
        workspaceId,
        relativePath: "file.txt",
        computerGeneration: 1,
        submittedAt: "2026-10-04T20:00:00.000Z",
      }
    : null;
  return { status: "ready", settings: value };
}
function snapshot(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    buildId,
    configuration: configuration(1, false),
    ...overrides,
  };
}
function receiptFor(
  configurationValue: WindowSnapshot["configuration"],
): EditReceipt {
  return { preview, configuration: configurationValue, ...owner };
}
function pendingSnapshot(revision = 2): WindowSnapshot {
  return snapshot({ configuration: configuration(revision, true) });
}
function withComputer(
  base: WindowSnapshot,
  patch: Partial<Ready["settings"]["computer"]>,
): WindowSnapshot {
  if (base.configuration?.status !== "ready") throw new Error("not ready");
  const next = structuredClone(base.configuration);
  Object.assign(next.settings.computer, patch);
  return { ...base, configuration: next };
}

describe("sameEditOwner", () => {
  const receipt = receiptFor(null);
  it("accepts a current snapshot of the same build, computer and generation", () => {
    expect(sameEditOwner(receipt, snapshot())).toBe(true);
  });
  it.each<[string, WindowSnapshot]>([
    ["a stale window", snapshot({ status: "stale" })],
    ["another build", snapshot({ buildId: "4".repeat(64) })],
    ["no build", snapshot({ buildId: null })],
    ["no configuration", snapshot({ configuration: null })],
    ["another computer", withComputer(snapshot(), { computerId: "other" })],
    ["another generation", withComputer(snapshot(), { generation: 2 })],
  ])("refuses %s", (_name, current) => {
    expect(sameEditOwner(receipt, current)).toBe(false);
  });
});

describe("samePendingEdit", () => {
  const receipt = receiptFor(null);
  it("accepts the owner whose pending edit is the receipt's", () => {
    expect(samePendingEdit(receipt, pendingSnapshot())).toBe(true);
  });
  it("refuses a settled snapshot with no pending edit", () => {
    expect(samePendingEdit(receipt, snapshot())).toBe(false);
  });
  it("refuses a snapshot without configuration", () => {
    expect(samePendingEdit(receipt, snapshot({ configuration: null }))).toBe(
      false,
    );
  });
  it.each<
    [string, Partial<NonNullable<Ready["settings"]["computer"]["pendingEdit"]>>]
  >([
    ["operation", { operationId: "op-2" }],
    ["workspace", { workspaceId: "other" }],
    ["path", { relativePath: "other.txt" }],
    ["generation", { computerGeneration: 2 }],
  ])("refuses another pending %s", (_name, patch) => {
    const base = pendingSnapshot();
    if (base.configuration?.status !== "ready") throw new Error("not ready");
    const next = structuredClone(base.configuration);
    const pending = next.settings.computer.pendingEdit;
    if (pending === null) throw new Error("no pending edit");
    next.settings.computer.pendingEdit = { ...pending, ...patch };
    expect(samePendingEdit(receipt, { ...base, configuration: next })).toBe(
      false,
    );
  });
  it("refuses a matching pending edit under another owner", () => {
    expect(
      samePendingEdit(receipt, { ...pendingSnapshot(), status: "stale" }),
    ).toBe(false);
    expect(
      samePendingEdit(receipt, {
        ...pendingSnapshot(),
        buildId: "4".repeat(64),
      }),
    ).toBe(false);
  });
});

describe("receiptMatchesSnapshot", () => {
  const evidence = { revision: 1, value: preview };
  function matching() {
    const current = snapshot({ evidence });
    return { current, receipt: receiptFor(current.configuration) };
  }
  it("accepts the same configuration and preview references", () => {
    const { current, receipt } = matching();
    expect(receiptMatchesSnapshot(receipt, current)).toBe(true);
  });
  it("compares by reference, not by value", () => {
    const { current, receipt } = matching();
    expect(
      receiptMatchesSnapshot(receipt, {
        ...current,
        configuration: structuredClone(current.configuration),
      }),
    ).toBe(false);
    expect(
      receiptMatchesSnapshot(receipt, {
        ...current,
        evidence: { revision: 1, value: { ...preview } },
      }),
    ).toBe(false);
  });
  it("refuses a snapshot without the preview evidence", () => {
    const { current, receipt } = matching();
    expect(
      receiptMatchesSnapshot(receipt, { ...current, evidence: null }),
    ).toBe(false);
  });
  it("refuses a snapshot of another owner", () => {
    const { current, receipt } = matching();
    expect(
      receiptMatchesSnapshot(receipt, { ...current, buildId: "4".repeat(64) }),
    ).toBe(false);
  });
});

describe("settledEditState", () => {
  const receipt = receiptFor(null);
  const applied = { state: "applied", code: null } as const;
  it("settles a refusal with or without evidence", () => {
    const refused = { state: "refused", code: "X" } as const;
    expect(settledEditState(receipt, refused, undefined)).toBe("refused");
    expect(settledEditState(receipt, refused, mutation)).toBe("refused");
  });
  it("settles an applied reply only as the matching edit mutation", () => {
    expect(settledEditState(receipt, applied, mutation)).toBe("applied");
  });
  it.each<[string, Partial<Mutation>]>([
    ["operation", { operationId: "op-2" }],
    ["workspace", { workspaceId: "other" }],
    ["path", { relativePath: "other.txt" }],
    ["before digest", { beforeSha256: "d".repeat(64) }],
    ["kind of write", { operation: "write" }],
  ])("does not settle an applied reply with another %s", (_name, patch) => {
    expect(settledEditState(receipt, applied, { ...mutation, ...patch })).toBe(
      null,
    );
  });
  it("does not settle an applied reply without or with other evidence", () => {
    expect(settledEditState(receipt, applied, undefined)).toBeNull();
    expect(settledEditState(receipt, applied, null)).toBeNull();
    expect(settledEditState(receipt, applied, preview)).toBeNull();
  });
  it("never settles a pending or unknown reply", () => {
    for (const state of ["pending", "unknown"] as const)
      expect(settledEditState(receipt, { state, code: null }, mutation)).toBe(
        null,
      );
  });
});

describe("settlesAcknowledgedEdit", () => {
  function scenario() {
    const before = pendingSnapshot(2);
    const observed: ObservedEdit = {
      submitted: {
        intention: "apply",
        receipt: receiptFor(before.configuration),
      },
      configuration: before.configuration,
      evidence: before.evidence,
      state: "applied",
      code: null,
    };
    const readyBefore = { ...before, workspaceEditDelivery: operationId };
    const current = snapshot({ configuration: configuration(3, false) });
    return { observed, before: readyBefore, current };
  }
  it("accepts the delivered, still-shown observation once the edit is gone", () => {
    const { observed, before, current } = scenario();
    expect(
      settlesAcknowledgedEdit(observed, operationId, before, current),
    ).toBe(true);
  });
  it("refuses when nothing was observed or the observation had no receipt", () => {
    const { observed, before, current } = scenario();
    expect(
      settlesAcknowledgedEdit(undefined, operationId, before, current),
    ).toBe(false);
    expect(
      settlesAcknowledgedEdit(
        { ...observed, submitted: { intention: "apply", receipt: null } },
        operationId,
        before,
        current,
      ),
    ).toBe(false);
  });
  it("refuses another delivery", () => {
    const { observed, before, current } = scenario();
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        {
          ...before,
          workspaceEditDelivery: "op-2",
        },
        current,
      ),
    ).toBe(false);
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        {
          ...before,
          workspaceEditDelivery: null,
        },
        current,
      ),
    ).toBe(false);
  });
  it("refuses when the window moved on from the observed snapshot", () => {
    const { observed, before, current } = scenario();
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        { ...before, configuration: structuredClone(before.configuration) },
        current,
      ),
    ).toBe(false);
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        { ...before, evidence: { revision: 9, value: preview } },
        current,
      ),
    ).toBe(false);
  });
  it("refuses when the edit is no longer pending before the reply", () => {
    const { observed, before, current } = scenario();
    const settled = configuration(2, false);
    expect(
      settlesAcknowledgedEdit(
        { ...observed, configuration: settled },
        operationId,
        { ...before, configuration: settled },
        current,
      ),
    ).toBe(false);
  });
  it("refuses another owner after the reply", () => {
    const { observed, before } = scenario();
    expect(
      settlesAcknowledgedEdit(observed, operationId, before, {
        ...snapshot({ configuration: configuration(3, false) }),
        buildId: "4".repeat(64),
      }),
    ).toBe(false);
  });
  it("refuses a reply that did not advance the revision or left the edit pending", () => {
    const { observed, before } = scenario();
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        before,
        snapshot({ configuration: configuration(2, false) }),
      ),
    ).toBe(false);
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        before,
        pendingSnapshot(3),
      ),
    ).toBe(false);
    expect(
      settlesAcknowledgedEdit(
        observed,
        operationId,
        before,
        snapshot({ configuration: null }),
      ),
    ).toBe(false);
  });
});

describe("edit registry", () => {
  function harness(initialCurrent: WindowSnapshot = snapshot()) {
    const state = { current: initialCurrent };
    const registry = createEditRegistry({ snapshot: () => state.current });
    return { state, registry };
  }
  /** Retain the preview and submit the Apply against a matching snapshot. */
  function submitted() {
    const h = harness();
    const before = snapshot({ evidence: { revision: 1, value: preview } });
    h.state.current = before;
    expect(h.registry.retainPreview(preview, owner)).toBe("retained");
    expect(h.registry.submit(operationId, "apply", before)).toBe("submitted");
    const pending = pendingSnapshot();
    h.state.current = pending;
    return { ...h, before: pending };
  }
  function observation(
    before: WindowSnapshot,
    overrides: Partial<ObservationInput> = {},
  ): ObservationInput {
    return {
      before,
      delivery: operationId,
      settled: true,
      result: { state: "applied", code: null },
      value: mutation,
      ...overrides,
    };
  }

  describe("preview", () => {
    it("starts empty", () => {
      const { registry } = harness();
      expect(registry.preview(operationId)).toBeUndefined();
      expect(registry.observed(operationId)).toBeUndefined();
    });
    it("retains the preview with the owner and the configuration shown now", () => {
      const { registry, state } = harness();
      expect(registry.retainPreview(preview, owner)).toBe("retained");
      expect(registry.preview(operationId)).toEqual({
        preview,
        configuration: state.current.configuration,
        ...owner,
      });
      expect(registry.preview(operationId)?.preview).toBe(preview);
      expect(registry.preview(operationId)?.configuration).toBe(
        state.current.configuration,
      );
    });
    it("re-retains an identical preview, refreshing its configuration", () => {
      const { registry, state } = harness();
      registry.retainPreview(preview, owner);
      const first = registry.preview(operationId);
      state.current = snapshot({ configuration: configuration(2, false) });
      expect(registry.retainPreview({ ...preview }, owner)).toBe("retained");
      const second = registry.preview(operationId);
      expect(second).not.toBe(first);
      expect(second?.configuration).toBe(state.current.configuration);
    });
    it.each<[string, Partial<EditOwner>]>([
      ["build", { buildId: "4".repeat(64) }],
      ["computer", { computerId: "other" }],
      ["generation", { generation: 2 }],
    ])("refuses to replace a receipt of another %s", (_name, patch) => {
      const { registry } = harness();
      registry.retainPreview(preview, owner);
      const retained = registry.preview(operationId);
      expect(registry.retainPreview(preview, { ...owner, ...patch })).toBe(
        "unconfirmed",
      );
      expect(registry.preview(operationId)).toBe(retained);
    });
    it("refuses to replace a receipt whose preview content differs", () => {
      const { registry } = harness();
      registry.retainPreview(preview, owner);
      const retained = registry.preview(operationId);
      expect(registry.retainPreview({ ...preview, bytes: 11 }, owner)).toBe(
        "unconfirmed",
      );
      expect(registry.preview(operationId)).toBe(retained);
    });
    it("keeps receipts of different operations apart", () => {
      const { registry } = harness();
      registry.retainPreview(preview, owner);
      expect(
        registry.retainPreview(
          { ...preview, operationId: "op-2", bytes: 99 },
          { ...owner, generation: 2 },
        ),
      ).toBe("retained");
      expect(registry.preview(operationId)?.generation).toBe(1);
      expect(registry.preview("op-2")?.generation).toBe(2);
    });
  });

  describe("submit", () => {
    it("keeps the retained receipt while the window still shows its preview", () => {
      const { registry, state } = harness();
      const before = snapshot({ evidence: { revision: 1, value: preview } });
      state.current = before;
      registry.retainPreview(preview, owner);
      const receipt = registry.preview(operationId);
      expect(registry.submit(operationId, "apply", before)).toBe("submitted");
      // Observe proves what was stored: the receipt is the retained object.
      state.current = pendingSnapshot();
      expect(registry.observe(operationId, observation(state.current))).toBe(
        true,
      );
      expect(registry.observed(operationId)?.submitted).toEqual({
        intention: "apply",
        receipt,
      });
      expect(registry.observed(operationId)?.submitted.receipt).toBe(receipt);
    });
    it("consumes the operation once and keeps the original intention", () => {
      const { registry, state } = harness();
      const before = snapshot({ evidence: { revision: 1, value: preview } });
      state.current = before;
      registry.retainPreview(preview, owner);
      expect(registry.submit(operationId, "first", before)).toBe("submitted");
      expect(registry.submit(operationId, "second", before)).toBe("consumed");
      state.current = pendingSnapshot();
      registry.observe(operationId, observation(state.current));
      expect(registry.observed(operationId)?.submitted.intention).toBe("first");
    });
    it("stays consumed after the observation is forgotten", () => {
      const { registry, before } = submitted();
      registry.observe(operationId, observation(before));
      registry.forgetObserved(operationId);
      expect(registry.submit(operationId, "again", snapshot())).toBe(
        "consumed",
      );
    });
    it("records no provenance when nothing was previewed", () => {
      const { registry, state } = harness();
      expect(registry.submit(operationId, "apply", snapshot())).toBe(
        "submitted",
      );
      state.current = pendingSnapshot();
      expect(registry.observe(operationId, observation(state.current))).toBe(
        false,
      );
    });
    it.each<[string, (value: WindowSnapshot) => WindowSnapshot]>([
      [
        "the configuration changed",
        (value) => ({ ...value, configuration: configuration(2, false) }),
      ],
      [
        "the evidence changed",
        (value) => ({
          ...value,
          evidence: { revision: 1, value: { ...preview } },
        }),
      ],
      ["the evidence is gone", (value) => ({ ...value, evidence: null })],
      ["the owner changed", (value) => ({ ...value, buildId: "4".repeat(64) })],
    ])("records no provenance when %s", (_name, change) => {
      const { registry, state } = harness();
      const shown = snapshot({ evidence: { revision: 1, value: preview } });
      state.current = shown;
      registry.retainPreview(preview, owner);
      expect(registry.submit(operationId, "apply", change(shown))).toBe(
        "submitted",
      );
      state.current = pendingSnapshot();
      expect(registry.observe(operationId, observation(state.current))).toBe(
        false,
      );
    });
    it("is not affected by a later receipt for the same operation", () => {
      const { registry, state, before } = submitted();
      const kept = registry.preview(operationId);
      state.current = snapshot({ configuration: configuration(5, false) });
      registry.retainPreview(preview, owner);
      expect(registry.preview(operationId)).not.toBe(kept);
      state.current = before;
      registry.observe(operationId, observation(before));
      expect(registry.observed(operationId)?.submitted.receipt).toBe(kept);
    });
  });

  describe("observe", () => {
    it("records the settlement with the snapshot and evidence shown now", () => {
      const { registry, state, before } = submitted();
      expect(registry.observe(operationId, observation(before))).toBe(true);
      const recorded = registry.observed(operationId);
      expect(recorded?.state).toBe("applied");
      expect(recorded?.code).toBeNull();
      expect(recorded?.configuration).toBe(state.current.configuration);
      expect(recorded?.evidence).toBe(state.current.evidence);
    });
    it("records a refusal with its code", () => {
      const { registry, before } = submitted();
      expect(
        registry.observe(
          operationId,
          observation(before, {
            result: { state: "refused", code: "WORKSPACE_EDIT_REFUSED" },
            value: undefined,
          }),
        ),
      ).toBe(true);
      expect(registry.observed(operationId)).toMatchObject({
        state: "refused",
        code: "WORKSPACE_EDIT_REFUSED",
      });
    });
    it("records nothing for an operation that was never submitted", () => {
      const { registry } = harness(pendingSnapshot());
      expect(
        registry.observe(operationId, observation(pendingSnapshot())),
      ).toBe(false);
      expect(registry.observed(operationId)).toBeUndefined();
    });
    it.each<[string, (before: WindowSnapshot) => Partial<ObservationInput>]>([
      ["another delivery", () => ({ delivery: "op-2" })],
      ["no delivery", () => ({ delivery: null })],
      ["an unsettled revision", () => ({ settled: false })],
      ["a pending reply", () => ({ result: { state: "pending", code: null } })],
      [
        "an unknown reply",
        () => ({ result: { state: "unknown", code: null } }),
      ],
      [
        "evidence of another edit",
        () => ({ value: { ...mutation, operationId: "op-2" } }),
      ],
      ["no evidence", () => ({ value: undefined })],
      ["a settled snapshot before the reply", () => ({ before: snapshot() })],
    ])("records nothing for %s", (_name, override) => {
      const { registry, before } = submitted();
      expect(
        registry.observe(operationId, observation(before, override(before))),
      ).toBe(false);
      expect(registry.observed(operationId)).toBeUndefined();
    });
    it("records nothing when the edit is no longer pending now", () => {
      const { registry, state, before } = submitted();
      state.current = snapshot({ configuration: configuration(3, false) });
      expect(registry.observe(operationId, observation(before))).toBe(false);
    });
    it("records nothing when the window now belongs to another owner", () => {
      const { registry, state, before } = submitted();
      state.current = { ...pendingSnapshot(), buildId: "4".repeat(64) };
      expect(registry.observe(operationId, observation(before))).toBe(false);
    });
    it("supersedes an earlier observation even when the new reply proves nothing", () => {
      const { registry, before } = submitted();
      expect(registry.observe(operationId, observation(before))).toBe(true);
      expect(
        registry.observe(operationId, observation(before, { settled: false })),
      ).toBe(false);
      expect(registry.observed(operationId)).toBeUndefined();
    });
    it("replaces an earlier observation with the latest proof", () => {
      const { registry, before } = submitted();
      registry.observe(operationId, observation(before));
      registry.observe(
        operationId,
        observation(before, {
          result: { state: "refused", code: "LATE" },
          value: undefined,
        }),
      );
      expect(registry.observed(operationId)?.code).toBe("LATE");
    });
  });

  describe("forgetObserved", () => {
    it("drops the observation so it cannot be acknowledged twice", () => {
      const { registry, before } = submitted();
      registry.observe(operationId, observation(before));
      expect(registry.observed(operationId)).toBeDefined();
      registry.forgetObserved(operationId);
      expect(registry.observed(operationId)).toBeUndefined();
    });
    it("ignores an operation with no observation", () => {
      const { registry } = harness();
      expect(() => registry.forgetObserved("never")).not.toThrow();
    });
  });
});
