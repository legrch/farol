import type { DesktopAdmission } from "./admission";

// Quit's claim steps: the synchronous preparation that runs once, right after
// the drain claims its attempt and before preparation can wait. The latched
// admission is what the updater's effect fence and every closer then see, so a
// step that throws is recorded by the drain as an unconfirmed stop and never
// skips the remaining steps or the drain itself. Main keeps every owner; each
// of its `let`s is a late getter here and each timer or watch is read through
// its holder when the step runs, never captured at construction. The one owner
// write, the cancelled-resume flag, is a setter port. Abort and close are
// idempotent; a re-entrant Quit cannot create a new start, Stop, drain or
// cancellation. Nothing here awaits: the order of the steps is the order of
// effects.

type Held<T> = { current: T };

export type ClaimPorts = Readonly<{
  desktopAdmission: Pick<DesktopAdmission, "beginQuit">;
  /** The owner write: a launch-time connector resume must not start after Quit. */
  cancelConnectorResume: () => void;
  connectorStartCancellation: () => { abort(): void } | null | undefined;
  processAuditObserver: () => { stop(): void } | undefined;
  connectorTransportWatch: Held<{ close(): void } | null>;
  connectorTransportTimer: Held<NodeJS.Timeout | null>;
  connectorConnection: { close(): unknown };
  isolatedE2EHome: string | undefined;
  process: Pick<NodeJS.Process, "removeAllListeners">;
  connectorStatusTimer: Held<NodeJS.Timeout | null>;
  installedUpdates: { stopTimer(): void };
}>;

export type ClaimStep = Readonly<{ name: string; run(): void }>;

export function quitClaim(ports: ClaimPorts): readonly ClaimStep[] {
  return [
    { name: "admission", run: () => ports.desktopAdmission.beginQuit() },
    {
      name: "connector-resume",
      run: () => {
        ports.cancelConnectorResume();
      },
    },
    {
      name: "connector-start",
      run: () => ports.connectorStartCancellation()?.abort(),
    },
    { name: "process-audit", run: () => ports.processAuditObserver()?.stop() },
    {
      name: "transport-watch",
      run: () => ports.connectorTransportWatch.current?.close(),
    },
    {
      name: "transport-timer",
      run: () => {
        if (ports.connectorTransportTimer.current)
          clearInterval(ports.connectorTransportTimer.current);
      },
    },
    { name: "connection", run: () => ports.connectorConnection.close() },
    {
      name: "e2e-observer",
      run: () => {
        if (ports.isolatedE2EHome !== undefined)
          ports.process.removeAllListeners("farol-e2e-observe-connection");
      },
    },
    {
      name: "status-timer",
      run: () => {
        if (ports.connectorStatusTimer.current)
          clearInterval(ports.connectorStatusTimer.current);
      },
    },
    { name: "update-timer", run: () => ports.installedUpdates.stopTimer() },
  ];
}
