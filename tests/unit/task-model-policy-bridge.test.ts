import { describe, expect, it, vi } from "vitest";
import { TaskModelPolicyBridge } from "../../apps/desktop/bridge/task-model-policy";
import { BridgeError } from "../../apps/desktop/bridge/client";
import type { Context, Json, Outcome } from "../../apps/desktop/bridge/wire";
import { taskPolicy } from "../fixtures/task-policy";

const context: Context = {
  profileId: "fixture-profile",
  backendGeneration: "fixture-generation",
};
const ready = {
  revision: "7",
  status: "ready",
  selection: {
    harness: "codex",
    modelAlias: "luna",
    model: "fixture-model",
    effort: "high",
  },
  configSha256: "a".repeat(64),
};

function fixture(change: (out: Outcome) => Outcome = (out) => out) {
  let current = { ...context };
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options?: { id?: string },
    ): Promise<Outcome> =>
      change({
        status: "ok",
        context: { ...context },
        requestId: options!.id!,
        data: structuredClone(ready),
      }),
  );
  const bridge = new TaskModelPolicyBridge({
    request,
    get verifiedContext() {
      return current;
    },
  });
  return {
    bridge,
    request,
    changeContext: () => {
      current = { ...context, backendGeneration: "successor" };
    },
  };
}

describe("Go Task model policy transport", () => {
  it("sends one captured read and returns only the Go-owned immutable binding", async () => {
    const f = fixture();
    const config = taskPolicy();
    const request = { harness: "codex", effort: "low" };
    const pending = f.bridge.resolve(7, config, request);
    config.harnesses.codex!.models.luna!.model = "changed-after-call";
    request.effort = "max";
    const out = await pending;
    expect(out).toEqual({
      status: "ready",
      selection: ready.selection,
      configSha256: ready.configSha256,
    });
    expect(Object.isFrozen(out)).toBe(true);
    if (out.status === "ready")
      expect(Object.isFrozen(out.selection)).toBe(true);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![0]).toBe("task.model.resolve");
    expect(f.request.mock.calls[0]![1]).toMatchObject({
      revision: "7",
      selection: { effort: "low" },
      config: taskPolicy(),
    });
    expect(f.request.mock.calls[0]![2]).not.toHaveProperty("operationId");
  });

  it.each([
    "config-missing",
    "config-invalid",
    "selection-invalid",
    "harness-missing",
    "harness-unsupported",
    "model-missing",
    "unavailable",
  ])("preserves Go refusal %s without a local resolver", async (status) => {
    const f = fixture((out) => ({ ...out, data: { revision: "7", status } }));
    await expect(f.bridge.resolve(7, taskPolicy(), {})).resolves.toEqual({
      status,
    });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([
    ["request", (out: Outcome) => ({ ...out, requestId: "other" })],
    ["effect", (out: Outcome) => ({ ...out, operationId: "not-a-read" })],
    [
      "context",
      (out: Outcome) => ({
        ...out,
        context: { ...context, profileId: "other" },
      }),
    ],
    [
      "revision",
      (out: Outcome) => ({ ...out, data: { ...ready, revision: "8" } }),
    ],
    [
      "missing selection",
      (out: Outcome) => ({
        ...out,
        data: { ...ready, selection: undefined } as unknown as Json,
      }),
    ],
    [
      "invalid effort",
      (out: Outcome) => ({
        ...out,
        data: { ...ready, selection: { ...ready.selection, effort: "" } },
      }),
    ],
    [
      "invalid digest",
      (out: Outcome) => ({
        ...out,
        data: { ...ready, configSha256: "B".repeat(64) },
      }),
    ],
    [
      "unknown field",
      (out: Outcome) => ({ ...out, data: { ...ready, permitted: true } }),
    ],
    [
      "refusal with binding",
      (out: Outcome) => ({
        ...out,
        data: { ...ready, status: "config-invalid" },
      }),
    ],
  ] as const)("refuses crossed or malformed %s", async (_name, change) => {
    const f = fixture(change);
    await expect(f.bridge.resolve(7, taskPolicy(), {})).rejects.toBeInstanceOf(
      BridgeError,
    );
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("rejects a successor peer even if the old reply was well formed", async () => {
    const f = fixture();
    const result = f.bridge.resolve(7, taskPolicy(), {});
    f.changeContext();
    await expect(result).rejects.toMatchObject({
      code: "task_model_policy_response_context",
    });
  });

  it("does not retry a lost or unavailable original response", async () => {
    const f = fixture();
    const failure = new BridgeError("unknown", "response_timeout");
    f.request.mockRejectedValue(failure);
    await expect(f.bridge.resolve(7, taskPolicy(), {})).rejects.toBe(failure);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid revision %s before dispatch",
    async (revision) => {
      const f = fixture();
      await expect(
        f.bridge.resolve(revision, taskPolicy(), {}),
      ).rejects.toMatchObject({ code: "task_model_policy_revision_invalid" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});
