import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestNotSentError,
  type Client,
} from "../../apps/desktop/bridge/client.ts";
import { SettingsDeliveryBridge } from "../../apps/desktop/bridge/settings-delivery.ts";
import {
  validate,
  type ComputerSettingsEditRequest,
  type Context,
  type Json,
  type Outcome,
  type SettingsDeliveryACKResult,
  type SettingsDeliveryResult,
  type SettingsStorePending,
} from "../../apps/desktop/bridge/wire.ts";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type MutableOutcome = {
  -readonly [K in keyof Omit<Outcome, "context">]: Outcome[K];
} & {
  context: Mutable<Context>;
};
type Options = NonNullable<Parameters<Client["request"]>[2]>;
const operationId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const receiptId = "44444444-4444-4444-8444-444444444444";
const peer: Context = { profileId, backendGeneration: "backend" };
const input: ComputerSettingsEditRequest = {
  publication: {
    fence: "1",
    storeRevision: "2",
    settingsRevision: "3",
    generation: "4",
    approvalDigest: "a".repeat(64),
    publishOperationId: "publish",
  },
  workspaceId,
  relativePath: "note.md",
  expectedSHA256: "b".repeat(64),
  edits: [{ oldText: "old", newText: "new" }],
};
const pending: SettingsStorePending = {
  backend: "go-owner-v2",
  operationId,
  profileId,
  workspaceId,
  relativePath: "note.md",
  computerGeneration: "4",
  beforeSHA256: "b".repeat(64),
  submittedAt: "2026-10-05T08:00:00.123456789Z",
};
function offer(p = pending): Mutable<SettingsDeliveryResult> {
  return {
    state: "offered",
    pending: structuredClone(p),
    receiptId,
    retention: "durable",
    result: {
      operationId: p.operationId,
      workspaceId: p.workspaceId,
      computerGeneration: p.computerGeneration,
      phase: "completed",
      publication: "durable",
      receipt: {
        operation: "edit",
        relativePath: p.relativePath,
        bytes: "8",
        replacements: 1,
        beforeSHA256: p.beforeSHA256,
        afterSHA256: "c".repeat(64),
      },
    },
  };
}
function envelope(data: unknown, options: Options): MutableOutcome {
  return {
    status: "ok",
    requestId: options.id!,
    operationId: options.operationId!,
    context: { ...peer },
    data: data as Json,
  };
}

// Pure transport doubles. No child, filesystem fixture, Electron or provider.
function fixture() {
  const client = {
    verifiedContext: { ...peer },
    request: vi.fn<Client["request"]>(async (method, body, options = {}) => {
      const p = (body as unknown as { pending?: SettingsStorePending }).pending;
      return envelope(
        method === "computer.settings.delivery.ack"
          ? {
              receiptId,
              pending: structuredClone(p),
              acknowledged: true,
            }
          : offer(p),
        options,
      );
    }),
  };
  return {
    client,
    request: client.request,
    bridge: new SettingsDeliveryBridge(client),
  };
}
function changeReply(
  f: ReturnType<typeof fixture>,
  change: (out: MutableOutcome, data: Mutable<SettingsDeliveryResult>) => void,
) {
  f.request.mockImplementationOnce(async (_method, _body, options = {}) => {
    const data = offer();
    const out = envelope(data, options);
    change(out, data);
    return out;
  });
}
afterEach(() => vi.useRealTimers());

