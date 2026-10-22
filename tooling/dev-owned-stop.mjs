import {
  LEGACY_DEV_DATA_DIRECTORY_NAME,
  desktopIdentity as harnessDesktopIdentity,
} from "./harness-identity.ts";
import { devExecutables } from "./dev-runtime.mjs";

// Mechanical launcher sequencing only. No native lookup, process discovery,
// profile access, recovery, startup, or implicit host ports live here.
export const DEV_OWNED_STOP_LIMITS = Object.freeze({
  // Normal Quit can drain the connector and retire/record Go sequentially.
  gracefulMs: 30_000,
  maxWaitMs: 32_000,
  pollMs: 100,
});

/**
 * @typedef {Readonly<{pid: number, uid: number, startIdentity: string,
 * executable: string, writerRoot: string, appPath: string, profilePath: string,
 * environment: 'dev', applicationId: string, installed: false}>} DevIdentity
 * @typedef {Readonly<{uid: number, writerRoot: string, appPath: string,
 * profilePath: string}>} DevScope
 * @typedef {{status: 'absent'} | {status: 'unreadable'} |
 * {status: 'present', identity: DevIdentity}} Inspection
 * @typedef {'SIGTERM' | 'SIGKILL'} StopSignal
 * @typedef {{status: 'sent' | 'absent' | 'refused' | 'unknown'}} SignalResult
 * @typedef {{clock: () => number, sleep: (ms: number) => Promise<void>,
 * inspect: (pid: number, remainingMs: number) => Inspection,
 * signal: (pid: number, signal: StopSignal, expected: DevIdentity,
 * remainingMs: number) => SignalResult}} StopPorts
 */

const IDENTITY_FIELDS = Object.freeze([
  "pid",
  "uid",
  "startIdentity",
  "executable",
  "writerRoot",
  "appPath",
  "profilePath",
  "environment",
  "applicationId",
  "installed",
]);

function canonicalPath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    value
      .split("/")
      .slice(1)
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function validScope(scope) {
  return (
    scope &&
    Number.isSafeInteger(scope.uid) &&
    scope.uid >= 0 &&
    ["writerRoot", "appPath", "profilePath"].every((field) =>
      canonicalPath(scope[field]),
    ) &&
    scope.appPath === `${scope.writerRoot}/_output/build/app/main.cjs` &&
    [
      harnessDesktopIdentity("dev", "/").userData,
      `/${LEGACY_DEV_DATA_DIRECTORY_NAME}`,
    ].some((leaf) => scope.profilePath.endsWith(leaf))
  );
}

function validIdentity(identity) {
  return (
    validScope(identity) &&
    Number.isSafeInteger(identity.pid) &&
    identity.pid > 0 &&
    identity.pid <= 2 ** 31 - 1 &&
    typeof identity.startIdentity === "string" &&
    identity.startIdentity.trim().length > 0 &&
    identity.startIdentity.length <= 256 &&
    !identity.startIdentity.includes("\0") &&
    identity.environment === "dev" &&
    identity.applicationId ===
      harnessDesktopIdentity("dev", "/").applicationId &&
    identity.installed === false &&
    devExecutables(identity.writerRoot).includes(identity.executable)
  );
}

/**
 * Stop exactly one retained ordinary Dev lifetime. Only status='absent' permits
 * the Lead to proceed to its separate build gate. It proves no clean Quit,
 * drain, profile safety, or child/descendant closure.
 *
 * scope is independently selected by the Lead, never derived from an untrusted
 * marker. Paths must already be physically canonical; lexical checks here
 * cannot prove realpath or ownership. startIdentity must be a native lifetime
 * token including boot and precise kernel start identity, NOT marker startedAt
 * or the whole-second ps lstart string. inspect must correlate the actual
 * executable/app/profile with that lifetime, not merely echo retained values.
 *
 * inspect/signal are synchronous, bounded native adapters (remainingMs is their
 * upper budget). No await occurs between pre-signal inspection and signaling.
 * signal must enforce expected identity at its native boundary and distinguish
 * absent/refused/unknown; a numeric-PID syscall alone has a reuse race. Async
 * adapters, exceptions, and unknown results refuse without retry. sleep must
 * settle within its requested budget; clock must be monotonic milliseconds.
 * JavaScript cannot preempt a blocking/never-settling injected port.
 *
 * @param {DevIdentity} retained
 * @param {DevScope} scope
 * @param {StopPorts} ports No ambient defaults and no timeout overrides.
 */
