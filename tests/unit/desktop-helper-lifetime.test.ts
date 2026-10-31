import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifetimeChannel } from "../../src/modules/release/infra/native/desktop-helper-lifetime";
import type { InstalledUpdateRequest } from "../../src/modules/release/infra/native/installed-update-helper";

const request: InstalledUpdateRequest = {
  operationId: "a".repeat(32),
  action: "apply",
  installLocation: "shared",
  source: { buildId: "b".repeat(64), digest: "c".repeat(64), version: "0.5.2" },
  target: { buildId: "d".repeat(64), digest: "e".repeat(64), version: "0.5.3" },
  pid: 10,
  processStart: "Sat Oct 31 23:31:30 2026",
  waitSeconds: 120,
  relaunch: true,
  drain: {
    status: "reconciled",
    acceptedSource: "b".repeat(64),
    acceptedTarget: "d".repeat(64),
  },
};
const helper = { pid: 11, processStart: "Sat Oct 31 23:31:35 2026" };
const streams: PassThrough[] = [];
function channel() {
  const send = new PassThrough();
  const receive = new PassThrough();
  streams.push(send, receive);
  const channel = lifetimeChannel(
    send as unknown as Socket,
    receive as unknown as Socket,
  );
  return { send, receive, channel };
}
afterEach(() => {
  for (const s of streams.splice(0)) s.destroy();
  vi.useRealTimers();
});

describe("desktop helper lifetime custody", () => {
  it("rejects an expired ACK even when the timer callback has not run", async () => {
    vi.useFakeTimers();
    const f = channel();
    let frame = "";
    f.send.on("data", (chunk: Buffer) => {
      frame += chunk.toString();
    });
    const deadline = Date.now() + 15;
    const retained = f.channel.retain(request, helper, deadline);
    const rejected = expect(retained).rejects.toThrow("UNKNOWN");
    vi.setSystemTime(deadline);
    f.receive.write(frame);
    await rejected;
    expect(f.channel.available()).toBe(false);
  });
  it("accepts only a complete original correlated ACK without renewing its deadline", async () => {
    const f = channel();
    const deadline = Date.now() + 1000;
    let frame = "";
    f.send.on("data", (chunk: Buffer) => {
      frame += chunk.toString();
    });
    let resolved = false;
    const retained = f.channel.retain(request, helper, deadline).then(() => {
      resolved = true;
    });
    expect(JSON.parse(frame)).toMatchObject({
      operationId: request.operationId,
      predecessor: { pid: 10 },
      helper,
      source: request.source,
      target: request.target,
      deadlineAt: deadline,
    });
    f.receive.write(frame.slice(0, -1));
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.receive.write("\n");
    await retained;
    expect(resolved).toBe(true);
    expect(f.channel.available()).toBe(true);
  });

  it.each(["foreign", "duplicate", "overflow", "eof"])(
    "keeps %s ACK uncertain and closes further admission",
    async (kind) => {
      const f = channel();
      let frame = "";
      f.send.on("data", (chunk: Buffer) => {
        frame += chunk.toString();
      });
      const retained = f.channel.retain(request, helper, Date.now() + 1000);
      const rejected = expect(retained).rejects.toThrow(
        "UPDATE_HELPER_LIFETIME_UNKNOWN",
      );
      if (kind === "foreign")
        f.receive.write(frame.replace(request.operationId, "f".repeat(32)));
      if (kind === "duplicate") f.receive.write(frame + frame);
      if (kind === "overflow") f.receive.write("x".repeat(4097));
      if (kind === "eof") f.receive.end();
      await rejected;
      expect(f.channel.available()).toBe(false);
      await expect(
        f.channel.retain(request, helper, Date.now() + 1000),
      ).rejects.toThrow("UNAVAILABLE");
    },
  );

  it("lost ACK consumes the original bound and cannot be replaced by a late ACK", async () => {
    vi.useFakeTimers();
    const f = channel();
    let frame = "";
    f.send.on("data", (chunk: Buffer) => {
      frame += chunk.toString();
    });
    const retained = f.channel.retain(request, helper, Date.now() + 15);
    const rejected = expect(retained).rejects.toThrow("UNKNOWN");
    await vi.advanceTimersByTimeAsync(15);
    await rejected;
    expect(f.channel.available()).toBe(false);
    expect(frame.endsWith("\n")).toBe(true);
  });
});
