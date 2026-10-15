import { describe, expect, it, vi } from "vitest";
import { TaskModelCatalogueBridge } from "../../apps/desktop/bridge/task-model-catalogue";
import type { Context, Json, Outcome } from "../../apps/desktop/bridge/wire";
import { taskPolicy } from "../fixtures/task-policy";

const context: Context = {
  profileId: "profile",
  backendGeneration: "generation",
};
const catalogue = {
  status: "ready",
  source: "model/list",
  scope: "fixture-account",
  observedAt: 1,
  models: [
    {
      id: "observed",
      model: "fixture-model",
      displayName: "Fixture",
      hidden: false,
      supportedEfforts: ["high"],
    },
  ],
};
const view = {
  harness: "codex",
  catalogue,
  configError: null,
  configured: [
    {
      alias: "luna",
      model: "fixture-model",
      defaultEffort: "high",
      available: "yes",
      effortAvailable: true,
    },
  ],
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
        data: structuredClone({ revision: "7", view }),
      }),
  );
  const bridge = new TaskModelCatalogueBridge({
    request,
    get verifiedContext() {
      return current;
    },
  });
  return {
    bridge,
    request,
    cross: () => {
      current = { ...context, backendGeneration: "successor" };
    },
  };
}

describe("Go Task model catalogue transport", () => {
  it("captures facts once and returns the Go view without deriving availability", async () => {
    const f = fixture();
    const config = taskPolicy();
    const observed = structuredClone(catalogue);
    const pending = f.bridge.describe(7, config, "codex", observed);
    config.harnesses.codex!.models.luna!.model = "changed";
    observed.models[0]!.supportedEfforts.length = 0;
    expect(await pending).toEqual(view);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0]![0]).toBe("task.models.describe");
    expect(f.request.mock.calls[0]![1]).toEqual({
      revision: "7",
      config: taskPolicy(),
      harness: "codex",
      catalogue,
    });
    expect(f.request.mock.calls[0]![2]).not.toHaveProperty("operationId");
  });

  it("does not retain mutable transport DTOs", async () => {
    let original: Outcome | undefined;
    const f = fixture((out) => {
      original = out;
      return out;
    });
    const result = await f.bridge.describe(7, taskPolicy(), "codex", catalogue);
    result.configured[0]!.available = "no";
    expect(original!.data).toEqual({ revision: "7", view });
  });

  it.each([
    ["request", (out: Outcome) => ({ ...out, requestId: "other" })],
    ["effect", (out: Outcome) => ({ ...out, operationId: "effect" })],
    [
      "context",
      (out: Outcome) => ({
        ...out,
        context: { ...context, profileId: "other" },
      }),
    ],
    ["revision", (out: Outcome) => ({ ...out, data: { revision: "8", view } })],
    [
      "harness",
      (out: Outcome) => ({
        ...out,
        data: { revision: "7", view: { ...view, harness: "other" } },
      }),
    ],
    [
      "shape",
      (out: Outcome) => ({
        ...out,
        data: { revision: "7", view: { ...view, extra: true } },
      }),
    ],
    ["missing", (out: Outcome) => ({ ...out, data: { revision: "7" } })],
  ] as const)(
    "refuses a crossed or invalid %s reply",
    async (_label, change) => {
      const f = fixture(change);
      await expect(
        f.bridge.describe(7, taskPolicy(), "codex", catalogue),
      ).rejects.toMatchObject({ state: "unknown" });
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it("refuses a backend replacement while the original read is pending", async () => {
    const f = fixture();
    const pending = f.bridge.describe(7, taskPolicy(), "codex", catalogue);
    f.cross();
    await expect(pending).rejects.toMatchObject({ state: "unknown" });
  });

  it.each(["refused", "unavailable", "unknown"] as const)(
    "preserves %s without a local fallback or retry",
    async (status) => {
      const f = fixture((out) => {
        const response = { ...out, status, code: "ORIGINAL_RESULT" };
        delete response.data;
        return response;
      });
      await expect(
        f.bridge.describe(7, taskPolicy(), "codex", catalogue),
      ).rejects.toMatchObject({ state: status, code: "ORIGINAL_RESULT" });
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it.each([-1, 1.2, Number.MAX_SAFE_INTEGER + 1])(
    "rejects revision %s before dispatch",
    async (revision) => {
      const f = fixture();
      await expect(
        f.bridge.describe(revision, taskPolicy(), "codex", catalogue),
      ).rejects.toMatchObject({ state: "refused" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );
});
