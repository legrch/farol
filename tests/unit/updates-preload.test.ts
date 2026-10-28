import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { updatesChannels } from "../../apps/desktop/renderer/updates/contract";
import { isTrustedIpcSender } from "../../src/apps/desktop/ipc-sender";

// Execute the bundled real preload with controlled Electron ports, never an app.
async function exposed(args: string[]) {
  const result = await build({
    entryPoints: ["src/apps/desktop/preload.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
  });
  const worlds: Record<string, Record<string, unknown>> = {};
  const ipc = {
    send: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  vm.runInNewContext(result.outputFiles[0]!.text, {
    require: (name: string) => {
      if (name !== "electron")
        throw Error(`UNEXPECTED_PRELOAD_REQUIRE:${name}`);
      return {
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
            worlds[key] = value;
          },
        },
      };
    },
    process: { argv: args },
    module: { exports: {} },
    exports: {},
  });
  return { worlds, ipc };
}
it("exposes only the narrow Updates API in the Updates renderer", async () => {
  const f = await exposed(["--farol-updates"]);
  expect(Object.keys(f.worlds)).toEqual(["farolUpdates"]);
  expect(Object.keys(f.worlds.farolUpdates!).sort()).toEqual([
    "close",
    "intent",
    "onState",
    "state",
  ]);
  expect(f.worlds.farolUpdates!.installedUpdate).toBeUndefined();
  expect(f.worlds.farolUpdates!.configure).toBeUndefined();
  expect(f.ipc.send).not.toHaveBeenCalled();
});
it("keeps recovery separately selected and the shell API in the shell only", async () => {
  expect(
    Object.keys((await exposed(["--farol-startup-recovery"])).worlds),
  ).toEqual(["farolRecovery"]);
  const shell = await exposed([]);
  expect(Object.keys(shell.worlds)).toEqual(["farol"]);
  expect(shell.worlds.farol!.openUpdates).toBeTypeOf("function");
});

it("wires the actual host handlers with shell-only opening and panel-only observation", async () => {
  const source = await readFile("src/apps/desktop/main.ts", "utf8");
  const start = source.indexOf("function installIpc(): void {");
  const end = source.indexOf(
    "  const settings = configuration?.snapshot();",
    start,
  );
  expect(start).toBeGreaterThan(0);
  const code = await transform(
    source.slice(start, end) + "\n}\ninstallIpc();",
    { loader: "ts" },
  );
  const handlers = new Map<string, (...args: any[]) => any>();
  const frame = { url: "file:///app/shell.html" };
  const owner = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  const panel = {
    bindOwner: vi.fn(),
    publish: vi.fn(),
    settle: vi.fn(),
    relay: vi.fn(),
    close: vi.fn(),
    isOwner: vi.fn(() => false),
    isPanel: vi.fn(() => false),
    state: vi.fn(() => ({ status: "unavailable" })),
    open: vi.fn(async (_value: unknown) => {}),
  };
  const context: Record<string, unknown> = {
    ipcMain: {
      on: (key: string, run: (...args: any[]) => any) => handlers.set(key, run),
      handle: (key: string, run: (...args: any[]) => any) =>
        handlers.set(key, run),
    },
    updatesChannels,
    updatesPanel: panel,
    window: owner,
    isTrustedIpcSender,
    desktopExecutionResources: () => ({ directory: "/app" }),
    quitInProgress: false,
    installedUpdateAdmission: false,
    windowMode: "hidden",
    selectedVisibleTestPlacement: vi.fn(),
    UPDATES_PANEL_SIZE: { width: 480, height: 560 },
    console: { error: vi.fn() },
  };
  vm.runInNewContext(code.code, context);
  const event = { sender: owner.webContents, senderFrame: frame };
  handlers.get(updatesChannels.projection)!(
    { sender: {}, senderFrame: frame },
    {},
  );
  handlers.get(updatesChannels.projection)!(
    { ...event, senderFrame: { url: frame.url } },
    {},
  );
  expect(panel.bindOwner).not.toHaveBeenCalled();
  handlers.get(updatesChannels.projection)!(event, { projection: true });
  expect(panel.bindOwner).toHaveBeenCalledWith(owner, "/app");
  expect(panel.publish).toHaveBeenCalledWith(event, { projection: true });
  expect(handlers.get(updatesChannels.state)!({})).toEqual({
    status: "unavailable",
  });
  expect(panel.state).not.toHaveBeenCalled();
  handlers.get(updatesChannels.open)!(event);
  expect(panel.open).not.toHaveBeenCalled();
  panel.isOwner.mockReturnValue(true);
  context.quitInProgress = true;
  handlers.get(updatesChannels.open)!(event);
  context.quitInProgress = false;
  context.installedUpdateAdmission = true;
  handlers.get(updatesChannels.open)!(event);
  expect(panel.open).not.toHaveBeenCalled();
  context.installedUpdateAdmission = false;
  handlers.get(updatesChannels.open)!(event);
  expect(panel.open).toHaveBeenCalledOnce();
  const options = panel.open.mock.calls[0]![0] as { admitted(): boolean };
  expect(options.admitted()).toBe(true);
  context.installedUpdateAdmission = true;
  expect(options.admitted()).toBe(false);
});
