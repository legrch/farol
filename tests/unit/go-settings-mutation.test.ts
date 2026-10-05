import { describe, expect, it, vi } from "vitest";
import { SettingsDeliveryBridge } from "../../apps/desktop/bridge/settings-delivery";
import {
  BridgeError,
  RequestNotSentError,
  type Client,
} from "../../apps/desktop/bridge/client";
import { PendingWorkspaceEditDeliverySchema } from "../../src/pkg/product-settings/contract";
import type {
  ComputerSettingsEditRequest,
  ComputerSettingsMutationResponse,
  SettingsDeliveryResult,
  SettingsStorePending,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire";

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type MutableOutcome = {
  -readonly [K in keyof Omit<Outcome, "context">]: Outcome[K];
} & {
  context: Mutable<Outcome["context"]>;
};
const context = {
  profileId: "33333333-3333-4333-8333-333333333333",
  backendGeneration: "backend",
};
const operationId = "11111111-1111-4111-8111-111111111111";
const input: ComputerSettingsEditRequest = {
  publication: {
    fence: "1",
    storeRevision: "2",
    settingsRevision: "3",
    generation: "4",
    approvalDigest: "a".repeat(64),
    publishOperationId: "publish",
  },
  workspaceId: "22222222-2222-4222-8222-222222222222",
  relativePath: "note.md",
  expectedSHA256: "b".repeat(64),
  edits: [{ oldText: "old", newText: "new" }],
};
const selected: SettingsStorePending = {
  backend: "go-owner-v2",
  operationId,
  profileId: context.profileId,
  workspaceId: input.workspaceId,
  relativePath: input.relativePath,
  computerGeneration: "4",
  beforeSHA256: input.expectedSHA256,
  submittedAt: "2026-10-05T08:00:00.123456789Z",
};
const mutation: ComputerSettingsMutationResponse = {
  operationId,
  workspaceId: input.workspaceId,
  computerGeneration: "4",
  phase: "completed",
  publication: "durable",
  receipt: {
    operation: "edit",
    relativePath: "note.md",
    bytes: "8",
    replacements: 1,
    beforeSHA256: "b".repeat(64),
    afterSHA256: "c".repeat(64),
  },
};
const terminal: SettingsDeliveryResult = {
  state: "offered",
  pending: selected,
  receiptId: "44444444-4444-4444-8444-444444444444",
  retention: "durable",
  result: mutation,
};
// Transport doubles only. No journal, filesystem, Go or native effect executes.
function fixture(
  change?: (
    outcome: MutableOutcome,
    result: Mutable<SettingsDeliveryResult>,
  ) => void,
) {
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) => {
      const data = structuredClone(terminal) as Mutable<SettingsDeliveryResult>;
      const outcome: MutableOutcome = {
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context: { ...context },
        data: data as unknown as Json,
      };
      change?.(outcome, data);
      return outcome;
    },
  );
  return {
    request,
    bridge: new SettingsDeliveryBridge({ request, verifiedContext: context }),
  };
}

