import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { channels } from "../../../src/pkg/ipc/channels";
import {
  connectorSupervisor,
  type ConnectorSupervisorPorts,
} from "./supervisor";

// The supervisor over a fixture that stands in for main-process state: a ready
// Settings snapshot, a running helper and an admitted Go binding of one build.
// Every port reads the fixture when it is called, so a test changes one field
// and the next predicate sees it. No process, tunnel, timer or provider runs.
function fixture() {
  const binding = Object.freeze({
    buildId: "build",
    profileId: "profile",
    backendGeneration: "backend",
    runtimeId: "runtime",
    connectorGeneration: "9",
  });
  const runtime = {
    state: "ready",
    buildId: "build",
    runtimeGeneration: "tunnel",
    computerGeneration: 7,
    connectorGeneration: 9,
  };
  const settings = {
    revision: 10,
    computer: { generation: 7, pendingEdit: null },
    setup: {
      computer: { outcomeUnknown: false },
      connect: { outcomeUnknown: false },
    },
    connectors: {
      secureMcp: { generation: 9, credential: "stored", runtime },
    },
  };
  const observed = { state: "recent_transport" };
  const connector = {
    isRunning: () => true,
    hasUnresolvedEffect: () => false,
    getTunnelObservation: () => null,
    checkHealth: vi.fn(async () => true),
    observeHealth: vi.fn(async () => ({
      runtimeGeneration: "tunnel",
      expectedInstanceId: "instance",
      snapshot: { polls: "1" },
    })),
  };
  const core = {
    backendAvailable: true,
    currentComputerConnectorBinding: () => binding,
    observeComputerConnectorHealth: vi.fn(async () => observed),
  };
  const sent: unknown[][] = [];
  const state = {
    configuration: { snapshot: () => ({ status: "ready", settings }) } as
      object | null,
    window: {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      webContents: { send: (...values: unknown[]) => sent.push(values) },
    },
    quitInProgress: false,
    connectorTaskAdmission: false,
    connectorTaskAdmissionPurpose: null as "manual-diagnostic" | null,
    summaryFenceRecovery: { status: "reconciled", unresolved: 0 } as
      object | null,
    power: new EventEmitter(),
    transitions: new AuthorityTransitionReservation(),
  };
  const refused = (name: string) => () => {
    throw Error(`UNEXPECTED_PORT_${name}`);
  };
  const ports = {
    configuration: () => state.configuration,
    secureMcpConnectorRuntime: () => connector,
    desktopGoCore: () => core,
    window: () => state.window,
    quitInProgress: () => state.quitInProgress,
    installedUpdateAdmission: () => false,
    connectorTaskAdmission: () => state.connectorTaskAdmission,
    setConnectorTaskAdmission: (value: boolean) => {
      state.connectorTaskAdmission = value;
    },
    connectorTaskAdmissionPurpose: () => state.connectorTaskAdmissionPurpose,
    connectorStartInFlight: () => null,
    configurationRequests: () => 0,
    summaryFenceRecovery: () => state.summaryFenceRecovery,
    workspaceMutationAdmission: () => false,
    codexAgentOperationActive: () => false,
    authorityTransitions: () => state.transitions,
    operationsStore: () => ({ record() {} }),
    buildId: "build",
    isolatedE2EHome: undefined,
    powerMonitor: () => state.power,
    computerMcpLifecycle: refused("computerMcpLifecycle"),
    stopAndConfirmComputerMcp: refused("stopAndConfirmComputerMcp"),
    observeConnectorStart: refused("observeConnectorStart"),
    startAdmittedSecureMcpConnector: refused("startAdmittedSecureMcpConnector"),
    recordConnectorRuntime: refused("recordConnectorRuntime"),
    reportConnectorTransport: refused("reportConnectorTransport"),
    transitionRefusal: refused("transitionRefusal"),
    configurationFailure: refused("configurationFailure"),
  };
  // The doubles carry only the members the supervisor reads.
  const supervisor = connectorSupervisor(
    ports as unknown as ConnectorSupervisorPorts,
  );
  return { supervisor, state, settings, runtime, connector, core, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connector attempt generation", () => {
  it("hashes both generations, this build, the launch contract and the phase", () => {
    const input = {
      connectorGeneration: 3,
      computerGeneration: 7,
      launchContractSha256: "a".repeat(64),
      phase: "open",
    };
    expect(fixture().supervisor.connectorAttemptGeneration(input)).toBe(
      createHash("sha256")
        .update(["3", "7", "build", "a".repeat(64), "open"].join("\0"))
        .digest("hex"),
    );
  });
});

describe("connection admission", () => {
  it("counts a connector admission but not a manual diagnostic", () => {
    const f = fixture();
    expect(f.supervisor.connectionAdmissionInProgress()).toBe(false);
    f.state.connectorTaskAdmission = true;
    expect(f.supervisor.connectionAdmissionInProgress()).toBe(true);
    expect(f.supervisor.captureConnectionStatus()).toBeNull();
    f.state.connectorTaskAdmissionPurpose = "manual-diagnostic";
    expect(f.supervisor.connectionAdmissionInProgress()).toBe(false);
    expect(f.supervisor.captureConnectionStatus()?.kind).toBe("running");
  });
});

