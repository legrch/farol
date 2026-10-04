import { afterEach, describe, expect, it, vi } from "vitest";
import { observeBoundChatGptAccount } from "../../apps/desktop/chatgpt-account-observation.ts";
import type { PhysicalSurface } from "../../apps/desktop/chatgpt-physical-host-port.ts";

// Host mechanics only. Page execution and native surfaces are explicit doubles;
// the real page parser has its separate VM corpus. No provider/approval/Send.
function fixture() {
  let now = 1000;
  const first: PhysicalSurface = {
    handle: {},
    binding: {
      viewId: "17",
      viewGeneration: 1,
      documentGeneration: 1,
      partition: "persist:farol-dev-chatgpt",
      phase: "home",
      url: "https://chatgpt.com/",
      conversationId: null,
    },
    isDestroyed: () => false,
  };
  let current: PhysicalSurface | null = first;
  const observation = {
    state: "observed",
    source: "provider-session-v1",
    accountKey: "c".repeat(64),
    observedAtMillis: 1000,
    expiresAtMillis: 10000,
    documentUrl: first.binding.url,
  };
  const read = vi.fn(async () => structuredClone(observation) as unknown);
  const input = {
    e2eOrigin: null as string | null,
    snapshot: () => current,
    read,
    now: () => now,
  };
  return {
    first,
    observation,
    read,
    input,
    setCurrent: (v: PhysicalSurface | null) => {
      current = v;
    },
    setNow: (v: number) => {
      now = v;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("account observation bound to physical surface", () => {
  it("reads once and returns detached exact document facts", async () => {
    const f = fixture();
    const value = await observeBoundChatGptAccount(f.input);
    expect(value).toEqual({ binding: f.first.binding, account: f.observation });
    expect(value?.binding).not.toBe(f.first.binding);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.first);
    f.observation.accountKey = "d".repeat(64);
    expect(value?.account.accountKey).toBe("c".repeat(64));
  });
  it.each(["missing", "destroyed", "origin", "policy-origin", "invalid-clock"])(
    "refuses %s before page execution",
    async (variant) => {
      const f = fixture();
      if (variant === "missing") f.setCurrent(null);
      if (variant === "destroyed")
        f.setCurrent({ ...f.first, isDestroyed: () => true });
      if (variant === "origin")
        f.setCurrent({
          ...f.first,
          binding: { ...f.first.binding, url: "https://example.invalid/" },
        });
      if (variant === "policy-origin")
        f.input.e2eOrigin = "https://example.invalid";
      if (variant === "invalid-clock") f.setNow(0);
      expect(await observeBoundChatGptAccount(f.input)).toBeNull();
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it.each([
    "handle",
    "document",
    "view-generation",
    "partition",
    "gone",
    "destroyed",
    "time-backwards",
    "time-late",
    "expired",
    "future",
    "pre-existing",
    "url",
    "private-field",
    "throw",
    "unavailable",
  ])("refuses %s across the awaited page read", async (variant) => {
    const f = fixture();
    f.read.mockImplementationOnce(async () => {
      if (variant === "handle") f.setCurrent({ ...f.first, handle: {} });
      if (variant === "document")
        f.setCurrent({
          ...f.first,
          binding: { ...f.first.binding, documentGeneration: 2 },
        });
      if (variant === "view-generation")
        f.setCurrent({
          ...f.first,
          binding: { ...f.first.binding, viewGeneration: 2 },
        });
      if (variant === "partition")
        f.setCurrent({
          ...f.first,
          binding: {
            ...f.first.binding,
            partition: "persist:farol-next-chatgpt",
          },
        });
      if (variant === "gone") f.setCurrent(null);
      if (variant === "destroyed")
        f.setCurrent({ ...f.first, isDestroyed: () => true });
      if (variant === "time-backwards") f.setNow(999);
      if (variant === "time-late") f.setNow(6000);
      if (variant === "expired")
        return { ...f.observation, expiresAtMillis: 1000 };
      if (variant === "future")
        return { ...f.observation, observedAtMillis: 1001 };
      if (variant === "pre-existing")
        return { ...f.observation, observedAtMillis: 999 };
      if (variant === "url")
        return { ...f.observation, documentUrl: "https://chatgpt.com/c/other" };
      if (variant === "private-field")
        return { ...f.observation, token: "must-not-escape" };
      if (variant === "throw")
        throw new Error("private provider body must not escape");
      if (variant === "unavailable")
        return { state: "unavailable", code: "session_refused" };
      return f.observation;
    });
    expect(await observeBoundChatGptAccount(f.input)).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("allows a canonical fixture only under its exact selected loopback origin", async () => {
    const f = fixture();
    f.input.e2eOrigin = "http://127.0.0.1:43210";
    f.setCurrent({
      ...f.first,
      binding: { ...f.first.binding, url: "http://127.0.0.1:43210/chatgpt" },
    });
    f.observation.documentUrl = "http://127.0.0.1:43210/chatgpt";
    expect(await observeBoundChatGptAccount(f.input)).not.toBeNull();
    f.input.e2eOrigin = "http://127.0.0.1:43211";
    expect(await observeBoundChatGptAccount(f.input)).toBeNull();
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("bounds a hanging native read and does not retry a late rejection", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let reject!: (e: Error) => void;
    f.read.mockReturnValueOnce(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    const pending = observeBoundChatGptAccount(f.input);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    reject(new Error("late private error"));
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
