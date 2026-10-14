import { describe, expect, it, vi } from "vitest";
import { runParentOwnedRuntime } from "../../src/apps/runtime/parent-owned-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function ports() {
  let stop!: () => void;
  const parent = {
    onStop: (handler: () => void) => {
      stop = handler;
    },
    connected: vi.fn(() => true),
    ready: vi.fn(),
    closed: vi.fn(),
    exit: vi.fn(),
  };
  return { parent, stop: () => stop() };
}
describe("parent-owned runtime shutdown", () => {
  it("installs ownership before startup and closes its late result after parent loss", async () => {
    const started = deferred<{ close(): Promise<void> }>();
    const runtime = { close: vi.fn(async () => undefined) };
    const { parent, stop } = ports();
    const start = vi.fn(() => started.promise);
    const original = runParentOwnedRuntime(start, parent);
    stop();
    stop();
    parent.connected.mockReturnValue(false);
    started.resolve(runtime);
    await original;
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(parent.ready).not.toHaveBeenCalled();
    expect(parent.closed).not.toHaveBeenCalled();
    expect(parent.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("does not start a service whose parent is already disconnected", async () => {
    const { parent } = ports();
    parent.connected.mockReturnValue(false);
    const start = vi.fn();
    await runParentOwnedRuntime(start, parent);
    expect(start).not.toHaveBeenCalled();
    expect(parent.ready).not.toHaveBeenCalled();
    expect(parent.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("keeps shutdown pending through the original delayed close, once", async () => {
    const closed = deferred<void>();
    const runtime = { close: vi.fn(() => closed.promise) };
    const { parent, stop } = ports();
    await runParentOwnedRuntime(async () => runtime, parent);
    stop();
    stop();
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(parent.exit).not.toHaveBeenCalled();
    expect(parent.closed).not.toHaveBeenCalled();
    closed.resolve();
    await vi.waitFor(() =>
      expect(parent.exit).toHaveBeenCalledExactlyOnceWith(0),
    );
    expect(parent.closed).toHaveBeenCalledOnce();
  });
  it("reports failed closure with exit 1 and without a closed ACK", async () => {
    const { parent, stop } = ports();
    await runParentOwnedRuntime(
      async () => ({
        close: async () => {
          throw Error("UNKNOWN_CLOSE");
        },
      }),
      parent,
    );
    stop();
    await vi.waitFor(() =>
      expect(parent.exit).toHaveBeenCalledExactlyOnceWith(1),
    );
    expect(parent.closed).not.toHaveBeenCalled();
  });
});
