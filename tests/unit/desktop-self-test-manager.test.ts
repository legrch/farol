import { expect, it, vi } from "vitest";
import { SelfTestManager } from "../../apps/desktop/bridge/self-test-manager";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

const context = { profileId: "profile", backendGeneration: "backend" };
const publication = {
  fence: "1",
  storeRevision: "1",
  settingsRevision: "1",
  generation: "1",
  approvalDigest: "a".repeat(64),
  publishOperationId: "publish",
};

it("retains one original owner for concurrent calls and never repeats unknown", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string; operationId?: string },
    ): Promise<Outcome> => {
      if (method.endsWith("history"))
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: { workspaceId: "work", entries: [] },
        };
      if (method.endsWith("begin") || method.endsWith("reserve"))
        return {
          status: "ok",
          requestId: options.id!,
          context,
          operationId: options.operationId!,
          data: {
            operationId: options.operationId!,
            workspaceId: "work",
            computerGeneration: "1",
            planVersion: "2",
          },
        };
      return {
        status: "ok",
        requestId: options.id!,
        context,
        operationId: options.operationId!,
        data: {
          operationId: options.operationId!,
          workspaceId: "work",
          computerGeneration: "1",
          planVersion: "2",
          status: "unknown",
          steps: [],
        },
      };
    },
  );
  const manager = new SelfTestManager(
    { request },
    context,
    () => {},
    () => publication,
  );
  const [first, second] = await Promise.allSettled([
    manager.start("work"),
    manager.start("work"),
  ]);
  expect([first.status, second.status].sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    request.mock.calls.filter(
      ([method]) => method === "computer.selftest.marker.begin",
    ),
  ).toHaveLength(1);
  await expect(manager.start("work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(
    request.mock.calls.filter(
      ([method]) => method === "computer.selftest.start",
    ),
  ).toHaveLength(1);
});

it("does not dispatch after host is closed during history observation", async () => {
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
  const manager = new SelfTestManager(
    { request },
    context,
    () => {
      if (!live) throw new Error("closed");
    },
    () => publication,
  );
  await expect(manager.start("work")).rejects.toThrow("closed");
  expect(
    request.mock.calls.every(([method]) => method.endsWith("history")),
  ).toBe(true);
});

it.each(["computer.selftest.marker.begin", "computer.selftest.reserve"])(
  "stops before the next effect when owner changes during %s",
  async (interruptedMethod) => {
    let live = true;
    const request = vi.fn(
      async (
        method: string,
        _body: Json,
        options: { id?: string; operationId?: string },
      ): Promise<Outcome> => {
        if (method.endsWith("history"))
          return {
            status: "ok",
            requestId: options.id!,
            context,
            data: { workspaceId: "work", entries: [] },
          };
        if (method === interruptedMethod) live = false;
        return {
          status: "ok",
          requestId: options.id!,
          context,
          operationId: options.operationId!,
          data: {
            operationId: options.operationId!,
            workspaceId: "work",
            computerGeneration: "1",
            planVersion: "2",
          },
        };
      },
    );
    const manager = new SelfTestManager(
      { request },
      context,
      () => {
        if (!live) throw new Error("owner changed");
      },
      () => publication,
    );
    expect((await manager.start("work")).state).toBe("unknown");
    expect(
      request.mock.calls.filter(
        ([method]) => method === "computer.selftest.start",
      ),
    ).toHaveLength(0);
    if (interruptedMethod.endsWith("begin"))
      expect(
        request.mock.calls.filter(
          ([method]) => method === "computer.selftest.reserve",
        ),
      ).toHaveLength(0);
  },
);
