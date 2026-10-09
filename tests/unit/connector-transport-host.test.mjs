import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition.ts";
import { ProductConfigurationResultSchema } from "../../src/pkg/product-settings/contract.ts";
import { ConnectorTransportWatch } from "../../apps/desktop/connector-transport-watch.ts";

// Execute the actual host join with controlled IO, not a reimplementation of
// its policy. No app, process, credentials, live profile or provider is used.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const wanted = new Set([
  "captureConnectorTransport",
  "connectorTransportCurrent",
  "recoverConnectorTransport",
  "observeConnectorStart",
]);
const nodes = parse(source, { sourceType: "module", plugins: ["typescript"] })
  .program.body;
const functions = nodes.filter(
  (node) => node.type === "FunctionDeclaration" && wanted.has(node.id?.name),
);
if (functions.length !== wanted.size)
  throw Error("HOST_RECOVERY_SOURCE_MISSING");

function fixture() {
  const binding = Object.freeze({
    profileId: "profile",
    backendGeneration: "backend",
    buildId: "build",
    runtimeId: "old-runtime",
    connectorGeneration: "3",
  });
  let currentBinding = binding;
  let closure;
  const snapshot = {
    status: "ready",
    settings: {
      revision: 10,
      computer: { generation: 7, pendingEdit: null },
      setup: {
        computer: { outcomeUnknown: false },
        connect: { outcomeUnknown: false },
      },
      connectors: {
        secureMcp: {
          generation: 3,
          credential: "stored",
          runtime: {
            state: "ready",
            buildId: "build",
            computerGeneration: 7,
            connectorGeneration: 3,
            runtimeGeneration: "old-health",
          },
        },
      },
    },
  };
  const core = {
    currentComputerConnectorBinding: () => currentBinding,
    computerConnectorClosureReceipt: () => closure,
  };
  const owner = {
    snapshot: () => snapshot,
    recordSecureMcpStopped: vi.fn(async (_reason, _purpose, revision) => {
      expect(revision).toBe(10);
      snapshot.settings.revision += 1;
      snapshot.settings.connectors.secureMcp.runtime = null;
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
  };
  const connector = { hasUnresolvedEffect: vi.fn(() => false) };
  const reservation = new AuthorityTransitionReservation();
  const context = {
    configuration: owner,
    secureMcpConnectorRuntime: connector,
    desktopGoCore: core,
    quitInProgress: false,
    installedUpdateAdmission: false,
    configurationRequests: 0,
    connectorTaskAdmission: false,
    connectorStartInFlight: null,
    buildIdentity: { buildId: "build" },
    summaryFenceRecovery: {},
    authorityTransitions: reservation,
    codexAgentOperationActive: () => false,
    computerConnectorAdmission: vi.fn(() => ({ admissible: true })),
    computerMcpLifecycle: () => ({ hasUnconfirmedStop: unconfirmed }),
    ProductConfigurationResultSchema: { parse: (result) => result },
    configurationFailure: (error) =>
      ProductConfigurationResultSchema.parse({
        ok: false,
        error,
        snapshot: { status: "error", error: "SETTINGS_READ_FAILED" },
      }),
    transitionRefusal: () => ({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    }),
    stopAndConfirmComputerMcp: vi.fn(
      async (actualConnector, start, actualCore) => {
        expect(actualConnector).toBe(connector);
        expect(start).toBeNull();
        expect(actualCore).toBe(core);
        currentBinding = undefined;
        closure = {
          requestId: "original-close-request",
          operationId: "original-close-operation",
          result: { binding, closed: true, recovery: "settled" },
        };
      },
    ),
    startAdmittedSecureMcpConnector: vi.fn(async (repair, resume, origin) => {
      expect(context.connectorTaskAdmission).toBe(true);
      expect(typeof context.connectorStartInFlight?.then).toBe("function");
      expect(reservation.current()).toBe("connector-start");
      expect(origin).toBe(binding);
      expect(repair).toBe(false);
      expect(resume).toBe(false);
      expect(snapshot.settings.connectors.secureMcp.runtime).toBeNull();
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
  };
  const unconfirmed = vi.fn(async () => false);
  const code = functions
    .map((node) => source.slice(node.start, node.end))
    .join("\n");
  const actual = vm.runInNewContext(
    stripTypeScriptTypes(
      `${code}; ({ captureConnectorTransport, recoverConnectorTransport });`,
    ),
    context,
  );
  const entry = {
    ...actual,
    recoverConnectorTransport: (original, observationCurrent = () => true) =>
      actual.recoverConnectorTransport(original, observationCurrent),
  };
  const original = entry.captureConnectorTransport();
  return {
    context,
    snapshot,
    owner,
    core,
    connector,
    reservation,
    unconfirmed,
    original,
    entry,
    closure: () => closure,
    setClosure: (next) => {
      closure = next;
    },
    setBinding: (next) => {
      currentBinding = next;
    },
  };
}

it("joins exact acknowledged closure and one stopped publication under the original reservation", async () => {
  const f = fixture();
  expect((await f.entry.recoverConnectorTransport(f.original)).ok).toBe(true);
  expect(f.owner.recordSecureMcpStopped).toHaveBeenCalledExactlyOnceWith(
    undefined,
    "stop",
    10,
  );
  expect(f.context.startAdmittedSecureMcpConnector).toHaveBeenCalledTimes(1);
  expect(f.reservation.current()).toBeNull();
  expect(f.context.connectorTaskAdmission).toBe(false);
  expect(f.context.connectorStartInFlight).toBeNull();
  expect(f.closure()).toMatchObject({
    requestId: "original-close-request",
    operationId: "original-close-operation",
  });
  await f.entry.recoverConnectorTransport(f.original);
  expect(f.context.stopAndConfirmComputerMcp).toHaveBeenCalledTimes(1);
  expect(f.context.startAdmittedSecureMcpConnector).toHaveBeenCalledTimes(1);
});

it.each([
  "computer-generation",
  "connector-generation",
  "revision",
  "pending",
  "unknown",
  "revoked",
  "quit",
  "update",
  "owner",
  "backend",
  "reservation",
])(
  "refuses a changed or unresolved boundary before drain: %s",
  async (boundary) => {
    const f = fixture();
    const settings = f.snapshot.settings;
    if (boundary === "computer-generation") settings.computer.generation += 1;
    if (boundary === "connector-generation")
      settings.connectors.secureMcp.generation += 1;
    if (boundary === "revision") settings.revision += 1;
    if (boundary === "pending") settings.computer.pendingEdit = {};
    if (boundary === "unknown") settings.setup.connect.outcomeUnknown = true;
    if (boundary === "revoked")
      settings.connectors.secureMcp.credential = "missing";
    if (boundary === "quit") f.context.quitInProgress = true;
    if (boundary === "update") f.context.installedUpdateAdmission = true;
    if (boundary === "owner")
      f.context.configuration = { snapshot: f.owner.snapshot };
    if (boundary === "backend") f.context.desktopGoCore = {};
    if (boundary === "reservation")
      f.reservation.tryReserve("authority-change");
    expect((await f.entry.recoverConnectorTransport(f.original)).ok).toBe(
      false,
    );
    expect(f.context.stopAndConfirmComputerMcp).not.toHaveBeenCalled();
    expect(f.owner.recordSecureMcpStopped).not.toHaveBeenCalled();
    expect(f.context.startAdmittedSecureMcpConnector).not.toHaveBeenCalled();
  },
);

it.each([
  "previous-unconfirmed",
  "drain-unknown",
  "no-close",
  "crossed-close",
  "late-revoke",
  "late-quit",
])("does not borrow closure or repeat a phase after %s", async (fault) => {
  const f = fixture();
  if (fault === "previous-unconfirmed") f.unconfirmed.mockResolvedValue(true);
  const originalDrain =
    f.context.stopAndConfirmComputerMcp.getMockImplementation();
  f.context.stopAndConfirmComputerMcp.mockImplementation(async (...args) => {
    if (fault === "drain-unknown") throw Error("original drain unknown");
    await originalDrain(...args);
    if (fault === "no-close") f.setClosure(undefined);
    if (fault === "crossed-close")
      f.setClosure({
        ...f.closure(),
        result: {
          ...f.closure().result,
          binding: { ...f.original.binding, runtimeId: "foreign" },
        },
      });
    if (fault === "late-revoke") f.snapshot.settings.computer.generation += 1;
    if (fault === "late-quit") f.context.quitInProgress = true;
  });
  expect((await f.entry.recoverConnectorTransport(f.original)).ok).toBe(false);
  expect(f.owner.recordSecureMcpStopped).not.toHaveBeenCalled();
  expect(f.context.startAdmittedSecureMcpConnector).not.toHaveBeenCalled();
  expect(f.context.connectorTaskAdmission).toBe(false);
  expect(f.reservation.current()).toBeNull();
});

it.each([
  ["pending_operation", "CONNECTOR_RECOVERY_PENDING_OPERATION"],
  ["operation_unknown", "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"],
  ["authority_unknown", "CONNECTOR_RECOVERY_AUTHORITY_UNAVAILABLE"],
  [undefined, "CONNECTOR_RECOVERY_UNAVAILABLE"],
])(
  "preserves a known closure without upgrading %s to permission",
  async (disposition, code) => {
    const f = fixture();
    const stop = f.context.stopAndConfirmComputerMcp.getMockImplementation();
    f.context.stopAndConfirmComputerMcp.mockImplementation(async (...args) => {
      await stop(...args);
      f.closure().result.recovery = disposition;
    });
    expect(await f.entry.recoverConnectorTransport(f.original)).toMatchObject({
      ok: false,
      error: code,
    });
    expect(f.owner.recordSecureMcpStopped).toHaveBeenCalledTimes(1);
    expect(f.context.startAdmittedSecureMcpConnector).not.toHaveBeenCalled();
  },
);

it.each(["lost-settings-reply", "late-settings-result", "lost-start-reply"])(
  "retains one original attempt and releases host admission on %s",
  async (fault) => {
    const f = fixture();
    if (fault === "lost-settings-reply")
      f.owner.recordSecureMcpStopped.mockRejectedValueOnce(
        Error("lost publication"),
      );
    if (fault === "late-settings-result") {
      const write = f.owner.recordSecureMcpStopped.getMockImplementation();
      f.owner.recordSecureMcpStopped.mockImplementationOnce(async (...args) => {
        const result = await write(...args);
        f.snapshot.settings.revision += 1;
        return result;
      });
    }
    if (fault === "lost-start-reply")
      f.context.startAdmittedSecureMcpConnector.mockRejectedValueOnce(
        Error("lost start"),
      );
    if (fault === "late-settings-result")
      expect((await f.entry.recoverConnectorTransport(f.original)).ok).toBe(
        false,
      );
    else
      await expect(
        f.entry.recoverConnectorTransport(f.original),
      ).rejects.toThrow();
    expect(f.owner.recordSecureMcpStopped).toHaveBeenCalledTimes(1);
    expect(f.context.startAdmittedSecureMcpConnector).toHaveBeenCalledTimes(
      fault === "lost-start-reply" ? 1 : 0,
    );
    expect(f.reservation.current()).toBeNull();
    expect(f.context.connectorTaskAdmission).toBe(false);
    expect(f.context.connectorStartInFlight).toBeNull();
  },
);

it.each(["explicit-stop", "suspend", "quit"])(
  "finishes original drain but refuses successor admission after %s during recovery",
  async (reason) => {
    const f = fixture();
    let entered;
    let finish;
    const draining = new Promise((resolve) => {
      entered = resolve;
    });
    const drained = new Promise((resolve) => {
      finish = resolve;
    });
    const originalDrain =
      f.context.stopAndConfirmComputerMcp.getMockImplementation();
    f.context.stopAndConfirmComputerMcp.mockImplementation(async (...args) => {
      entered();
      await drained;
      await originalDrain(...args);
    });
    const recover = vi.fn(async (original, observationCurrent) => {
      await f.entry.recoverConnectorTransport(original, observationCurrent);
    });
    const watch = new ConnectorTransportWatch({
      capture: () => f.original,
      current: () => true,
      observe: async () => "exited",
      recover,
      unknown: async () => {},
      wait: async () => {},
    });
    const pending = watch.check();
    await draining;
    if (reason === "explicit-stop") watch.suppressCurrent();
    else if (reason === "suspend") watch.invalidate();
    else watch.close();
    finish();
    await pending;
    expect(f.context.stopAndConfirmComputerMcp).toHaveBeenCalledTimes(1);
    expect(f.closure()).toMatchObject({
      operationId: "original-close-operation",
      result: { closed: true },
    });
    expect(f.owner.recordSecureMcpStopped).toHaveBeenCalledTimes(1);
    expect(f.context.startAdmittedSecureMcpConnector).not.toHaveBeenCalled();
    expect(f.reservation.current()).toBeNull();
    expect(f.context.connectorTaskAdmission).toBe(false);
    await watch.check();
    expect(recover).toHaveBeenCalledTimes(1);
  },
);
