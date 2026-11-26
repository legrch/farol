import type { ChildProcess } from "node:child_process";
import {
  TUNNEL_EXITED,
  TUNNEL_UNKNOWN,
  terminalCode,
  terminalReceipt,
  terminalSignal,
  type ConnectorChildLifecycleObservation,
} from "./receipt";

// What Desktop observes about one spawned connector child: the tunnel's own
// terminal report, kept apart from confirmation that the whole owned process
// group has closed, plus the content-free lifecycle diagnostics. The child is
// a port, so the same wrapper serves the real anchor and a test double.

export type ConnectorTunnelObservation = Readonly<{
  state: "exited" | "outcome_unknown";
  terminal?: ConnectorChildLifecycleObservation;
}>;

export type ConnectorChild = Readonly<{
  pid: number | undefined;
  exitCode: number | null;
  // Separate from confirmation that the entire owned group has closed.
  tunnelObservation?: ConnectorTunnelObservation | null;
  kill: (signal: NodeJS.Signals) => boolean;
  waitForExit: (timeoutMs: number) => Promise<boolean>;
  observeLifecycle?: (
    observer: (observation: ConnectorChildLifecycleObservation) => void,
  ) => () => void;
}>;

export function observedConnectorChild(
  child: ChildProcess,
  ownsProcessGroup = false,
  observesTunnel = false,
): ConnectorChild {
  let tunnelObservation: ConnectorTunnelObservation | null = null;
  const retained = new Map<string, ConnectorChildLifecycleObservation>();
  const observers = new Set<
    (observation: ConnectorChildLifecycleObservation) => void
  >();
  let forced = false;
  const diagnostic = (
    source: ConnectorChildLifecycleObservation["source"],
    event: ConnectorChildLifecycleObservation["event"],
    code: ConnectorChildLifecycleObservation["code"],
    state: ConnectorChildLifecycleObservation["state"],
    exitCode: unknown = null,
    signal: unknown = null,
  ) => {
    const key = `${source}:${event}`;
    if (retained.has(key)) return retained.get(key)!;
    const safeCode = terminalCode(exitCode),
      safeSignal = terminalSignal(signal);
    const terminalKnown = (safeCode === null) !== (safeSignal === null);
    const observation = Object.freeze({
      source,
      event,
      code,
      state: state === "observed" && !terminalKnown ? "outcome_unknown" : state,
      exitCode: terminalKnown ? safeCode : null,
      signal: terminalKnown ? safeSignal : null,
      forced,
    });
    retained.set(key, observation);
    for (const observer of observers) {
      try {
        void Promise.resolve(observer(observation)).catch(() => undefined);
      } catch {
        /* Diagnostics never change cleanup. */
      }
    }
    return observation;
  };
  const observe = (
    state: ConnectorTunnelObservation["state"],
    terminal?: ConnectorChildLifecycleObservation,
  ) => {
    tunnelObservation ??= Object.freeze({
      state,
      ...(terminal ? { terminal } : {}),
    });
  };
  // A failed signal can emit `error` without `exit`. Never treat it as exit.
  child.on("error", () => {
    if (observesTunnel) observe("outcome_unknown");
    diagnostic(
      "connector-anchor",
      "error",
      "CONNECTOR_ANCHOR_ERROR",
      "outcome_unknown",
    );
  });
  if (observesTunnel) {
    // This channel belongs to the exact spawned anchor. Accept only closed,
    // content-free receipts; no coercion, getters or retained raw payload.
    child.on("message", (message: unknown) => {
      if (tunnelObservation) return;
      if (message === TUNNEL_EXITED) {
        observe("exited");
        // Legacy exit tokens prove no exit-code/signal detail.
        diagnostic(
          "connector-tunnel",
          "exit",
          "CONNECTOR_TUNNEL_EXIT",
          "outcome_unknown",
        );
      } else if (message === TUNNEL_UNKNOWN) {
        observe("outcome_unknown");
        diagnostic(
          "connector-tunnel",
          "error",
          "CONNECTOR_TUNNEL_ERROR",
          "outcome_unknown",
        );
      } else {
        const receipt = terminalReceipt(message);
        if (receipt) {
          observe("exited");
          const terminal = diagnostic(
            "connector-tunnel",
            "exit",
            "CONNECTOR_TUNNEL_EXIT",
            "observed",
            receipt.exitCode,
            receipt.signal,
          );
          tunnelObservation = Object.freeze({ state: "exited", terminal });
        } else {
          observe("outcome_unknown");
          diagnostic(
            "connector-tunnel",
            "invalid-receipt",
            "CONNECTOR_TUNNEL_RECEIPT_INVALID",
            "outcome_unknown",
          );
        }
      }
    });
    child.once("disconnect", () => {
      observe("outcome_unknown");
      diagnostic(
        "connector-anchor",
        "disconnect",
        "CONNECTOR_IPC_DISCONNECTED",
        "outcome_unknown",
      );
    });
    child.once("exit", (code, signal) => {
      observe("outcome_unknown");
      diagnostic(
        "connector-anchor",
        "exit",
        "CONNECTOR_ANCHOR_EXIT",
        "observed",
        code,
        signal,
      );
    });
    child.once("close", (code, signal) =>
      diagnostic(
        "connector-anchor",
        "close",
        "CONNECTOR_ANCHOR_CLOSE",
        "observed",
        code,
        signal,
      ),
    );
  }
  const groupPid = ownsProcessGroup ? child.pid : undefined;
  let groupGone = false;
  let signalRefused = false;
  const directExitCode = () =>
    child.exitCode ?? (child.signalCode === null ? null : -1);
  const groupExitConfirmed = () => {
    if (!ownsProcessGroup) return true;
    if (signalRefused || groupPid === undefined) return false;
    if (groupGone) return true;
    try {
      process.kill(-groupPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        // Cache absence: never probe or signal a subsequently reused group.
        groupGone = true;
      } else {
        signalRefused = true;
      }
    }
    return groupGone;
  };
  return {
    pid: child.pid,
    get tunnelObservation() {
      return tunnelObservation;
    },
    get exitCode() {
      const code = directExitCode();
      return code !== null && groupExitConfirmed() ? code : null;
    },
    observeLifecycle: (observer) => {
      if (observers.size < 4) {
        observers.add(observer);
        for (const observation of retained.values()) {
          try {
            void Promise.resolve(observer(observation)).catch(() => undefined);
          } catch {
            /* Diagnostics remain optional. */
          }
        }
      }
      return () => {
        observers.delete(observer);
      };
    },
    kill: (signal) => {
      if (signal === "SIGKILL") forced = true;
      if (!ownsProcessGroup) return child.kill(signal);
      // Only the exact detached spawn owns this group. Once its leader exited,
      // ownership cannot be re-established from a numeric PID; do not escalate
      // against descendants or a reused group. Retain unconfirmed cleanup.
      if (
        groupPid === undefined ||
        signalRefused ||
        groupGone ||
        directExitCode() !== null
      )
        return false;
      try {
        process.kill(-groupPid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") groupGone = true;
        else signalRefused = true;
        return false;
      }
    },
    waitForExit: async (timeoutMs) => {
      if (ownsProcessGroup) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (signalRefused) return false;
          if (directExitCode() !== null && groupExitConfirmed()) return true;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return false;
          await wait(Math.min(50, remaining));
        }
      }
      if (directExitCode() !== null) return true;
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", exited);
          child.off("error", failed);
          resolve(value);
        };
        const exited = () => finish(true);
        const failed = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", exited);
        child.once("error", failed);
      });
    },
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
