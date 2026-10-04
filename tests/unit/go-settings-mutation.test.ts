import { describe, expect, it, vi } from "vitest";
import { SettingsMutationBridge } from "../../apps/desktop/bridge/settings-mutation";
import { PendingWorkspaceEditDeliverySchema } from "../../src/pkg/product-settings/contract";
import type { Client } from "../../apps/desktop/bridge/client";
import type {
  ComputerSettingsEditRequest,
  ComputerSettingsMutationRead,
  ComputerSettingsMutationResponse,
  Json,
  Outcome,
} from "../../apps/desktop/bridge/wire";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableOutcome = Mutable<Omit<Outcome, "context">> & {
  context: Mutable<Outcome["context"]>;
};
type MutableResult = Mutable<
  Omit<ComputerSettingsMutationResponse, "receipt">
> & {
  receipt?: Mutable<NonNullable<ComputerSettingsMutationResponse["receipt"]>>;
};

// Transport doubles only. No journal, filesystem or backend effect is executed.
const context = { profileId: "profile", backendGeneration: "backend" };
const input: ComputerSettingsEditRequest = {
  publication: {
    fence: "1",
    storeRevision: "2",
    settingsRevision: "3",
    generation: "4",
    approvalDigest: "a".repeat(64),
    publishOperationId: "publish",
  },
  workspaceId: "work",
  relativePath: "note.md",
  expectedSHA256: "b".repeat(64),
  edits: [{ oldText: "old", newText: "new" }],
};
const selected: ComputerSettingsMutationRead = {
  operationId: "operation",
  workspaceId: "work",
  relativePath: "note.md",
  computerGeneration: "4",
};
const terminal: ComputerSettingsMutationResponse = {
  operationId: "operation",
  workspaceId: "work",
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
function fixture(change?: (outcome: MutableOutcome) => unknown) {
  const request = vi.fn<Client["request"]>(
    async (_method, _body, options = {}) => {
      const outcome: MutableOutcome = {
        status: "ok",
        requestId: options.id!,
        context: { ...context },
        ...(options.operationId ? { operationId: options.operationId } : {}),
        data: structuredClone(terminal) as unknown as Json,
      };
      return (change ? change(outcome) : outcome) as Outcome;
    },
  );
  return {
    request,
    bridge: new SettingsMutationBridge({ request, verifiedContext: context }),
  };
}
describe("Go owner mutation transport", () => {
  it("sends exactly once then observes the original metadata without another effect", async () => {
    const f = fixture();
    expect(await f.bridge.edit("operation", input)).toEqual(terminal);
    await expect(f.bridge.edit("operation", input)).rejects.toMatchObject({
      code: "settings_mutation_attempt_consumed",
    });
    expect(await f.bridge.observe(selected)).toEqual(terminal);
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([
      "computer.settings.edit",
      "computer.settings.mutation.read",
    ]);
    expect(f.request.mock.calls[0]![2]).toMatchObject({
      operationId: "operation",
      timeoutMs: 16_000,
    });
    expect(f.request.mock.calls[1]![2]).not.toHaveProperty("operationId");
    expect(f.request.mock.calls[1]![1]).not.toHaveProperty("edits");
    expect(f.request.mock.calls[1]![1]).not.toHaveProperty("publication");
  });
  it.each(["lost", "refused", "unknown", "unavailable"])(
    "retains %s transport consumption with no automatic retry or fallback",
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
      await expect(f.bridge.edit("operation", input)).rejects.toBeDefined();
      await expect(
        f.bridge.edit("operation", {
          ...input,
          edits: [{ oldText: "old", newText: "again" }],
        }),
      ).rejects.toMatchObject({ code: "settings_mutation_attempt_consumed" });
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
    "rejects a crossed or malformed %s reply and consumes its original attempt",
    async (kind) => {
      const f = fixture((outcome) => {
        const result = outcome.data as unknown as MutableResult;
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
        return outcome;
      });
      await expect(f.bridge.edit("operation", input)).rejects.toMatchObject({
        state: "unknown",
      });
      await expect(f.bridge.edit("operation", input)).rejects.toMatchObject({
        code: "settings_mutation_attempt_consumed",
      });
      expect(f.request).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["failed", "outcome_unknown"] as const)(
    "preserves classified %s metadata without relabelling it as completed",
    async (phase) => {
      const f = fixture((outcome) => {
        const data = outcome.data as unknown as MutableResult;
        delete data.receipt;
        data.phase = phase;
        data.failure = {
          code:
            phase === "failed"
              ? "WORKSPACE_MUTATION_CONFLICT"
              : "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          source: "native-workspace",
          retry: "never",
        };
        return outcome;
      });
      const result = await f.bridge.edit("operation", input);
      expect(result.phase).toBe(phase);
      expect(result.receipt).toBeUndefined();
    },
  );
  it("preserves memory-only result retention", async () => {
    const f = fixture((outcome) => {
      (outcome.data as unknown as MutableResult).publication = "memory_only";
      return outcome;
    });
    expect((await f.bridge.edit("operation", input)).publication).toBe(
      "memory_only",
    );
  });
  it("refuses a complete oversized request before any transport", async () => {
    const f = fixture();
    const oversized = {
      ...input,
      edits: [{ oldText: "x".repeat(262144), newText: "x".repeat(262144) }],
    };
    await expect(f.bridge.edit("operation", oversized)).rejects.toMatchObject({
      code: "invalid_settings_mutation_request",
    });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("snapshots the effect body before asynchronous transport and never exposes the raw reply", async () => {
    let release!: (outcome: Outcome) => void;
    const f = fixture();
    f.request.mockImplementationOnce(
      () =>
        new Promise<Outcome>((resolve) => {
          release = resolve;
        }),
    );
    const value = { ...input, edits: input.edits.map((edit) => ({ ...edit })) };
    const pending = f.bridge.edit("operation", value);
    value.edits[0]!.newText = "changed after dispatch";
    expect(f.request.mock.calls[0]![1]).toEqual(input);
    const options = f.request.mock.calls[0]![2]!;
    const raw = structuredClone(terminal) as MutableResult;
    release({
      status: "ok",
      requestId: options.id!,
      operationId: "operation",
      context,
      data: raw as unknown as Json,
    });
    const result = await pending;
    raw.receipt!.afterSHA256 = "d".repeat(64);
    expect(result.receipt!.afterSHA256).toBe(terminal.receipt!.afterSHA256);
  });
  it("refuses an effect envelope masquerading as observation", async () => {
    const f = fixture((outcome) => ({ ...outcome, operationId: "operation" }));
    await expect(f.bridge.observe(selected)).rejects.toMatchObject({
      state: "unknown",
    });
    expect(f.request.mock.calls[0]![0]).toBe("computer.settings.mutation.read");
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
