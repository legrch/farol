import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedCodexProxyHost } from "../../src/modules/chat/infra/native/shared-codex-proxy-host";
import { HandoffNotSubmittedError } from "../../src/modules/chat/app/service/persistent-codex-handoff";

// No native child, signal, socket, daemon or owner state is used by this fixture.
function fixture(kill: (signal?: NodeJS.Signals | number) => boolean) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(kill),
  });
  const writes: unknown[] = [];
  let markReadSent: () => void = () => {};
  const readSent = new Promise<void>((resolve) => {
    markReadSent = resolve;
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as {
      id?: number;
      method?: string;
    };
    writes.push(request);
    if (request.method === "thread/read") markReadSent();
    if (request.method === "initialize") {
      child.stdout.write(
        `${JSON.stringify({
          id: request.id,
          result: {
            codexHome: "/fixture/codex-home",
            platformFamily: "unix",
            platformOs: "macos",
            userAgent: "fixture",
          },
        })}\n`,
      );
    }
  });
  const launch = vi.fn(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  const host = new SharedCodexProxyHost(launch, "/fixture/codex-home");
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("exit", code, signal);
  };
  return { host, child, launch, writes, exit, readSent };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("owned proxy cleanup refusal fixture", () => {
  it.each(["EPERM", "false"])(
    "keeps %s signal failure unverified without another signal or launch",
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture(() => {
        if (kind === "EPERM")
          throw Object.assign(new Error("synthetic refusal"), {
            code: "EPERM",
          });
        return false;
      });
      await f.host.connect();
      const pending = f.host.request("thread/read", { threadId: "owned" });
      const outcome = pending.catch((error: unknown) => error);
      await f.readSent;
      expect(() => f.host.close()).not.toThrow();
      const terminal = f.host.closeAndWait();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await terminal).toBe(false);
      expect(await outcome).toBeInstanceOf(Error);
      expect(await outcome).not.toBeInstanceOf(HandoffNotSubmittedError);
      expect(f.child.kill.mock.calls).toEqual([["SIGTERM"]]);
      const again = f.host.closeAndWait();
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await again).toBe(false);
      await expect(f.host.request("turn/start", {})).rejects.toThrow(
        "CODEX_SHARED_HOST_UNAVAILABLE",
      );
      expect(f.child.kill.mock.calls).toEqual([["SIGTERM"]]);
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.writes).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.child.listenerCount("exit")).toBe(1);
    },
  );

  it("confirms only a later observed exit after a refused signal", async () => {
    vi.useFakeTimers();
    const f = fixture(() => {
      throw Object.assign(new Error("synthetic refusal"), { code: "EPERM" });
    });
    await f.host.connect();
    const terminal = f.host.closeAndWait();
    f.exit(0, null);
    expect(await terminal).toBe(true);
    expect(await f.host.closeAndWait()).toBe(true);
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not signal a proxy already observed to exit by signal", async () => {
    const f = fixture(() => true);
    await f.host.connect();
    f.exit(null, "SIGTERM");
    expect(await f.host.closeAndWait()).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("keeps a refused escalation unverified and never repeats it", async () => {
    vi.useFakeTimers();
    const f = fixture((signal) => {
      if (signal === "SIGKILL")
        throw Object.assign(new Error("synthetic refusal"), { code: "EPERM" });
      return true;
    });
    await f.host.connect();
    const terminal = f.host.closeAndWait();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await terminal).toBe(false);
    const again = f.host.closeAndWait();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await again).toBe(false);
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one escalation across concurrent cleanup reads", async () => {
    vi.useFakeTimers();
    const f = fixture(() => true);
    await f.host.connect();
    const first = f.host.closeAndWait();
    const second = f.host.closeAndWait();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    const later = f.host.closeAndWait();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await later).toBe(false);
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires observed exit even after successful signal delivery", async () => {
    vi.useFakeTimers();
    const f = fixture(() => true);
    await f.host.connect();
    const terminal = f.host.closeAndWait();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(f.child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    f.exit(null, "SIGKILL");
    expect(await terminal).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
