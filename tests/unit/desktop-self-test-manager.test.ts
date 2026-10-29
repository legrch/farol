import { expect, it, vi } from "vitest";
import { SelfTestManager } from "../../apps/desktop/bridge/self-test-manager";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

const context = { profileId: "profile", backendGeneration: "backend" };
const prior = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "work",
  computerGeneration: "1",
  planVersion: "2" as const,
};
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
            planVersion: "3",
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
          planVersion: "3",
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
  expect(manager.canRetire()).toBe(true);
  const [first, second] = await Promise.allSettled([
    manager.start("work"),
    manager.start("work"),
  ]);
  expect([first.status, second.status].sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  const successful =
    first.status === "fulfilled"
      ? first.value
      : second.status === "fulfilled"
        ? second.value
        : undefined;
  expect(manager.pending("work")).toEqual(successful?.selection);
  expect(manager.canRetire()).toBe(false);
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

it("cannot retire an owner while its initial inventory is in flight", async () => {
  let release!: (value: Outcome) => void;
  const request = vi.fn(
    () =>
      new Promise<Outcome>((resolve) => {
        release = resolve;
      }),
  );
  const manager = new SelfTestManager(
    { request },
    context,
    () => {},
    () => publication,
  );
  const pending = manager.start("work");
  expect(manager.canRetire()).toBe(false);
  release({ status: "refused", requestId: "not-matching", context });
  await expect(pending).rejects.toBeDefined();
  expect(manager.canRetire()).toBe(true);
});

it("exposes a restored original while refusing a replacement start", async () => {
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
            ? [{ selection: prior, phase: "selected" }]
            : [],
      },
    }),
  );
  const manager = new SelfTestManager(
    { request },
    context,
    () => {},
    () => publication,
  );
  await expect(manager.start("work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(manager.pending("work")).toEqual(prior);
  expect(
    request.mock.calls.every(([method]) => method.endsWith("history")),
  ).toBe(true);
});

it("keeps original unresolved if the connector changes during observation", async () => {
  let live = true;
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.observe") {
        live = false;
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: {
            ...prior,
            status: "fail",
            steps: [
              {
                name: "scratch",
                status: "fail",
                operationId: prior.operationId,
              },
            ],
          },
        };
      }
      return {
        status: "ok",
        requestId: options.id!,
        context,
        data: {
          workspaceId: "work",
          entries:
            method === "computer.selftest.marker.history"
              ? [{ selection: prior, phase: "selected" }]
              : [],
        },
      };
    },
  );
  const manager = new SelfTestManager(
    { request },
    context,
    () => {
      if (!live) throw new Error("changed");
    },
    () => publication,
  );
  expect(await manager.observe("work", prior)).toEqual({
    selection: prior,
    state: "unknown",
  });
  expect(manager.pending("work")).toEqual(prior);
  expect(request.mock.calls.at(-1)?.[0]).toBe("computer.selftest.observe");
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
