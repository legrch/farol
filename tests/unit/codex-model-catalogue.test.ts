import { describe, expect, it } from "vitest";
import { ReadCodexModelCatalogue } from "../../src/modules/chat/app/service/read-codex-model-catalogue";

const model = (patch: Record<string, unknown> = {}) => ({
  id: "picker-entry",
  model: "fixture-model",
  displayName: "Fixture model",
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "First in provider order" },
    { reasoningEffort: "low", description: "Second" },
  ],
  defaultReasoningEffort: "high",
  ...patch,
});
function fixture() {
  let now = 1000;
  let epoch = "client-a/account-a";
  let reply: unknown = { data: [model()], nextCursor: null };
  let fault = false;
  const calls: Array<{
    method: string;
    params: unknown;
    deadline?: number | undefined;
  }> = [];
  const host = {
    modelCatalogueScope: () => epoch,
    async request(method: string, params: unknown, deadline?: number) {
      calls.push({ method, params, deadline });
      if (fault) throw new Error("catalogue unavailable");
      return reply;
    },
  };
  const catalog = new ReadCodexModelCatalogue(host, () => now);
  return {
    catalog,
    calls,
    host,
    set reply(value: unknown) {
      reply = value;
    },
    set now(value: number) {
      now = value;
    },
    set epoch(value: string) {
      epoch = value;
    },
    set fault(value: boolean) {
      fault = value;
    },
  };
}

