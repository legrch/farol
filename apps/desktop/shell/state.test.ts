import { describe, expect, it } from "vitest";
import { desktopWindowState, type WindowStatePorts } from "./state";

// The window state over recording ports. Reads are late-bound: every property
// read goes to its port at that moment, so an owner swapped after construction
// is observed. Writes reach the owner through its setter.

function fixture() {
  const owners = {
    window: null as unknown as ReturnType<WindowStatePorts["window"]>,
    ready: false,
    runtime: null as ReturnType<WindowStatePorts["runtime"]>,
    runtimeState: "starting" as ReturnType<WindowStatePorts["runtimeState"]>,
    quitting: false,
    applying: false,
    selected: "task-1",
    home: false,
  };
  const reads: string[] = [];
  const read =
    <T>(name: string, get: () => T) =>
    () => {
      reads.push(name);
      return get();
    };
  const ports: WindowStatePorts = {
    window: read("window", () => owners.window),
    setWindow: (value) => {
      owners.window = value;
    },
    windowPresentationReady: read("ready", () => owners.ready),
    setWindowPresentationReady: (value) => {
      owners.ready = value;
    },
    runtime: read("runtime", () => owners.runtime),
    runtimeState: read("runtimeState", () => owners.runtimeState),
    quitInProgress: read("quitting", () => owners.quitting),
    installedUpdateAdmission: read("applying", () => owners.applying),
    selectedTaskId: read("selected", () => owners.selected),
    browserHomeSurfaceOpen: read("home", () => owners.home),
    setBrowserHomeSurfaceOpen: (value) => {
      owners.home = value;
    },
  };
  return { owners, reads, state: desktopWindowState(ports) };
}

describe("desktopWindowState", () => {
  it("exposes the eight properties and reads nothing at construction", () => {
    const { state, reads } = fixture();
    expect(reads).toEqual([]);
    expect(Object.keys(state).sort()).toEqual([
      "browserHomeSurfaceOpen",
      "installedUpdateAdmission",
      "quitInProgress",
      "runtime",
      "runtimeState",
      "selectedTaskId",
      "window",
      "windowPresentationReady",
    ]);
  });

  it("reads each owner when the property is read, not when built", () => {
    const { state, owners } = fixture();
    expect(state.selectedTaskId).toBe("task-1");
    owners.selected = "task-2";
    owners.quitting = true;
    owners.applying = true;
    owners.runtimeState = "ready";
    const runtime = { port: 1, tasks: [] };
    owners.runtime = runtime;
    expect(state.selectedTaskId).toBe("task-2");
    expect(state.quitInProgress).toBe(true);
    expect(state.installedUpdateAdmission).toBe(true);
    expect(state.runtimeState).toBe("ready");
    expect(state.runtime).toBe(runtime);
  });

  it("writes the window, presentation flag and home flag through the setters", () => {
    const { state, owners } = fixture();
    const win = { id: 7 } as unknown as typeof owners.window;
    state.window = win;
    state.windowPresentationReady = true;
    state.browserHomeSurfaceOpen = true;
    expect(owners.window).toBe(win);
    expect(owners.ready).toBe(true);
    expect(owners.home).toBe(true);
    owners.home = false;
    expect(state.browserHomeSurfaceOpen).toBe(false);
  });
});
