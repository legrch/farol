import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../pkg/ipc/channels";

contextBridge.exposeInMainWorld("farolNext", {
  bootstrap: () => ipcRenderer.invoke(channels.bootstrap) as Promise<unknown>,
  snapshot: () => ipcRenderer.invoke(channels.snapshot) as Promise<unknown>,
  control: (taskId: string, action: string) =>
    ipcRenderer.invoke(channels.control, {
      taskId,
      action,
    }) as Promise<unknown>,
  layout: (section: string, taskId: string) => {
    ipcRenderer.send(channels.layout, { section, taskId });
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
});