describe("SettingsDeliveryBridge transport correlation", () => {
  it("sends the original edit once and distinct observe/ACK effects with exact live metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T08:00:00Z"));
    const f = fixture();
    expect(await f.bridge.apply(operationId, input)).toEqual(offer());
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(await f.bridge.observe(pending)).toEqual(offer());
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(await f.bridge.acknowledge(operationId)).toEqual({
      receiptId,
      pending,
      acknowledged: true,
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.settings.delivery.apply",
      "computer.settings.delivery.observe",
      "computer.settings.delivery.ack",
    ]);
    const calls = f.request.mock.calls;
    expect(calls[0]![1]).toEqual({
      deadlineMillis: String(Date.now() + 14000),
      request: input,
    });
    expect(calls[1]![1]).toEqual({
      deadlineMillis: String(Date.now() + 14000),
      pending,
    });
    expect(calls[2]![1]).toEqual({
      deadlineMillis: String(Date.now() + 14000),
      pending,
      receiptId,
    });
    expect(calls[0]![2]).toMatchObject({ operationId, timeoutMs: 15000 });
    const ids = calls.map((call) => call[2]!.operationId!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids.slice(1)) {
      expect(id).not.toBe(operationId);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
    expect(new Set(calls.map((call) => call[2]!.id)).size).toBe(3);
  });

  it.each([
    "lost",
    "notSent",
    "refused",
    "unknown",
    "unavailable",
    "unsupported",
  ] as const)(
    "consumes an apply after %s and only permits exact observation",
    async (kind) => {
      const f = fixture();
      const error =
        kind === "notSent" ? new RequestNotSentError() : new Error("lost");
      if (kind === "lost" || kind === "notSent")
        f.request.mockRejectedValueOnce(error);
      else
        f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
          status: kind,
          requestId: options.id!,
          operationId: options.operationId!,
          context: peer,
          code: "synthetic_failure",
        }));
      await expect(f.bridge.apply(operationId, input)).rejects.toBeDefined();
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        code: "settings_delivery_attempt_consumed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(await f.bridge.observe(pending)).toEqual(offer());
      expect(f.request).toHaveBeenCalledTimes(2);
      // An absent offer at the original ACK invocation cannot be repaired later.
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );

  const crossedReply: Array<
    [
      string,
      (out: MutableOutcome, data: Mutable<SettingsDeliveryResult>) => void,
    ]
  > = [
    [
      "request ID",
      (o) => {
        o.requestId = "foreign";
      },
    ],
    [
      "transport operation ID",
      (o) => {
        o.operationId = "foreign";
      },
    ],
    [
      "missing transport operation ID",
      (o) => {
        delete o.operationId;
      },
    ],
    [
      "profile context",
      (o) => {
        o.context.profileId = "foreign";
      },
    ],
    [
      "backend context",
      (o) => {
        o.context.backendGeneration = "foreign";
      },
    ],
    [
      "success with code",
      (o) => {
        o.code = "surprise";
      },
    ],
    [
      "failure without code",
      (o) => {
        o.status = "unknown";
        delete o.data;
      },
    ],
    [
      "failure with data",
      (o) => {
        o.status = "refused";
        o.code = "failure";
      },
    ],
    [
      "unknown envelope field",
      (o) => {
        Object.assign(o, { extra: true });
      },
    ],
    [
      "malformed nested context",
      (o) => {
        Object.assign(o.context, { extra: true });
      },
    ],
    [
      "backend binding",
      (_o, d) => {
        Object.assign(d.pending, { backend: "other" });
      },
    ],
    [
      "original operation",
      (_o, d) => {
        d.pending.operationId = "foreign";
      },
    ],
    [
      "profile binding",
      (_o, d) => {
        d.pending.profileId = "foreign";
      },
    ],
    [
      "workspace binding",
      (_o, d) => {
        d.pending.workspaceId = "foreign";
      },
    ],
    [
      "path binding",
      (_o, d) => {
        d.pending.relativePath = "other.md";
      },
    ],
    [
      "generation binding",
      (_o, d) => {
        d.pending.computerGeneration = "5";
      },
    ],
    [
      "before hash binding",
      (_o, d) => {
        d.pending.beforeSHA256 = "d".repeat(64);
      },
    ],
    [
      "invalid timestamp",
      (_o, d) => {
        d.pending.submittedAt = "2026-02-30T08:00:00Z";
      },
    ],
    [
      "missing timestamp",
      (_o, d) => {
        Reflect.deleteProperty(d.pending, "submittedAt");
      },
    ],
    [
      "extra pending field",
      (_o, d) => {
        Object.assign(d.pending, { extra: true });
      },
    ],
    [
      "result operation",
      (_o, d) => {
        d.result!.operationId = "foreign";
      },
    ],
    [
      "result workspace",
      (_o, d) => {
        d.result!.workspaceId = "foreign";
      },
    ],
    [
      "result generation",
      (_o, d) => {
        d.result!.computerGeneration = "5";
      },
    ],
    [
      "receipt path",
      (_o, d) => {
        d.result!.receipt!.relativePath = "other.md";
      },
    ],
    [
      "receipt before hash",
      (_o, d) => {
        d.result!.receipt!.beforeSHA256 = "d".repeat(64);
      },
    ],
    [
      "receipt before hash absent",
      (_o, d) => {
        delete d.result!.receipt!.beforeSHA256;
      },
    ],
    [
      "write receipt",
      (_o, d) => {
        d.result!.receipt!.operation = "write";
      },
    ],
    [
      "oversized receipt",
      (_o, d) => {
        d.result!.receipt!.bytes = "8388609";
      },
    ],
    [
      "malformed receipt bytes",
      (_o, d) => {
        d.result!.receipt!.bytes = "-1";
      },
    ],
    [
      "malformed after hash",
      (_o, d) => {
        d.result!.receipt!.afterSHA256 = "wrong";
      },
    ],
    [
      "zero replacements",
      (_o, d) => {
        d.result!.receipt!.replacements = 0;
      },
    ],
    [
      "too many replacements",
      (_o, d) => {
        d.result!.receipt!.replacements = 257;
      },
    ],
    [
      "fractional replacements",
      (_o, d) => {
        d.result!.receipt!.replacements = 1.5;
      },
    ],
    [
      "extra receipt field",
      (_o, d) => {
        Object.assign(d.result!.receipt!, { extra: true });
      },
    ],
    [
      "missing completed receipt",
      (_o, d) => {
        delete d.result!.receipt;
      },
    ],
    [
      "completed with failure",
      (_o, d) => {
        d.result!.failure = {
          code: "conflict",
          source: "native-workspace",
          retry: "never",
        };
      },
    ],
    [
      "extra result field",
      (_o, d) => {
        Object.assign(d.result!, { extra: true });
      },
    ],
    [
      "retention mismatch",
      (_o, d) => {
        d.retention = "memory_only";
      },
    ],
    [
      "missing offer retention",
      (_o, d) => {
        delete d.retention;
      },
    ],
    [
      "missing offer result",
      (_o, d) => {
        delete d.result;
      },
    ],
    [
      "missing offer receipt ID",
      (_o, d) => {
        delete d.receiptId;
      },
    ],
    [
      "malformed offer receipt ID",
      (_o, d) => {
        d.receiptId = "";
      },
    ],
    [
      "pending with offered fields",
      (_o, d) => {
        d.state = "pending";
      },
    ],
    [
      "extra delivery field",
      (_o, d) => {
        Object.assign(d, { extra: true });
      },
    ],
  ];
  it.each(crossedReply)(
    "rejects crossed or malformed %s and never offers an ACK",
    async (_name, change) => {
      const f = fixture();
      changeReply(f, change);
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        state: "unknown",
      });
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        code: "settings_delivery_attempt_consumed",
      });
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["failed", "outcome_unknown"] as const)(
    "accepts a classified %s offer and its exact retention",
    async (phase) => {
      const f = fixture();
      changeReply(f, (_o, d) => {
        delete d.result!.receipt;
        d.result!.phase = phase;
        d.result!.failure = {
          code:
            phase === "failed"
              ? "WORKSPACE_MUTATION_CONFLICT"
              : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          source: "native-workspace",
          retry: "never",
        };
        d.retention = d.result!.publication = "memory_only";
      });
      const out = await f.bridge.apply(operationId, input);
      expect(out.result?.phase).toBe(phase);
      expect(out.retention).toBe("memory_only");
      expect(out.result?.receipt).toBeUndefined();
      expect(f.request).toHaveBeenCalledTimes(1);
      await f.bridge.acknowledge(operationId);
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "missing failure",
    "receipt with failure",
    "failed with unknown code",
    "unknown with failed code",
    "retry",
    "extra failure field",
  ])("rejects inconsistent failure: %s", async (kind) => {
    const f = fixture();
    changeReply(f, (_o, d) => {
      d.result!.phase = "failed";
      if (kind !== "receipt with failure") delete d.result!.receipt;
      if (kind !== "missing failure")
        d.result!.failure = {
          code: "WORKSPACE_MUTATION_CONFLICT",
          source: "native-workspace",
          retry: "never",
        };
      if (kind === "failed with unknown code")
        d.result!.failure!.code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";
      if (kind === "unknown with failed code")
        d.result!.phase = "outcome_unknown";
      if (kind === "retry")
        Object.assign(d.result!.failure!, { retry: "allowed" });
      if (kind === "extra failure field")
        Object.assign(d.result!.failure!, { extra: true });
    });
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("preserves a completed memory-only offer and accepts the maximum receipt bounds", async () => {
    const f = fixture();
    changeReply(f, (_o, d) => {
      d.retention = d.result!.publication = "memory_only";
      d.result!.receipt!.bytes = "8388608";
      d.result!.receipt!.replacements = 256;
    });
    expect((await f.bridge.apply(operationId, input)).retention).toBe(
      "memory_only",
    );
    await f.bridge.acknowledge(operationId);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("distinguishes pending from offered and never obtains an ACK from pending alone", async () => {
    const f = fixture();
    changeReply(f, (_o, d) => {
      d.state = "pending";
      delete d.receiptId;
      delete d.result;
      delete d.retention;
    });
    expect(await f.bridge.apply(operationId, input)).toEqual({
      state: "pending",
      pending,
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    const unknown = await f.bridge
      .acknowledge(operationId)
      .catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "settings_delivery_offer_missing" });
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.bridge.observe(pending);
    expect(f.request).toHaveBeenCalledTimes(2);
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(unknown);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    "backend",
    "operationId",
    "profileId",
    "workspaceId",
    "relativePath",
    "computerGeneration",
    "beforeSHA256",
    "submittedAt",
  ] as const)(
    "rejects a changed observed %s before sending an effect",
    async (key) => {
      const f = fixture();
      await f.bridge.apply(operationId, input);
      const changed = {
        ...pending,
        [key]:
          key === "submittedAt" ? "2026-10-05T08:00:00.123456788Z" : "foreign",
      };
      // A different original ID is a distinct record; cross its response instead.
      if (key === "operationId") {
        changeReply(f, () => undefined);
        await expect(f.bridge.observe(changed)).rejects.toMatchObject({
          state: "unknown",
        });
        expect(f.request).toHaveBeenCalledTimes(2);
      } else {
        await expect(f.bridge.observe(changed)).rejects.toBeDefined();
        expect(f.request).toHaveBeenCalledTimes(1);
      }
      await f.bridge.acknowledge(operationId);
      expect(f.request).toHaveBeenCalledTimes(key === "operationId" ? 3 : 2);
      expect(f.request.mock.lastCall![1]).toMatchObject({ receiptId, pending });
    },
  );
  it.each([
    "receipt ID",
    "result",
    "binding",
    "timestamp",
    "retention",
    "pending regression",
  ])(
    "does not replace a retained offer after a crossed %s response",
    async (kind) => {
      const f = fixture();
      await f.bridge.apply(operationId, input);
      changeReply(f, (_o, d) => {
        if (kind === "receipt ID") d.receiptId = "another-receipt";
        if (kind === "result") d.result!.receipt!.afterSHA256 = "d".repeat(64);
        if (kind === "binding")
          d.pending.relativePath = d.result!.receipt!.relativePath = "other.md";
        if (kind === "timestamp")
          d.pending.submittedAt = "2026-10-05T08:00:00.123456788Z";
        if (kind === "retention")
          d.retention = d.result!.publication = "memory_only";
        if (kind === "pending regression") {
          d.state = "pending";
          delete d.receiptId;
          delete d.result;
          delete d.retention;
        }
      });
      await expect(f.bridge.observe(pending)).rejects.toMatchObject({
        state: "unknown",
      });
      expect(f.request).toHaveBeenCalledTimes(2);
      await f.bridge.acknowledge(operationId);
      expect(f.request).toHaveBeenCalledTimes(3);
      expect(f.request.mock.lastCall![1]).toMatchObject({ receiptId, pending });
    },
  );
  it("rejects a receipt ID reused across two original operations", async () => {
    const f = fixture();
    await f.bridge.observe(pending);
    const other = { ...pending, operationId: "other" };
    await expect(f.bridge.observe(other)).rejects.toMatchObject({
      code: "crossed_settings_delivery_receipt",
    });
    await expect(f.bridge.acknowledge("other")).rejects.toMatchObject({
      code: "settings_delivery_offer_missing",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each(["profileId", "backendGeneration"] as const)(
    "rejects a stale peer %s before or after await",
    async (key) => {
      const f = fixture();
      f.request.mockImplementationOnce(async (_m, _b, options = {}) => {
        f.client.verifiedContext[key] = "foreign";
        return envelope(offer(), options);
      });
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        code: "settings_delivery_peer_changed",
      });
      await expect(f.bridge.observe(pending)).rejects.toMatchObject({
        code: "settings_delivery_peer_changed",
      });
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_peer_changed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
      const before = fixture();
      before.client.verifiedContext[key] = "foreign";
      await expect(
        before.bridge.apply(operationId, input),
      ).rejects.toMatchObject({ code: "settings_delivery_peer_changed" });
      expect(before.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "receipt ID",
    "false",
    "missing",
    "extra",
    "original operation",
    "profile",
    "workspace",
    "path",
    "generation",
    "hash",
    "timestamp",
    "request ID",
    "transport operation",
    "context",
    "code",
  ])("retains the original forged/crossed ACK error for %s", async (kind) => {
    const f = fixture();
    await f.bridge.apply(operationId, input);
    f.request.mockImplementationOnce(async (_m, _b, options = {}) => {
      const data: Mutable<SettingsDeliveryACKResult> = {
        receiptId,
        pending: structuredClone(pending),
        acknowledged: true,
      };
      const out = envelope(data, options);
      if (kind === "receipt ID") data.receiptId = "foreign";
      if (kind === "false") data.acknowledged = false;
      if (kind === "missing") Reflect.deleteProperty(data, "acknowledged");
      if (kind === "extra") Object.assign(data, { extra: true });
      if (kind === "original operation") data.pending.operationId = "foreign";
      if (kind === "profile") data.pending.profileId = "foreign";
      if (kind === "workspace") data.pending.workspaceId = "foreign";
      if (kind === "path") data.pending.relativePath = "other.md";
      if (kind === "generation") data.pending.computerGeneration = "5";
      if (kind === "hash") data.pending.beforeSHA256 = "d".repeat(64);
      if (kind === "timestamp")
        data.pending.submittedAt = "2026-10-05T08:00:00.123456788Z";
      if (kind === "request ID") out.requestId = "foreign";
      if (kind === "transport operation") out.operationId = operationId;
      if (kind === "context") out.context.backendGeneration = "foreign";
      if (kind === "code") out.code = "unexpected";
      return out;
    });
    const error = await f.bridge
      .acknowledge(operationId)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ state: "unknown" });
    expect(f.request).toHaveBeenCalledTimes(2);
    await f.bridge.observe(pending);
    expect(f.request).toHaveBeenCalledTimes(3);
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each(["lost", "notSent", "refused", "unknown"])(
    "never retries an ACK after %s",
    async (kind) => {
      const f = fixture();
      await f.bridge.observe(pending);
      const original =
        kind === "notSent" ? new RequestNotSentError() : new Error("lost ACK");
      if (kind === "lost" || kind === "notSent")
        f.request.mockRejectedValueOnce(original);
      else
        f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
          status: kind as "refused" | "unknown",
          code: "synthetic_ack_failure",
          context: peer,
          requestId: options.id!,
          operationId: options.operationId!,
        }));
      const error = await f.bridge
        .acknowledge(operationId)
        .catch((e: unknown) => e);
      if (kind === "lost" || kind === "notSent") expect(error).toBe(original);
      expect(f.request).toHaveBeenCalledTimes(2);
      await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
      expect(f.request).toHaveBeenCalledTimes(2);
      await f.bridge.observe(pending);
      expect(f.request).toHaveBeenCalledTimes(3);
      f.client.verifiedContext.backendGeneration = "foreign";
      await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
      expect(f.request).toHaveBeenCalledTimes(3);
    },
  );
  it("shares one in-flight ACK and returns immutable retained success only within the same peer", async () => {
    const f = fixture();
    await f.bridge.apply(operationId, input);
    let release!: (out: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.bridge.acknowledge(operationId);
    const second = f.bridge.acknowledge(operationId);
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledTimes(2);
    release(
      envelope(
        { receiptId, pending, acknowledged: true },
        f.request.mock.lastCall![2]!,
      ),
    );
    const a = (await first) as Mutable<SettingsDeliveryACKResult>;
    a.pending.submittedAt = "2026-10-05T08:00:00Z";
    expect(await second).toEqual({ receiptId, pending, acknowledged: true });
    await f.bridge.observe(pending);
    expect(await f.bridge.acknowledge(operationId)).toEqual({
      receiptId,
      pending,
      acknowledged: true,
    });
    expect(f.request).toHaveBeenCalledTimes(3);
    f.client.verifiedContext.backendGeneration = "new-peer";
    await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
      code: "settings_delivery_peer_changed",
    });
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it("never reconstructs a lost ACK in a new bridge from an original operation ID", async () => {
    const f = fixture();
    await f.bridge.apply(operationId, input);
    f.request.mockRejectedValueOnce(new Error("lost"));
    await expect(f.bridge.acknowledge(operationId)).rejects.toThrow("lost");
    const next = new SettingsDeliveryBridge(f.client);
    await expect(next.acknowledge(operationId)).rejects.toMatchObject({
      code: "settings_delivery_offer_missing",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("bounds correlation memory without evicting consumed original IDs", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("lost"));
    for (let i = 0; i < 4096; i++)
      await f.bridge.apply(`op-${i}`, input).catch(() => undefined);
    expect(f.request).toHaveBeenCalledTimes(4096);
    await expect(f.bridge.apply("overflow", input)).rejects.toMatchObject({
      code: "settings_delivery_retention_full",
    });
    await expect(f.bridge.apply("op-0", input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    await expect(f.bridge.acknowledge("overflow")).rejects.toMatchObject({
      code: "settings_delivery_retention_full",
    });
    expect(f.request).toHaveBeenCalledTimes(4096);
  });
  it("bounds observe calls independently of the correlation map", async () => {
    const f = fixture();
    for (let i = 0; i < 4096; i++) await f.bridge.observe(pending);
    expect(f.request).toHaveBeenCalledTimes(4096);
    await expect(f.bridge.observe(pending)).rejects.toMatchObject({
      code: "settings_delivery_call_budget",
    });
    const error = await f.bridge
      .acknowledge(operationId)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "settings_delivery_call_budget" });
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(4096);
  });
  it("bounds ACK-only invocations without any transport", async () => {
    const f = fixture();
    for (let i = 0; i < 4096; i++)
      await f.bridge.acknowledge(`op-${i}`).catch(() => undefined);
    await expect(f.bridge.acknowledge("overflow")).rejects.toMatchObject({
      code: "settings_delivery_retention_full",
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("retains the original deadline and immutable request, pending and offer copies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T08:00:00Z"));
    const f = fixture();
    let release!: (out: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const selected = structuredClone(
      input,
    ) as Mutable<ComputerSettingsEditRequest>;
    const waiting = f.bridge.apply(operationId, selected);
    selected.edits[0]!.newText = "changed";
    selected.expectedSHA256 = "d".repeat(64);
    vi.setSystemTime(Date.now() + 5000);
    expect(f.request.mock.calls[0]![1]).toEqual({
      deadlineMillis: String(Date.now() + 9000),
      request: input,
    });
    const raw = offer();
    release(envelope(raw, f.request.mock.calls[0]![2]!));
    const result = (await waiting) as Mutable<SettingsDeliveryResult>;
    raw.receiptId = result.receiptId = "forged";
    raw.pending.submittedAt = result.pending.submittedAt =
      "2026-10-05T08:00:00Z";
    result.result!.receipt!.afterSHA256 = "d".repeat(64);
    const observation = { ...pending };
    f.request.mockImplementationOnce((_m, _b, options = {}) => {
      observation.submittedAt = "2026-10-05T08:00:00Z";
      return Promise.resolve(envelope(offer(), options));
    });
    expect(await f.bridge.observe(observation)).toEqual(offer());
    expect(f.request.mock.calls[1]![1]).toMatchObject({ pending });
    await f.bridge.acknowledge(operationId);
    expect(f.request.mock.calls[2]![1]).toMatchObject({ receiptId, pending });
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it.each(["apply", "observe", "ack"] as const)(
    "bounds a stalled %s with no retry or late resurrection",
    async (method) => {
      vi.useFakeTimers();
      const f = fixture();
      if (method === "ack") await f.bridge.observe(pending);
      let release!: (out: Outcome) => void;
      f.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const work =
        method === "apply"
          ? f.bridge.apply(operationId, input)
          : method === "observe"
            ? f.bridge.observe(pending)
            : f.bridge.acknowledge(operationId);
      const rejected = work.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15000);
      const error = await rejected;
      expect(error).toMatchObject({ code: "settings_delivery_timeout" });
      const count = method === "ack" ? 2 : 1;
      expect(f.request).toHaveBeenCalledTimes(count);
      release(
        envelope(
          method === "ack"
            ? { receiptId, pending, acknowledged: true }
            : offer(),
          f.request.mock.lastCall![2]!,
        ),
      );
      await Promise.resolve();
      if (method === "apply")
        await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
          code: "settings_delivery_attempt_consumed",
        });
      if (method === "ack")
        await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
      else
        await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
          code: "settings_delivery_offer_missing",
        });
      expect(f.request).toHaveBeenCalledTimes(count);
    },
  );
  it("rejects a reply past its original budget even when the event loop has not fired its timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.request.mockImplementationOnce(async (_m, _b, options = {}) => {
      vi.setSystemTime(Date.now() + 15000);
      return envelope(offer(), options);
    });
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_response_late",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each([
    "empty edits",
    "oversized body",
    "zero generation",
    "unsafe generation",
    "extra request field",
    "invalid original ID",
    "129 edits",
  ])(
    "refuses %s before transport using the generated boundary",
    async (kind) => {
      const f = fixture();
      const selected = structuredClone(
        input,
      ) as Mutable<ComputerSettingsEditRequest>;
      if (kind === "empty edits") selected.edits = [];
      if (kind === "oversized body")
        selected.edits = [
          { oldText: "x".repeat(262144), newText: "x".repeat(262144) },
        ];
      if (kind === "zero generation") selected.publication.generation = "0";
      if (kind === "unsafe generation")
        selected.publication.generation = "9007199254740992";
      if (kind === "extra request field")
        Object.assign(selected, { extra: true });
      if (kind === "129 edits")
        selected.edits = Array.from({ length: 129 }, () => ({
          oldText: "old",
          newText: "new",
        }));
      await expect(
        f.bridge.apply(
          kind === "invalid original ID" ? "" : operationId,
          selected,
        ),
      ).rejects.toMatchObject({ code: "invalid_settings_delivery_request" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
  it("uses generated UTC validation without truncating nanoseconds", async () => {
    expect(validate("SettingsStorePending", pending)).toBe(true);
    const f = fixture();
    await f.bridge.observe(pending);
    changeReply(f, (_o, d) => {
      d.pending.submittedAt = "2026-10-05T08:00:00.123Z";
    });
    await expect(f.bridge.observe(pending)).rejects.toMatchObject({
      code: "crossed_settings_delivery_pending",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("consumes an original apply while its first response is still in flight", async () => {
    const f = fixture();
    let release!: (out: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = f.bridge.apply(operationId, input);
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    release(envelope(offer(), f.request.mock.lastCall![2]!));
    expect(await first).toEqual(offer());
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("never dispatches apply after observation of that original operation", async () => {
    const f = fixture();
    await f.bridge.observe(pending);
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["request", "operation", "backend", "profile"])(
    "correlates the observation effect envelope's %s",
    async (field) => {
      const f = fixture();
      changeReply(f, (out) => {
        if (field === "request") out.requestId = "foreign";
        if (field === "operation") out.operationId = operationId;
        if (field === "backend") out.context.backendGeneration = "foreign";
        if (field === "profile") out.context.profileId = "foreign";
      });
      await expect(f.bridge.observe(pending)).rejects.toMatchObject({
        code: "crossed_settings_delivery_outcome",
      });
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "operationId",
    "profileId",
    "workspaceId",
    "relativePath",
    "computerGeneration",
    "beforeSHA256",
    "submittedAt",
  ] as const)(
    "validates the full returned observation tuple: %s",
    async (field) => {
      const f = fixture();
      changeReply(f, (_out, data) => {
        Object.assign(data.pending, {
          [field]:
            field === "submittedAt"
              ? "2026-10-05T08:00:00.123456788Z"
              : field === "computerGeneration"
                ? "5"
                : field === "beforeSHA256"
                  ? "d".repeat(64)
                  : "foreign",
        });
      });
      await expect(f.bridge.observe(pending)).rejects.toMatchObject({
        code: "crossed_settings_delivery_pending",
      });
      await expect(f.bridge.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["receiptId", "result", "retention"] as const)(
    "rejects even a single offered %s field on a pending state",
    async (field) => {
      const f = fixture();
      changeReply(f, (_out, data) => {
        data.state = "pending";
        for (const key of ["receiptId", "result", "retention"] as const)
          if (key !== field) delete data[key];
      });
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        code: "invalid_settings_delivery_pending",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["apply", "observe", "ack"] as const)(
    "consumes a synchronous %s transport throw without any retry",
    async (method) => {
      const f = fixture();
      if (method === "ack") await f.bridge.observe(pending);
      const original = new Error("synchronous transport loss");
      f.request.mockImplementationOnce(() => {
        throw original;
      });
      const work =
        method === "apply"
          ? f.bridge.apply(operationId, input)
          : method === "observe"
            ? f.bridge.observe(pending)
            : f.bridge.acknowledge(operationId);
      await expect(work).rejects.toBe(original);
      if (method === "apply")
        await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
          code: "settings_delivery_attempt_consumed",
        });
      if (method === "ack")
        await expect(f.bridge.acknowledge(operationId)).rejects.toBe(original);
      expect(f.request).toHaveBeenCalledTimes(method === "ack" ? 2 : 1);
    },
  );
  it("binds an ACK to the offered tuple even if the transport mutates its body", async () => {
    const f = fixture();
    await f.bridge.observe(pending);
    f.request.mockImplementationOnce(async (_m, body, options = {}) => {
      const wire = body as unknown as Mutable<SettingsDeliveryACKResult>;
      wire.receiptId = "forged";
      wire.pending.relativePath = "other.md";
      return envelope({ ...wire, acknowledged: true }, options);
    });
    const error = await f.bridge
      .acknowledge(operationId)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ state: "unknown" });
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("retains the ACK error when the verified peer changes during its await", async () => {
    const f = fixture();
    await f.bridge.observe(pending);
    f.request.mockImplementationOnce(async (_m, _body, options = {}) => {
      f.client.verifiedContext.backendGeneration = "foreign";
      return envelope({ receiptId, pending, acknowledged: true }, options);
    });
    const error = await f.bridge
      .acknowledge(operationId)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "settings_delivery_peer_changed" });
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("captures offer absence at ACK invocation even if observation finishes before its microtask", async () => {
    const f = fixture();
    let release!: (out: Outcome) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const observing = f.bridge.observe(pending);
    release(envelope(offer(), f.request.mock.lastCall![2]!));
    const ack = f.bridge.acknowledge(operationId);
    const rejected = ack.catch((error: unknown) => error);
    await observing;
    const error = await rejected;
    expect(error).toMatchObject({ code: "settings_delivery_offer_missing" });
    await expect(f.bridge.acknowledge(operationId)).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("cannot ACK a forged renderer receipt ID in place of the original operation ID", async () => {
    const f = fixture();
    await f.bridge.observe(pending);
    await expect(f.bridge.acknowledge(receiptId)).rejects.toMatchObject({
      code: "settings_delivery_offer_missing",
    });
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.bridge.acknowledge(operationId);
    expect(f.request).toHaveBeenCalledTimes(2);
  });
});
