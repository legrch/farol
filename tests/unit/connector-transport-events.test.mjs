import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import { ConnectorTransportWatch } from "../../apps/desktop/connector-transport-watch.ts";
import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition.ts";

// Run the actual event/timer join and watcher with controlled health/clock ports.
// This is not OS sleep, network loss, native process closure or provider evidence.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const declarations = parse(source, {
  sourceType: "module",
  plugins: ["typescript"],
}).program.body.filter(
  (node) =>
    node.type === "FunctionDeclaration" &&
    node.id?.name === "startConnectorTransportWatch",
);
if (declarations.length !== 1)
  throw Error("CONNECTOR_TRANSPORT_EVENT_SOURCE_MISSING");
const node = declarations[0];
const compiled = stripTypeScriptTypes(
  `${source.slice(node.start, node.end)}; ({ start: startConnectorTransportWatch, watch: () => connectorTransportWatch });`,
);

async function until(predicate) {
  for (let n = 0; n < 50; n += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw Error("CONTROLLED_EVENT_DID_NOT_REACH_BOUNDARY");
}

function fixture() {
  const power = new EventEmitter();
  const timeouts = [];
  const intervals = [];
  const owner = {};
  const core = { backendAvailable: true };
  const original = Object.freeze({
    owner,
    core,
    key: "original-runtime",
    revision: 10,
    runtimeGeneration: "original-health",
    computerGeneration: 7,
    connector: {
      checkHealth: vi.fn(async () => true),
      getTunnelObservation: vi.fn(() => null),
    },
  });
  let eligible = true;
  const context = {
    ConnectorTransportWatch,
    connectorTransportWatch: null,
    connectorTransportTimer: null,
    connectorStatusTimer: null,
    connectorConnection: {
      sample: vi.fn(async () => undefined),
      suspend: vi.fn(),
      resume: vi.fn(),
    },
    currentConnectionStatus: vi.fn(),
    connectorTaskAdmission: false,
    quitInProgress: false,
    installedUpdateAdmission: false,
    configuration: owner,
    desktopGoCore: core,
    secureMcpConnectorRuntime: original.connector,
    captureConnectorTransport: vi.fn(() => (eligible ? original : null)),
    connectorTransportCurrent: vi.fn(
      (selected, _revision, _stopped, admitted = false) =>
        eligible &&
        selected === original &&
        context.connectorTaskAdmission === admitted,
    ),
    authorityTransitions: new AuthorityTransitionReservation(),
    recordConnectorRuntime: vi.fn(async () => null),
    recoverConnectorTransport: vi.fn(async () => ({ ok: true })),
    reportConnectorTransport: vi.fn(),
    window: {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      webContents: { send: vi.fn() },
    },
    channels: { configurationChanged: "fixture.configuration-changed" },
    powerMonitor: power,
    setInterval: vi.fn((callback, milliseconds) => {
      const timer = { callback, milliseconds, unref: vi.fn() };
      intervals.push(timer);
      return timer;
    }),
    setTimeout: vi.fn((callback, milliseconds) => {
      timeouts.push({ callback, milliseconds });
    }),
    console: { warn: vi.fn() },
  };
  const actual = vm.runInNewContext(compiled, context);
  actual.start();
  return {
    actual,
    context,
    original,
    power,
    intervals,
    timeouts,
    revoke: () => {
      eligible = false;
    },
    tick: () => intervals[0].callback(),
    finish: () => actual.watch().check(),
  };
}

it("wires one resume observer and an unrefed bounded timer without an eager restart", async () => {
  const f = fixture();
  f.actual.start();
  expect(f.intervals).toHaveLength(2);
  expect(f.intervals[1].milliseconds).toBe(1000);
  expect(f.intervals[1].unref).toHaveBeenCalledTimes(1);
  expect(f.context.connectorConnection.sample).toHaveBeenCalledTimes(1);
  expect(f.intervals[0].milliseconds).toBe(30_000);
  expect(f.intervals[0].unref).toHaveBeenCalledTimes(1);
  expect(f.power.listenerCount("resume")).toBe(1);
  expect(f.power.listenerCount("suspend")).toBe(1);
  expect(f.original.connector.checkHealth).not.toHaveBeenCalled();
  f.power.emit("resume");
  await f.finish();
  expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(1);
  expect(f.context.connectorConnection.resume).toHaveBeenCalledTimes(1);
  expect(f.context.connectorConnection.sample).toHaveBeenCalledTimes(2);
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
  expect(f.context.window.webContents.send).not.toHaveBeenCalled();
});

it("keeps temporary offline/online recovery at safe observations with the actual backoff", async () => {
  const f = fixture();
  f.original.connector.checkHealth
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false);
  f.power.emit("resume");
  const pending = f.finish();
  await until(() => f.timeouts.length === 1);
  expect(f.timeouts[0].milliseconds).toBe(1_000);
  f.timeouts[0].callback();
  await until(() => f.timeouts.length === 2);
  expect(f.timeouts[1].milliseconds).toBe(5_000);
  f.timeouts[1].callback();
  await pending;
  expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(3);
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
  expect(f.context.recordConnectorRuntime).not.toHaveBeenCalled();
});

