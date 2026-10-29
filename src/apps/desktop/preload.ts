import { contextBridge, ipcRenderer } from "electron";
import { recoveryChannels } from "../../../apps/desktop/renderer/recovery/contract";
import { channels } from "../../pkg/ipc/channels";
import { updatesChannels } from "../../../apps/desktop/renderer/updates/contract";

// Recovery uses the existing attested entry with a separately selected, narrow API.
// Recovery exposes no normal desktop handlers, publications or mutation actions.
if (process.argv.includes("--farol-startup-recovery")) {
  contextBridge.exposeInMainWorld(
    "farolRecovery",
    Object.freeze({
      state: () =>
        ipcRenderer.invoke(recoveryChannels.state) as Promise<unknown>,
      read: (request: unknown) =>
        ipcRenderer.invoke(recoveryChannels.read, request) as Promise<unknown>,
      quit: () => ipcRenderer.send(recoveryChannels.quit),
    }),
  );
} else if (process.argv.includes("--farol-updates")) {
  contextBridge.exposeInMainWorld(
    "farolUpdates",
    Object.freeze({
      state: () =>
        ipcRenderer.invoke(updatesChannels.state) as Promise<unknown>,
      onState: (listener: (state: unknown) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
          listener(value);
        ipcRenderer.on(updatesChannels.state, wrapped);
        return () => ipcRenderer.removeListener(updatesChannels.state, wrapped);
      },
      intent: (value: unknown) =>
        ipcRenderer.send(updatesChannels.intent, value),
      close: () => ipcRenderer.send(updatesChannels.close),
    }),
  );
} else {
  contextBridge.exposeInMainWorld("farol", {
    openUpdates: () => ipcRenderer.send(updatesChannels.open),
    publishUpdates: (value: unknown) =>
      ipcRenderer.send(updatesChannels.projection, value),
    onUpdatesCommand: (listener: (value: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(updatesChannels.command, wrapped);
      return () => ipcRenderer.removeListener(updatesChannels.command, wrapped);
    },
    settleUpdates: (value: unknown) =>
      ipcRenderer.send(updatesChannels.settled, value),
    operations: () =>
      ipcRenderer.invoke(channels.operations) as Promise<unknown>,
    selfTest: (command: unknown) =>
      ipcRenderer.invoke(channels.selfTest, command) as Promise<unknown>,
    installedUpdate: (command: unknown, operationId?: string) =>
      ipcRenderer.invoke(
        channels.installedUpdate,
        command,
        operationId,
      ) as Promise<unknown>,
    settleUpdateDirect: (value: unknown) =>
      ipcRenderer.send(updatesChannels.directSettled, value),
    onInstalledUpdateState: (listener: (state: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.installedUpdateState, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.installedUpdateState, wrapped);
    },
    onConfigurationChanged: (listener: () => void) => {
      // A notification only: the renderer reads the existing validated bootstrap
      // instead of accepting settings or mutation authority in this event.
      const wrapped = () => listener();
      ipcRenderer.on(channels.configurationChanged, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.configurationChanged, wrapped);
    },
    bootstrap: () => ipcRenderer.invoke(channels.bootstrap) as Promise<unknown>,
    snapshot: () => ipcRenderer.invoke(channels.snapshot) as Promise<unknown>,
    configure: (command: unknown) =>
      ipcRenderer.invoke(channels.configuration, command) as Promise<unknown>,
    chatHistory: (request: unknown) =>
      ipcRenderer.invoke(channels.chatHistory, request) as Promise<unknown>,
    retiredReplies: (request: unknown) =>
      ipcRenderer.invoke(channels.retiredReplies, request) as Promise<unknown>,
    task: (command: unknown) =>
      ipcRenderer.invoke(channels.task, command) as Promise<unknown>,
    control: (taskId: string, action: string) =>
      ipcRenderer.invoke(channels.control, {
        taskId,
        action,
      }) as Promise<unknown>,
    setNavigationShortcuts: (shortcuts: unknown) =>
      ipcRenderer.invoke(
        channels.navigationShortcuts,
        shortcuts,
      ) as Promise<unknown>,
    layout: (
      section: string,
      taskId: string,
      setupOpen: boolean,
      checkFeedbackVisible: boolean,
      sidebar: string,
      overlay: string,
      sidebarWidth?: number,
    ) => {
      ipcRenderer.send(channels.layout, {
        section,
        taskId,
        setupOpen,
        checkFeedbackVisible,
        sidebar,
        overlay,
        sidebarWidth,
      });
    },
    onRuntimeEvent: (listener: (event: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.runtimeEvent, wrapped);
      return () => ipcRenderer.removeListener(channels.runtimeEvent, wrapped);
    },
    onConnectionStatus: (listener: (status: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.connectionStatus, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.connectionStatus, wrapped);
    },
    onRuntimeState: (listener: (status: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.runtimeState, wrapped);
      return () => ipcRenderer.removeListener(channels.runtimeState, wrapped);
    },
    onBrowserRouteState: (listener: (status: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.browserRouteState, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.browserRouteState, wrapped);
    },
    browserHistory: (request: unknown) =>
      ipcRenderer.invoke(channels.browserHistory, request) as Promise<unknown>,
    onBrowserHistoryState: (listener: (value: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.browserHistoryState, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.browserHistoryState, wrapped);
    },
    onTaskSurfaceState: (listener: (status: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.taskSurfaceState, wrapped);
      return () =>
        ipcRenderer.removeListener(channels.taskSurfaceState, wrapped);
    },
    onTasksState: (listener: (state: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.tasksState, wrapped);
      return () => ipcRenderer.removeListener(channels.tasksState, wrapped);
    },
    onLayout: (listener: (layout: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.layout, wrapped);
      return () => ipcRenderer.removeListener(channels.layout, wrapped);
    },
    onShellAction: (listener: (action: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.shellAction, wrapped);
      return () => ipcRenderer.removeListener(channels.shellAction, wrapped);
    },
    onWindowState: (listener: (state: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(value);
      ipcRenderer.on(channels.windowState, wrapped);
      return () => ipcRenderer.removeListener(channels.windowState, wrapped);
    },
  });
}
