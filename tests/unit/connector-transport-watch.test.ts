import { expect, it, vi } from "vitest";
import {
  ConnectorTransportWatch,
  type ConnectorTransportObservation,
} from "../../apps/desktop/connector-transport-watch";

function fixture(observations: ConnectorTransportObservation[]) {
  const original = Object.freeze<{ key: string }>({ key: "original-runtime" });
  let eligible = true;
  const ports = {
    capture: vi.fn(() => (eligible ? original : null)),
    current: vi.fn(() => eligible),
    observe: vi.fn(
      async () => observations.shift() ?? ("unreachable" as const),
    ),
    recover: vi.fn(async () => {}),
    unknown: vi.fn(async () => {}),
    wait: vi.fn(async (_ms: number) => {}),
  };
  const watch = new ConnectorTransportWatch(ports);
  return {
    watch,
    ports,
    revoke: () => {
      eligible = false;
    },
  };
}

it("keeps a healthy connection and bounds offline/online checks without a restart", async () => {
  const f = fixture(["unreachable", "unreachable", "healthy"]);
  await f.watch.check();
  expect(f.ports.wait.mock.calls).toEqual([[1_000], [5_000]]);
  expect(f.ports.observe).toHaveBeenCalledTimes(3);
  expect(f.ports.recover).not.toHaveBeenCalled();
  expect(f.ports.unknown).not.toHaveBeenCalled();
});

it.each(["exited", "unreachable"] as const)(
  "permits only one admitted recovery port after %s",
  async (state) => {
    const f = fixture([state, state, state, state]);
    f.ports.recover.mockRejectedValueOnce(new Error("original reply lost"));
    await expect(f.watch.check()).rejects.toThrow("original reply lost");
    await f.watch.check();
    expect(f.ports.recover).toHaveBeenCalledTimes(1);
    expect(f.ports.observe).toHaveBeenCalledTimes(state === "exited" ? 1 : 4);
    expect(f.ports.wait.mock.calls).toEqual(
      state === "exited" ? [] : [[1_000], [5_000], [15_000]],
    );
  },
);

it("coalesces simultaneous wake/timer checks and never repeats an UNKNOWN", async () => {
  const f = fixture(["unknown"]);
  const first = f.watch.check();
  expect(f.watch.check()).toBe(first);
  await first;
  await f.watch.check();
  expect(f.ports.unknown).toHaveBeenCalledExactlyOnceWith({
    key: "original-runtime",
  });
  expect(f.ports.recover).not.toHaveBeenCalled();
});

it.each(["revoke", "suspend", "quit", "explicit-stop"])(
  "drops an observation after %s instead of reviving the old transport",
  async (reason) => {
    const f = fixture(["unreachable", "exited"]);
    f.ports.wait.mockImplementationOnce(async () => {
      if (reason === "revoke") f.revoke();
      else if (reason === "suspend") f.watch.invalidate();
      else if (reason === "quit") f.watch.close();
      else f.watch.suppressCurrent();
    });
    await f.watch.check();
    expect(f.ports.observe).toHaveBeenCalledTimes(1);
    expect(f.ports.recover).not.toHaveBeenCalled();
    if (reason === "explicit-stop") {
      await f.watch.check();
      expect(f.ports.observe).toHaveBeenCalledTimes(1);
    }
  },
);

it("observes afresh after sleep without borrowing a late pre-sleep result", async () => {
  const f = fixture(["exited", "healthy"]);
  f.ports.observe.mockImplementationOnce(async () => {
    f.watch.invalidate();
    return "exited";
  });
  await f.watch.check();
  f.ports.observe.mockResolvedValueOnce("healthy");
  await f.watch.check();
  expect(f.ports.observe).toHaveBeenCalledTimes(2);
  expect(f.ports.recover).not.toHaveBeenCalled();
});

it("refuses new effects at the finite fence budget without evicting old identities", async () => {
  const f = fixture(["exited"]);
  let id = 0;
  f.ports.capture.mockImplementation(() => ({ key: String(id++) }));
  f.ports.observe.mockResolvedValue("exited");
  for (let n = 0; n < 65; n += 1) await f.watch.check();
  expect(f.ports.recover).toHaveBeenCalledTimes(64);
  f.ports.capture.mockReturnValue({ key: "0" });
  await f.watch.check();
  expect(f.ports.recover).toHaveBeenCalledTimes(64);
});
