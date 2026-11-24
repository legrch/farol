import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import type { DesktopCoreSelection, DesktopGoCore } from "../go-core-host";
import { startGoCore, type GoCoreStartPorts } from "./start";

// The core start over scripted ports. Every late port reads the fixture when
// it is called, so a test changes a field after the ports exist and the start
// sees the change, the way main lends its own state. The host launch is a stub
// that captures the argument object; no core, child, provider or filesystem
// runs, and the result proves composition only, not native or live behavior.
const originalE2e = process.env.FAROL_E2E;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalE2e === undefined) delete process.env.FAROL_E2E;
  else process.env.FAROL_E2E = originalE2e;
});

const devDirectory = "/synthetic/repo/_output/dev-core/Contents/Resources/app";
const devExecutable =
  "/synthetic/repo/_output/dev-core/Contents/Frameworks/Farol Dev.app/Contents/MacOS/Electron";
const rawDirectory = "/synthetic/repo/_output/build/app";
const rawExecutable =
  "/synthetic/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";

type Environment = GoCoreStartPorts["runtimeEnvironment"];
type Fixture = {
  runtimeEnvironment: Environment;
  directory: string;
  executable: string;
  fresh: boolean;
  ready: boolean;
  resourcesOrigin: { execution: { directory: string } } | undefined;
  realpathError?: unknown;
};

const compiledShell = {
  support: "controlled",
  watchdogSource: new Uint8Array([1]),
};
const buildIdentity = { buildId: "b".repeat(64) } as unknown as BuildIdentity;
const settings = (() => {
  throw Error("SETTINGS_NOT_CALLED");
}) as DesktopCoreSelection["settings"];
const browser = (() => {
  throw Error("BROWSER_NOT_CALLED");
}) as DesktopCoreSelection["browser"];
const reportOwnedBackendLifecycle = vi.fn();
const reportQualificationObservation = vi.fn();

function build(init: Partial<Fixture> = {}) {
  const fixture: Fixture = {
    runtimeEnvironment: "preview",
    directory: rawDirectory,
    executable: rawExecutable,
    fresh: false,
    ready: true,
    resourcesOrigin: undefined,
    ...init,
  };
  const events: string[] = [];
  const records: unknown[][] = [];
  const selections: DesktopCoreSelection[] = [];
  const core = { controlled: true } as unknown as DesktopGoCore;
  const launch = vi.fn(async (selection: DesktopCoreSelection) => {
    events.push("launch");
    selections.push(selection);
    return core;
  });
  const withInactiveForFreshStart = vi.fn();
  const lifecycleReads = vi.fn(() => ({
    withInactiveForFreshStart: <T>(start: () => Promise<T>) => {
      withInactiveForFreshStart(start);
      return start();
    },
  }));
  const realpathSync = vi.fn((value: string) => {
    if (fixture.realpathError !== undefined) throw fixture.realpathError;
    return value;
  });
  const ports: GoCoreStartPorts = {
    startDesktopGoCore: launch,
    operationsStore: () => ({
      record: ((...args: unknown[]) => {
        events.push("record");
        records.push(args);
      }) as never,
    }),
    compiledArtifact: "artifact",
    compiledResources: "resources",
    compiledShell,
    get runtimeEnvironment() {
      return fixture.runtimeEnvironment;
    },
    get directory() {
      return fixture.directory;
    },
    executablePath: () => fixture.executable,
    realpathSync,
    freshStartup: () => fixture.fresh,
    get previousHostAdmissionReady() {
      return fixture.ready;
    },
    computerMcpLifecycle: lifecycleReads,
    buildIdentity,
    get installedUpdates() {
      return { resourcesOrigin: fixture.resourcesOrigin } as never;
    },
    stateRoot: "/synthetic/state",
    home: () => "/synthetic/home",
    settings,
    reportOwnedBackendLifecycle,
    reportQualificationObservation,
    browser,
  };
  return {
    fixture,
    ports,
    launch,
    selections,
    records,
    events,
    core,
    realpathSync,
    lifecycleReads,
    withInactiveForFreshStart,
  };
}

