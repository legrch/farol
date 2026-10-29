import { expect, it, vi } from "vitest";
import { openSelfTestOwner } from "../../apps/desktop/bridge/self-test-owner";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";
import type {
  PriorSelfTest,
  SelfTestSelection,
} from "../../apps/desktop/bridge/self-test";

const context = { profileId: "profile", backendGeneration: "backend" };
function marker() {
  let saved: "none" | PriorSelfTest = "none";
  return {
    load: async () => saved,
    begin: async (selection: SelfTestSelection) => {
      saved = { selection, settlementAttempted: false };
      return "durable" as const;
    },
    finish: async () => {
      saved = "none";
      return "durable" as const;
    },
  };
}
const publication = {
  fence: "1",
  storeRevision: "1",
  settingsRevision: "1",
  generation: "1",
  approvalDigest: "a".repeat(64),
  publishOperationId: "publish",
};
const original = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "work",
  computerGeneration: "1",
  planVersion: "2",
};

it("reserves the exact durable parent before sending one start", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string; operationId?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.history")
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: { workspaceId: "work", entries: [] },
        };
      if (method === "computer.selftest.reserve")
        return {
          status: "ok",
          requestId: options.id!,
          operationId: options.operationId!,
          context,
          data: {
            operationId: options.operationId!,
            workspaceId: "work",
            computerGeneration: "1",
            planVersion: "4",
          },
        };
      return {
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context,
        data: {
          operationId: options.operationId!,
          workspaceId: "work",
          computerGeneration: "1",
          planVersion: "4",
          status: "unknown",
          steps: [],
        },
      };
    },
  );
  const owner = await openSelfTestOwner({ request }, context, "work", marker());
  const result = await owner.bridge.start(publication, "work");
  expect(result.report?.status).toBe("unknown");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.history",
    "computer.selftest.reserve",
    "computer.selftest.start",
  ]);
  expect(request.mock.calls[1]?.[2].operationId).toBe(
    request.mock.calls[2]?.[2].operationId,
  );
  await expect(owner.bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
});

it("does not send start if the reservation acknowledgement is lost", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.history")
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: { workspaceId: "work", entries: [] },
        };
      throw new Error("lost acknowledgement");
    },
  );
  const journal = marker();
  const owner = await openSelfTestOwner({ request }, context, "work", journal);
  expect((await owner.bridge.start(publication, "work")).state).toBe("unknown");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.history",
    "computer.selftest.reserve",
  ]);
  const reopened = await openSelfTestOwner(
    { request },
    context,
    "work",
    journal,
  );
  await expect(
    reopened.bridge.start(publication, "work"),
  ).rejects.toMatchObject({ code: "self_test_unresolved" });
});

it("restores a prepared original without granting a new start", async () => {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: {
        workspaceId: "work",
        entries: [{ selection: original, phase: "prepared" }],
      },
    }),
  );
  const owner = await openSelfTestOwner({ request }, context, "work", marker());
  expect(owner.history[0]?.selection).toEqual(original);
  await expect(owner.bridge.start(publication, "work")).rejects.toMatchObject({
    code: "self_test_unresolved",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("settles a known failure only by observing its original terminal record", async () => {
  let terminal: { selection: typeof original; phase: string } | undefined;
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string; operationId?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.history")
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: { workspaceId: "work", entries: terminal ? [terminal] : [] },
        };
      const selection = {
        ...original,
        planVersion: "4",
        operationId: options.operationId!,
      };
      if (method === "computer.selftest.reserve")
        return {
          status: "ok",
          requestId: options.id!,
          operationId: options.operationId!,
          context,
          data: selection,
        };
      terminal = { selection, phase: "failed" };
      return {
        status: "ok",
        requestId: options.id!,
        operationId: options.operationId!,
        context,
        data: {
          ...selection,
          status: "fail",
          steps: [
            {
              name: "scratch",
              status: "fail",
              operationId: options.operationId!,
            },
          ],
        },
      };
    },
  );
  const owner = await openSelfTestOwner({ request }, context, "work", marker());
  expect((await owner.bridge.start(publication, "work")).report?.status).toBe(
    "fail",
  );
  expect((await owner.bridge.start(publication, "work")).report?.status).toBe(
    "fail",
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.history",
    "computer.selftest.reserve",
    "computer.selftest.start",
    "computer.selftest.history",
    "computer.selftest.reserve",
    "computer.selftest.start",
    "computer.selftest.history",
  ]);
});

it("does not dispatch a test for a workspace whose history was not read", async () => {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data: { workspaceId: "work", entries: [] },
    }),
  );
  const owner = await openSelfTestOwner({ request }, context, "work", marker());
  expect((await owner.bridge.start(publication, "other")).state).toBe(
    "unknown",
  );
  expect(request).toHaveBeenCalledTimes(1);
});

it("refuses to treat an unreadable terminal report as settled on reopen", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.history")
        return {
          status: "ok",
          requestId: options.id!,
          context,
          data: {
            workspaceId: "work",
            entries: [{ selection: original, phase: "completed" }],
          },
        };
      throw new Error("report unavailable");
    },
  );
  await expect(
    openSelfTestOwner({ request }, context, "work", marker()),
  ).rejects.toMatchObject({ code: "self_test_report_unavailable" });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.history",
    "computer.selftest.observe",
  ]);
});
