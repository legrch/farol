import { describe, expect, it } from "vitest";
import { correlation, parseHandoff, parseTerminal } from "./handoff";
import type { InstalledUpdateRequest } from "./request";

const build = (char: string, version: string) => ({
  digest: char.repeat(64),
  version,
  buildId: char.repeat(64),
});
const expected = {
  action: "apply",
  operationId: "3".repeat(32),
  source: build("a", "1.0.0"),
  target: build("b", "1.1.0"),
  drain: {
    status: "reconciled",
    acceptedSource: "a".repeat(64),
    acceptedTarget: "b".repeat(64),
  },
  pid: 42,
  processStart: "Mon Jan  1 00:00:00 2024",
  waitSeconds: 30,
  relaunch: true,
} as InstalledUpdateRequest;

const base = {
  schema: "farol.installed-update-handoff/1",
  operationId: expected.operationId,
  action: "apply",
  pid: 42,
  processStart: expected.processStart,
  source: expected.source,
  target: expected.target,
};
const frame = (event: unknown) => Buffer.from(JSON.stringify(event));

describe("parseHandoff", () => {
  it("accepts the exact waiting frame", () => {
    expect(
      parseHandoff(frame({ ...base, phase: "waiting_for_exit" }), expected),
    ).toEqual({ phase: "waiting_for_exit" });
  });

  it("refuses with a closed error code only", () => {
    expect(
      parseHandoff(
        frame({ ...base, phase: "refused", error: "quit_denied" }),
        expected,
      ),
    ).toEqual({ phase: "refused", error: "quit_denied" });
    expect(
      parseHandoff(
        frame({ ...base, phase: "refused", error: "Bad Code" }),
        expected,
      ),
    ).toBeNull();
  });

  it("rejects extra keys, wrong identity and invalid bytes", () => {
    expect(
      parseHandoff(
        frame({ ...base, phase: "waiting_for_exit", extra: 1 }),
        expected,
      ),
    ).toBeNull();
    expect(
      parseHandoff(
        frame({ ...base, pid: 43, phase: "waiting_for_exit" }),
        expected,
      ),
    ).toBeNull();
    expect(parseHandoff(Buffer.from("{}{}"), expected)).toBeNull();
  });

  it("requires lease identity and proof for a closed predecessor", () => {
    const predecessor = {
      kind: "confirmed_closed" as const,
      startedAt: "2024-01-01T00:00:00Z",
      lastQuitSha256: "c".repeat(64),
      stateIdentity: { device: "1", inode: "2" },
    };
    const closed = { ...expected, predecessor } as InstalledUpdateRequest;
    const lease = { device: "3", inode: "4" };
    const event = {
      ...base,
      phase: "closed_predecessor_ready",
      predecessor,
      leaseIdentity: lease,
    };
    expect(parseHandoff(frame(event), closed, lease)).toEqual({
      phase: "closed_predecessor_ready",
    });
    expect(parseHandoff(frame(event), closed)).toBeNull();
    expect(
      parseHandoff(
        frame({ ...event, phase: "waiting_for_exit" }),
        closed,
        lease,
      ),
    ).toBeNull();
  });
});

describe("parseTerminal", () => {
  const id = "4".repeat(32);
  it("parses phase with and without an error", () => {
    expect(
      parseTerminal(frame({ operationId: id, phase: "verified" }), id),
    ).toEqual({
      phase: "verified",
      error: null,
    });
    expect(
      parseTerminal(
        frame({ operationId: id, phase: "failed", error: "swap_failed" }),
        id,
      ),
    ).toEqual({ phase: "failed", error: "swap_failed" });
  });

  it("returns null for any mismatch", () => {
    expect(
      parseTerminal(frame({ operationId: id, phase: "Bad" }), id),
    ).toBeNull();
    expect(
      parseTerminal(frame({ operationId: "x", phase: "ok" }), id),
    ).toBeNull();
    expect(
      parseTerminal(frame({ operationId: id, phase: "ok", error: "A" }), id),
    ).toBeNull();
    expect(parseTerminal(Buffer.from("nope"), id)).toBeNull();
  });
});

describe("correlation", () => {
  it("carries the lease only with a predecessor", () => {
    const plain = correlation(expected, { device: "1", inode: "2" });
    expect("leaseIdentity" in plain).toBe(false);
    expect("relaunchPresentation" in plain).toBe(false);
  });
});
