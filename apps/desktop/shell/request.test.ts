import { describe, expect, it } from "vitest";
import { createShellRequests, type ShellRequestPorts } from "./request";

// The owner requests over recording ports: what each does, in what order, and
// that nothing acts once admission has closed.

function ports(log: string[], overrides: Partial<ShellRequestPorts> = {}) {
  const owners: ShellRequestPorts = {
    closed: () => false,
    contain: async (work) => {
      await work();
      return "opened";
    },
    ensureWindow: () => Promise.resolve(void log.push("ensure")),
    window: () => ({
      isDestroyed: () => false,
      webContents: { focus: () => void log.push("focus") },
    }),
    publishShellAction: (action, source) =>
      void log.push(`publish:${action}:${source}`),
    requestUpdateCheck: () => Promise.resolve(void log.push("check")),
    ...overrides,
  };
  return owners;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createShellRequests", () => {
  it("opens the window, publishes, focuses and then checks for updates", async () => {
    const log: string[] = [];
    createShellRequests(ports(log)).requestUpdates();
    await settle();
    expect(log).toEqual([
      "ensure",
      "publish:open-updates:update-command",
      "focus",
      "check",
    ]);
  });

  it("does nothing for updates once admission has closed", async () => {
    const log: string[] = [];
    createShellRequests(ports(log, { closed: () => true })).requestUpdates();
    await settle();
    expect(log).toEqual([]);
  });

  it("stops after the open when admission closed or the window is gone", async () => {
    const closing: string[] = [];
    let calls = 0;
    createShellRequests(
      ports(closing, { closed: () => ++calls > 1 }),
    ).requestUpdates();
    await settle();
    expect(closing).toEqual(["ensure"]);

    const destroyed: string[] = [];
    createShellRequests(
      ports(destroyed, {
        window: () => ({
          isDestroyed: () => true,
          webContents: { focus: () => void destroyed.push("focus") },
        }),
      }),
    ).requestUpdates();
    await settle();
    expect(destroyed).toEqual(["ensure"]);
  });

  it("opens settings only on an existing window", () => {
    const log: string[] = [];
    createShellRequests(ports(log)).requestSettings();
    expect(log).toEqual(["publish:open-settings:settings-command", "focus"]);

    const none: string[] = [];
    createShellRequests(ports(none, { window: () => null })).requestSettings();
    createShellRequests(ports(none, { closed: () => true })).requestSettings();
    expect(none).toEqual([]);
  });
});
