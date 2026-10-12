import { describe, expect, it, vi } from "vitest";

import { AuthorityTransitionReservation } from "../../src/apps/desktop/authority-transition";
import { workspaceConfigurationRoute } from "../../src/apps/desktop/configuration-admission";
import { drainComputerConnector } from "../../src/apps/desktop/computer-connector-drain";
import {
  WorkspaceConfigurationDrain,
  type WorkspaceConfigurationCommand,
  type WorkspaceConfigurationConfirmation,
  type WorkspaceConfigurationDrainPorts,
} from "../../src/apps/desktop/workspace-configuration-drain";

// Fake ports prove host sequencing only: no native drain, durable filesystem,
// provider, root wiring or authority-admission semantics are exercised here.
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const commands = [
  { kind: "computer.add-workspace", selectionId: "opaque-selection" },
  {
    kind: "computer.update-access",
    workspaceId: "opaque-workspace",
    access: "write",
  },
  { kind: "computer.remove-workspace", workspaceId: "opaque-workspace" },
  { kind: "computer.update-commands", commands: "workspace" },
  { kind: "computer.update-file-policy", filePolicy: "approved-roots-v1" },
] as const satisfies readonly WorkspaceConfigurationCommand[];

function fixture(command: WorkspaceConfigurationCommand = commands[1]) {
  const events: string[] = [];
  const state = {
    reservationHeld: true,
    permissionGeneration: 1,
    settingsGeneration: 1,
    quit: false,
    update: false,
  };
  const result = Object.freeze({
    ok: true,
    evidence: Object.freeze({
      operationId: "uninterpreted/original/operation",
      workspaceId: "uninterpreted/original/workspace",
    }),
    snapshot: Object.freeze({ revision: 2 }),
  });
  const current = vi.fn(
    () =>
      state.reservationHeld &&
      state.permissionGeneration === 1 &&
      state.settingsGeneration === 1 &&
      !state.quit &&
      !state.update,
  );
  const stop = vi.fn(async (): Promise<WorkspaceConfigurationConfirmation> => {
    events.push("stop");
    return true;
  });
  const recordStopped = vi.fn(
    async (): Promise<WorkspaceConfigurationConfirmation> => {
      events.push("record-stopped");
      return true;
    },
  );
  const apply = vi.fn(async (_command: WorkspaceConfigurationCommand) => {
    events.push("apply");
    return result;
  });
  const ports = { current, stop, recordStopped, apply };
  const drain = new WorkspaceConfigurationDrain(command, ports);
  return { events, state, result, ports, drain };
}

const consumed = {
  status: "refused",
  phase: "admission",
  error: "WORKSPACE_CONFIGURATION_ATTEMPT_CONSUMED",
};