describe("captures", () => {
  it("captures the running connector for health, transport and stop", () => {
    const f = fixture();
    const health = f.supervisor.captureConnectorHealth();
    expect(health).toMatchObject({
      runtimeGeneration: "tunnel",
      computerGeneration: 7,
      connectorGeneration: 9,
    });
    expect(f.supervisor.connectorHealthCurrent(health!)).toBe(true);
    const transport = f.supervisor.captureConnectorTransport();
    expect(transport).toMatchObject({
      key: "profile/backend/runtime/tunnel",
      revision: 10,
    });
    expect(f.supervisor.connectorTransportCurrent(transport!)).toBe(true);
    expect(f.supervisor.captureConnectorStop()).toMatchObject({
      computerGeneration: 7,
      connectorGeneration: 9,
    });
  });

  it("withdraws every capture when the build, generation or owner moved", () => {
    const f = fixture();
    const health = f.supervisor.captureConnectorHealth()!;
    const transport = f.supervisor.captureConnectorTransport()!;
    f.runtime.runtimeGeneration = "successor";
    expect(f.supervisor.connectorHealthCurrent(health)).toBe(false);
    expect(f.supervisor.connectorTransportCurrent(transport)).toBe(false);
    f.runtime.buildId = "other-build";
    expect(f.supervisor.captureConnectorHealth()).toBeNull();
    expect(f.supervisor.captureConnectorTransport()).toBeNull();
    expect(f.supervisor.captureConnectorStop()).toBeNull();
    f.runtime.buildId = "build";
    f.state.quitInProgress = true;
    expect(f.supervisor.captureConnectorHealth()).toBeNull();
    expect(f.supervisor.captureConnectorTransport()).toBeNull();
    expect(f.supervisor.captureConnectorStop()).toBeNull();
    f.state.quitInProgress = false;
    f.state.summaryFenceRecovery = null;
    expect(f.supervisor.captureConnectorTransport()).toBeNull();
    expect(f.supervisor.captureConnectorHealth()).not.toBeNull();
    f.state.configuration = null;
    expect(f.supervisor.captureConnectionStatus()).toBeNull();
  });

  it("holds no completed owner stop until main records one", () => {
    const f = fixture();
    expect(f.supervisor.completedOwnerStop.current).toBeNull();
  });
});

describe("connection status", () => {
  it("observes health through the helper and the original Go owner", async () => {
    const f = fixture();
    await f.supervisor.connectorConnection.sample();
    expect(f.connector.observeHealth).toHaveBeenCalledTimes(1);
    expect(f.core.observeComputerConnectorHealth).toHaveBeenCalledWith(
      "instance",
      { polls: "1" },
    );
  });

  it("does not ask Go about a helper sample of another runtime generation", async () => {
    const f = fixture();
    f.connector.observeHealth.mockResolvedValue({
      runtimeGeneration: "successor",
      expectedInstanceId: "instance",
      snapshot: { polls: "1" },
    });
    await f.supervisor.connectorConnection.sample();
    expect(f.core.observeComputerConnectorHealth).not.toHaveBeenCalled();
  });

  it("publishes one revisioned view per change to a live window", () => {
    const f = fixture();
    const first = f.supervisor.currentConnectionStatus();
    expect(first.revision).toBe(1);
    expect(f.sent).toEqual([[channels.connectionStatus, first]]);
    expect(f.supervisor.currentConnectionStatus()).toBe(first);
    expect(f.sent).toHaveLength(1);
  });

  it("retains the view without sending to a destroyed window", () => {
    const f = fixture();
    f.state.window.destroyed = true;
    expect(f.supervisor.currentConnectionStatus().revision).toBe(1);
    expect(f.sent).toHaveLength(0);
  });
});

describe("transport watch", () => {
  it("starts once with a 30 s check, a 1 s projection and power listeners", () => {
    const f = fixture();
    const timers: { milliseconds: number; unref: () => void }[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      _callback: () => void,
      milliseconds: number,
    ) => {
      const timer = { milliseconds, unref: vi.fn() };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setInterval);
    f.supervisor.startConnectorTransportWatch();
    f.supervisor.startConnectorTransportWatch();
    expect(timers.map((timer) => timer.milliseconds)).toEqual([30_000, 1000]);
    for (const timer of timers) expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(f.supervisor.connectorTransportWatch.current).not.toBeNull();
    expect(f.supervisor.connectorTransportTimer.current).toBe(timers[0]);
    expect(f.supervisor.connectorStatusTimer.current).toBe(timers[1]);
    expect(f.state.power.listenerCount("suspend")).toBe(1);
    expect(f.state.power.listenerCount("resume")).toBe(1);
  });

  it("does not start during Quit", () => {
    const f = fixture();
    f.state.quitInProgress = true;
    const interval = vi.spyOn(globalThis, "setInterval");
    f.supervisor.startConnectorTransportWatch();
    expect(interval).not.toHaveBeenCalled();
    expect(f.supervisor.connectorTransportWatch.current).toBeNull();
    expect(f.state.power.listenerCount("resume")).toBe(0);
  });
});
