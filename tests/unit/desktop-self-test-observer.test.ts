import { expect, it, vi } from "vitest";
import { SelfTestObserver } from "../../apps/desktop/bridge/self-test-observer";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

const context = { profileId: "profile", backendGeneration: "backend" };
const selection = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "work",
  computerGeneration: "1",
  planVersion: "2" as const,
};

it("observes the original identity through the new connector without an effect", async () => {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: { ...selection, status: "unknown", steps: [] },
    }),
  );
  const observer = new SelfTestObserver({ request }, context, () => {});
  expect(await observer.observe("work", selection)).toMatchObject({
    selection,
    state: "unknown",
    report: { status: "unknown" },
  });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.observe",
  ]);
});

it("withholds a report when the newly selected connector changes during the read", async () => {
  let live = true;
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      live = false;
      return {
        status: "ok",
        requestId: options.id!,
        context,
        data: { ...selection, status: "unknown", steps: [] },
      };
    },
  );
  const observer = new SelfTestObserver({ request }, context, () => {
    if (!live) throw new Error("changed");
  });
  expect(await observer.observe("work", selection)).toEqual({
    selection,
    state: "unknown",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not continue an inventory after the connector changes", async () => {
  let live = true;
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      live = false;
      return {
        status: "ok",
        requestId: options.id!,
        context,
        data: { workspaceId: "work", entries: [] },
      };
    },
  );
  const observer = new SelfTestObserver({ request }, context, () => {
    if (!live) throw new Error("changed");
  });
  await expect(observer.history("work")).rejects.toThrow("changed");
  expect(request).toHaveBeenCalledTimes(1);
});

it("includes the original unresolved marker in history after reopening", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: {
        workspaceId: "work",
        entries:
          method === "computer.selftest.marker.history"
            ? [{ selection, phase: "selected" }]
            : [],
      },
    }),
  );
  const observer = new SelfTestObserver({ request }, context, () => {});
  expect((await observer.history("work")).unresolved).toEqual([selection]);
  expect(
    request.mock.calls.every(([method]) => method.endsWith("history")),
  ).toBe(true);
});
