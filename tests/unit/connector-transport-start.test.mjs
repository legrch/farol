import { connectorRuntimeUncertain } from "../../src/pkg/product-settings/connector-uncertainty.ts";
import {
  restartedConnectorAppSelection,
  selectedConnectorApp,
} from "../../src/pkg/product-settings/connector-app-selection.ts";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";
import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition.ts";
import { ConnectorTransportWatch } from "../../apps/desktop/connector-transport-watch.ts";
import { ConnectorHostError } from "../../apps/desktop/bridge/connector-host.ts";
import { ConnectorRuntimeEffectUnknown } from "../../src/apps/desktop/secure-mcp-connector-runtime.ts";

// Source-level host sequencing only. The actual AST-extracted start and recovery
// join execute; IO ports and Settings publications are controlled doubles. A
// known fixture Open/Close/Start is not Go, native, filesystem or provider proof.
// The real watcher supplies its observation epoch, never launch authority.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const wanted = new Set([
  "startAdmittedSecureMcpConnector",
  "captureConnectorTransport",
  "connectorTransportCurrent",
  "recoverConnectorTransport",
  "observeConnectorStart",
  "recordConnectorRuntime",
  "connectorAttemptGeneration",
]);
const declarations = parse(source, {
  sourceType: "module",
  plugins: ["typescript"],
}).program.body.filter(
  (node) => node.type === "FunctionDeclaration" && wanted.has(node.id?.name),
);
if (
  declarations.length !== wanted.size ||
  new Set(declarations.map((node) => node.id.name)).size !== wanted.size
)
  throw Error("CONNECTOR_TRANSPORT_START_SOURCE_MISSING");
const extracted = declarations
  .map((node) => source.slice(node.start, node.end))
  .join("\n");
const compiled = stripTypeScriptTypes(
  `${extracted}; ({ ${[...wanted].join(", ")} });`,
);

const phases = [
  "verify",
  "credential",
  "receipt-clear",
  "open",
  "prepare",
  "resources",
  "configure",
  "doctor",
  "start",
];
const originalBinding = Object.freeze({
  profileId: "fixture-profile",
  backendGeneration: "fixture-backend",
  buildId: "fixture-build",
  runtimeId: "fixture-original-runtime",
  connectorGeneration: "3",
});
const launchSha256 = "a".repeat(64);
const originalStart = Object.freeze({
  state: "ready",
  runtimeGeneration: "b".repeat(64),
});

