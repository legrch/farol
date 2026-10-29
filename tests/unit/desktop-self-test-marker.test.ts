import { expect, it, vi } from "vitest";
import {
  CoreSelfTestMarker,
  beginSelfTestMarker,
  readSelfTestMarkers,
} from "../../apps/desktop/bridge/self-test-marker";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";
import { openSelfTestOwner } from "../../apps/desktop/bridge/self-test-owner";

const context = { profileId: "profile", backendGeneration: "backend" };
const selection = {
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

it("reads the original selected marker without replay", async () => {
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
        entries: [{ selection, phase: "selected" }],
      },
    }),
  );
  expect(await readSelfTestMarkers({ request }, context, "work")).toEqual([
    { selection, phase: "selected" },
  ]);
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.marker.history",
  ]);
});

it.each(["crossed", "duplicate", "wrong-context"])(
  "rejects %s marker inventory",
  async (mode) => {
    const request = vi.fn(
      async (
        _method: string,
        _body: Json,
        options: { id?: string },
      ): Promise<Outcome> => ({
        status: "ok",
        requestId: options.id!,
        context:
          mode === "wrong-context"
            ? { ...context, profileId: "other" }
            : context,
        data: {
          workspaceId: mode === "crossed" ? "other" : "work",
          entries:
            mode === "duplicate"
              ? [
                  { selection, phase: "selected" },
                  { selection, phase: "selected" },
                ]
              : [],
        },
      }),
    );
    await expect(
      readSelfTestMarkers({ request }, context, "work"),
    ).rejects.toMatchObject({ code: "self_test_marker_unavailable" });
  },
);

it("does not settle when original report loses authority", async () => {
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: method === "computer.selftest.observe" ? "unavailable" : "ok",
      requestId: options.id!,
      context,
      ...(method === "computer.selftest.observe"
        ? {}
        : {
            data: {
              workspaceId: "work",
              entries: [
                {
                  selection,
                  phase:
                    method === "computer.selftest.marker.history"
                      ? "selected"
                      : "failed",
                },
              ],
            },
          }),
    }),
  );
  const marker = new CoreSelfTestMarker({ request }, context, "work");
  expect(await marker.finish(selection)).toBe("unknown");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.marker.history",
    "computer.selftest.history",
    "computer.selftest.observe",
  ]);
});

it("checks a terminal that appears between the two history snapshots", async () => {
  let histories = 0;
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => {
      if (method === "computer.selftest.observe")
        return { status: "unavailable", requestId: options.id!, context };
      const entries =
        method === "computer.selftest.marker.history"
          ? [{ selection, phase: "selected" }]
          : ++histories === 1
            ? []
            : [{ selection, phase: "failed" }];
      return {
        status: "ok",
        requestId: options.id!,
        context,
        data: { workspaceId: "work", entries },
      };
    },
  );
  const marker = new CoreSelfTestMarker({ request }, context, "work");
  await expect(
    openSelfTestOwner({ request }, context, "work", marker),
  ).rejects.toMatchObject({ code: "self_test_report_unavailable" });
  expect(request.mock.calls.at(-1)?.[0]).toBe("computer.selftest.observe");
});

it("requires the exact one-shot marker acknowledgement", async () => {
  const current = { ...selection, planVersion: "4" as const };
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string; operationId?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      operationId: options.operationId!,
      context,
      data: current,
    }),
  );
  expect(
    await beginSelfTestMarker({ request }, context, current, publication),
  ).toBe("durable");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.marker.begin",
  ]);
  expect(
    await beginSelfTestMarker({ request }, context, current, {
      ...publication,
      generation: "2",
    }),
  ).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not repeat a lost marker admission", async () => {
  const request = vi.fn(async (): Promise<Outcome> => {
    throw new Error("lost");
  });
  expect(
    await beginSelfTestMarker(
      { request },
      context,
      { ...selection, planVersion: "4" },
      publication,
    ),
  ).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([
  ["selected", "prepared", true],
  ["selected", "outcome_unknown", true],
  ["selected", "failed", false],
  ["settling", "completed", true],
] as const)(
  "derives %s / %s conservatively without writing",
  async (phase, parentPhase, pending) => {
    const request = vi.fn(
      async (
        method: string,
        _body: Json,
        options: { id?: string },
      ): Promise<Outcome> => ({
        status: "ok",
        requestId: options.id!,
        context,
        data:
          method === "computer.selftest.observe"
            ? {
                ...selection,
                status: "fail",
                steps: [
                  {
                    name: "scratch",
                    status: "fail",
                    operationId: selection.operationId,
                  },
                ],
              }
            : {
                workspaceId: "work",
                entries: [
                  {
                    selection,
                    phase:
                      method === "computer.selftest.marker.history"
                        ? phase
                        : parentPhase,
                  },
                ],
              },
      }),
    );
    const marker = new CoreSelfTestMarker({ request }, context, "work");
    const saved = await marker.load("work");
    if (pending)
      expect(saved).toEqual({
        selection,
        settlementAttempted: phase === "settling",
      });
    else expect(saved).toBe("none");
    expect(await marker.finish(selection)).toBe(
      pending ? "unknown" : "durable",
    );
    expect(
      request.mock.calls.every(
        ([method]) =>
          method === "computer.selftest.marker.history" ||
          method === "computer.selftest.history" ||
          method === "computer.selftest.observe",
      ),
    ).toBe(true);
  },
);

it("preserves an old v2 terminal and a new v3 unknown across the same inventory", async () => {
  const current = {
    ...selection,
    operationId: "00000000-0000-4000-8000-000000000002",
    planVersion: "3" as const,
  };
  const request = vi.fn(
    async (
      method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: "ok",
      requestId: options.id!,
      context,
      data:
        method === "computer.selftest.observe"
          ? {
              ...selection,
              status: "fail",
              steps: [
                {
                  name: "scratch",
                  status: "fail",
                  operationId: selection.operationId,
                },
              ],
            }
          : {
              workspaceId: "work",
              entries:
                method === "computer.selftest.marker.history"
                  ? [
                      { selection, phase: "selected" },
                      { selection: current, phase: "selected" },
                    ]
                  : [
                      { selection, phase: "failed" },
                      { selection: current, phase: "outcome_unknown" },
                    ],
            },
    }),
  );
  const marker = new CoreSelfTestMarker({ request }, context, "work");
  expect(await marker.load("work")).toEqual({
    selection: current,
    settlementAttempted: false,
  });
  expect(
    request.mock.calls.every(([method]) =>
      [
        "computer.selftest.marker.history",
        "computer.selftest.history",
        "computer.selftest.observe",
      ].includes(method),
    ),
  ).toBe(true);
});