describe("argument object", () => {
  it("builds the non-fresh object in the original key order", async () => {
    delete process.env.FAROL_E2E;
    const { ports, selections, core, launch } = build();
    await expect(startGoCore(ports)).resolves.toBe(core);
    expect(launch).toHaveBeenCalledTimes(1);
    const selection = selections[0]!;
    expect(Object.keys(selection)).toEqual([
      "compiledArtifact",
      "compiledResources",
      "compiledShell",
      "previousHostDrainConfirmed",
      "build",
      "artifactRoot",
      "stateRoot",
      "home",
      "settings",
      "onLifecycleObservation",
      "browser",
    ]);
    expect(selection).toMatchObject({
      compiledArtifact: "artifact",
      compiledResources: "resources",
      previousHostDrainConfirmed: true,
      artifactRoot: rawDirectory,
      stateRoot: "/synthetic/state",
      home: "/synthetic/home",
    });
    expect(selection.compiledShell).toBe(compiledShell);
    expect(selection.build).toBe(buildIdentity);
    expect(selection.settings).toBe(settings);
    expect(selection.browser).toBe(browser);
    expect(selection.onLifecycleObservation).toBe(reportOwnedBackendLifecycle);
  });

  it("passes the previous drain confirmation only when not fresh", async () => {
    for (const ready of [true, false]) {
      const { ports, selections } = build({ ready });
      await startGoCore(ports);
      expect(selections[0]!.previousHostDrainConfirmed).toBe(ready);
      expect(Object.hasOwn(selections[0]!, "startupPurpose")).toBe(false);
      expect(Object.hasOwn(selections[0]!, "withInactiveMcp")).toBe(false);
    }
  });

  it("builds the fresh object without trusting the previous drain", async () => {
    const { ports, selections, lifecycleReads, withInactiveForFreshStart } =
      build({ fresh: true, ready: true });
    await startGoCore(ports);
    const selection = selections[0]!;
    expect(Object.keys(selection)).toEqual([
      "compiledArtifact",
      "compiledResources",
      "compiledShell",
      "previousHostDrainConfirmed",
      "startupPurpose",
      "withInactiveMcp",
      "build",
      "artifactRoot",
      "stateRoot",
      "home",
      "settings",
      "onLifecycleObservation",
      "browser",
    ]);
    expect(selection.previousHostDrainConfirmed).toBe(false);
    expect(selection.startupPurpose).toBe("fresh");
    // The MCP lifecycle is read when the host asks, not when the object is built.
    expect(lifecycleReads).not.toHaveBeenCalled();
    const start = vi.fn(async () => "started");
    await expect(selection.withInactiveMcp!(start)).resolves.toBe("started");
    expect(lifecycleReads).toHaveBeenCalledTimes(1);
    expect(withInactiveForFreshStart).toHaveBeenCalledWith(start);
  });

  it("reads the fresh flag inside the start, not when the ports are built", async () => {
    const { ports, fixture, selections } = build({ fresh: false });
    fixture.fresh = true;
    await startGoCore(ports);
    expect(selections[0]!.startupPurpose).toBe("fresh");
  });
});