export async function stopRetainedDevProcess(retained, scope, ports) {
  /** @type {StopSignal[]} */
  const attemptedSignals = [];
  const result = (status, reason) =>
    Object.freeze({
      status,
      reason,
      attemptedSignals: Object.freeze([...attemptedSignals]),
    });
  if (
    !validScope(scope) ||
    !validIdentity(retained) ||
    !["uid", "writerRoot", "appPath", "profilePath"].every(
      (field) => retained[field] === scope[field],
    )
  )
    return result("refused", "RETAINED_IDENTITY_INVALID");
  if (
    !ports ||
    !["clock", "sleep", "inspect", "signal"].every(
      (field) => typeof ports[field] === "function",
    )
  )
    return result("refused", "PORTS_INVALID");

  const expected = Object.freeze(
    Object.fromEntries(
      IDENTITY_FIELDS.map((field) => [field, retained[field]]),
    ),
  );
  let lastTime = -Infinity;
  function now() {
    const time = ports.clock();
    if (!Number.isFinite(time) || time < 0 || time < lastTime)
      throw new Error("CLOCK_INVALID");
    lastTime = time;
    return time;
  }
  let deadline;
  // Also cap work if an injected clock advances by arbitrarily tiny amounts.
  let pollsRemaining =
    Math.ceil(DEV_OWNED_STOP_LIMITS.maxWaitMs / DEV_OWNED_STOP_LIMITS.pollMs) +
    2;
  function inspect() {
    let observation;
    try {
      observation = ports.inspect(expected.pid, Math.max(0, deadline - now()));
    } catch {
      return "IDENTITY_UNREADABLE";
    }
    if (observation?.status === "absent") return "absent";
    if (
      observation?.status !== "present" ||
      !validIdentity(observation.identity)
    )
      return "IDENTITY_UNREADABLE";
    return IDENTITY_FIELDS.every(
      (field) => observation.identity[field] === expected[field],
    )
      ? "present"
      : "IDENTITY_CHANGED";
  }
  function send(signalName) {
    // A separate current observation immediately precedes EACH signal.
    const current = inspect();
    if (current !== "present") return current;
    const remaining = deadline - now();
    if (remaining <= 0) return "STOP_TIMEOUT";
    attemptedSignals.push(signalName);
    let outcome;
    try {
      outcome = ports.signal(expected.pid, signalName, expected, remaining);
    } catch {
      return "SIGNAL_OUTCOME_UNKNOWN";
    }
    if (outcome?.status === "refused") return "SIGNAL_REFUSED";
    if (outcome?.status !== "sent" && outcome?.status !== "absent")
      return "SIGNAL_OUTCOME_UNKNOWN";
    if (outcome.status === "absent") {
      const confirmed = inspect();
      return confirmed === "present" ? "SIGNAL_ABSENCE_UNCONFIRMED" : confirmed;
    }
    return "present";
  }
  async function waitUntil(until) {
    for (;;) {
      const current = inspect();
      if (current !== "present") return current;
      const before = now();
      if (before >= until) return "present";
      if (pollsRemaining-- <= 0) return "WAIT_BUDGET_EXHAUSTED";
      try {
        await ports.sleep(
          Math.min(DEV_OWNED_STOP_LIMITS.pollMs, until - before),
        );
      } catch {
        return "WAIT_UNREADABLE";
      }
      if (now() <= before) return "CLOCK_NOT_ADVANCING";
    }
  }
  try {
    const started = now();
    deadline = started + DEV_OWNED_STOP_LIMITS.maxWaitMs;
    const initial = inspect();
    if (initial !== "present")
      return result(initial === "absent" ? "absent" : "refused", initial);
    let state = send("SIGTERM");
    if (state === "present")
      state = await waitUntil(started + DEV_OWNED_STOP_LIMITS.gracefulMs);
    if (state === "present") state = send("SIGKILL");
    if (state === "present") state = await waitUntil(deadline);
    if (state === "present") state = "STOP_TIMEOUT";
    return result(state === "absent" ? "absent" : "refused", state);
  } catch {
    return result("refused", "CLOCK_INVALID");
  }
}
