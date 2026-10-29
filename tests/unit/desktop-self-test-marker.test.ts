import { expect, it, vi } from "vitest";
import {
  beginSelfTestMarker,
  readSelfTestMarkers,
} from "../../apps/desktop/bridge/self-test-marker";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

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

it("requires the exact one-shot marker acknowledgement", async () => {
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
      data: selection,
    }),
  );
  expect(
    await beginSelfTestMarker({ request }, context, selection, publication),
  ).toBe("durable");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "computer.selftest.marker.begin",
  ]);
  expect(
    await beginSelfTestMarker({ request }, context, selection, {
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
    await beginSelfTestMarker({ request }, context, selection, publication),
  ).toBe("unknown");
  expect(request).toHaveBeenCalledTimes(1);
});