it("coalesces resume and timer events while observing the same original health request", async () => {
  const f = fixture();
  const health = Promise.withResolvers();
  f.original.connector.checkHealth.mockReturnValueOnce(health.promise);
  f.original.connector.getTunnelObservation.mockReturnValue({
    state: "exited",
    runtimeGeneration: f.original.runtimeGeneration,
  });
  f.power.emit("resume");
  const pending = f.finish();
  f.tick();
  f.power.emit("resume");
  await until(() => f.original.connector.checkHealth.mock.calls.length === 1);
  health.resolve(false);
  await pending;
  expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(1);
  expect(f.context.recoverConnectorTransport).toHaveBeenCalledTimes(1);
  expect(f.context.reportConnectorTransport).toHaveBeenCalledExactlyOnceWith(
    f.original,
    "recovered_attachment_check_needed",
  );
  expect(f.context.window.webContents.send).toHaveBeenCalledExactlyOnceWith(
    f.context.channels.configurationChanged,
  );
});

it("invalidates a pre-sleep exit result and observes afresh immediately after resume", async () => {
  const f = fixture();
  const health = Promise.withResolvers();
  f.original.connector.checkHealth.mockReturnValueOnce(health.promise);
  f.tick();
  const pending = f.finish();
  await until(() => f.original.connector.checkHealth.mock.calls.length === 1);
  f.power.emit("suspend");
  f.original.connector.getTunnelObservation.mockReturnValueOnce({
    state: "exited",
    runtimeGeneration: f.original.runtimeGeneration,
  });
  f.power.emit("resume");
  health.resolve(false);
  await pending;
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
  expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(2);
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
});

it.each(["before-probe", "during-probe"])(
  "withdraws healthy tunnel readiness after backend loss %s without recovery",
  async (phase) => {
    const f = fixture();
    if (phase === "before-probe") f.original.core.backendAvailable = false;
    else
      f.original.connector.checkHealth.mockImplementationOnce(async () => {
        f.original.core.backendAvailable = false;
        return true;
      });
    f.power.emit("resume");
    await f.finish();
    f.power.emit("resume");
    f.tick();
    await f.finish();
    expect(f.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
      "outcome_unknown",
      f.original.runtimeGeneration,
      f.original.computerGeneration,
    );
    expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
    expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(
      phase === "before-probe" ? 0 : 1,
    );
  },
);

it("does not revive withdrawn authority on resume or consume a late pre-withdrawal result", async () => {
  const f = fixture();
  const health = Promise.withResolvers();
  f.original.connector.checkHealth.mockReturnValueOnce(health.promise);
  f.power.emit("resume");
  const pending = f.finish();
  await until(() => f.original.connector.checkHealth.mock.calls.length === 1);
  f.revoke();
  f.original.connector.getTunnelObservation.mockReturnValue({
    state: "exited",
    runtimeGeneration: f.original.runtimeGeneration,
  });
  health.resolve(false);
  await pending;
  f.power.emit("resume");
  f.tick();
  await f.finish();
  expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(1);
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
  expect(f.context.recordConnectorRuntime).not.toHaveBeenCalled();
});

