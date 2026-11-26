import type { BrowserWindow } from "electron";
import type { MainWindowState } from "../window/main";
import type { TaskSurfaceState } from "../window/surface";

// The window and task-surface adapters borrow their owners through one live
// state object. Main keeps every owner (the window, its presentation flag, the
// runtime, the selected task, the browser-home flag, the admission); this
// builds only the accessors. Each read goes to its port when the property is
// read, never when the object is built, and each write goes back to main's
// owner through its setter at the point the adapter assigns it.

export type WindowStatePorts = Readonly<{
  window: () => BrowserWindow | null;
  setWindow: (window: BrowserWindow | null) => void;
  windowPresentationReady: () => boolean;
  setWindowPresentationReady: (ready: boolean) => void;
  runtime: () => MainWindowState["runtime"];
  runtimeState: () => MainWindowState["runtimeState"];
  quitInProgress: () => boolean;
  installedUpdateAdmission: () => boolean;
  selectedTaskId: () => string;
  browserHomeSurfaceOpen: () => boolean;
  setBrowserHomeSurfaceOpen: (open: boolean) => void;
}>;

export type DesktopWindowState = MainWindowState & TaskSurfaceState;

export function desktopWindowState(
  ports: WindowStatePorts,
): DesktopWindowState {
  return {
    get window() {
      return ports.window();
    },
    set window(value) {
      ports.setWindow(value);
    },
    get windowPresentationReady() {
      return ports.windowPresentationReady();
    },
    set windowPresentationReady(value) {
      ports.setWindowPresentationReady(value);
    },
    get runtime() {
      return ports.runtime();
    },
    get runtimeState() {
      return ports.runtimeState();
    },
    get quitInProgress() {
      return ports.quitInProgress();
    },
    get installedUpdateAdmission() {
      return ports.installedUpdateAdmission();
    },
    get selectedTaskId() {
      return ports.selectedTaskId();
    },
    get browserHomeSurfaceOpen() {
      return ports.browserHomeSurfaceOpen();
    },
    set browserHomeSurfaceOpen(value) {
      ports.setBrowserHomeSurfaceOpen(value);
    },
  };
}