describe("compiled Shell", () => {
  it("keeps it for a matching Dev image", async () => {
    const { ports, selections } = build({
      runtimeEnvironment: "dev",
      directory: devDirectory,
      executable: devExecutable,
    });
    await startGoCore(ports);
    expect(selections[0]!.compiledShell).toBe(compiledShell);
  });

  it("drops it for a Dev image that is not the executing copy", async () => {
    for (const [directory, executable] of [
      [rawDirectory, rawExecutable],
      [devDirectory, rawExecutable],
      [rawDirectory, devExecutable],
    ] as const) {
      const { ports, selections } = build({
        runtimeEnvironment: "dev",
        directory,
        executable,
      });
      await startGoCore(ports);
      expect(selections[0]!.compiledShell).toBeUndefined();
      expect(Object.hasOwn(selections[0]!, "compiledShell")).toBe(true);
    }
  });

  it("never consults the image outside Dev", async () => {
    for (const runtimeEnvironment of ["preview", "owner-preview"] as const) {
      const { ports, selections, realpathSync } = build({
        runtimeEnvironment,
        directory: rawDirectory,
        executable: rawExecutable,
      });
      await startGoCore(ports);
      expect(selections[0]!.compiledShell).toBe(compiledShell);
      expect(realpathSync).not.toHaveBeenCalled();
    }
  });

  it("resolves the directory before the executable", async () => {
    const { ports, realpathSync } = build({
      runtimeEnvironment: "dev",
      directory: devDirectory,
      executable: devExecutable,
    });
    await startGoCore(ports);
    expect(realpathSync.mock.calls.map(([value]) => value)).toEqual([
      devDirectory,
      devExecutable,
    ]);
  });

  it("throws a refused resolution before the host is launched", () => {
    const failure = Error("CONTROLLED_REALPATH");
    const { ports, launch, events } = build({
      runtimeEnvironment: "dev",
      realpathError: failure,
    });
    expect(() => startGoCore(ports)).toThrow(failure);
    expect(launch).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("artifact root", () => {
  it("uses the executing directory without a private image", async () => {
    const { ports, selections } = build({ directory: rawDirectory });
    await startGoCore(ports);
    expect(selections[0]!.artifactRoot).toBe(rawDirectory);
  });

  it("prefers the authenticated private image, read at start time", async () => {
    const privateRoot = "/owner-private/Farol.app/Contents/Resources/app";
    for (const runtimeEnvironment of [
      "dev",
      "preview",
      "owner-preview",
    ] as const) {
      const { ports, fixture, selections } = build({
        runtimeEnvironment,
        directory: "/Applications/Farol.app/Contents/Resources/app",
      });
      fixture.resourcesOrigin = { execution: { directory: privateRoot } };
      await startGoCore(ports);
      expect(selections[0]!.artifactRoot).toBe(privateRoot);
    }
  });

  it("refuses a root that is not canonical and absolute", () => {
    const { ports, launch } = build({ directory: "relative/app" });
    expect(() => startGoCore(ports)).toThrow("DEV_CORE_LAYOUT_INVALID");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("observers", () => {
  it("adds the qualification observer in Dev", async () => {
    delete process.env.FAROL_E2E;
    const { ports, selections } = build({
      runtimeEnvironment: "dev",
      directory: devDirectory,
      executable: devExecutable,
    });
    await startGoCore(ports);
    expect(selections[0]!.onQualificationObservation).toBe(
      reportQualificationObservation,
    );
    expect(Object.keys(selections[0]!).slice(-2)).toEqual([
      "onQualificationObservation",
      "browser",
    ]);
  });

  it("adds it only under the E2E gate outside Dev", async () => {
    delete process.env.FAROL_E2E;
    const quiet = build({ runtimeEnvironment: "preview" });
    await startGoCore(quiet.ports);
    expect(
      Object.hasOwn(quiet.selections[0]!, "onQualificationObservation"),
    ).toBe(false);
    process.env.FAROL_E2E = "0";
    const stillQuiet = build({ runtimeEnvironment: "owner-preview" });
    await startGoCore(stillQuiet.ports);
    expect(
      Object.hasOwn(stillQuiet.selections[0]!, "onQualificationObservation"),
    ).toBe(false);
    process.env.FAROL_E2E = "1";
    const gated = build({ runtimeEnvironment: "preview" });
    await startGoCore(gated.ports);
    expect(gated.selections[0]!.onQualificationObservation).toBe(
      reportQualificationObservation,
    );
  });

  it("hands the host the very same lifecycle sink the caller supplied", async () => {
    const { ports, selections } = build();
    await startGoCore(ports);
    expect(selections[0]!.onLifecycleObservation).toBe(
      ports.reportOwnedBackendLifecycle,
    );
  });
});

describe("observed operation", () => {
  it("records the Setup start once the host start settles", async () => {
    const { ports, records, events } = build();
    await startGoCore(ports);
    expect(events).toEqual(["launch", "record"]);
    expect(records).toHaveLength(1);
    expect(records[0]![0]).toEqual({
      source: "Setup",
      kind: "hub.start",
      target: {},
    });
  });

  it("records and rethrows a refused start without starting again", async () => {
    const { ports, launch, records } = build();
    const refusal = Error("CONTROLLED_REFUSAL");
    launch.mockRejectedValueOnce(refusal);
    await expect(startGoCore(ports)).rejects.toBe(refusal);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0]![1]).not.toBe("done");
  });
});