it.each(["outcome_unknown", "foreign-runtime"])(
  "retains %s instead of starting a successor from a healthy endpoint",
  async (fault) => {
    const f = fixture();
    f.original.connector.getTunnelObservation.mockReturnValue({
      state: fault === "outcome_unknown" ? fault : "exited",
      runtimeGeneration:
        fault === "outcome_unknown"
          ? f.original.runtimeGeneration
          : "other-runtime",
    });
    f.power.emit("resume");
    await f.finish();
    f.power.emit("resume");
    f.tick();
    await f.finish();
    expect(f.context.recordConnectorRuntime).toHaveBeenCalledExactlyOnceWith(
      "outcome_unknown",
      f.original.runtimeGeneration,
      f.original.computerGeneration,
    );
    expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
    expect(f.context.authorityTransitions.current()).toBeNull();
    expect(f.context.connectorTaskAdmission).toBe(false);
    expect(f.original.connector.checkHealth).toHaveBeenCalledTimes(1);
    expect(f.context.window.webContents.send).toHaveBeenCalledExactlyOnceWith(
      f.context.channels.configurationChanged,
    );
  },
);

it("does not notify the renderer when terminal UNKNOWN persistence fails", async () => {
  const f = fixture();
  f.original.connector.getTunnelObservation.mockReturnValue({
    state: "outcome_unknown",
    runtimeGeneration: f.original.runtimeGeneration,
  });
  f.context.recordConnectorRuntime.mockResolvedValue({
    ok: false,
    error: "SETTINGS_WRITE_FAILED",
  });
  f.tick();
  await f.finish();
  expect(f.context.recordConnectorRuntime).toHaveBeenCalledOnce();
  expect(f.context.window.webContents.send).not.toHaveBeenCalled();
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
  expect(f.context.connectorTaskAdmission).toBe(false);
});

it.each(["owner", "connector", "core", "window", "destroyed-window", "quit"])(
  "preserves UNKNOWN recording without notifying after late %s withdrawal",
  async (change) => {
    const f = fixture();
    const recorded = Promise.withResolvers();
    const originalWindow = f.context.window;
    f.original.connector.getTunnelObservation.mockReturnValue({
      state: "outcome_unknown",
      runtimeGeneration: f.original.runtimeGeneration,
    });
    f.context.recordConnectorRuntime.mockReturnValue(recorded.promise);
    f.tick();
    const pending = f.finish();
    await until(() => f.context.recordConnectorRuntime.mock.calls.length === 1);
    if (change === "owner") f.context.configuration = {};
    if (change === "connector") f.context.secureMcpConnectorRuntime = {};
    if (change === "core") f.context.desktopGoCore = {};
    if (change === "window")
      f.context.window = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() },
      };
    if (change === "destroyed-window") originalWindow.destroyed = true;
    if (change === "quit") f.context.quitInProgress = true;
    recorded.resolve(null);
    await pending;
    expect(f.context.recordConnectorRuntime).toHaveBeenCalledOnce();
    expect(originalWindow.webContents.send).not.toHaveBeenCalled();
    expect(f.context.window.webContents.send).not.toHaveBeenCalled();
    expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
    expect(f.context.connectorTaskAdmission).toBe(false);
    expect(f.context.authorityTransitions.current()).toBeNull();
  },
);

it("does not discard a successful UNKNOWN publication because the saved state closes transport observation", async () => {
  const f = fixture();
  const current = f.context.connectorTransportCurrent.getMockImplementation();
  let persisted = false;
  f.context.connectorTransportCurrent.mockImplementation(
    (...args) => !persisted && current(...args),
  );
  f.original.connector.getTunnelObservation.mockReturnValue({
    state: "outcome_unknown",
    runtimeGeneration: f.original.runtimeGeneration,
  });
  f.context.recordConnectorRuntime.mockImplementation(async () => {
    persisted = true;
    return null;
  });
  f.tick();
  await f.finish();
  expect(persisted).toBe(true);
  expect(f.context.window.webContents.send).toHaveBeenCalledExactlyOnceWith(
    f.context.channels.configurationChanged,
  );
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
});

it("does not admit another observation or recovery from resume after Quit closes the watcher", async () => {
  const f = fixture();
  f.context.quitInProgress = true;
  f.actual.watch().close();
  f.power.emit("resume");
  f.tick();
  await f.finish();
  expect(f.original.connector.checkHealth).not.toHaveBeenCalled();
  expect(f.context.recoverConnectorTransport).not.toHaveBeenCalled();
});
