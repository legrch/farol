import {
  E2E_WINDOW_LIFETIME_SCHEMA,
  E2E_WINDOW_LIFETIME_PREFIX,
} from "../../../apps/desktop/bridge/e2e-window-observer.ts";

export { E2E_WINDOW_LIFETIME_PREFIX, E2E_WINDOW_LIFETIME_SCHEMA };
const fields = [
  "schema",
  "pid",
  "sequence",
  "priorWindows",
  "createdWindows",
  "openWindows",
  "violations",
  "overflow",
  "observerFault",
];
const terminalEvents = new Set(["node-exit", "app-quit"]);
const events = new Set([
  "armed",
  "created",
  "show",
  "focus",
  "closed",
  ...terminalEvents,
]);
const require = (ok, name) => {
  if (!ok) throw new Error(`NATIVE_LIFETIME_WINDOW_${name}`);
};
const keys = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
function shape(value) {
  require(value.schema === E2E_WINDOW_LIFETIME_SCHEMA &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 1 &&
    [
      "sequence",
      "priorWindows",
      "createdWindows",
      "openWindows",
      "violations",
    ].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    typeof value.overflow === "boolean" &&
    typeof value.observerFault === "boolean", "MALFORMED");
}
function healthy(value, pid) {
  require(value.pid === pid &&
    value.priorWindows === 0 &&
    value.createdWindows <= 64 &&
    value.openWindows <= value.createdWindows &&
    value.violations === 0 &&
    value.overflow === false &&
    value.observerFault === false, "UNCONFIRMED");
}
export function assertWindowSnapshot(value, pid) {
  require(keys(value, fields), "SNAPSHOT_REQUIRED");
  shape(value);
  healthy(value, pid);
  require(value.createdWindows >= 1 &&
    value.openWindows >= 1 &&
    value.sequence >= 1, "EARLY_OBSERVER_REQUIRED");
  return value;
}
export function parseWindowFrame(line) {
  require(typeof line === "string" &&
    line.startsWith(E2E_WINDOW_LIFETIME_PREFIX) &&
    Buffer.byteLength(line) <= 4096, "FRAME_INVALID");
  const text = line.slice(E2E_WINDOW_LIFETIME_PREFIX.length);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("NATIVE_LIFETIME_WINDOW_FRAME_INVALID");
  }
  const expected = [...fields, "event", "exitCode"];
  require(keys(value, expected) &&
    (text.match(/"(?:[^"\\]|\\.)*"\s*:/gu) ?? []).length ===
      expected.length, "FRAME_INVALID");
  shape(value);
  require(events.has(value.event) &&
    (terminalEvents.has(value.event)
      ? Number.isSafeInteger(value.exitCode)
      : value.exitCode === null), "FRAME_INVALID");
  return Object.freeze(value);
}

// Only classified frames are retained. Earlier events are represented by the
// producer's cumulative counters; collection continues until actual stream end.
export function collectWindowObservation(stream) {
  require(stream && typeof stream.on === "function", "STREAM_REQUIRED");
  const frames = [];
  let buffer = "",
    malformed = false,
    overflow = false,
    complete = false;
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith(E2E_WINDOW_LIFETIME_PREFIX)) continue;
      if (frames.length === 256) {
        overflow = true;
        continue;
      }
      try {
        frames.push(parseWindowFrame(line));
      } catch {
        malformed = true;
      }
    }
    if (buffer.length > 16384) {
      if (buffer.startsWith(E2E_WINDOW_LIFETIME_PREFIX)) malformed = true;
      buffer = buffer.slice(-16384);
    }
  });
  stream.once("error", () => {
    malformed = true;
  });
  stream.once("end", () => {
    if (buffer.startsWith(E2E_WINDOW_LIFETIME_PREFIX)) malformed = true;
    buffer = "";
    complete = true;
  });
  stream.once("close", () => {
    if (!complete) malformed = true;
  });
  return Object.freeze({
    snapshot: () =>
      Object.freeze({
        frames: Object.freeze([...frames]),
        malformed,
        overflow,
        complete,
      }),
  });
}
export function assertWindowLifetime(before, trace, exit) {
  assertWindowSnapshot(before, exit.pid);
  require(exit.code === 0 &&
    exit.signal === null &&
    trace &&
    trace.complete === true &&
    trace.malformed === false &&
    trace.overflow === false &&
    Array.isArray(trace.frames), "TERMINAL_UNCONFIRMED");
  let prior = null;
  const terminals = new Map();
  for (const frame of trace.frames) {
    require(keys(frame, [...fields, "event", "exitCode"]), "FRAME_INVALID");
    shape(frame);
    require(events.has(frame.event) &&
      (terminalEvents.has(frame.event)
        ? Number.isSafeInteger(frame.exitCode)
        : frame.exitCode === null), "FRAME_INVALID");
    healthy(frame, exit.pid);
    if (prior)
      require(frame.sequence > prior.sequence &&
        frame.createdWindows >= prior.createdWindows &&
        frame.violations >= prior.violations, "COUNTER_REGRESSION");
    prior = frame;
    if (terminalEvents.has(frame.event)) {
      require(!terminals.has(frame.event) &&
        frame.exitCode === 0 &&
        frame.openWindows === 0 &&
        frame.sequence >= before.sequence &&
        frame.createdWindows >= before.createdWindows, "TERMINAL_UNCONFIRMED");
      terminals.set(frame.event, frame);
    }
  }
  require(terminals.has("node-exit") &&
    terminals.has("app-quit") &&
    prior &&
    prior.openWindows === 0, "TERMINAL_UNCONFIRMED");
  return Object.freeze({
    before,
    nodeExit: terminals.get("node-exit"),
    appQuit: terminals.get("app-quit"),
    final: prior,
    classifiedFrames: trace.frames.length,
  });
}
