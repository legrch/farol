import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../../pkg/ipc/channels";

contextBridge.exposeInMainWorld("farolNext", {
  installedUpdate: (command: unknown) =>
    ipcRenderer.invoke(channels.installedUpdate, command) as Promise<unknown>,
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
  ) => {
    ipcRenderer.send(channels.layout, {
      section,
      taskId,
      setupOpen,
      checkFeedbackVisible,
      sidebar,
      overlay,
    });
  },
  onRuntimeEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(value);
    ipcRenderer.on(channels.runtimeEvent, wrapped);
    return () => ipcRenderer.removeListener(channels.runtimeEvent, wrapped);
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
  onTaskSurfaceState: (listener: (status: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(value);
    ipcRenderer.on(channels.taskSurfaceState, wrapped);
    return () => ipcRenderer.removeListener(channels.taskSurfaceState, wrapped);
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
