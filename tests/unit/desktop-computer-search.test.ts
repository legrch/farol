import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client.ts";
import { ComputerBridge } from "../../apps/desktop/bridge/computer.ts";
import {
  maxFrameBytes,
  type ComputerSearchRequest,
} from "../../apps/desktop/bridge/wire.ts";

// Injected transport and fabricated JSON only; no backend or filesystem evidence.
const body: ComputerSearchRequest = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: "9007199254740993",
  participantId: "participant",
  turnId: "turn",
  generation: "18446744073709551615",
  callId: "call",
  workspaceId: "workspace",
  relativePath: "src",
  pattern: "日本語|🌊",
};
const call = {
  requestId: "request",
  context: { profileId: "profile", backendGeneration: "backend" },
};
const match = {
  path: "src/日本語.md",
  line: "9007199254740991",
  text: "🌊\t日本語",
  truncated: true,
};
const reply = (
  matches: unknown = [match],
  resultLimited = false,
  scanLimited = false,
) => ({
  status: "ok",
  requestId: call.requestId,
  context: call.context,
  data: { ...body, matches, resultLimited, scanLimited },
});
async function checkUnknown(raw: unknown, code = "invalid_computer_result") {
  const request = vi.fn().mockResolvedValue(raw);
  const result = await new ComputerBridge({ request }).search(body, call);
  expect(result).toMatchObject({ status: "unknown", code, retry: "never" });
  expect(result).not.toHaveProperty("data");
  expect(request).toHaveBeenCalledTimes(1);
}

