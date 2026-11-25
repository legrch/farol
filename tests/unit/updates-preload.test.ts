import { InstalledUpdateCommandSchema } from "../../src/modules/release/contract/installed-update";
import { admissionFixture } from "../support/desktop-admission";
import { build } from "esbuild";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { updatesChannels } from "../../apps/desktop/renderer/updates/contract";
import { createIpc, type IpcPorts } from "../../apps/desktop/shell/ipc";
import { channels } from "../../src/pkg/ipc/channels";

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
  vm.runInNewContext(
    result.outputFiles[0]!.text,
    admissionFixture({
      require: (name: string) => {
        if (name !== "electron")
          throw Error(`UNEXPECTED_PRELOAD_REQUIRE:${name}`);
        return {
          ipcRenderer: ipc,
          contextBridge: {
            exposeInMainWorld: (
              key: string,
              value: Record<string, unknown>,
            ) => {
              worlds[key] = value;
            },
          },
        };
      },
      process: { argv: args },
      module: { exports: {} },
      exports: {},
    }),
  );
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
it("keeps the shell API in the shell only", async () => {
  const shell = await exposed([]);
  expect(Object.keys(shell.worlds)).toEqual(["farol"]);
  expect(shell.worlds.farol!.openUpdates).toBeTypeOf("function");
});

it("wires the actual host handlers with shell-only opening and panel-only observation", async () => {
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
    quitInProgress: false,
    installedUpdateAdmission: false,
  };
  const { desktopAdmission } = admissionFixture(context);
  createIpc({
    ipcMain: {
      on: (key: string, run: (...args: any[]) => any) => handlers.set(key, run),
      handle: (key: string, run: (...args: any[]) => any) =>
        handlers.set(key, run),
    },
    window: () => owner,
    updatesPanel: panel,
    installedUpdates: { resources: () => ({ directory: "/app" }) },
    desktopAdmission,
    windowMode: "hidden",
    UPDATES_PANEL_SIZE: { width: 480, height: 560 },
    selectedVisibleTestPlacement: vi.fn(),
    configuration: () => null,
  } as unknown as IpcPorts).install();
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
  context.installedUpdateAdmission = false;
  context.quitInProgress = true;
  handlers.get(updatesChannels.open)!(event);
  expect(panel.open).toHaveBeenCalledOnce();
  expect(options.admitted()).toBe(false);
});

it("refuses an untracked direct command before invoking the updater", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const beginDirect = vi.fn(() => false);
  const endDirect = vi.fn();
  const installedUpdateCommand = vi.fn();
  const sender = {};
  createIpc({
    ipcMain: {
      on: (key: string, run: (...args: any[]) => any) => handlers.set(key, run),
      handle: (key: string, run: (...args: any[]) => any) =>
        handlers.set(key, run),
    },
    window: () => ({ webContents: sender }),
    updatesPanel: { beginDirect, endDirect },
    installedUpdates: { updater: {}, command: installedUpdateCommand },
    installedUpdateCommandSchema: InstalledUpdateCommandSchema,
    configuration: () => null,
  } as unknown as IpcPorts).install();
  const dispatch = handlers.get(channels.installedUpdate)!;
  expect(
    await dispatch(
      { sender: {}, senderFrame: {} },
      { kind: "check" },
      "invalid",
    ),
  ).toEqual({ error: "IPC_SENDER_DENIED" });
  expect(beginDirect).not.toHaveBeenCalled();
  expect(
    await dispatch({ sender, senderFrame: {} }, { kind: "check" }, "invalid"),
  ).toEqual({
    phase: "unavailable",
    code: "UPDATE_ACTION_INVALID",
  });
  expect(beginDirect).toHaveBeenCalledOnce();
  expect(installedUpdateCommand).not.toHaveBeenCalled();
  expect(endDirect).not.toHaveBeenCalled();
});
