import { describe, expect, it, vi } from "vitest";
import {
  connectGoSettings,
  type SettingsCore,
  type SettingsOwner,
  type SettingsWindow,
} from "./settings";

type Driver = {
  read: (input: { deadlineMillis: number }) => unknown;
  replace: (input: { change: unknown; deadlineMillis: number }) => unknown;
  fence: () => unknown;
};

function harness() {
  const store = {
    read: vi.fn(() => "read"),
    replace: vi.fn(() => "replace"),
    fence: vi.fn(() => "fenced"),
  };
  const owner = {
    attachComputerAuthority: vi.fn(),
    attachSettingsDeliveryStore: vi.fn(() => store),
  };
  let driver: Driver | undefined;
  const withdraw = vi.fn();
  const core = {
    withdraw,
    connectSettingsStore: vi.fn((make: (profileId: string) => Driver) => {
      driver = make("profile-1");
    }),
  };
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } };
  const state = {
    configuration: owner as unknown as SettingsOwner | null,
    core: core as unknown as SettingsCore | null,
    window: win as SettingsWindow | null,
    closed: false,
  };
  connectGoSettings({
    configuration: () => state.configuration,
    core: () => state.core,
    window: () => state.window,
    admissionClosed: () => state.closed,
    ownerId: "owner-desktop",
    configurationChanged: "configuration:changed",
  });
  return { store, owner, core, withdraw, send, win, state, driver: driver! };
}

describe("go settings boundary", () => {
  it("binds the computer authority to the core's withdrawal", () => {
    const { owner, withdraw } = harness();
    const [bind] = owner.attachComputerAuthority.mock.calls[0]! as unknown as [
      () => void,
    ];
    bind();
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("attaches the delivery store for the core's profile and delegates", () => {
    const { owner, store, driver } = harness();
    expect(owner.attachSettingsDeliveryStore).toHaveBeenCalledWith({
      profileId: "profile-1",
      ownerId: "owner-desktop",
    });
    expect(driver.read({ deadlineMillis: 5 })).toBe("read");
    expect(store.read).toHaveBeenCalledWith(5);
    expect(driver.replace({ change: "c", deadlineMillis: 6 })).toBe("replace");
    expect(store.replace).toHaveBeenCalledWith("c", 6);
  });

  it("notifies the renderer after a fence while everything is still current", () => {
    const { driver, send } = harness();
    expect(driver.fence()).toBe("fenced");
    expect(send).toHaveBeenCalledWith("configuration:changed");
  });

  it.each([
    [
      "admission closed",
      (s: ReturnType<typeof harness>) => (s.state.closed = true),
    ],
    [
      "configuration replaced",
      (s: ReturnType<typeof harness>) =>
        (s.state.configuration = {} as SettingsOwner),
    ],
    [
      "core replaced",
      (s: ReturnType<typeof harness>) => (s.state.core = {} as SettingsCore),
    ],
    ["window gone", (s: ReturnType<typeof harness>) => (s.state.window = null)],
  ])("keeps the outcome and stays silent when %s", (_name, change) => {
    const h = harness();
    h.store.fence.mockImplementation(() => {
      change(h);
      return "fenced";
    });
    expect(h.driver.fence()).toBe("fenced");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("stays silent when the window was swapped during the fence", () => {
    const h = harness();
    h.store.fence.mockImplementation(() => {
      h.state.window = {
        isDestroyed: () => false,
        webContents: { send: h.send },
      };
      return "fenced";
    });
    h.driver.fence();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not notify a destroyed window", () => {
    const h = harness();
    h.state.window = { isDestroyed: () => true, webContents: { send: h.send } };
    expect(h.driver.fence()).toBe("fenced");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("never lets a failed renderer delivery replace the fence outcome", () => {
    const h = harness();
    h.send.mockImplementation(() => {
      throw new Error("destroyed");
    });
    expect(h.driver.fence()).toBe("fenced");
  });
});