describe("one admitted workspace configuration drain", () => {
  it("refuses a second workspace request after failed MCP wait and successful tunnel exit", async () => {
    let stopping = false;
    let running = true;
    const beginStop = vi.fn(async () => {
      stopping = true;
    });
    const stopConnector = vi.fn(async () => {
      running = false;
    });
    const confirmStop = vi.fn(async () => {});
    const recordStopped = vi.fn(async () => true as const);
    const apply = vi.fn(async () => ({ ok: true }));
    const runRequest = async () => {
      const route = workspaceConfigurationRoute(stopping, running);
      if (route === "unconfirmed") return "refused";
      if (route === "configure-stopped") return apply();
      return new WorkspaceConfigurationDrain(commands[1], {
        current: () => true,
        stop: async () => {
          await drainComputerConnector({
            beginStop,
            startInFlight: null,
            waitForMcpStop: async () => {
              throw new Error("synthetic MCP drain failure");
            },
            stopConnector,
            closeSavedChat: async () => {},
            confirmStop,
          });
          return true;
        },
        recordStopped,
        apply,
      }).run();
    };
    await expect(runRequest()).resolves.toMatchObject({
      status: "unknown",
      phase: "stop",
    });
    expect(running).toBe(false);
    expect(stopping).toBe(true);
    await expect(runRequest()).resolves.toBe("refused");
    expect(beginStop).toHaveBeenCalledOnce();
    expect(stopConnector).toHaveBeenCalledOnce();
    expect(confirmStop).not.toHaveBeenCalled();
    expect(recordStopped).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("allows a second stopped configuration after the original acknowledged drain with its marker retained", async () => {
    let marker = false;
    let acknowledged = false;
    let running = true;
    const apply = vi.fn(async () => ({ ok: true }));
    const drain = new WorkspaceConfigurationDrain(commands[1], {
      current: () => true,
      stop: async () => {
        await drainComputerConnector({
          beginStop: async () => {
            marker = true;
            acknowledged = false;
          },
          startInFlight: null,
          waitForMcpStop: async () => {},
          stopConnector: async () => {
            running = false;
          },
          closeSavedChat: async () => {},
          confirmStop: async () => {
            acknowledged = true;
          },
        });
        return true;
      },
      recordStopped: async () => true,
      apply,
    });
    await expect(drain.run()).resolves.toMatchObject({ status: "completed" });
    expect(marker).toBe(true);
    expect(workspaceConfigurationRoute(marker && !acknowledged, running)).toBe(
      "configure-stopped",
    );
    await apply();
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it.each(commands)(
    "preserves the $kind command and original reply",
    async (command) => {
      const f = fixture();
      const drain = new WorkspaceConfigurationDrain(command, f.ports);
      const reply = await drain.run();
      expect(f.events).toEqual(["stop", "record-stopped", "apply"]);
      expect(reply).toEqual({
        status: "completed",
        phase: "apply",
        result: f.result,
      });
      if (reply.status !== "completed")
        throw new Error("Expected original reply");
      expect(reply.result).toBe(f.result);
      expect(reply.result.evidence).toBe(f.result.evidence);
      expect(f.ports.apply.mock.calls[0]?.[0]).toBe(command);
      expect(f.ports.current).toHaveBeenCalledTimes(7);
    },
  );

  it("returns an original configuration refusal intact without interpreting it", async () => {
    const f = fixture();
    const original = Object.freeze({
      ok: false,
      error: "ORIGINAL_CONFIGURATION_REFUSAL",
      opaque: Symbol("reply"),
    });
    const drain = new WorkspaceConfigurationDrain(commands[2], {
      ...f.ports,
      apply: async () => original,
    });
    const reply = await drain.run();
    if (reply.status !== "completed")
      throw new Error("Expected original reply");
    expect(reply.result).toBe(original);
    await expect(drain.run()).resolves.toEqual(consumed);
  });

  it.each(commands)(
    "keeps the original caller reservation held across every awaited phase for $kind",
    async (command) => {
      const f = fixture(command);
      const reservation = new AuthorityTransitionReservation();
      const stop = deferred<WorkspaceConfigurationConfirmation>();
      const record = deferred<WorkspaceConfigurationConfirmation>();
      const apply = deferred<typeof f.result>();
      const recording = deferred<void>();
      const applying = deferred<void>();
      const drain = new WorkspaceConfigurationDrain(command, {
        current: () =>
          reservation.current() === "authority-change" && f.ports.current(),
        stop: () => stop.promise,
        recordStopped: () => {
          recording.resolve();
          return record.promise;
        },
        apply: () => {
          applying.resolve();
          return apply.promise;
        },
      });
      const operation = reservation.withReservation("authority-change", () =>
        drain.run(),
      );
      for (const release of [
        async () => {
          stop.resolve(true);
          await recording.promise;
        },
        async () => {
          record.resolve(true);
          await applying.promise;
        },
        async () => {
          apply.resolve(f.result);
        },
      ]) {
        expect(reservation.current()).toBe("authority-change");
        for (const kind of [
          "connector-start",
          "agent-admission",
          "authority-change",
        ] as const) {
          const forbidden = vi.fn(async () => "unexpected");
          await expect(
            reservation.withReservation(kind, forbidden),
          ).resolves.toEqual({
            admitted: false,
            heldBy: "authority-change",
          });
          expect(forbidden).not.toHaveBeenCalled();
        }
        await expect(drain.run()).resolves.toEqual(consumed);
        await release();
      }
      await expect(operation).resolves.toEqual({
        admitted: true,
        value: { status: "completed", phase: "apply", result: f.result },
      });
      expect(reservation.current()).toBeNull();
    },
  );

  it.each([
    ["missing", undefined],
    ["false", () => false],
    ["undefined", () => undefined],
    ["null", () => null],
    ["truthy number", () => 1],
    ["truthy string", () => "true"],
    ["object", () => ({ current: true })],
    ["Promise", () => Promise.resolve(true)],
    [
      "throw",
      () => {
        throw new Error("private predicate diagnostic");
      },
    ],
  ])(
    "refuses %s current before any effect and consumes the attempt",
    async (_label, current) => {
      const f = fixture();
      const ports = {
        ...f.ports,
        current,
      } as unknown as WorkspaceConfigurationDrainPorts<typeof f.result>;
      const drain = new WorkspaceConfigurationDrain(commands[1], ports);
      await expect(drain.run()).resolves.toEqual({
        status: "refused",
        phase: "admission",
        error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
      });
      expect(f.events).toEqual([]);
      await expect(drain.run()).resolves.toEqual(consumed);
    },
  );

  it.each(["stop", "recordStopped", "apply"] as const)(
    "refuses a missing %s port before draining",
    async (missing) => {
      const f = fixture();
      const ports = {
        ...f.ports,
        [missing]: undefined,
      } as unknown as WorkspaceConfigurationDrainPorts<typeof f.result>;
      const drain = new WorkspaceConfigurationDrain(commands[1], ports);
      await expect(drain.run()).resolves.toEqual({
        status: "refused",
        phase: "admission",
        error: "WORKSPACE_CONFIGURATION_INPUT_INVALID",
      });
      expect(f.events).toEqual([]);
    },
  );

  it.each([null, undefined, { kind: "connector.start" }])(
    "refuses a missing or unsupported admitted command",
    async (command) => {
      const f = fixture();
      const drain = new WorkspaceConfigurationDrain(
        command as unknown as WorkspaceConfigurationCommand,
        f.ports,
      );
      await expect(drain.run()).resolves.toEqual({
        status: "refused",
        phase: "admission",
        error: "WORKSPACE_CONFIGURATION_INPUT_INVALID",
      });
      expect(f.events).toEqual([]);
    },
  );

  it.each([
    [2, "stop", []],
    [4, "record-stopped", ["stop"]],
    [6, "apply", ["stop", "record-stopped"]],
  ] as const)(
    "checks current before a new phase at predicate call %s",
    async (check, phase, effects) => {
      const f = fixture();
      let calls = 0;
      f.ports.current.mockImplementation(() => ++calls !== check);
      await expect(f.drain.run()).resolves.toEqual({
        status: "refused",
        phase,
        error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
      });
      expect(f.events).toEqual(effects);
      expect(calls).toBe(check);
    },
  );

  for (const command of commands) {
    for (const phase of ["stop", "record-stopped"] as const) {
      it.each([
        "reservationHeld",
        "permissionGeneration",
        "settingsGeneration",
        "quit",
        "update",
      ] as const)(
        `blocks a late ${phase} for ${command.kind} after %s drift`,
        async (field) => {
          const f = fixture(command);
          const gate = deferred<WorkspaceConfigurationConfirmation>();
          const entered = deferred<void>();
          const port = phase === "stop" ? f.ports.stop : f.ports.recordStopped;
          port.mockImplementation(() => {
            f.events.push(phase);
            entered.resolve();
            return gate.promise;
          });
          const operation = f.drain.run();
          await entered.promise;
          if (field === "reservationHeld") f.state.reservationHeld = false;
          else if (field === "quit" || field === "update")
            f.state[field] = true;
          else f.state[field] += 1;
          gate.resolve(true);
          await expect(operation).resolves.toEqual({
            status: "stale",
            phase,
            error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
          });
          expect(f.events).toEqual(
            phase === "stop" ? ["stop"] : ["stop", "record-stopped"],
          );
          expect(f.ports.apply).not.toHaveBeenCalled();
          if (phase === "stop")
            expect(f.ports.recordStopped).not.toHaveBeenCalled();
          await expect(f.drain.run()).resolves.toEqual(consumed);
        },
      );

      it.each([
        [
          "known refusal",
          false,
          "refused",
          "WORKSPACE_CONFIGURATION_PHASE_REFUSED",
        ],
        [
          "unknown",
          "unknown",
          "unknown",
          "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
        ],
        [
          "missing confirmation",
          undefined,
          "unknown",
          "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
        ],
        [
          "truthy malformed confirmation",
          { stopped: true },
          "unknown",
          "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
        ],
      ] as const)(
        `blocks ${phase} %s for ${command.kind} without claiming effect absence`,
        async (_label, confirmation, status, error) => {
          const f = fixture(command);
          const port = phase === "stop" ? f.ports.stop : f.ports.recordStopped;
          port.mockImplementation(async () => {
            f.events.push(phase);
            return confirmation as WorkspaceConfigurationConfirmation;
          });
          await expect(f.drain.run()).resolves.toEqual({
            status,
            phase,
            error,
          });
          expect(f.events).toEqual(
            phase === "stop" ? ["stop"] : ["stop", "record-stopped"],
          );
          expect(f.ports.apply).not.toHaveBeenCalled();
          expect(f.ports.current).toHaveBeenCalledTimes(
            phase === "stop" ? 3 : 5,
          );
          await expect(f.drain.run()).resolves.toEqual(consumed);
        },
      );
    }
  }

  it.each(["stop", "record-stopped", "apply"] as const)(
    "classifies %s rejection safely and rechecks current",
    async (phase) => {
      const f = fixture();
      const gate = deferred<never>();
      const entered = deferred<void>();
      const reject = () => {
        f.events.push(phase);
        entered.resolve();
        return gate.promise;
      };
      if (phase === "stop") f.ports.stop.mockImplementation(reject);
      else if (phase === "record-stopped")
        f.ports.recordStopped.mockImplementation(reject);
      else f.ports.apply.mockImplementation(reject);
      const operation = f.drain.run();
      await entered.promise;
      f.state.quit = true;
      gate.reject(new Error("secret diagnostic and private filesystem path"));
      await expect(operation).resolves.toEqual({
        status: "unknown",
        phase,
        error: "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
      });
      expect(f.ports.current).toHaveBeenCalledTimes(
        phase === "stop" ? 3 : phase === "record-stopped" ? 5 : 7,
      );
      expect(f.events).toEqual(
        phase === "stop"
          ? ["stop"]
          : phase === "record-stopped"
            ? ["stop", "record-stopped"]
            : ["stop", "record-stopped", "apply"],
      );
      await expect(f.drain.run()).resolves.toEqual(consumed);
    },
  );

  it.each(["stop", "record-stopped", "apply"] as const)(
    "classifies a synchronous %s throw without replay or diagnostic disclosure",
    async (phase) => {
      const f = fixture();
      const fail = () => {
        f.events.push(phase);
        throw new Error("private synchronous port diagnostic");
      };
      if (phase === "stop") f.ports.stop.mockImplementation(fail);
      else if (phase === "record-stopped")
        f.ports.recordStopped.mockImplementation(fail);
      else f.ports.apply.mockImplementation(fail);
      await expect(f.drain.run()).resolves.toEqual({
        status: "unknown",
        phase,
        error: "WORKSPACE_CONFIGURATION_PHASE_UNCONFIRMED",
      });
      expect(f.events).toEqual(
        phase === "stop"
          ? ["stop"]
          : phase === "record-stopped"
            ? ["stop", "record-stopped"]
            : ["stop", "record-stopped", "apply"],
      );
      await expect(f.drain.run()).resolves.toEqual(consumed);
    },
  );

  it.each([
    [3, "stop"],
    [5, "record-stopped"],
    [7, "apply"],
  ] as const)(
    "blocks a throwing post-await predicate at call %s",
    async (check, phase) => {
      const f = fixture();
      let calls = 0;
      f.ports.current.mockImplementation(() => {
        if (++calls === check) throw new Error("private readback diagnostic");
        return true;
      });
      const reply = await f.drain.run();
      expect(reply).toEqual({
        status: "stale",
        phase,
        error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
        ...(phase === "apply" ? { result: f.result } : {}),
      });
      expect(f.events).toEqual(
        phase === "stop"
          ? ["stop"]
          : phase === "record-stopped"
            ? ["stop", "record-stopped"]
            : ["stop", "record-stopped", "apply"],
      );
      await expect(f.drain.run()).resolves.toEqual(consumed);
    },
  );

  it("does not revive a consumed pre-effect refusal when current becomes valid", async () => {
    const f = fixture();
    f.state.quit = true;
    await expect(f.drain.run()).resolves.toEqual({
      status: "refused",
      phase: "admission",
      error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
    });
    f.state.quit = false;
    await expect(f.drain.run()).resolves.toEqual(consumed);
    expect(f.events).toEqual([]);
  });

  it.each(["stop", "record-stopped", "apply"] as const)(
    "does not dispatch duplicate clicks during or after %s",
    async (phase) => {
      const f = fixture();
      const confirmation = deferred<WorkspaceConfigurationConfirmation>();
      const applied = deferred<typeof f.result>();
      const entered = deferred<void>();
      const held = () => {
        f.events.push(phase);
        entered.resolve();
        return confirmation.promise;
      };
      if (phase === "stop") f.ports.stop.mockImplementation(held);
      else if (phase === "record-stopped")
        f.ports.recordStopped.mockImplementation(held);
      else
        f.ports.apply.mockImplementation(() => {
          f.events.push(phase);
          entered.resolve();
          return applied.promise;
        });
      const operation = f.drain.run();
      await entered.promise;
      await expect(f.drain.run()).resolves.toEqual(consumed);
      await expect(f.drain.run()).resolves.toEqual(consumed);
      confirmation.resolve(true);
      applied.resolve(f.result);
      await expect(operation).resolves.toEqual({
        status: "completed",
        phase: "apply",
        result: f.result,
      });
      await expect(f.drain.run()).resolves.toEqual(consumed);
      expect(f.events).toEqual(["stop", "record-stopped", "apply"]);
      for (const port of [f.ports.stop, f.ports.recordStopped, f.ports.apply]) {
        expect(port).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("consumes before synchronous stop-port reentry", async () => {
    const f = fixture();
    let reentry: ReturnType<typeof f.drain.run> | undefined;
    f.ports.stop.mockImplementation(() => {
      f.events.push("stop");
      reentry = f.drain.run();
      return Promise.resolve(true);
    });
    await f.drain.run();
    await expect(reentry).resolves.toEqual(consumed);
    expect(f.events).toEqual(["stop", "record-stopped", "apply"]);
  });

  it("consumes before synchronous predicate reentry", async () => {
    const f = fixture();
    let reentry: ReturnType<typeof f.drain.run> | undefined;
    f.ports.current.mockImplementationOnce(() => {
      reentry = f.drain.run();
      return true;
    });
    await f.drain.run();
    await expect(reentry).resolves.toEqual(consumed);
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
  });

  it.each(commands)(
    "keeps a late original $kind apply reply intact without reporting current completion",
    async (command) => {
      const f = fixture(command);
      const gate = deferred<typeof f.result>();
      const entered = deferred<void>();
      f.ports.apply.mockImplementation(() => {
        f.events.push("apply");
        entered.resolve();
        return gate.promise;
      });
      const operation = f.drain.run();
      await entered.promise;
      f.state.settingsGeneration += 1;
      gate.resolve(f.result);
      const reply = await operation;
      expect(reply).toEqual({
        status: "stale",
        phase: "apply",
        error: "WORKSPACE_CONFIGURATION_NOT_CURRENT",
        result: f.result,
      });
      if (reply.status !== "stale" || reply.phase !== "apply")
        throw new Error("Expected late original reply");
      expect(reply.result).toBe(f.result);
      await expect(f.drain.run()).resolves.toEqual(consumed);
      expect(f.ports.apply).toHaveBeenCalledTimes(1);
    },
  );
});
