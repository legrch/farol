import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../../pkg/ipc/channels";

contextBridge.exposeInMainWorld("farolNext", {
  bootstrap: () => ipcRenderer.invoke(channels.bootstrap) as Promise<unknown>,
  snapshot: () => ipcRenderer.invoke(channels.snapshot) as Promise<unknown>,
  configure: (command: unknown) =>
    ipcRenderer.invoke(channels.configuration, command) as Promise<unknown>,
  control: (taskId: string, action: string) =>
    ipcRenderer.invoke(channels.control, {
      taskId,
      action,
    }) as Promise<unknown>,
  layout: (
    section: string,
    taskId: string,
    setupOpen: boolean,
    sidebar: string,
    overlay: string,
  ) => {
    ipcRenderer.send(channels.layout, {
      section,
      taskId,
      setupOpen,
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
  onTaskSurfaceState: (listener: (status: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(value);
    ipcRenderer.on(channels.taskSurfaceState, wrapped);
    return () => ipcRenderer.removeListener(channels.taskSurfaceState, wrapped);
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
