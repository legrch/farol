// In-memory producer/stream fixtures only; no native window or app acceptance.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
  createE2EWindowObserver,
  E2E_WINDOW_LIFETIME_PREFIX,
} from "../../apps/desktop/bridge/e2e-window-observer.ts";
import {
  assertWindowSnapshot,
  parseWindowFrame,
  collectWindowObservation,
  assertWindowLifetime,
} from "../e2e/lib/native-window-observation.mjs";
const immediate = () => new Promise((resolve) => setImmediate(resolve));
function producer() {
  let created;
  const frames = [];
  const observer = createE2EWindowObserver({
    pid: 77,
    existingWindows: () => [],
    subscribeCreated: (listen) => {
      created = listen;
    },
    publish: (frame) => frames.push(frame),
  });
  const window = Object.assign(new EventEmitter(), {
    id: 1,
    isVisible: () => false,
    isFocused: () => false,
  });
  created(window);
  return { observer, window, frames };
}
const line = (frame) =>
  E2E_WINDOW_LIFETIME_PREFIX + JSON.stringify(frame) + "\n";
async function finish(p, extra = []) {
  const before = p.observer.snapshot();
  p.window.emit("closed");
  p.observer.terminal("node-exit", 0);
  p.observer.terminal("app-quit", 0);
  const stream = new PassThrough();
  const reader = collectWindowObservation(stream);
  for (const frame of [...p.frames.slice(-3), ...extra]) {
    const text = line(frame);
    stream.write(text.slice(0, 15));
    stream.write(text.slice(15));
  }
  stream.end();
  await immediate();
  return { before, trace: reader.snapshot() };
}
it("qualifies complete current-PID terminal evidence from the actual pure producer", async () => {
  const p = producer(),
    { before, trace } = await finish(p);
  expect(
    assertWindowLifetime(before, trace, { pid: 77, code: 0, signal: null })
      .appQuit.openWindows,
  ).toBe(0);
});
it("retains early show+hide before late driver attachment through the cumulative producer snapshot", async () => {
  const p = producer();
  p.window.emit("show");
  // There is deliberately no late show event. The producer already retained it.
  const { before, trace } = await finish(p);
  expect(() =>
    assertWindowLifetime(before, trace, { pid: 77, code: 0, signal: null }),
  ).toThrow("UNCONFIRMED");
});
it.each(["priorWindows", "violations", "overflow", "observerFault"])(
  "rejects %s without supplying a clean default",
  (field) => {
    const before = producer().observer.snapshot();
    expect(() =>
      assertWindowSnapshot(
        {
          ...before,
          [field]: field === "overflow" || field === "observerFault" ? true : 1,
        },
        77,
      ),
    ).toThrow();
    const missing = { ...before };
    delete missing[field];
    expect(() => assertWindowSnapshot(missing, 77)).toThrow();
  },
);
it.each([
  "missing-node",
  "missing-app",
  "foreign-pid",
  "nonzero",
  "incomplete",
  "regression",
  "duplicate",
  "late-violation",
  "late-open-window",
  "invalid-event",
])("refuses %s lifetime evidence", async (kind) => {
  const p = producer();
  const { before, trace } = await finish(p);
  let frames = [...trace.frames],
    exit = { pid: 77, code: 0, signal: null };
  if (kind === "missing-node")
    frames = frames.filter((frame) => frame.event !== "node-exit");
  if (kind === "missing-app")
    frames = frames.filter((frame) => frame.event !== "app-quit");
  if (kind === "foreign-pid") exit.pid = 78;
  if (kind === "nonzero") exit.code = 1;
  if (kind === "regression")
    frames[frames.length - 1] = { ...frames.at(-1), sequence: 0 };
  if (kind === "duplicate")
    frames.push({ ...frames.at(-1), sequence: frames.at(-1).sequence + 1 });
  if (kind === "late-violation")
    frames.push({
      ...frames.at(-1),
      event: "show",
      exitCode: null,
      sequence: frames.at(-1).sequence + 1,
      violations: 1,
    });
  if (kind === "late-open-window")
    frames.push({
      ...frames.at(-1),
      event: "created",
      exitCode: null,
      sequence: frames.at(-1).sequence + 1,
      createdWindows: frames.at(-1).createdWindows + 1,
      openWindows: 1,
    });
  if (kind === "invalid-event") frames[0] = { ...frames[0], event: "invented" };
  expect(() =>
    assertWindowLifetime(
      before,
      { ...trace, frames, complete: kind !== "incomplete" },
      exit,
    ),
  ).toThrow();
});
it("refuses duplicate, missing or malformed flat fields", () => {
  const frame = producer().frames[0];
  const terminal = { ...frame, event: "app-quit", exitCode: 0 };
  expect(() =>
    parseWindowFrame(
      line(terminal).replace('"violations":0', '"violations":1,"violations":0'),
    ),
  ).toThrow();
  const missing = { ...terminal };
  delete missing.observerFault;
  expect(() => parseWindowFrame(line(missing))).toThrow();
  expect(() =>
    parseWindowFrame(E2E_WINDOW_LIFETIME_PREFIX + "{broken"),
  ).toThrow();
});
it("does not ignore a truncated classified frame at stream end", async () => {
  const p = producer(),
    { before, trace } = await finish(p);
  const stream = new PassThrough(),
    reader = collectWindowObservation(stream);
  for (const frame of trace.frames) stream.write(line(frame));
  stream.end(E2E_WINDOW_LIFETIME_PREFIX + '{"schema":');
  await immediate();
  expect(() =>
    assertWindowLifetime(before, reader.snapshot(), {
      pid: 77,
      code: 0,
      signal: null,
    }),
  ).toThrow();
});
it("fails closed when its classified frame budget overflows", async () => {
  const p = producer(),
    { before, trace } = await finish(p);
  const stream = new PassThrough(),
    reader = collectWindowObservation(stream);
  for (let index = 0; index < 260; index++)
    stream.write(line({ ...trace.frames[0], sequence: index + 1 }));
  stream.end();
  await immediate();
  expect(() =>
    assertWindowLifetime(before, reader.snapshot(), {
      pid: 77,
      code: 0,
      signal: null,
    }),
  ).toThrow();
});
