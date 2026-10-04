import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recordTerminal } from "../../apps/desktop/bridge/terminal-recorder";

const ports = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: ports.spawn }));
const profile = {
  profileId: "profile",
  root: "/synthetic/profile",
  home: "/synthetic/home",
  device: "1",
  inode: "2",
};
const ack = {
  handoffId: "handoff",
  receiptDigest: "d".repeat(64),
  ackDigest: "a".repeat(64),
};
const observation = {
  ...ack,
  backendGeneration: "generation",
  hostLifetimeId: "host",
  childLaunchId: "child",
  exitCode: "0",
  signal: "",
  forced: false,
};
let child: EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  ports.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());
const record = () =>
  recordTerminal("/attested/backend", profile, observation, ack);

it("sends exact retained identity once and waits for original successful close", async () => {
  let payload = "";
  child.stdin.on("data", (bytes) => {
    payload += bytes.toString();
  });
  const done = record();
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  child.stdout.write(JSON.stringify(ack));
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(JSON.parse(payload)).toEqual(observation);
  expect(ports.spawn).toHaveBeenCalledExactlyOnceWith(
    "/attested/backend",
    [
      "record-native-terminal",
      "--profile",
      "profile",
      "--profile-root",
      "/synthetic/profile",
      "--profile-device",
      "1",
      "--profile-inode",
      "2",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.emit("close", 0, null);
  await done;
  expect(child.kill).not.toHaveBeenCalled();
});
it.each([
  [
    "crossed ACK",
    JSON.stringify({ ...ack, ackDigest: "b".repeat(64) }),
    0,
    null,
  ],
  [
    "duplicate field",
    JSON.stringify(ack).replace(
      '"handoffId":',
      '"handoffId":"other","handoffId":',
    ),
    0,
    null,
  ],
  ["nonzero terminal", JSON.stringify(ack), 1, null],
  ["signal terminal", JSON.stringify(ack), null, "SIGTERM"],
  ["missing reply", "", 0, null],
] as const)(
  "rejects %s without replacement",
  async (_name, bytes, code, signal) => {
    const check = expect(record()).rejects.toMatchObject({ state: "unknown" });
    child.stdout.write(bytes);
    child.emit("close", code, signal);
    await check;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
  },
);
it.each(["stdout", "stderr"] as const)(
  "bounds %s and refuses even a subsequent zero close",
  async (stream) => {
    const check = expect(record()).rejects.toMatchObject({ state: "unknown" });
    child[stream].write("x".repeat(8193));
    child.emit("close", 0, null);
    await check;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  },
);
it("retains unknown cleanup after a late valid reply and close", async () => {
  const done = record();
  const check = expect(done).rejects.toMatchObject({
    code: "terminal_recorder_cleanup_unconfirmed",
  });
  await vi.advanceTimersByTimeAsync(4000);
  await check;
  child.stdout.write(JSON.stringify(ack));
  child.emit("close", 0, null);
  await expect(done).rejects.toMatchObject({ state: "unknown" });
  expect(ports.spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it("classifies synchronous launch failure without retry", async () => {
  ports.spawn.mockImplementation(() => {
    throw new Error("private native diagnostic");
  });
  await expect(record()).rejects.toMatchObject({
    code: "terminal_record_launch_unconfirmed",
  });
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});
it("waits for bounded cleanup when kill itself throws", async () => {
  child.kill.mockImplementation(() => {
    throw new Error("kill refused");
  });
  const check = expect(record()).rejects.toMatchObject({
    code: "terminal_recorder_cleanup_unconfirmed",
  });
  await vi.advanceTimersByTimeAsync(4000);
  await check;
});