describe("Computer Search bridge (pure only)", () => {
  it("retains exact non-ASCII data, flags, safe decimal lines and immutable snapshots", async () => {
    const raw = reply();
    const request = vi.fn().mockResolvedValue(raw);
    const result = await new ComputerBridge({ request }).search(body, {
      ...call,
      timeoutMs: 1000,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "computer.workspace.search",
      body,
      { id: "request", timeoutMs: 1000 },
    );
    expect(result).toMatchObject({ status: "ok", data: raw.data });
    if (result.status !== "ok") throw Error("missing result");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    expect(Object.isFrozen(result.data.matches)).toBe(true);
    expect(Object.isFrozen(result.data.matches[0])).toBe(true);
    raw.data.pattern = "changed";
    expect(result.data.pattern).toBe(body.pattern);
    expect(result.data.matches[0]).not.toBe(match);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "retains empty results with resultLimited=%s and scanLimited=%s",
    async (resultLimited, scanLimited) => {
      const request = vi
        .fn()
        .mockResolvedValue(reply([], resultLimited, scanLimited));
      expect(
        await new ComputerBridge({ request }).search(body, call),
      ).toMatchObject({
        status: "ok",
        data: { matches: [], resultLimited, scanLimited },
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["src", "src/nested/file", "src/one space.md"])(
    "allows exact or subtree path %s",
    async (path) => {
      const request = vi.fn().mockResolvedValue(reply([{ ...match, path }]));
      expect(
        await new ComputerBridge({ request }).search(body, call),
      ).toMatchObject({ status: "ok" });
    },
  );
  it("allows workspace-root Search and exactly 100 maximum-size Unicode excerpts", async () => {
    const input = { ...body, relativePath: ".", pattern: "🌊".repeat(1024) };
    const matches = Array.from({ length: 100 }, (_, i) => ({
      path: `日本語/${i}`,
      line: "1",
      text: "🌊".repeat(500),
      truncated: false,
    }));
    const request = vi.fn().mockResolvedValue({
      ...reply(),
      data: { ...input, matches, resultLimited: true, scanLimited: true },
    });
    expect(
      await new ComputerBridge({ request }).search(input, call),
    ).toMatchObject({ status: "ok", data: { matches } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: "../private" },
    { path: "." },
    { path: "src/.." },
    { path: "src/./file" },
    { path: "/src/file" },
    { path: "src\\file" },
    { path: "src//file" },
    { path: "src/" },
    { path: "src-other/file" },
    { path: "other/file" },
    { path: "src/bad\nfile" },
    { path: "src/\ud800" },
    { path: "src/" + "🌊".repeat(1024) },
    { path: "" },
    { line: "0" },
    { line: "01" },
    { line: "-1" },
    { line: "1.5" },
    { line: 1 },
    { line: "9007199254740992" },
    { line: "18446744073709551616" },
    { text: "a".repeat(501) },
    { text: "🌊".repeat(501) },
    { text: "\ud800" },
    { text: "line\nnext" },
    { text: "\r" },
    { text: "\0" },
    { text: "\u001f" },
    { text: "\u007f" },
    { truncated: "true" },
    { extra: true },
  ])("withholds malformed or out-of-scope match %#", async (extra) => {
    await checkUnknown(reply([{ ...match, ...extra }]));
  });
  it.each([null, {}, [null], [{}], Array(101).fill(match)])(
    "withholds malformed match array %#",
    async (matches) => {
      await checkUnknown(reply(matches));
    },
  );
  it.each([
    { resultLimited: "false" },
    { scanLimited: null },
    { matches: undefined },
    { resultLimited: undefined },
    { scanLimited: undefined },
  ])("withholds missing or malformed response fields %#", async (extra) => {
    await checkUnknown({ ...reply(), data: { ...reply().data, ...extra } });
  });

  it.each(Object.keys(body))("withholds crossed echoed %s", async (key) => {
    const replacement =
      key === "taskEpoch" || key === "generation" ? "1" : "crossed";
    await checkUnknown(
      { ...reply(), data: { ...reply().data, [key]: replacement } },
      "crossed_computer_response",
    );
  });
  it.each([
    { requestId: "crossed" },
    { context: { ...call.context, profileId: "crossed" } },
    { context: { ...call.context, backendGeneration: "crossed" } },
    { operationId: "unexpected" },
  ])("withholds crossed envelope %#", async (extra) => {
    await checkUnknown({ ...reply(), ...extra }, "crossed_computer_response");
  });

  it.each([
    { pattern: "" },
    { pattern: "🌊".repeat(1025) },
    { pattern: "\ud800" },
    { relativePath: "../src" },
    { relativePath: "/src" },
    { relativePath: "src/./file" },
    { relativePath: "src//file" },
    { relativePath: "src\\file" },
    { relativePath: "src\nfile" },
    { authority: "allow" },
  ])("refuses invalid input before dispatch %#", async (extra) => {
    const request = vi.fn();
    await expect(
      new ComputerBridge({ request }).search({ ...body, ...extra }, call),
    ).rejects.toMatchObject({
      state: "refused",
      code: "invalid_computer_request",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves native POSIX colon paths and C1 text under the Go contract", async () => {
    const input = { ...body, relativePath: "C:/src" };
    const data = {
      ...reply().data,
      ...input,
      matches: [
        { ...match, path: "C:/src/note\u0085.md", text: "native\u0085text" },
      ],
    };
    const request = vi.fn().mockResolvedValue({ ...reply(), data });
    expect(
      await new ComputerBridge({ request }).search(input, call),
    ).toMatchObject({ status: "ok", data });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("snapshots inputs before asynchronous dispatch and rejects getters without invoking them", async () => {
    const input = { ...body };
    const selection = { ...call, context: { ...call.context } };
    const request = vi.fn().mockResolvedValue(reply());
    const pending = new ComputerBridge({ request }).search(input, selection);
    input.pattern = "changed";
    selection.context.profileId = "changed";
    expect(await pending).toMatchObject({ status: "ok" });
    expect(request.mock.calls[0]?.[1]).toEqual(body);
    const getter = vi.fn(() => [match]);
    const raw = reply();
    Object.defineProperty(raw.data, "matches", {
      enumerable: true,
      get: getter,
    });
    await checkUnknown(raw);
    expect(getter).not.toHaveBeenCalled();
  });
  it("withholds sparse, cyclic and oversized JSON before disclosure", async () => {
    await checkUnknown(reply(Array(2)));
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    await checkUnknown(reply(cyclic));
    await checkUnknown(reply([{ ...match, text: "a".repeat(maxFrameBytes) }]));
  });

  it("preserves correlated refusal source and refuses crossed pattern or identity", async () => {
    const raw = {
      status: "refused",
      requestId: call.requestId,
      context: call.context,
      code: "AUTHORITY_PATH_DENIED",
      data: {
        request: body,
        code: "AUTHORITY_PATH_DENIED",
        source: "task-grant",
        retry: "never",
      },
    };
    const request = vi.fn().mockResolvedValue(raw);
    expect(
      await new ComputerBridge({ request }).search(body, call),
    ).toMatchObject({
      status: "refused",
      retry: "never",
      refusal: { request: body, source: "task-grant" },
    });
    for (const extra of [{ pattern: "crossed" }, { ownerId: "crossed" }]) {
      await checkUnknown(
        { ...raw, data: { ...raw.data, request: { ...body, ...extra } } },
        "crossed_computer_response",
      );
    }
  });
  it.each(["refused", "unknown", "unavailable", "unsupported"] as const)(
    "preserves %s with no retry",
    async (status) => {
      const request = vi.fn().mockResolvedValue({
        status,
        requestId: call.requestId,
        context: call.context,
        code: "EXACT_CODE",
      });
      expect(
        await new ComputerBridge({ request }).search(body, call),
      ).toMatchObject({ status, code: "EXACT_CODE", retry: "never" });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [
      new BridgeError("unavailable", "go_owner_unavailable"),
      "unavailable",
      "go_owner_unavailable",
    ],
    [
      new BridgeError("unknown", "go_outcome_unknown"),
      "unknown",
      "go_outcome_unknown",
    ],
    [new Error("private details"), "unknown", "computer_transport_failed"],
  ])(
    "preserves missing backend and uncertain transport without retry %#",
    async (error, status, code) => {
      const request = vi.fn().mockRejectedValue(error);
      const result = await new ComputerBridge({ request }).search(body, call);
      expect(result).toMatchObject({ status, code, retry: "never" });
      expect(JSON.stringify(result)).not.toContain("private details");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
