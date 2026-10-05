import { expect, it, vi } from "vitest";
import { ComputerBridge } from "../../apps/desktop/bridge/computer";
import { methodKinds, validate } from "../../apps/desktop/bridge/wire";

const body = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  generation: "18446744073709551615",
  callId: "call",
  workspaceId: "workspace",
  relativePath: ".",
};
const call = {
  requestId: "request",
  context: { profileId: "profile", backendGeneration: "backend" },
};
const reply = (entries: unknown, truncated = false) => ({
  status: "ok",
  requestId: call.requestId,
  context: call.context,
  data: { ...body, entries, truncated },
});

it("returns exact names, uint64 correlation and partial listing without another dispatch", async () => {
  const request = vi
    .fn()
    .mockResolvedValue(
      reply(["AGENTS.md", "one space.md", "日本語.md", "folder/"], true),
    );
  const result = await new ComputerBridge({ request }).list(body, call);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw Error("missing result");
  expect(result.data).toEqual({
    ...body,
    entries: ["AGENTS.md", "one space.md", "日本語.md", "folder/"],
    truncated: true,
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "computer.workspace.list",
    body,
    { id: "request" },
  );
});

it.each([
  null,
  {},
  ["../private"],
  ["nested/file"],
  ["."],
  [".."],
  ["a", "a/"],
  ["bad\nname"],
  ["🌊".repeat(64)],
  ["\ud800"],
  Array(501).fill("file"),
])("withholds malformed listing %#", async (entries) => {
  const request = vi.fn().mockResolvedValue(reply(entries));
  const result = await new ComputerBridge({ request }).list(body, call);
  expect(result).toMatchObject({
    status: "unknown",
    code: "invalid_computer_result",
    retry: "never",
  });
  expect(request).toHaveBeenCalledTimes(1);
});

it("keeps empty and truncated-empty distinct and refuses crossed identities", async () => {
  for (const truncated of [false, true]) {
    const request = vi.fn().mockResolvedValue(reply([], truncated));
    expect(
      await new ComputerBridge({ request }).list(body, call),
    ).toMatchObject({ status: "ok", data: { entries: [], truncated } });
  }
  for (const key of ["callId", "generation", "workspaceId", "taskEpoch"]) {
    const request = vi.fn().mockResolvedValue({
      ...reply([]),
      data: { ...reply([]).data, [key]: "wrong" },
    });
    expect(
      await new ComputerBridge({ request }).list(body, call),
    ).toMatchObject({ status: "unknown", retry: "never" });
  }
});

it("validates method advertisement separately from bounded workspace ID arrays", () => {
  const methods = Object.keys(methodKinds);
  expect(methods.length).toBeGreaterThan(64);
  expect(validate("method[]", methods)).toBe(true);
  expect(validate("method[]", [...methods, methods[0]])).toBe(false);
  expect(validate("method[]", ["computer.unknown"])).toBe(false);
  expect(validate("method[]", Array(129).fill("core.status"))).toBe(false);
  expect(validate("text[]", Array(64).fill("workspace"))).toBe(true);
  expect(validate("text[]", Array(65).fill("workspace"))).toBe(false);
});
