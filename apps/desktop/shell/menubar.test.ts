import { describe, expect, it, vi } from "vitest";
import { startMenuBar, type MenuBarPorts } from "./menubar";

function setup(over: Partial<MenuBarPorts> = {}) {
  const calls: string[] = [];
  const dispose = vi.fn();
  let actions: Parameters<MenuBarPorts["create"]>[0] | undefined;
  let status: Parameters<MenuBarPorts["create"]>[1] | undefined;
  const ports: MenuBarPorts = {
    enabled: true,
    boundary: async (create) => {
      calls.push("boundary");
      return create();
    },
    create: (a, s) => {
      actions = a;
      status = s;
      calls.push("create");
      return dispose;
    },
    reopen: () => calls.push("reopen"),
    runningTask: () => ({ taskId: "t1", label: "Task one" }),
    showTask: (id) => calls.push("show:" + id),
    requestUpdates: () => calls.push("updates"),
    quit: () => calls.push("quit"),
    connection: () => ({ state: "recent_transport", label: "Connected" }),
    attached: () => true,
    ...over,
  };
  return {
    ports,
    calls,
    dispose,
    actions: () => actions!,
    status: () => status!(),
  };
}

describe("startup menu bar", () => {
  it("creates nothing when disabled, without entering the boundary", async () => {
    const h = setup({ enabled: false });
    expect(await startMenuBar(h.ports)).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it("creates inside the boundary and answers the disposer", async () => {
    const h = setup();
    expect(await startMenuBar(h.ports)).toBe(h.dispose);
    expect(h.calls).toEqual(["boundary", "create"]);
  });

  it("opens the current task, then the window; opens only the window with none", async () => {
    const h = setup();
    await startMenuBar(h.ports);
    h.actions().current();
    expect(h.calls.slice(2)).toEqual(["show:t1", "reopen"]);
    const idle = setup({ runningTask: () => null });
    await startMenuBar(idle.ports);
    idle.actions().current();
    expect(idle.calls.slice(2)).toEqual(["reopen"]);
  });

  it("routes open, updates and quit to their own ports", async () => {
    const h = setup();
    await startMenuBar(h.ports);
    h.actions().open();
    h.actions().updates();
    h.actions().quit();
    expect(h.calls.slice(2)).toEqual(["reopen", "updates", "quit"]);
  });

  it("reads status fresh each time: label, icon from attachment, running task", async () => {
    let state: "recent_transport" | "checking" = "recent_transport";
    const h = setup({
      connection: () => ({ state, label: "Connected" }),
      attached: (s) => s === "recent_transport",
    });
    await startMenuBar(h.ports);
    expect(h.status()).toEqual({
      label: "Farol · Connected",
      icon: "filled",
      current: "Task one",
    });
    state = "checking";
    expect(h.status().icon).toBe("hollow");
  });
});
