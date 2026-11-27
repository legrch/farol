import { describe, expect, it } from "vitest";
import { initial } from "../../../apps/desktop/renderer/snapshot";
import type { ChatHistoryContext } from "../../pkg/ipc/chat-history";
import type { WindowSnapshot } from "./contract";
import {
  chatHistoryCrossed,
  readSuperseded,
  readUnavailable,
  retiredReplyCrossed,
  sameOrBothAbsent,
} from "./fence";

const context: ChatHistoryContext = {
  profileId: "profile",
  backendGeneration: "gen-1",
};
const other: ChatHistoryContext = { ...context, backendGeneration: "gen-2" };
const snap = (patch: Partial<WindowSnapshot> = {}): WindowSnapshot => ({
  ...initial,
  status: "current",
  buildId: "build",
  chatHistoryContext: context,
  ...patch,
});
const revisions = { stale: 1, runtime: 2, history: 3 };

describe("read availability", () => {
  it("needs a live, current window with a transport", () => {
    expect(readUnavailable(false, snap(), true)).toBe(false);
    expect(readUnavailable(true, snap(), true)).toBe(true);
    expect(readUnavailable(false, snap({ status: "stale" }), true)).toBe(true);
    expect(readUnavailable(false, snap(), false)).toBe(true);
  });
});

describe("readSuperseded", () => {
  const base = {
    disposed: false,
    before: snap(),
    now: snap(),
    context,
    captured: revisions,
    current: revisions,
  };
  it("holds while nothing the read was asked against has moved", () => {
    expect(readSuperseded(base)).toBe(false);
  });
  it.each([
    ["disposed", { disposed: true }],
    ["status", { now: snap({ status: "stale" }) }],
    ["stale revision", { current: { ...revisions, stale: 2 } }],
    ["runtime revision", { current: { ...revisions, runtime: 3 } }],
    ["history revision", { current: { ...revisions, history: 4 } }],
    ["build", { now: snap({ buildId: "other" }) }],
    ["context", { now: snap({ chatHistoryContext: other }) }],
    ["lost context", { now: snap({ chatHistoryContext: null }) }],
  ])("is superseded by %s", (_name, patch) => {
    expect(readSuperseded({ ...base, ...patch })).toBe(true);
  });
});

describe("chatHistoryCrossed", () => {
  const key = { backendGeneration: "gen-1", operationId: "op-1" };
  const page = (offset: number) =>
    ({ context, value: { kind: "page", offset, entries: [] } }) as never;
  const result = (operationId: string, backendGeneration: string) =>
    ({
      context,
      value: {
        kind: "result",
        entry: { key: { operationId, backendGeneration } },
      },
    }) as never;
  it("accepts a reply that answers the query", () => {
    expect(
      chatHistoryCrossed(page(5), context, { kind: "list", offset: 5 }),
    ).toBe(false);
    expect(
      chatHistoryCrossed(result("op-1", "gen-1"), context, {
        kind: "result",
        offset: 0,
        key,
      }),
    ).toBe(false);
  });
  it("rejects another context, kind, offset or key", () => {
    expect(
      chatHistoryCrossed(page(5), other, { kind: "list", offset: 5 }),
    ).toBe(true);
    expect(
      chatHistoryCrossed(page(5), context, { kind: "list", offset: 6 }),
    ).toBe(true);
    expect(
      chatHistoryCrossed(page(0), context, { kind: "result", offset: 0, key }),
    ).toBe(true);
    expect(
      chatHistoryCrossed(result("op-2", "gen-1"), context, {
        kind: "result",
        offset: 0,
        key,
      }),
    ).toBe(true);
    expect(
      chatHistoryCrossed(result("op-1", "gen-2"), context, {
        kind: "result",
        offset: 0,
        key,
      }),
    ).toBe(true);
  });
});

describe("retiredReplyCrossed", () => {
  const reply = (data: unknown, status = "ok") =>
    ({ context, result: { status, data } }) as never;
  it("accepts an ok reply that answers the query", () => {
    expect(
      retiredReplyCrossed(
        reply({ kind: "archive-list", after: "a" }),
        context,
        { kind: "archive-list", after: "a" } as never,
      ),
    ).toBe(false);
    expect(
      retiredReplyCrossed(
        reply({ kind: "archive-read", summary: { key: "k", digest: "d" } }),
        context,
        { kind: "archive-read", key: "k", digest: "d" } as never,
      ),
    ).toBe(false);
  });
  it("rejects a refused, foreign or mismatched reply", () => {
    const list = { kind: "archive-list", after: "a" } as never;
    expect(retiredReplyCrossed(reply({}, "refused"), context, list)).toBe(true);
    expect(
      retiredReplyCrossed(
        reply({ kind: "archive-list", after: "a" }),
        other,
        list,
      ),
    ).toBe(true);
    expect(
      retiredReplyCrossed(
        reply({ kind: "archive-list", after: "b" }),
        context,
        list,
      ),
    ).toBe(true);
    expect(
      retiredReplyCrossed(
        reply({ kind: "archive-read", summary: { key: "k", digest: "x" } }),
        context,
        { kind: "archive-read", key: "k", digest: "d" } as never,
      ),
    ).toBe(true);
  });
});

describe("sameOrBothAbsent", () => {
  it("treats two absent contexts as the same, unlike the context test", () => {
    expect(sameOrBothAbsent(null, null)).toBe(true);
    expect(sameOrBothAbsent(context, { ...context })).toBe(true);
    expect(sameOrBothAbsent(context, other)).toBe(false);
    expect(sameOrBothAbsent(context, null)).toBe(false);
  });
});
