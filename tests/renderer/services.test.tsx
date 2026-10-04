import { StrictMode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Services, useRenderer } from "../../src/ui/renderer/services";
import { PanelBoundary } from "../../src/ui/renderer/boundary";
import { WindowController } from "../../src/ui/renderer/controller";
import { deferred, fixture } from "./fixture";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => document.body.replaceChildren());
function Action() {
  const { snapshot, facade } = useRenderer();
  return (
    <button
      onClick={() => void facade.task({ kind: "task.create-chatgpt" }, "new")}
    >
      {snapshot.status}
    </button>
  );
}
it("R01 R11 R15 R16 R22 StrictMode test.tsx executes; mounts observe without effects", async () => {
  const f = fixture();
  const c = new WindowController(f.api);
  await c.start();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StrictMode>
        <Services value={c}>
          <Action />
          <Action />
        </Services>
      </StrictMode>,
    ),
  );
  expect(f.api.task).not.toHaveBeenCalled();
  await act(async () => {
    host.querySelectorAll("button").forEach((button) => button.click());
  });
  expect(f.api.task).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(f.listeners.size).toBe(10);
  expect(f.api.task).toHaveBeenCalledTimes(1);
  c.dispose();
});
it("R38 isolates render failure without exposing payload or replaying effects", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Broken(): never {
    throw new Error("private payload");
  }
  await act(async () =>
    root.render(
      <PanelBoundary>
        <Broken />
      </PanelBoundary>,
    ),
  );
  expect(host.textContent).toContain("work continues");
  expect(host.textContent).not.toContain("private payload");
  await act(async () => root.unmount());
  log.mockRestore();
});

it("R11 R15 R17 R22 StrictMode root remount retains the pending and unknown intention without replay", async () => {
  const f = fixture();
  const waiting = deferred<unknown>();
  vi.mocked(f.api.task).mockReturnValue(waiting.promise);
  const c = new WindowController(f.api);
  await c.start();
  const subscribe = c.subscribe;
  let observers = 0;
  const spy = vi.spyOn(c, "subscribe").mockImplementation((listener) => {
    observers++;
    const off = subscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      observers--;
      off();
    };
  });
  const host = document.createElement("div");
  document.body.append(host);
  const mount = async () => {
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <StrictMode>
          <Services value={c}>
            <Action />
            <Action />
          </Services>
        </StrictMode>,
      ),
    );
    return root;
  };
  const first = await mount();
  await act(async () => host.querySelector("button")!.click());
  expect(c.getSnapshot().intents.new?.state).toBe("pending");
  expect(f.api.task).toHaveBeenCalledTimes(1);
  await act(async () => first.unmount());
  expect(observers).toBe(0);
  expect(f.listeners.size).toBe(10);
  const second = await mount();
  expect(observers).toBe(2);
  await act(async () =>
    host.querySelectorAll("button").forEach((button) => button.click()),
  );
  expect(f.api.task).toHaveBeenCalledTimes(1);
  await act(async () => waiting.reject(new Error("fixture reply lost")));
  expect(c.getSnapshot().intents.new?.state).toBe("unknown");
  await act(async () => second.unmount());
  expect(observers).toBe(0);
  const third = await mount();
  await act(async () =>
    host.querySelectorAll("button").forEach((button) => button.click()),
  );
  expect(c.getSnapshot().intents.new?.state).toBe("unknown");
  expect(f.api.task).toHaveBeenCalledTimes(1);
  await act(async () => third.unmount());
  expect(observers).toBe(0);
  spy.mockRestore();
  c.dispose();
  expect(f.listeners.size).toBe(0);
});
