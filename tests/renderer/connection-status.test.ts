import { expect, it, vi } from "vitest";
import { WindowController } from "../../src/ui/renderer/controller";
import { unavailableConnectionStatus } from "../../apps/desktop/renderer/connection-status";
import { fixture, bootstrap, deferred } from "./fixture";

const view = (revision: number, state: "recent_transport" | "unavailable") => ({
  ...unavailableConnectionStatus,
  revision,
  state,
  label:
    state === "recent_transport"
      ? "Recent server polling"
      : "Server transport unavailable",
});
function liveFixture() {
  const f = fixture();
  let notify: (value: unknown) => void = () => undefined;
  const off = vi.fn();
  const api = {
    ...f.api,
    onConnectionStatus: (listener: (value: unknown) => void) => {
      notify = listener;
      return off;
    },
  };
  return { ...f, api, off, notify: (value: unknown) => notify(value) };
}
it("adopts live status without configuration/task actions and refuses stale refresh rollback", async () => {
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  await c.start();
  expect(c.getSnapshot().connectionStatus?.state).toBe("recent_transport");
  f.notify(view(2, "unavailable"));
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  await c.refresh();
  expect(c.getSnapshot().connectionStatus?.revision).toBe(2);
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  expect(f.api.configure).not.toHaveBeenCalled();
  expect(f.api.task).not.toHaveBeenCalled();
  c.dispose();
  expect(f.off).toHaveBeenCalledTimes(1);
});
it("a newer live event during bootstrap keeps the original ordering", async () => {
  const f = liveFixture(),
    held = deferred<unknown>();
  vi.mocked(f.api.bootstrap).mockReturnValueOnce(held.promise);
  const c = new WindowController(f.api),
    pending = c.start();
  f.notify(view(2, "unavailable"));
  held.resolve({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  await pending;
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  c.dispose();
});
it("malformed status loses a cached positive without permitting an old bootstrap to revive it", async () => {
  const f = liveFixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    connectionStatus: view(1, "recent_transport"),
  });
  const c = new WindowController(f.api);
  await c.start();
  f.notify({ ...view(2, "recent_transport"), state: "invented_connected" });
  expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
  await c.refresh();
  expect(c.getSnapshot().connectionStatus?.state).toBe("unobserved");
  f.notify(view(2, "unavailable"));
  expect(c.getSnapshot().connectionStatus?.state).toBe("unavailable");
  c.dispose();
});
