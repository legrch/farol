import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCodexThreadRuntime } from "../../src/modules/chat/app/service/read-codex-thread-runtime";
import { CodexThreadRuntimeSchema } from "../../src/modules/chat/contract/codex-task-route";

const snapshot = {
  scope: "thread",
  source: "thread/read",
  snapshot: "non-atomic",
};
describe("closed thread runtime observation", () => {
  it.each(["notLoaded", "idle", "systemError"])(
    "reads %s without inferring a terminal turn",
    (state) => {
      const result = readCodexThreadRuntime({
        type: state,
        privatePayload: "not forwarded",
      });
      expect(result).toEqual({ ...snapshot, state });
      expect(CodexThreadRuntimeSchema.safeParse(result).success).toBe(true);
    },
  );
  it.each([
    { activeFlags: [] },
    { activeFlags: ["waitingOnApproval"] },
    { activeFlags: ["waitingOnUserInput"] },
    { activeFlags: ["waitingOnUserInput", "waitingOnApproval"] },
  ])("reads active flags %j without granting a decision", ({ activeFlags }) => {
    const result = readCodexThreadRuntime({ type: "active", activeFlags });
    expect(result).toEqual({ ...snapshot, state: "active", activeFlags });
    expect(CodexThreadRuntimeSchema.safeParse(result).success).toBe(true);
  });
  it("does not expose or retain the provider's mutable array", () => {
    const input = {
      type: "active",
      activeFlags: ["waitingOnApproval"],
      payload: "private request",
    };
    const result = readCodexThreadRuntime(input);
    input.activeFlags.push("waitingOnUserInput");
    expect(result).toEqual({
      ...snapshot,
      state: "active",
      activeFlags: ["waitingOnApproval"],
    });
  });
  it("makes omitted status explicitly unavailable", () => {
    expect(readCodexThreadRuntime(undefined)).toEqual({
      ...snapshot,
      state: "unavailable",
    });
  });
  it.each([
    null,
    [],
    false,
    1,
    "idle",
    {},
    { type: "unavailable" },
    { type: "active" },
    { type: "active", activeFlags: null },
    { type: "active", activeFlags: ["new"] },
    { type: "active", activeFlags: ["waitingOnApproval", "waitingOnApproval"] },
    {
      type: "active",
      activeFlags: ["waitingOnApproval", "waitingOnUserInput", "new"],
    },
    { type: "idle", activeFlags: [] },
  ])("refuses malformed or unsupported status %j", (value) => {
    expect(readCodexThreadRuntime(value)).toBeNull();
  });
  it.each([
    { ...snapshot, state: "active" },
    {
      ...snapshot,
      state: "active",
      activeFlags: ["waitingOnApproval", "waitingOnApproval"],
    },
    { ...snapshot, state: "idle", activeFlags: [] },
    { ...snapshot, state: "idle", payload: "private" },
    { ...snapshot, scope: "turn", state: "idle" },
  ])("refuses invalid public metadata %j", (value) => {
    expect(CodexThreadRuntimeSchema.safeParse(value).success).toBe(false);
  });
  it.skipIf(!process.env.FAROL_CODEX_SCHEMA_ROOT)(
    "matches the selected saved CLI schema without launching a host",
    async () => {
      const root = process.env.FAROL_CODEX_SCHEMA_ROOT;
      if (!root) throw new Error("SCHEMA_ROOT_REQUIRED");
      const schema = JSON.parse(
        await fs.readFile(
          path.join(root, "v2/ThreadReadResponse.json"),
          "utf8",
        ),
      );
      expect(schema.definitions.Thread.properties.status.allOf).toEqual([
        { $ref: "#/definitions/ThreadStatus" },
      ]);
      expect(schema.definitions.ThreadActiveFlag.enum).toEqual([
        "waitingOnApproval",
        "waitingOnUserInput",
      ]);
      expect(
        schema.definitions.ThreadStatus.oneOf.map(
          (state: any) => state.properties.type.enum[0],
        ),
      ).toEqual(["notLoaded", "idle", "systemError", "active"]);
    },
  );
});
