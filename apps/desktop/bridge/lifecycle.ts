// Facts observed on the original ChildProcess, not a clean-retirement decision.
// Go must separately qualify origin retirement and the initiating host's ACK.
export type ChildTerminalObservation = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}>;

export type BackendLifecycleObservation = Readonly<{
  source: "go-backend";
  phase: "startup" | "active" | "closing";
  event: "failure" | "child-close" | "cleanup-unknown";
  code: BackendLifecycleCode;
  state: "observed" | "outcome_unknown" | "unavailable";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  hostLifetimeId: string | null;
  childLaunchId: string | null;
}>;
const lifecycleCodeValues = [
  "protocol_violation",
  "transport_ended",
  "truncated_frame",
  "transport_failed",
  "backend_unavailable",
  "response_timeout",
  "stale_event_context",
  "event_stream_budget",
  "event_sequence_regression",
  "invalid_response",
  "crossed_response_id",
  "crossed_response_context",
  "invalid_backend_identity",
  "wrong_backend_identity",
  "handshake_refused",
  "client_closed",
] as const;
export type BackendLifecycleCode =
  | (typeof lifecycleCodeValues)[number]
  | "backend_unclassified_failure"
  | "backend_child_closed"
  | "backend_requested_clean_exit"
  | "backend_cleanup_unconfirmed";
const lifecycleCodes = new Set<string>(lifecycleCodeValues);
const lifecycleSignals = new Set([
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

export type LifecycleIdentity = Readonly<{
  hostLifetimeId: string;
  childLaunchId: string;
}>;

// Same shape the launcher accepts for every host-supplied identifier.
export const safeIdentity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

// Copies only own data fields, never invoking caller accessors. A missing or
// malformed diagnostic identity must not change launch behavior.
export function lifecycleIdentity(
  input?: Readonly<{ hostLifetimeId: string; childLaunchId: string }>,
): LifecycleIdentity | undefined {
  try {
    const fields: PropertyDescriptorMap = input
      ? Object.getOwnPropertyDescriptors(input)
      : {};
    const host = fields.hostLifetimeId?.value;
    const child = fields.childLaunchId?.value;
    if (
      typeof host === "string" &&
      typeof child === "string" &&
      safeIdentity.test(host) &&
      safeIdentity.test(child)
    )
      return Object.freeze({ hostLifetimeId: host, childLaunchId: child });
  } catch {
    /* Missing diagnostic identity must not change launch behavior. */
  }
  return undefined;
}

// Failure codes outside the closed set collapse to one unclassified code.
export function lifecycleCode(code: string): BackendLifecycleCode {
  return lifecycleCodes.has(code)
    ? (code as BackendLifecycleCode)
    : "backend_unclassified_failure";
}

// Builds one frozen observation. Exactly one of exit code or signal must be
// a known value, otherwise a child-close is reported as outcome_unknown.
export function lifecycleObservation(
  input: Readonly<{
    event: BackendLifecycleObservation["event"];
    code: BackendLifecycleCode;
    state: BackendLifecycleObservation["state"];
    phase: BackendLifecycleObservation["phase"];
    exitCode: unknown;
    signal: unknown;
    forced: boolean;
    identity: LifecycleIdentity | undefined;
  }>,
): BackendLifecycleObservation {
  const { exitCode, signal } = input;
  const safeExitCode =
    typeof exitCode === "number" &&
    Number.isInteger(exitCode) &&
    exitCode >= -2147483648 &&
    exitCode <= 2147483647
      ? exitCode
      : null;
  const safeSignal =
    typeof signal === "string" && lifecycleSignals.has(signal)
      ? (signal as NodeJS.Signals)
      : null;
  const terminalKnown = (safeExitCode === null) !== (safeSignal === null);
  return Object.freeze({
    source: "go-backend",
    phase: input.phase,
    event: input.event,
    code: input.code,
    state:
      input.event === "child-close" && !terminalKnown
        ? "outcome_unknown"
        : input.state,
    exitCode: terminalKnown ? safeExitCode : null,
    signal: terminalKnown ? safeSignal : null,
    forced: input.forced,
    hostLifetimeId: input.identity?.hostLifetimeId ?? null,
    childLaunchId: input.identity?.childLaunchId ?? null,
  });
}
