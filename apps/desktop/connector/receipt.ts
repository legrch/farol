// The closed vocabulary a connector child may report about its own end, and
// the strict parsers that admit it. A receipt crosses an IPC channel from the
// tunnel anchor, so nothing here coerces, reads a getter or keeps the raw
// payload: only an exact, content-free shape becomes an observation.

export const TUNNEL_EXITED = "farol-tunnel-exited-v1";
export const TUNNEL_UNKNOWN = "farol-tunnel-unknown-v1";
export const TUNNEL_TERMINAL = "farol-tunnel-terminal-v1";

export type ConnectorChildLifecycleObservation = Readonly<{
  source: "connector-tunnel" | "connector-anchor";
  event:
    | "exit"
    | "close"
    | "error"
    | "disconnect"
    | "invalid-receipt"
    | "cleanup-unknown";
  code:
    | "CONNECTOR_TUNNEL_EXIT"
    | "CONNECTOR_TUNNEL_ERROR"
    | "CONNECTOR_TUNNEL_RECEIPT_INVALID"
    | "CONNECTOR_ANCHOR_EXIT"
    | "CONNECTOR_ANCHOR_CLOSE"
    | "CONNECTOR_ANCHOR_ERROR"
    | "CONNECTOR_IPC_DISCONNECTED"
    | "CONNECTOR_STOP_UNCONFIRMED";
  state: "observed" | "outcome_unknown";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}>;
export type ConnectorRuntimeLifecycleObservation =
  ConnectorChildLifecycleObservation &
    Readonly<{
      phase: "startup" | "active" | "closing";
      runtimeGeneration: string;
    }>;

const terminalSignals = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
  "SIGINFO",
  "SIGEMT",
  "SIGBREAK",
]);
export function terminalCode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
    ? value
    : null;
}
export function terminalSignal(value: unknown): NodeJS.Signals | null {
  return typeof value === "string" && terminalSignals.has(value)
    ? (value as NodeJS.Signals)
    : null;
}
export function terminalReceipt(
  value: unknown,
): Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(fields);
    if (
      keys.length !== 5 ||
      !["kind", "source", "event", "exitCode", "signal"].every(
        (key) => fields[key] && "value" in fields[key],
      )
    )
      return null;
    const kind = fields.kind!.value,
      source = fields.source!.value,
      event = fields.event!.value;
    const code = fields.exitCode!.value,
      signal = fields.signal!.value;
    if (
      kind !== TUNNEL_TERMINAL ||
      source !== "connector-tunnel" ||
      event !== "exit" ||
      (code !== null && terminalCode(code) !== code) ||
      (signal !== null && terminalSignal(signal) !== signal) ||
      (code === null && signal === null) ||
      (code !== null && signal !== null)
    )
      return null;
    return Object.freeze({ exitCode: code, signal });
  } catch {
    return null;
  }
}

export function childLifecycleRecord(
  value: unknown,
): ConnectorChildLifecycleObservation | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(fields).length !== 7 ||
      ![
        "source",
        "event",
        "code",
        "state",
        "exitCode",
        "signal",
        "forced",
      ].every((key) => fields[key] && "value" in fields[key])
    )
      return null;
    const source = fields.source!.value,
      event = fields.event!.value,
      code = fields.code!.value,
      state = fields.state!.value,
      exitCode = fields.exitCode!.value,
      signal = fields.signal!.value,
      forced = fields.forced!.value;
    const allowed = [
      ["connector-tunnel", "exit", "CONNECTOR_TUNNEL_EXIT"],
      ["connector-tunnel", "error", "CONNECTOR_TUNNEL_ERROR"],
      [
        "connector-tunnel",
        "invalid-receipt",
        "CONNECTOR_TUNNEL_RECEIPT_INVALID",
      ],
      ["connector-anchor", "exit", "CONNECTOR_ANCHOR_EXIT"],
      ["connector-anchor", "close", "CONNECTOR_ANCHOR_CLOSE"],
      ["connector-anchor", "error", "CONNECTOR_ANCHOR_ERROR"],
      ["connector-anchor", "disconnect", "CONNECTOR_IPC_DISCONNECTED"],
      ["connector-anchor", "cleanup-unknown", "CONNECTOR_STOP_UNCONFIRMED"],
    ] as const;
    if (
      !allowed.some(([s, e, c]) => source === s && event === e && code === c) ||
      (state !== "observed" && state !== "outcome_unknown") ||
      typeof forced !== "boolean" ||
      (exitCode !== null && terminalCode(exitCode) !== exitCode) ||
      (signal !== null && terminalSignal(signal) !== signal) ||
      (exitCode !== null && signal !== null) ||
      (event !== "exit" &&
        event !== "close" &&
        (state !== "outcome_unknown" ||
          exitCode !== null ||
          signal !== null)) ||
      (state === "observed" && exitCode === null && signal === null)
    )
      return null;
    return Object.freeze({
      source,
      event,
      code,
      state,
      exitCode,
      signal,
      forced,
    });
  } catch {
    return null;
  }
}
