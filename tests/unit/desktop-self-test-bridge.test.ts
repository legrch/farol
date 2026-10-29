import { expect, it, vi } from "vitest";
import { SelfTestBridge } from "../../apps/desktop/bridge/self-test";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

const context = { profileId: "profile", backendGeneration: "backend" };
const store = () => ({
  reserve: vi.fn(async () => "durable" as const),
  settle: vi.fn(async () => "durable" as const),
});
const publication = {
  fence: "1",
  storeRevision: "1",
  settingsRevision: "1",
  generation: "1",
  approvalDigest: "a".repeat(64),
  publishOperationId: "publish",
};

it("retains the original attempt and only observes that identity", async () => {
  const request = vi.fn(
    async (
      method: string,
      body: Json,
      options: { id?: string; operationId?: string } = {},
    ): Promise<Outcome> => {
      const input = body as Record<string, Json>;
      const operationId = method.endsWith("start")
        ? options.operationId!
        : (input.operationId as string);
      return {
        status: "ok",
        requestId: options.id!,
        context,
        ...(options.operationId ? { operationId: options.operationId } : {}),
        data: {
          operationId,
          workspaceId: "work",
          computerGeneration: "1",
          planVersion: "2",
          status: "unknown",
          steps: [],
        },
      };
    },
  );
  const bridge = new SelfTestBridge({ request }, context, "none", store());
  const first = await bridge.start(publication, "work");
  expect(first.state).toBe("observed");
  expect(first.report?.status).toBe("unknown");
  await expect(bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  const read = await bridge.observe(first.selection);
  expect(read.selection).toEqual(first.selection);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.start",
    "computer.selftest.observe",
  ]);
  expect(Object.isFrozen(read.report?.steps)).toBe(true);
});

it("keeps an unconfirmed original id after a lost or crossed response", async () => {
  const request = vi.fn(async (): Promise<Outcome> => {
    throw new Error("transport failed");
  });
  const bridge = new SelfTestBridge({ request }, context, "none", store());
  const first = await bridge.start(publication, "work");
  expect(first.state).toBe("unknown");
  expect(first.selection.operationId).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("permits a separate test only after the first result is settled", async () => {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string; operationId?: string } = {},
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
      data: {
        operationId: options.operationId!,
        workspaceId: "work",
        computerGeneration: "1",
        planVersion: "2",
        status: "partial",
        steps: [
          "scratch",
          "write",
          "edit",
          "mutation read",
          "catalogue",
          "bootstrap",
          "list",
          "read",
          "search",
          "cleanup",
          "shell",
          "shell cancel",
          "directory search",
          "git and hooks",
        ].map((name, index) => ({
          name,
          status: index < 12 ? "pass" : "not_tested",
          ...(index < 12
            ? {
                operationId:
                  options.operationId! +
                  [
                    "",
                    "-st2-write",
                    "-st2-edit",
                    "-st2-edit",
                    "-st2-catalogue",
                    "-st2-bootstrap",
                    "-st2-list",
                    "-st2-read",
                    "-st2-search",
                    "",
                    "-st2-quick",
                    "-st2-cancel",
                  ][index],
              }
            : {}),
        })),
      },
    }),
  );
  const bridge = new SelfTestBridge({ request }, context, "none", store());
  const first = await bridge.start(publication, "work");
  const second = await bridge.start(publication, "work");
  expect(first.report?.status).toBe("partial");
  expect(second.selection.operationId).not.toBe(first.selection.operationId);
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps restored unknown fenced when an observation has a forged failure", async () => {
  const prior = {
    operationId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "work",
    computerGeneration: "1",
    planVersion: "2" as const,
  };
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string } = {},
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: { ...prior, status: "fail", steps: [] },
    }),
  );
  const bridge = new SelfTestBridge(
    { request },
    context,
    { selection: prior, settlementAttempted: false },
    store(),
  );
  expect((await bridge.observe(prior)).state).toBe("unknown");
  await expect(bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("only releases a restored fence after observing its own settled result", async () => {
  const prior = {
    operationId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "work",
    computerGeneration: "1",
    planVersion: "2" as const,
  };
  const request = vi.fn(
    async (
      _method: string,
      body: Json,
      options: { id?: string } = {},
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: {
        ...(body as Record<string, Json>),
        status: "fail",
        steps: [
          { name: "scratch", status: "fail", operationId: prior.operationId },
        ],
      },
    }),
  );
  const bridge = new SelfTestBridge(
    { request },
    context,
    { selection: prior, settlementAttempted: false },
    store(),
  );
  expect((await bridge.observe(prior)).report?.status).toBe("fail");
  const second = await bridge.start(publication, "work");
  expect(second.selection.operationId).not.toBe(prior.operationId);
  expect(request).toHaveBeenCalledTimes(2);
});

it("never dispatches when reservation acknowledgement is lost", async () => {
  const request = vi.fn(async (): Promise<Outcome> => {
    throw new Error("unexpected request");
  });
  const persistence = {
    reserve: vi.fn(async () => "unknown" as const),
    settle: vi.fn(async () => "durable" as const),
  };
  const bridge = new SelfTestBridge({ request }, context, "none", persistence);
  const out = await bridge.start(publication, "work");
  expect(out.state).toBe("unknown");
  expect(request).not.toHaveBeenCalled();
  await expect(bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(persistence.reserve).toHaveBeenCalledTimes(1);
});

it("does not repeat an uncertain settlement", async () => {
  const prior = {
    operationId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "work",
    computerGeneration: "1",
    planVersion: "2" as const,
  };
  const request = vi.fn(
    async (
      _method: string,
      body: Json,
      options: { id?: string } = {},
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: {
        ...(body as Record<string, Json>),
        status: "fail",
        steps: [
          { name: "scratch", status: "fail", operationId: prior.operationId },
        ],
      },
    }),
  );
  const persistence = {
    reserve: vi.fn(async () => "durable" as const),
    settle: vi.fn(async () => "unknown" as const),
  };
  const bridge = new SelfTestBridge(
    { request },
    context,
    { selection: prior, settlementAttempted: false },
    persistence,
  );
  expect((await bridge.observe(prior)).state).toBe("unknown");
  expect((await bridge.observe(prior)).state).toBe("unknown");
  expect(persistence.settle).toHaveBeenCalledTimes(1);
  await expect(bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
});
