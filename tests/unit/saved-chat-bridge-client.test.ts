import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netMock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: netMock.connect }));

import { SavedChatBridgeClient } from "../../src/apps/computer-mcp/saved-chat-bridge-client";
import { SAVED_CHAT_BRIDGE_PROTOCOL } from "../../src/pkg/saved-chat-bridge/protocol";

const key = "12345678-1234-4123-8123-123456789abc";
const foreign = "22345678-1234-4123-8123-123456789abc";
const verified = {
  status: "verified",
  dispatchId: key,
  conversationUrl: "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc",
  titleVerified: false,
} as const;

// Controlled socket fixtures, not native filesystem/account/Send proof.
class FixtureSocket extends EventEmitter {
  write = vi.fn();
  destroy = vi.fn(() => {
    this.emit("close");
    return this;
  });
}
function fixture(operation: "create" | "status" = "status", connect = true) {
  const socket = new FixtureSocket();
  netMock.connect.mockReturnValue(socket);
  const client = new SavedChatBridgeClient({
    protocol: SAVED_CHAT_BRIDGE_PROTOCOL,
    socketPath: "/fixture/chat.sock",
    token: "0".repeat(64),
  });
  const pending = client.request(
    operation === "create"
      ? {
          operation,
          request: { key, title: "Fixture", firstMessage: "Fixture only" },
        }
      : { operation, dispatchId: key, recheck: false },
  );
  if (connect) socket.emit("connect");
  return { socket, pending };
}
function frame(socket: FixtureSocket, value: unknown) {
  socket.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
}
beforeEach(() => {
  vi.useFakeTimers();
  netMock.connect.mockReset();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe("saved-chat client frame identity and lifecycle (controlled fixtures)", () => {
  it.each(["create", "status"] as const)(
    "refuses a foreign dispatch ID for %s without retry",
    async (operation) => {
      const { socket, pending } = fixture(operation);
      const assertion = expect(pending).rejects.toThrow(
        "SAVED_CHAT_BRIDGE_RESPONSE_INVALID",
      );
      frame(socket, { ...verified, dispatchId: foreign });
      await assertion;
      expect(netMock.connect).toHaveBeenCalledTimes(1);
      expect(socket.write).toHaveBeenCalledTimes(1);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["refused", "outcome_unknown"] as const)(
    "does not correlate a foreign %s reply",
    async (status) => {
      const { socket, pending } = fixture();
      const assertion = expect(pending).rejects.toThrow(
        "SAVED_CHAT_BRIDGE_RESPONSE_INVALID",
      );
      frame(socket, {
        status,
        dispatchId: foreign,
        ...(status === "refused"
          ? { code: "SAVED_CHAT_ADMISSION_DENIED" }
          : {}),
      });
      await assertion;
      expect(netMock.connect).toHaveBeenCalledTimes(1);
    },
  );
  it("settles a complete response before peer end and ignores later frames", async () => {
    const { socket, pending } = fixture();
    frame(socket, verified);
    await expect(pending).resolves.toEqual(verified);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    frame(socket, { ...verified, dispatchId: foreign });
    socket.emit("end");
    expect(netMock.connect).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...verified, error: { message: "mixed" } },
    { ...verified, result: verified },
    { status: "verified", dispatchId: key },
  ])("refuses malformed/mixed frame %# without retry", async (reply) => {
    const { socket, pending } = fixture();
    const assertion = expect(pending).rejects.toThrow(
      "SAVED_CHAT_BRIDGE_RESPONSE_INVALID",
    );
    frame(socket, reply);
    await assertion;
    expect(netMock.connect).toHaveBeenCalledTimes(1);
  });
  it("keeps an explicit unknown response as unknown", async () => {
    const { socket, pending } = fixture();
    frame(socket, { status: "unknown" });
    await expect(pending).resolves.toEqual({ status: "unknown" });
    expect(netMock.connect).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch on a late connect after the request deadline", async () => {
    const { socket, pending } = fixture("create", false);
    const assertion = expect(pending).rejects.toThrow(
      "SAVED_CHAT_BRIDGE_TIMEOUT",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    socket.emit("connect");
    expect(socket.write).not.toHaveBeenCalled();
    expect(netMock.connect).toHaveBeenCalledTimes(1);
  });
  it("settles an abrupt close without waiting for its timeout or retrying", async () => {
    const { socket, pending } = fixture();
    let outcome = "pending";
    const handled = pending.then(
      () => {
        outcome = "success";
      },
      (error: Error) => {
        outcome = error.message;
      },
    );
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(outcome).toBe("SAVED_CHAT_BRIDGE_UNAVAILABLE");
      expect(vi.getTimerCount()).toBe(0);
      expect(netMock.connect).toHaveBeenCalledTimes(1);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      await handled;
    }
  });
});