describe("runtime model catalogue, not configured availability", () => {
  it("matches executable model exactly, never picker ID or display name", async () => {
    const f = fixture();
    expect(await f.catalog.check("fixture-model", "low")).toMatchObject({
      status: "available",
      effort: "low",
    });
    for (const wrong of [
      "picker-entry",
      "Fixture model",
      "fixture",
      "FIXTURE-MODEL",
    ])
      expect(await f.catalog.check(wrong, "high")).toMatchObject({
        status: "refused",
        code: "TASK_MODEL_UNAVAILABLE",
        available: "no",
      });
    expect(f.calls.every((call) => call.method === "model/list")).toBe(true);
  });
  it("keeps effort order and uses the runtime default only for a new selection", async () => {
    const f = fixture();
    expect(await f.catalog.check("fixture-model", undefined)).toMatchObject({
      status: "available",
      effort: "high",
      model: { supportedEfforts: ["high", "low"] },
    });
    expect(await f.catalog.check("fixture-model", "medium")).toMatchObject({
      code: "TASK_EFFORT_UNAVAILABLE",
      available: "yes",
    });
    expect(
      await f.catalog.check("fixture-model", undefined, {
        resolveDefault: false,
      }),
    ).toMatchObject({ code: "TASK_EFFORT_BINDING_UNKNOWN" });
  });
  it("uses a hidden model when explicitly configured and preserves its hidden status", async () => {
    const f = fixture();
    f.reply = { data: [model({ hidden: true })] };
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      status: "available",
      model: { hidden: true },
    });
    expect(f.calls[0]?.params).toEqual({ limit: 100, includeHidden: true });
  });
  it("supports models which actually advertise no effort", async () => {
    const f = fixture();
    f.reply = {
      data: [
        model({ supportedReasoningEfforts: [], defaultReasoningEffort: null }),
      ],
    };
    const result = await f.catalog.check("fixture-model", undefined);
    expect(result.status).toBe("available");
    expect(result).not.toHaveProperty("effort");
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      code: "TASK_EFFORT_UNAVAILABLE",
    });
  });
  it("caches display for 60s but every dispatch check calls the runtime", async () => {
    const f = fixture();
    await f.catalog.read();
    f.now = 2000;
    await f.catalog.read();
    expect(f.calls).toHaveLength(1);
    await f.catalog.check("fixture-model", "high");
    await f.catalog.check("fixture-model", "high");
    expect(f.calls).toHaveLength(3);
    f.now = 62_000;
    await f.catalog.read();
    expect(f.calls).toHaveLength(4);
  });
  it("invalidates display on connection/account epoch changes and explicit refresh", async () => {
    const f = fixture();
    await f.catalog.read();
    f.epoch = "client-a/account-b";
    await f.catalog.read();
    await f.catalog.read({ fresh: true });
    f.catalog.invalidate();
    await f.catalog.read();
    expect(f.calls).toHaveLength(4);
  });
  it("does not use stale success on network failure and distinguishes unknown from absence", async () => {
    const f = fixture();
    await f.catalog.read();
    f.fault = true;
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      code: "TASK_MODEL_CATALOG_UNAVAILABLE",
      available: "unknown",
      availableModels: [],
    });
    expect(await f.catalog.read()).toMatchObject({ status: "unavailable" });
    f.fault = false;
    f.reply = { data: [], nextCursor: null };
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      code: "TASK_MODEL_UNAVAILABLE",
      available: "no",
    });
  });
  it("reads all pages before declaring a model absent", async () => {
    const f = fixture();
    f.host.request = async (method, params) => {
      f.calls.push({ method, params });
      return f.calls.length === 1
        ? { data: [], nextCursor: "page-2" }
        : { data: [model()], nextCursor: null };
    };
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      status: "available",
    });
    expect(f.calls[1]?.params).toEqual({
      limit: 100,
      includeHidden: true,
      cursor: "page-2",
    });
  });
  it.each([
    null,
    {},
    { data: null },
    { data: [null] },
    { data: [model({ model: "" })] },
    { data: [model({ hidden: "false" })] },
    { data: [model({ defaultReasoningEffort: "missing" })] },
    { data: [model({ supportedReasoningEfforts: null })] },
    {
      data: [
        model({
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "high" },
          ],
        }),
      ],
    },
    { data: [model({ displayName: "unsafe\nname" })] },
    { data: [], nextCursor: 2 },
  ])("refuses malformed catalogue %j", async (reply) => {
    const f = fixture();
    f.reply = reply;
    expect(await f.catalog.read()).toMatchObject({
      status: "unavailable",
      code: "TASK_MODEL_CATALOG_INVALID",
    });
  });
  it("rejects duplicate or conflicting model entries", async () => {
    const f = fixture();
    f.reply = {
      data: [model(), model({ id: "other", defaultReasoningEffort: "low" })],
    };
    expect(await f.catalog.read()).toMatchObject({
      code: "TASK_MODEL_CATALOG_AMBIGUOUS",
    });
  });
  it("bounds cyclic cursors and incomplete pagination without pretending absence", async () => {
    const f = fixture();
    f.reply = { data: [], nextCursor: "loop" };
    expect(await f.catalog.check("fixture-model", "high")).toMatchObject({
      available: "unknown",
      code: "TASK_MODEL_CATALOG_INVALID",
    });
    expect(f.calls).toHaveLength(2);
    const g = fixture();
    let cursor = 0;
    g.host.request = async () => ({ data: [], nextCursor: String(++cursor) });
    expect(await g.catalog.read()).toMatchObject({
      code: "TASK_MODEL_CATALOG_INCOMPLETE",
    });
  });
  it("refuses a response after admission deadline or account change", async () => {
    const f = fixture();
    f.host.request = async () => {
      f.now = 3000;
      return { data: [model()] };
    };
    expect(await f.catalog.read({ deadlineAt: 2000 })).toMatchObject({
      status: "unavailable",
    });
    const g = fixture();
    g.host.request = async () => {
      g.epoch = "changed";
      return { data: [model()] };
    };
    expect(await g.catalog.read()).toMatchObject({
      code: "TASK_MODEL_CATALOG_CHANGED",
    });
  });
  it("does not overwrite a newer display result with a delayed refresh", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    let calls = 0;
    f.host.request = async () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { data: [model({ model: "newer" })] };
    const old = f.catalog.read();
    const newest = await f.catalog.read({ fresh: true });
    finish({ data: [model()] });
    await old;
    expect(await f.catalog.read()).toEqual(newest);
  });
});
