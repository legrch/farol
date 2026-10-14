import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { observeLocalRuntime } from "../../src/apps/desktop/local-runtime-lifetime";
import { drainOwnedChildren } from "../../src/apps/desktop/quit-drain";

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    stdin: null,
    stdout: null as object | null,
    stderr: null,
    send: vi.fn((_message: string, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    }),
  });
  return {
    child,
    lifetime: observeLocalRuntime(child as unknown as ChildProcess),
  };
}
describe("local runtime original-child ownership", () => {
  it("waits for close, without counting shutdown ACK or exit alone as drain", async () => {
    const { child, lifetime } = fixture();
    const completed = vi.fn();
    const closed = lifetime.close().then(completed);
    expect(lifetime.close()).toBe(lifetime.closed);
    lifetime.requestStop();
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(child.send).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
    await closed;
    expect(completed).toHaveBeenCalledTimes(1);
  });
  it("keeps failed IPC admission unconfirmed until an original close is observed", async () => {
    const { child, lifetime } = fixture();
    child.send.mockImplementationOnce(() => {
      throw Error("IPC_CLOSED");
    });
    const receipt = await drainOwnedChildren(
      [{ name: "local-runtime", close: () => lifetime.close() }],
      5,
    );
    expect(receipt).toEqual({ drained: false, unconfirmed: ["local-runtime"] });
    lifetime.requestStop();
    expect(child.send).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
    await lifetime.closed;
  });
  it("does not accept a forced or failed terminal as a clean shutdown", async () => {
    const { child, lifetime } = fixture();
    child.emit("close", null, "SIGKILL");
    await expect(lifetime.closed).rejects.toThrow(
      "LOCAL_RUNTIME_SHUTDOWN_UNCONFIRMED",
    );
    expect(
      await drainOwnedChildren(
        [{ name: "local-runtime", close: () => lifetime.close() }],
        50,
      ),
    ).toEqual({ drained: false, unconfirmed: ["local-runtime"] });
    expect(child.send).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "accepts only the combined original exit and disconnected IPC without stdio (exitFirst=%s)",
    async (exitFirst) => {
      const { child, lifetime } = fixture();
      const completed = vi.fn();
      const closed = lifetime.closed.then(completed);
      if (exitFirst) child.emit("exit", 0, null);
      else child.emit("disconnect");
      await Promise.resolve();
      expect(completed).not.toHaveBeenCalled();
      if (exitFirst) child.emit("disconnect");
      else child.emit("exit", 0, null);
      await closed;
    },
  );
  it("still waits for stdio closure when a disconnected root has parent-owned pipes", async () => {
    const { child, lifetime } = fixture();
    child.stdout = {};
    const completed = vi.fn();
    const closed = lifetime.closed.then(completed);
    child.emit("disconnect");
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await closed;
  });
  it("retains the same pending lifetime after IPC has already disconnected", async () => {
    const { child, lifetime } = fixture();
    child.connected = false;
    const completed = vi.fn();
    const closed = lifetime.close().then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(child.send).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await closed;
  });
});
