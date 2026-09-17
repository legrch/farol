import { describe, expect, it, vi } from "vitest";

import { compactCodexHostThread } from "../../src/apps/desktop/codex-host-compaction";

class FakePeer {
  readonly request = vi.fn(async () => ({}));
  private readonly handlers = new Map<string, (params: unknown) => void>();

  handleNotification(
    method: string,
    handler: (params: unknown) => void,
  ): () => void {
    if (this.handlers.has(method)) throw new Error("duplicate handler");
    this.handlers.set(method, handler);
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method);
    };
  }

  notify(method: string, params: unknown): void {
    this.handlers.get(method)?.(params);
  }

  handlerCount(): number {
    return this.handlers.size;
  }
}

describe("native Codex host compaction", () => {
  it("waits for the exact compaction item and its completed turn after acknowledgement", async () => {
    const peer = new FakePeer();
    let settled = false;
    const pending = compactCodexHostThread(peer, {
      threadId: "thread-owner-1",
      timeoutMs: 1_000,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(peer.request).toHaveBeenCalledWith("thread/compact/start", {
        threadId: "thread-owner-1",
      });
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    peer.notify("item/completed", {
      threadId: "thread-foreign",
      turnId: "turn-foreign",
      completedAtMs: 1,
      item: { id: "item-foreign", type: "contextCompaction" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    peer.notify("item/completed", {
      threadId: "thread-owner-1",
      turnId: "turn-compact-1",
      completedAtMs: 2,
      item: { id: "item-compact-1", type: "contextCompaction" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    peer.notify("turn/completed", {
      threadId: "thread-owner-1",
      turn: { id: "turn-stale", status: "completed" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    peer.notify("turn/completed", {
      threadId: "thread-owner-1",
      turn: { id: "turn-compact-1", status: "completed" },
    });

    await expect(pending).resolves.toEqual({
      threadId: "thread-owner-1",
      turnId: "turn-compact-1",
      itemId: "item-compact-1",
      signal: "turn_completed",
    });
    expect(peer.handlerCount()).toBe(0);
  });

  it("fails closed when the exact compaction turn does not complete", async () => {
    const peer = new FakePeer();
    const pending = compactCodexHostThread(peer, {
      threadId: "thread-owner-1",
      timeoutMs: 1_000,
    });

    await vi.waitFor(() => expect(peer.request).toHaveBeenCalledTimes(1));
    peer.notify("turn/completed", {
      threadId: "thread-owner-1",
      turn: { id: "turn-compact-failed", status: "failed" },
    });
    peer.notify("item/completed", {
      threadId: "thread-owner-1",
      turnId: "turn-compact-failed",
      completedAtMs: 2,
      item: { id: "item-compact-failed", type: "contextCompaction" },
    });

    await expect(pending).rejects.toThrow("CODEX_HOST_COMPACTION_FAILED");
    expect(peer.handlerCount()).toBe(0);
  });

  it("accepts the installed host legacy completion signal without treating ack as completion", async () => {
    const peer = new FakePeer();
    const pending = compactCodexHostThread(peer, {
      threadId: "thread-owner-1",
      timeoutMs: 50,
    });

    await vi.waitFor(() => expect(peer.request).toHaveBeenCalledTimes(1));
    peer.notify("thread/compacted", {
      threadId: "thread-owner-1",
      turnId: "turn-compact-legacy",
    });

    await expect(pending).resolves.toEqual({
      threadId: "thread-owner-1",
      turnId: "turn-compact-legacy",
      itemId: null,
      signal: "thread_compacted",
    });
    expect(peer.handlerCount()).toBe(0);
  });

  it("fails closed on invalid input or missing completion", async () => {
    const peer = new FakePeer();

    await expect(
      compactCodexHostThread(peer, { threadId: "", timeoutMs: 10 }),
    ).rejects.toThrow("CODEX_HOST_COMPACTION_INPUT_INVALID");
    await expect(
      compactCodexHostThread(peer, {
        threadId: "thread-owner-1",
        timeoutMs: 10,
      }),
    ).rejects.toThrow("CODEX_HOST_COMPACTION_TIMEOUT");
    expect(peer.handlerCount()).toBe(0);
  });
});