function fixture({ pause, startResult = originalStart, openError } = {}) {
  const reached = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const events = [];
  let binding = originalBinding;
  let closure;
  let retainedOpen;
  let uuid = 0;
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
          tunnelId: "fixture-tunnel",
          tunnelClient: {
            executablePath: "/controlled/tunnel-client",
            executableSha256: "c".repeat(64),
          },
          runtime: {
            state: "ready",
            buildId: "fixture-build",
            computerGeneration: 7,
            connectorGeneration: 3,
            runtimeGeneration: "fixture-original-health",
          },
          challenge: null,
        },
      },
    },
  };
  const reservation = new AuthorityTransitionReservation();
  const reserve = vi.spyOn(reservation, "tryReserve");
  const owner = {
    snapshot: vi.fn(() => snapshot),
    recordSecureMcpStopped: vi.fn(async (_reason, purpose, revision) => {
      events.push("stopped");
      if (purpose === "stop") expect(revision).toBe(10);
      await barrier("stopped");
      snapshot.settings.revision += 1;
      snapshot.settings.connectors.secureMcp.runtime = null;
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
    recordSecureMcpRuntime: vi.fn(async (result) => {
      events.push("record-runtime");
      await barrier("record-runtime");
      snapshot.settings.connectors.secureMcp.runtime = {
        ...result,
        connectorGeneration: 3,
      };
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
    recordSecureMcpChallenge: vi.fn(async (challenge) => {
      events.push("challenge");
      snapshot.settings.connectors.secureMcp.challenge = { ...challenge };
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
    recordSecureMcpCredential: vi.fn(async () => ({ ok: true })),
    selectSecureMcpChatGptApp: vi.fn(async (selection) => {
      events.push("select-app");
      snapshot.settings.connectors.secureMcp.chatgptApp = { ...selection };
      return { ok: true, snapshot: structuredClone(snapshot) };
    }),
  };
  async function barrier(phase) {
    // Every async port must stay under the original admitted owner. Neither
    // the watcher nor the extracted start may reacquire the reservation.
    expect(context.connectorTaskAdmission).toBe(true);
    expect(reservation.current()).toBe("connector-start");
    expect(context.configuration).toBe(owner);
    expect(context.desktopGoCore).toBe(core);
    expect(context.secureMcpConnectorRuntime).toBe(runtime);
    if (pause === phase) {
      reached.resolve();
      await resume.promise;
    }
  }
  function port(phase, result) {
    return vi.fn(async () => {
      events.push(phase);
      await barrier(phase);
      return result;
    });
  }
  const lifecycle = {
    hasUnconfirmedStop: port("stop-check", false),
    prepare: port("prepare"),
  };
  const runtime = {
    hasUnresolvedEffect: vi.fn(() => false),
    isRunning: vi.fn(() => false),
    configure: port("configure"),
    doctor: port("doctor"),
    start: port("start", startResult),
  };
  const core = {
    currentComputerConnectorBinding: () => binding,
    computerConnectorClosureReceipt: () => closure,
    openComputerConnector: vi.fn(
      async (runtimeId, _intent, _challenge, _root, origin) => {
        events.push("open");
        if (origin) {
          expect(origin).toBe(originalBinding);
          expect(closure.result.binding).toBe(originalBinding);
          expect(closure.result.recovery).toBe("settled");
          expect(snapshot.settings.connectors.secureMcp.runtime).toBeNull();
          expect(binding).toBeUndefined();
        }
        await barrier("open");
        if (openError) throw openError;
        // The controlled Go-core port retains its original known reply. Host
        // invalidation must not replay Open or manufacture a replacement result.
        binding = Object.freeze({ ...originalBinding, runtimeId });
        retainedOpen = Object.freeze({
          admissionOperationId: "fixture-original-open-operation",
          endpoint: { binding },
          launchFile: "/controlled/launch/computer-go-launch.json",
          launchSha256,
        });
        return retainedOpen;
      },
    ),
  };
  const context = {
    connectorRuntimeUncertain,
    restartedConnectorAppSelection,
    selectedConnectorApp,
    configuration: owner,
    connectorCredentialStore: {
      reference: port("credential", "fixture-key-reference"),
    },
    secureMcpConnectorRuntime: runtime,
    desktopGoCore: core,
    authorityTransitions: reservation,
    connectorTaskAdmission: false,
    connectorStartInFlight: null,
    configurationRequests: 0,
    quitInProgress: false,
    installedUpdateAdmission: false,
    summaryFenceRecovery: {},
    buildIdentity: { buildId: "fixture-build" },
    computerConnectorAdmission: vi.fn(() => ({ admissible: true })),
    codexAgentOperationActive: () => false,
    verifySelectedTunnelClient: port("verify"),
    clearConnectorVerificationReceipt: port("receipt-clear"),
    secureMcpLaunchRoot: () => "/controlled/launch",
    computerMcpLifecycle: () => lifecycle,
    stopAndConfirmComputerMcp: vi.fn(async (connector, start, go) => {
      events.push("close");
      expect(connector).toBe(runtime);
      expect(start).toBeNull();
      expect(go).toBe(core);
      await barrier("close");
      binding = undefined;
      closure = {
        requestId: "fixture-original-close-request",
        operationId: "fixture-original-close-operation",
        result: { binding: originalBinding, closed: true, recovery: "settled" },
      };
    }),
    transitionRefusal: () => ({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    }),
    configurationFailure: (error, connectorAttempt) => ({
      ok: false,
      error,
      ...(connectorAttempt ? { connectorAttempt } : {}),
    }),
    // Partial Settings fixture: schema validation is outside this sequencing test.
    ProductConfigurationResultSchema: { parse: (result) => result },
    ConnectorHostError,
    ConnectorRuntimeEffectUnknown,
    randomUUID: () => `fixture-uuid-${++uuid}`,
    createHash,
    path,
    process: { execPath: "/controlled/electron" },
    directory: "/controlled/app",
    desktopExecutionResources: () => ({
      directory: "/controlled/app",
      executable: "/controlled/electron",
      recheck: port("resources"),
    }),
  };
  const actual = vm.runInNewContext(compiled, context);
  let recoveryResult;
  const watch = new ConnectorTransportWatch({
    capture: actual.captureConnectorTransport,
    current: actual.connectorTransportCurrent,
    observe: vi.fn(async () => "exited"),
    recover: async (original, observationCurrent) => {
      recoveryResult = await actual.recoverConnectorTransport(
        original,
        observationCurrent,
      );
    },
    unknown: vi.fn(async () => {
      throw Error("UNEXPECTED_UNKNOWN_OBSERVATION");
    }),
    wait: vi.fn(async () => {
      throw Error("UNEXPECTED_BACKOFF");
    }),
  });
  return {
    context,
    actual,
    owner,
    runtime,
    core,
    lifecycle,
    reservation,
    reserve,
    snapshot,
    events,
    watch,
    reached: reached.promise,
    resume: () => resume.resolve(),
    result: () => recoveryResult,
    closure: () => closure,
    opened: () => retainedOpen,
    direct: (origin, guard) => {
      const handle = reservation.tryReserve("connector-start");
      context.connectorTaskAdmission = true;
      snapshot.settings.connectors.secureMcp.runtime = null;
      binding = undefined;
      closure = {
        result: { binding: originalBinding, closed: true, recovery: "settled" },
      };
      return actual
        .startAdmittedSecureMcpConnector(false, false, origin, guard)
        .finally(() => {
          context.connectorTaskAdmission = false;
          handle.release();
        });
    },
  };
}

function assertFinishedOwner(f) {
  expect(f.reserve).toHaveBeenCalledTimes(1);
  expect(f.reservation.current()).toBeNull();
  expect(f.context.connectorTaskAdmission).toBe(false);
  expect(f.context.connectorStartInFlight).toBeNull();
}

function assertNoReadiness(f, result) {
  expect(result.ok).toBe(false);
  expect(result.evidence).toBeUndefined();
  expect(f.owner.recordSecureMcpChallenge).not.toHaveBeenCalled();
  expect(f.snapshot.settings.connectors.secureMcp.challenge).toBeNull();
}

describe("actual admitted transport start with controlled IO", () => {
  it.each(["quitInProgress", "installedUpdateAdmission"])(
    "%s during resources recheck prevents Configure/Doctor/Start",
    async (flag) => {
      const f = fixture({ pause: "resources" });
      const original = f.watch.check();
      await f.reached;
      f.context[flag] = true;
      f.resume();
      await original;
      assertNoReadiness(f, f.result());
      expect(f.core.openComputerConnector).toHaveBeenCalledTimes(1);
      expect(f.runtime.configure).not.toHaveBeenCalled();
      expect(f.runtime.doctor).not.toHaveBeenCalled();
      expect(f.runtime.start).not.toHaveBeenCalled();
      assertFinishedOwner(f);
    },
  );

  it("joins the exact original Close/stopped prerequisite and carries recoveryFrom through one healthy start", async () => {
    const f = fixture();
    await f.watch.check();
    expect(f.result().ok).toBe(true);
    expect(f.events).toEqual([
      "stop-check",
      "close",
      "stopped",
      ...phases,
      "record-runtime",
      "challenge",
    ]);
    expect(f.owner.recordSecureMcpStopped).toHaveBeenCalledExactlyOnceWith(
      undefined,
      "stop",
      10,
    );
    expect(f.closure()).toEqual({
      requestId: "fixture-original-close-request",
      operationId: "fixture-original-close-operation",
      result: { binding: originalBinding, closed: true, recovery: "settled" },
    });
    expect(f.core.openComputerConnector.mock.calls[0][4]).toBe(originalBinding);
    expect(f.lifecycle.prepare).toHaveBeenCalledExactlyOnceWith(launchSha256);
    expect(f.runtime.configure.mock.calls[0][0].mcp.launchContractPath).toBe(
      f.opened().launchFile,
    );
    expect(f.runtime.start.mock.calls[0][0].launchContractSha256).toBe(
      launchSha256,
    );
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      ...originalStart,
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.owner.recordSecureMcpChallenge).toHaveBeenCalledExactlyOnceWith({
      challenge: "fixture-uuid-2",
      runtimeGeneration: originalStart.runtimeGeneration,
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.result().evidence).toEqual({
      kind: "connector.runtime",
      ...originalStart,
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    assertFinishedOwner(f);
  });

  it.each([undefined, () => false])(
    "refuses a missing/false recovery guard before any IO (%s)",
    async (guard) => {
      const f = fixture();
      const result = await f.direct(originalBinding, guard);
      expect(result).toEqual({
        ok: false,
        error: "AUTHORITY_CHANGE_IN_PROGRESS",
      });
      expect(f.events).toEqual([]);
      expect(f.owner.snapshot).not.toHaveBeenCalled();
      expect(f.core.openComputerConnector).not.toHaveBeenCalled();
      assertNoReadiness(f, result);
      assertFinishedOwner(f);
    },
  );

  it("rebinds the saved same-tunnel app choice after a known ready start", async () => {
    const f = fixture();
    f.snapshot.settings.connectors.secureMcp.chatgptApp = {
      name: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 1,
    };
    const result = await f.direct(undefined);
    expect(result.ok).toBe(true);
    expect(f.owner.selectSecureMcpChatGptApp).toHaveBeenCalledExactlyOnceWith({
      name: "Farol Dev",
      tunnelId: "fixture-tunnel",
      connectorGeneration: 3,
    });
    expect(f.events).toEqual([
      ...phases,
      "record-runtime",
      "challenge",
      "select-app",
    ]);
    expect(f.snapshot.settings.connectors.secureMcp.attachment).toBeUndefined();
    assertFinishedOwner(f);
  });

  it.each([undefined, () => false])(
    "keeps ordinary start without recoveryFrom unchanged (%s)",
    async (guard) => {
      const f = fixture();
      const result = await f.direct(undefined, guard);
      expect(result.ok).toBe(true);
      expect(f.events).toEqual([...phases, "record-runtime", "challenge"]);
      expect(f.core.openComputerConnector.mock.calls[0][4]).toBeUndefined();
      expect(f.context.stopAndConfirmComputerMcp).not.toHaveBeenCalled();
      assertFinishedOwner(f);
    },
  );

  it.each(["task-admission", "reservation", "go-core", "fence"])(
    "a true observation guard does not supply missing %s authority",
    async (missing) => {
      const f = fixture();
      const guard = () => {
        if (missing === "task-admission")
          f.context.connectorTaskAdmission = false;
        if (missing === "reservation")
          f.context.authorityTransitions = { current: () => null };
        if (missing === "go-core") f.context.desktopGoCore = null;
        if (missing === "fence")
          f.context.computerConnectorAdmission.mockReturnValue({
            admissible: false,
            code: "FIXTURE_FENCE_REFUSED",
          });
        return true;
      };
      const result = await f.direct(originalBinding, guard);
      expect(result.ok).toBe(false);
      expect(f.events).toEqual([]);
      expect(f.core.openComputerConnector).not.toHaveBeenCalled();
      assertNoReadiness(f, result);
      assertFinishedOwner(f);
    },
  );

  // Actual watcher methods used by Stop and suspend respectively. This tests
  // their observation-epoch consequence, not the UI command or power monitor.
  for (const [label, invalidate] of [
    ["Stop/suppressCurrent", (watch) => watch.suppressCurrent()],
    ["suspend/invalidate", (watch) => watch.invalidate()],
    ["watch close", (watch) => watch.close()],
  ]) {
    it.each(phases)(
      `${label} during pending %s prevents later effects`,
      async (phase) => {
        const f = fixture({ pause: phase });
        const pending = f.watch.check();
        await f.reached;
        const index = phases.indexOf(phase);
        expect(f.events).toEqual([
          "stop-check",
          "close",
          "stopped",
          ...phases.slice(0, index + 1),
        ]);
        invalidate(f.watch);
        // Observation invalidation does not release or replace the admitted owner.
        expect(f.reservation.current()).toBe("connector-start");
        expect(f.context.connectorTaskAdmission).toBe(true);
        f.resume();
        await pending;
        const result = f.result();
        assertNoReadiness(f, result);
        expect(f.events).toEqual([
          "stop-check",
          "close",
          "stopped",
          ...phases.slice(0, index + 1),
          ...(phase === "start" ? ["record-runtime"] : []),
        ]);
        expect(f.core.openComputerConnector).toHaveBeenCalledTimes(
          index >= 3 ? 1 : 0,
        );
        for (const [effect, mock] of [
          ["prepare", f.lifecycle.prepare],
          ["configure", f.runtime.configure],
          ["doctor", f.runtime.doctor],
          ["start", f.runtime.start],
        ])
          expect(mock).toHaveBeenCalledTimes(
            index >= phases.indexOf(effect) ? 1 : 0,
          );
        if (index >= 3) {
          expect(f.opened().admissionOperationId).toBe(
            "fixture-original-open-operation",
          );
          expect(f.core.currentComputerConnectorBinding()).toBe(
            f.opened().endpoint.binding,
          );
          expect(f.context.stopAndConfirmComputerMcp).toHaveBeenCalledTimes(1);
        }
        if (phase === "start") {
          expect(
            f.owner.recordSecureMcpRuntime,
          ).toHaveBeenCalledExactlyOnceWith({
            ...originalStart,
            computerGeneration: 7,
            buildId: "fixture-build",
          });
          expect(
            f.snapshot.settings.connectors.secureMcp.runtime.runtimeGeneration,
          ).toBe(originalStart.runtimeGeneration);
        } else expect(f.owner.recordSecureMcpRuntime).not.toHaveBeenCalled();
        assertFinishedOwner(f);
        // No recovery replay for the old capture after a suspended check finishes.
        await f.watch.check();
        expect(f.core.openComputerConnector).toHaveBeenCalledTimes(
          index >= 3 ? 1 : 0,
        );
      },
    );
  }

  it("rechecks the epoch after recording an already dispatched Start result", async () => {
    const f = fixture({ pause: "record-runtime" });
    const pending = f.watch.check();
    await f.reached;
    f.watch.invalidate();
    f.resume();
    await pending;
    assertNoReadiness(f, f.result());
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      ...originalStart,
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    assertFinishedOwner(f);
  });

  it.each([
    ["unreachable", "CONNECTOR_RUNTIME_UNREACHABLE"],
    ["outcome_unknown", "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"],
  ])(
    "retains the original %s Start classification after invalidation",
    async (state, error) => {
      const startResult = { ...originalStart, state };
      const f = fixture({ pause: "start", startResult });
      const pending = f.watch.check();
      await f.reached;
      f.watch.invalidate();
      f.resume();
      await pending;
      expect(f.result().error).toBe(error);
      expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
        ...startResult,
        computerGeneration: 7,
        buildId: "fixture-build",
      });
      assertNoReadiness(f, f.result());
      assertFinishedOwner(f);
    },
  );

  it("retains original unknown Go Open IDs after invalidation without preparing or replaying", async () => {
    const openError = new ConnectorHostError(
      "unknown",
      "connector_open_unconfirmed",
      "computer.connector.open",
      "fixture-open-request",
      "fixture-open-operation",
      "unknown",
    );
    const f = fixture({ pause: "open", openError });
    const pending = f.watch.check();
    await f.reached;
    f.watch.invalidate();
    f.resume();
    await pending;
    expect(f.result().error).toBe("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    expect(f.result().connectorAttempt).toEqual({
      method: "computer.connector.open",
      requestId: openError.requestId,
      operationId: openError.operationId,
      outcome: "unknown",
    });
    expect(f.owner.recordSecureMcpRuntime).toHaveBeenCalledExactlyOnceWith({
      state: "outcome_unknown",
      runtimeGeneration: createHash("sha256")
        .update("fixture-open-request\0fixture-open-operation")
        .digest("hex"),
      computerGeneration: 7,
      buildId: "fixture-build",
    });
    expect(f.core.openComputerConnector).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.prepare).not.toHaveBeenCalled();
    expect(f.opened()).toBeUndefined();
    assertNoReadiness(f, f.result());
    assertFinishedOwner(f);
  });
});
