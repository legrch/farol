import { expect, it, vi } from "vitest";
import { readSelfTestHistory } from "../../apps/desktop/bridge/self-test-history";
import type { Json, Outcome } from "../../apps/desktop/bridge/wire";

const context = { profileId: "profile", backendGeneration: "backend" };
const original = {
  operationId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "work",
  computerGeneration: "1",
  planVersion: "2",
};

it("reads the original prepared attempt without dispatching it", async () => {
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
  const history = await readSelfTestHistory({ request }, context, "work");
  expect(history).toEqual([{ selection: original, phase: "prepared" }]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toBe("computer.selftest.history");
  expect(Object.isFrozen(history[0]?.selection)).toBe(true);
});

it.each([
  "context",
  "workspace",
  "duplicate",
  "missing-version",
  "unavailable",
])("does not turn %s history into an empty result", async (mode) => {
  const request = vi.fn(
    async (
      _method: string,
      _body: Json,
      options: { id?: string },
    ): Promise<Outcome> => ({
      status: mode === "unavailable" ? "unavailable" : "ok",
      requestId: options.id!,
      context:
        mode === "context" ? { ...context, profileId: "other" } : context,
      ...(mode === "unavailable"
        ? {}
        : {
            data: {
              workspaceId: mode === "workspace" ? "other" : "work",
              entries:
                mode === "duplicate"
                  ? [
                      { selection: original, phase: "prepared" },
                      { selection: original, phase: "prepared" },
                    ]
                  : [
                      {
                        selection:
                          mode === "missing-version"
                            ? {
                                operationId: original.operationId,
                                workspaceId: "work",
                                computerGeneration: "1",
                              }
                            : original,
                        phase: "prepared",
                      },
                    ],
            },
          }),
    }),
  );
  await expect(
    readSelfTestHistory({ request }, context, "work"),
  ).rejects.toMatchObject({ code: "self_test_history_unavailable" });
  expect(request).toHaveBeenCalledTimes(1);
});