describe("Go owner mutation through active Settings delivery transport", () => {
  it.each([
    "notSent",
    "lost",
    "plainBackpressure",
    "remoteBackpressure",
    "crossedRead",
    "otherPath",
    "otherGeneration",
    "newLifetime",
  ])(
    "never fabricates a delivery offer from %s plus a missing record",
    async (kind) => {
      const f = fixture();
      if (kind === "lost")
        f.request.mockRejectedValueOnce(
          new BridgeError("unknown", "response_timeout"),
        );
      else if (kind === "plainBackpressure")
        f.request.mockRejectedValueOnce(
          new BridgeError("unavailable", "backpressure"),
        );
      else if (kind === "remoteBackpressure")
        f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
          status: "unavailable",
          code: "backpressure",
          requestId: options.id!,
          operationId: options.operationId!,
          context,
        }));
      else f.request.mockRejectedValueOnce(new RequestNotSentError());
      const error = await f.bridge
        .apply(operationId, input)
        .catch((e: unknown) => e);
      if (!["lost", "plainBackpressure", "remoteBackpressure"].includes(kind))
        expect(error).toBeInstanceOf(RequestNotSentError);
      else expect(error).not.toBeInstanceOf(RequestNotSentError);
      f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
        status: "refused",
        code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
        requestId: kind === "crossedRead" ? "other" : options.id!,
        operationId: options.operationId!,
        context,
      }));
      const observer =
        kind === "newLifetime"
          ? new SettingsDeliveryBridge({
              request: f.request,
              verifiedContext: context,
            })
          : f.bridge;
      const read = {
        ...selected,
        ...(kind === "otherPath" ? { relativePath: "other.md" } : {}),
        ...(kind === "otherGeneration" ? { computerGeneration: "5" } : {}),
      };
      await expect(observer.observe(read)).rejects.toMatchObject({
        code: ["otherPath", "otherGeneration"].includes(kind)
          ? "crossed_settings_delivery_pending"
          : kind === "crossedRead"
            ? "crossed_settings_delivery_outcome"
            : "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
      });
      await expect(observer.acknowledge(operationId)).rejects.toMatchObject({
        code: "settings_delivery_offer_missing",
      });
      await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
        code: "settings_delivery_attempt_consumed",
      });
      expect(f.request).toHaveBeenCalledTimes(
        ["otherPath", "otherGeneration"].includes(kind) ? 1 : 2,
      );
    },
  );
  it("does not replace an accepted offer with a contradictory result", async () => {
    const f = fixture();
    expect(await f.bridge.apply(operationId, input)).toEqual(terminal);
    f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
      status: "refused",
      code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
    }));
    await expect(f.bridge.observe(selected)).rejects.toMatchObject({
      code: "COMPUTER_MUTATION_OPERATION_NOT_FOUND",
    });
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("sends once and observes original metadata with a distinct transport effect", async () => {
    const f = fixture();
    expect(await f.bridge.apply(operationId, input)).toEqual(terminal);
    await expect(f.bridge.apply(operationId, input)).rejects.toMatchObject({
      code: "settings_delivery_attempt_consumed",
    });
    expect(await f.bridge.observe(selected)).toEqual(terminal);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.settings.delivery.apply",
      "computer.settings.delivery.observe",
    ]);
    expect(f.request.mock.calls[0]![2]).toMatchObject({
      operationId,
      timeoutMs: 15_000,
    });
    expect(f.request.mock.calls[1]![2]!.operationId).not.toBe(operationId);
    expect(f.request.mock.calls[1]![1]).toEqual(
      expect.objectContaining({ pending: selected }),
    );
    expect(f.request.mock.calls[1]![1]).not.toHaveProperty("request");
  });
  it.each(["lost", "refused", "unknown", "unavailable"])(
    "retains %s consumption with no retry or fallback",
    async (kind) => {
      const f = fixture();
      if (kind === "lost") f.request.mockRejectedValueOnce(new Error("lost"));
      else
        f.request.mockImplementationOnce(async (_m, _b, options = {}) => ({
          status: kind as "refused" | "unknown" | "unavailable",
          code: "synthetic_failure",
          requestId: options.id!,
          operationId: options.operationId!,
          context,
        }));
      await expect(f.bridge.apply(operationId, input)).rejects.toBeDefined();
      await expect(
        f.bridge.apply(operationId, {
          ...input,
          edits: [{ oldText: "old", newText: "again" }],
        }),
      ).rejects.toMatchObject({ code: "settings_delivery_attempt_consumed" });
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(await f.bridge.observe(selected)).toEqual(terminal);
      expect(f.request).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    "request",
    "effect",
    "profile",
    "backend",
    "operation",
    "workspace",
    "generation",
    "path",
    "beforeHash",
    "tooManyBytes",
    "zeroReplacements",
    "bothResults",
    "wrongFailure",
    "codeOnSuccess",
    "unexpectedField",
  ])(
    "rejects a crossed or malformed %s reply and consumes the attempt",
    async (kind) => {
      const f = fixture((outcome, data) => {
        const result = data.result!;
        switch (kind) {
          case "request":
            outcome.requestId = "other";
            break;
          case "effect":
            outcome.operationId = "other";
            break;
          case "profile":
            outcome.context.profileId = "other";
            break;
          case "backend":
            outcome.context.backendGeneration = "other";
            break;
          case "operation":
            result.operationId = "other";
            break;
          case "workspace":
            result.workspaceId = "other";
            break;
          case "generation":
            result.computerGeneration = "5";
            break;
          case "path":
            result.receipt!.relativePath = "other.md";
            break;
          case "beforeHash":
            result.receipt!.beforeSHA256 = "d".repeat(64);
            break;
          case "tooManyBytes":
            result.receipt!.bytes = "8388609";
            break;
          case "zeroReplacements":
            result.receipt!.replacements = 0;
            break;
          case "bothResults":
            result.failure = {
              code: "WORKSPACE_MUTATION_CONFLICT",
              source: "native-workspace",
              retry: "never",
            };
            break;
          case "wrongFailure":
            result.phase = "failed";
            delete result.receipt;
            result.failure = {
              code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
              source: "native-workspace",
              retry: "never",
            };
            break;
          case "codeOnSuccess":
            outcome.code = "surprise";
            break;
          case "unexpectedField":
            Object.assign(result, { retry: true });
            break;
        }
      });
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
    "preserves classified %s metadata",
    async (phase) => {
      const f = fixture((_outcome, data) => {
        delete data.result!.receipt;
        data.result!.phase = phase;
        data.result!.failure = {
          code:
            phase === "failed"
              ? "WORKSPACE_MUTATION_CONFLICT"
              : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          source: "native-workspace",
          retry: "never",
        };
      });
      const result = await f.bridge.apply(operationId, input);
      expect(result.result!.phase).toBe(phase);
      expect(result.result!.receipt).toBeUndefined();
    },
  );
  it("preserves memory-only result retention", async () => {
    const f = fixture((_outcome, data) => {
      data.retention = data.result!.publication = "memory_only";
    });
    const result = await f.bridge.apply(operationId, input);
    expect(result.retention).toBe("memory_only");
    expect(result.result!.publication).toBe("memory_only");
  });
  it("refuses a complete oversized request before transport", async () => {
    const f = fixture();
    await expect(
      f.bridge.apply(operationId, {
        ...input,
        edits: [{ oldText: "x".repeat(262144), newText: "x".repeat(262144) }],
      }),
    ).rejects.toMatchObject({ code: "invalid_settings_delivery_request" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("snapshots input before asynchronous transport and never exposes the raw offer", async () => {
    let release!: (outcome: Outcome) => void;
    const f = fixture();
    f.request.mockImplementationOnce(
      () =>
        new Promise<Outcome>((resolve) => {
          release = resolve;
        }),
    );
    const value = { ...input, edits: input.edits.map((edit) => ({ ...edit })) };
    const pending = f.bridge.apply(operationId, value);
    value.edits[0]!.newText = "changed after dispatch";
    expect(f.request.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ request: input }),
    );
    const options = f.request.mock.calls[0]![2]!;
    const raw = structuredClone(terminal) as Mutable<SettingsDeliveryResult>;
    release({
      status: "ok",
      requestId: options.id!,
      operationId,
      context,
      data: raw as unknown as Json,
    });
    const result = await pending;
    raw.result!.receipt!.afterSHA256 = "d".repeat(64);
    raw.pending.relativePath = "other.md";
    expect(result).toEqual(terminal);
  });
  it("rejects observation correlated to the original effect instead of its fresh effect ID", async () => {
    const f = fixture((outcome) => {
      outcome.operationId = operationId;
    });
    await expect(f.bridge.observe(selected)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request.mock.calls[0]![0]).toBe(
      "computer.settings.delivery.observe",
    );
    expect(f.request.mock.calls[0]![2]!.operationId).not.toBe(operationId);
  });
});

it("keeps legacy delivery bytes distinct from a complete Go identity", () => {
  const legacy = {
    operationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    relativePath: "note.md",
    computerGeneration: 4,
    submittedAt: "2026-10-04T20:00:00.000Z",
  };
  expect(PendingWorkspaceEditDeliverySchema.parse(legacy)).toEqual(legacy);
  const go = {
    ...legacy,
    backend: "go-owner-v2",
    profileId: "33333333-3333-4333-8333-333333333333",
    beforeSha256: "a".repeat(64),
  };
  expect(PendingWorkspaceEditDeliverySchema.parse(go)).toEqual(go);
  for (const key of ["backend", "profileId", "beforeSha256"] as const) {
    const crossed = { ...go };
    delete (crossed as Record<string, unknown>)[key];
    expect(PendingWorkspaceEditDeliverySchema.safeParse(crossed).success).toBe(
      false,
    );
  }
  expect(
    PendingWorkspaceEditDeliverySchema.safeParse({
      ...go,
      backend: "typescript",
    }).success,
  ).toBe(false);
});
