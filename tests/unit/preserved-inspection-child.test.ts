import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  inspectPreservedRecoveryChild,
  discoverPreservedRecoveryChild,
} from "../../apps/desktop/bridge/preserved-inspection-child.ts";
import type {
  ExactPreservedRecoverySelection,
  PreservedRecoverySelectionInput,
} from "../../apps/desktop/bridge/preserved-recovery-child.ts";

// CPU-only mocked child/pipe events and monotonic time. These tests qualify no
// executable, filesystem, Go digest/schema/journal/effect policy, profile lease,
// native deadline, recovery authority, historical ACK or actual native process.
const ports = vi.hoisted(() => ({ spawn: vi.fn(), now: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: ports.spawn }));
vi.mock("node:perf_hooks", () => ({ performance: { now: ports.now } }));
const profile = {
  profileId: "profile",
  root: "/synthetic/go-core",
  home: "/synthetic/home",
  device: "1",
  inode: "2",
};
const exact: ExactPreservedRecoverySelection = {
  buildId: "b".repeat(64),
  operationId: "835a913b-bc20-42c6-bf56-9b83852cde3c",
  hostLifetimeId: "inspection-host",
  childLaunchId: "inspection-child",
  backendGeneration: "next-generation",
  current: {
    Scope: { ProfileID: "profile", BackendGeneration: "failed-generation" },
    ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
    ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
  },
};
const makeInput = () => ({
  Selection: {
    OperationID: exact.operationId,
    Current: structuredClone(exact.current),
    HandoffDigest: Array<number>(32).fill(0),
    LifecycleDigest: Array<number>(32).fill(0),
    ResultsDigest: Array<number>(32).fill(0),
    Next: {
      ProfileID: profile.profileId,
      BackendGeneration: exact.backendGeneration,
    },
    BuildID: exact.buildId,
    HostLifetimeID: exact.hostLifetimeId,
    ChildLaunchID: exact.childLaunchId,
  },
  OwnerID: "owner",
  ComputerID: "computer",
  AccessDigest: Array<number>(32).fill(3),
  // Go owns the record schema; this fixture never executes that qualification.
  Mutations: [{ fixture: "opaque record" }],
});
const reply = () => ({
  schema: "farol-preserved-profile-inspection/1",
  buildId: exact.buildId,
  selection: {
    ...makeInput().Selection,
    HandoffDigest: Array<number>(32).fill(0), // First chain can lack a handoff.
    LifecycleDigest: Array<number>(32).fill(2),
    ResultsDigest: Array<number>(32).fill(255),
  },
  recoveryAuthorized: false,
});
let now: number;
let finishWrite: (error?: Error | null) => void;
let child: EventEmitter & {
  stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
  ports.now.mockReset().mockImplementation(() => now);
  finishWrite = () => {
    throw Error("original end callback not captured");
  };
  child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      end: vi.fn((_bytes: string, cb: typeof finishWrite) => {
        finishWrite = cb;
      }),
    }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn().mockReturnValue(true),
  });
  ports.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
const run = (input: PreservedRecoverySelectionInput = makeInput()) =>
  inspectPreservedRecoveryChild("/attested/backend", profile, input, exact);
const send = (value: unknown = reply()) =>
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
const discovery = () => {
  const input = makeInput();
  const current = {
    ...structuredClone(exact.current),
    Scope: { ...exact.current.Scope, BackendGeneration: "" },
  };
  return {
    input: { ...input, Selection: { ...input.Selection, Current: current } },
    selected: { ...structuredClone(exact), current: structuredClone(current) },
  };
};
const advance = async (ms: number) => {
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
};
function change(value: object, path: string, replacement: unknown): void {
  const keys = path.split(".");
  let target = value as Record<string, unknown>;
  for (const key of keys.slice(0, -1))
    target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = replacement;
}
function unknown(done: ReturnType<typeof run>) {
  return expect(done).rejects.toMatchObject({ state: "unknown" });
}
async function refuse(input: unknown) {
  await expect(
    run(input as PreservedRecoverySelectionInput),
  ).rejects.toMatchObject({
    state: "refused",
    code: "preserved_inspection_selection_invalid",
  });
  expect(ports.spawn).not.toHaveBeenCalled();
}

it("captures only the canonical discovered scope after original write, reply and normal close", async () => {
  const { input, selected } = discovery();
  const original = structuredClone(input);
  const done = discoverPreservedRecoveryChild(
    "/attested/backend",
    profile,
    input,
    selected,
  );
  const settled = vi.fn();
  void done.then(settled, settled);
  expect(ports.spawn.mock.calls[0]![1][0]).toBe("discover-preserved-profile");
  expect(child.stdin.end.mock.calls[0]![0]).toBe(
    `${JSON.stringify(original)}\n`,
  );
  send();
  finishWrite();
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  child.emit("close", 0, null);
  const result = await done;
  expect(result).toEqual({ ...original, Selection: reply().selection });
  expect(input).toEqual(original);
  expect(Object.isFrozen(result.Selection.Current.Scope)).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});

it("keeps known-scope observation and empty-scope discovery as separate entries", async () => {
  await expect(
    discoverPreservedRecoveryChild(
      "/attested/backend",
      profile,
      makeInput(),
      exact,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  const { input } = discovery();
  await expect(run(input)).rejects.toMatchObject({ state: "refused" });
  expect(ports.spawn).not.toHaveBeenCalled();
});

it.each([
  ["Current.Scope.BackendGeneration", ""],
  ["Current.Scope.BackendGeneration", exact.backendGeneration],
  ["Current.Scope.ProfileID", "another-profile"],
  ["Current.ParentRoot.Inode", 999],
  ["Current.ChatRoot.Inode", 999],
  ["Current.Scope.extra", "unexpected"],
] as [string, unknown][])(
  "rejects crossed discovery response %s=%j without replacement",
  async (field, value) => {
    const { input, selected } = discovery();
    const done = discoverPreservedRecoveryChild(
      "/attested/backend",
      profile,
      input,
      selected,
    );
    const failed = expect(done).rejects.toMatchObject({ state: "unknown" });
    const invalid = reply();
    change(invalid.selection, field, value);
    send(invalid);
    child.emit("close", 0, null);
    await failed;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  },
);

it.each(["write-reply-close", "reply-write-close", "reply-close-write"])(
  "requires all three original observations: %s",
  async (ordering) => {
    const input = makeInput();
    const done = run(input);
    const settled = vi.fn();
    void done.then(settled, settled);
    expect(ports.spawn).toHaveBeenCalledExactlyOnceWith(
      "/attested/backend",
      [
        "observe-preserved-profile",
        "--profile",
        "profile",
        "--profile-root",
        "/synthetic/go-core",
        "--profile-device",
        "1",
        "--profile-inode",
        "2",
        "--expected-build",
        exact.buildId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stdin.end.mock.calls[0]![0]).toBe(
      `${JSON.stringify(input)}\n`,
    );
    const actions = {
      write: () => finishWrite(),
      reply: () => {
        const bytes = Buffer.from(`${JSON.stringify(reply())}\n`);
        child.stdout.emit("data", bytes.subarray(0, 137));
        child.stdout.emit("data", bytes.subarray(137));
      },
      close: () => child.emit("close", 0, null),
    };
    for (const [index, action] of ordering.split("-").entries()) {
      actions[action as keyof typeof actions]();
      if (index < 2) {
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
      }
    }
    await expect(done).resolves.toEqual({
      ...input,
      Selection: reply().selection,
    });
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it("retains an early close until the delayed original write callback at 7999ms", async () => {
  const done = run();
  send();
  child.emit("close", 0, null);
  await advance(7999);
  finishWrite();
  await expect(done).resolves.toMatchObject({ Selection: reply().selection });
});

it("copies and deeply freezes only the observed selection digests, retaining the zero Profile override", async () => {
  const input = {
    ...makeInput(),
    Profile: { ProfileID: "", Root: "", Device: 0, Inode: 0 } as const,
  };
  const saved = structuredClone(input);
  const selectedProfile = { ...profile };
  const selectedExact = structuredClone(exact);
  const done = inspectPreservedRecoveryChild(
    "/attested/backend",
    selectedProfile,
    input,
    selectedExact,
  );
  input.OwnerID = "changed";
  (input.Selection.Current.ChatRoot as { Inode: number }).Inode = 999;
  input.Mutations[0]!.fixture = "changed";
  input.AccessDigest[0] = 42;
  selectedProfile.root = "/changed";
  (selectedExact.current.ChatRoot as { Inode: number }).Inode = 999;
  const observed = reply();
  observed.selection.HandoffDigest[31] = 1;
  send(observed);
  finishWrite();
  child.emit("close", 0, null);
  const actual = await done;
  expect(actual).toEqual({ ...saved, Selection: observed.selection });
  expect(JSON.parse(child.stdin.end.mock.calls[0]![0] as string)).toEqual(
    saved,
  );
  for (const value of [
    actual,
    actual.Selection,
    actual.Selection.Current.ChatRoot,
    actual.Selection.HandoffDigest,
    actual.Selection.LifecycleDigest,
    actual.Selection.ResultsDigest,
    actual.AccessDigest,
    actual.Mutations,
    actual.Mutations[0],
    actual.Profile,
  ])
    expect(Object.isFrozen(value)).toBe(true);
});

const correlations: [string, unknown][] = [
  ["OperationID", "wrong"],
  ["BuildID", "wrong"],
  ["HostLifetimeID", "wrong"],
  ["ChildLaunchID", "wrong"],
  ["Next.ProfileID", "wrong"],
  ["Next.BackendGeneration", "wrong"],
  ["Current.Scope.ProfileID", "wrong"],
  ["Current.Scope.BackendGeneration", "wrong"],
  ...["ParentRoot", "ChatRoot"].flatMap((root) =>
    ["Device", "Inode", "OwnerUID"].map((field): [string, unknown] => [
      `Current.${root}.${field}`,
      999,
    ]),
  ),
];
it.each(correlations)(
  "refuses crossed request %s before spawn",
  async (path, value) => {
    const input = makeInput();
    change(input.Selection, path, value);
    await refuse(input);
  },
);
it.each(correlations)(
  "rejects crossed reply selection %s",
  async (path, value) => {
    const done = run();
    const check = unknown(done);
    const output = reply();
    change(output.selection, path, value);
    send(output);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", 0, null);
    await check;
  },
);

it.each(["HandoffDigest", "LifecycleDigest", "ResultsDigest"] as const)(
  "requires an exact all-zero request %s",
  async (key) => {
    for (const bytes of [
      Array(32).fill(1),
      Array(32), // Holes are not zero bytes and must not serialize as null.
      Array(31).fill(0),
      Array(33).fill(0),
      [...Array(31).fill(0), 256],
      [...Array(31).fill(0), -1],
      [...Array(31).fill(0), 0.5],
      "0".repeat(32),
      null,
    ]) {
      const input = makeInput();
      change(input.Selection, key, bytes);
      await refuse(input);
    }
  },
);
it.each(["HandoffDigest", "LifecycleDigest", "ResultsDigest"] as const)(
  "rejects invalid observed %s bytes",
  async (key) => {
    for (const bytes of [
      Array(31).fill(1),
      Array(33).fill(1),
      [...Array(31).fill(1), 256],
      [...Array(31).fill(1), -1],
      [...Array(31).fill(1), 0.5],
      [...Array(31).fill(1), "1"],
      null,
    ]) {
      const done = run();
      const check = unknown(done);
      const output = reply();
      change(output.selection, key, bytes);
      send(output);
      child.emit("close", 0, null);
      await check;
    }
  },
);
it.each(["LifecycleDigest", "ResultsDigest"] as const)(
  "requires a nonzero observed %s",
  async (key) => {
    const done = run();
    const check = unknown(done);
    const output = reply();
    output.selection[key].fill(0);
    send(output);
    child.emit("close", 0, null);
    await check;
  },
);

it.each([
  ["schema", "wrong"],
  ["buildId", "wrong"],
  ["recoveryAuthorized", true],
  ["recoveryAuthorized", "false"],
  ["recoveryAuthorized", 0],
  ["recoveryAuthorized", null],
  ["extra", false],
  ["selection.extra", false],
  ["selection.Next.extra", false],
  ["selection.Current.ChatRoot.extra", false],
] as [string, unknown][])(
  "rejects envelope/selection mismatch %s=%j",
  async (path, value) => {
    const done = run();
    const check = unknown(done);
    const output = reply();
    change(output, path, value);
    send(output);
    child.emit("close", 0, null);
    await check;
  },
);
it.each(["schema", "buildId", "selection", "recoveryAuthorized"])(
  "requires envelope field %s",
  async (key) => {
    const done = run();
    const check = unknown(done);
    const output = reply() as Record<string, unknown>;
    delete output[key];
    send(output);
    child.emit("close", 0, null);
    await check;
  },
);
it.each(Object.keys(makeInput().Selection))(
  "requires selected field %s",
  async (key) => {
    const done = run();
    const check = unknown(done);
    const output = reply();
    delete (output.selection as Record<string, unknown>)[key];
    send(output);
    child.emit("close", 0, null);
    await check;
  },
);

it.each([
  [
    "duplicate envelope key",
    () =>
      Buffer.from(
        JSON.stringify(reply()).replace(
          '"recoveryAuthorized":false',
          '"recoveryAuthorized":true,"recoveryAuthorized":false',
        ) + "\n",
      ),
  ],
  [
    "escaped duplicate nested key",
    () =>
      Buffer.from(
        JSON.stringify(reply()).replace(
          '"Device":1',
          '"Device":999,"\\u0044evice":1',
        ) + "\n",
      ),
  ],
  [
    "invalid UTF8",
    () =>
      Buffer.concat([
        Buffer.from('{"bad":"'),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}\n'),
      ]),
  ],
  ["invalid Unicode escape", () => Buffer.from('{"bad":"\\ud800"}\n')],
  ["UTF8 BOM", () => Buffer.from(`\ufeff${JSON.stringify(reply())}\n`)],
  ["invalid JSON", () => Buffer.from("not-json\n")],
  [
    "two frames",
    () =>
      Buffer.from(`${JSON.stringify(reply())}\n${JSON.stringify(reply())}\n`),
  ],
  ["extra blank frame", () => Buffer.from(`${JSON.stringify(reply())}\n\n`)],
  ["extra partial frame", () => Buffer.from(`${JSON.stringify(reply())}\nx`)],
  ["oversized stdout", () => Buffer.alloc(16385, 120)],
] as const)("rejects %s without private diagnostics", async (_name, bytes) => {
  const done = run();
  const captured = done.catch((error: unknown) => error);
  child.stdout.emit("data", bytes());
  child.emit("close", 0, null);
  expect(await captured).toMatchObject({
    state: "unknown",
    message: "preserved_inspection_unconfirmed",
  });
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});
it.each(["second frame", "partial suffix"])(
  "rejects a separately delivered %s",
  async (suffix) => {
    const done = run();
    const check = unknown(done);
    send();
    child.stdout.emit(
      "data",
      Buffer.from(
        suffix === "second frame" ? `${JSON.stringify(reply())}\n` : "x",
      ),
    );
    child.emit("close", 0, null);
    await check;
  },
);
it.each(["stdout", "stderr"] as const)(
  "enforces the cumulative %s byte budget",
  async (stream) => {
    const done = run();
    const check = unknown(done);
    const limit = stream === "stdout" ? 16384 : 8192;
    child[stream].emit("data", Buffer.alloc(limit, 120));
    expect(child.kill).not.toHaveBeenCalled();
    child[stream].emit("data", Buffer.from("private diagnostic"));
    child.emit("close", 0, null);
    await check;
    expect(child.kill).toHaveBeenCalledTimes(1);
  },
);

it("does not equate exit, pipe EOF, another emitter's close or kill return with actual close", async () => {
  const done = run();
  const check = expect(done).rejects.toMatchObject({
    state: "unknown",
    code: "preserved_inspection_cleanup_unconfirmed",
  });
  const settled = vi.fn();
  void done.then(settled, settled);
  send();
  finishWrite();
  child.emit("exit", 0, null);
  child.stdout.emit("end");
  child.stdout.emit("close", 0, null);
  await advance(8000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(settled).not.toHaveBeenCalled();
  await advance(999);
  expect(settled).not.toHaveBeenCalled();
  await advance(1);
  await check;
  child.emit("close", 0, null); // Late close never upgrades the failure.
  await check;
});
it("keeps a forced normal close UNKNOWN even when kill emits it synchronously", async () => {
  child.kill.mockImplementation(() => child.emit("close", 0, null));
  const done = run();
  const check = unknown(done);
  send();
  await advance(8000); // Lost write callback.
  finishWrite();
  await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it("expires a missing write callback after original normal close without signalling a closed child", async () => {
  const done = run();
  const check = unknown(done);
  send();
  child.emit("close", 0, null);
  await advance(8000);
  await check;
  finishWrite();
  await check;
  expect(child.kill).not.toHaveBeenCalled();
});
it("accepts an immediate original write callback while still requiring reply and close", async () => {
  child.stdin.end.mockImplementation((_bytes: string, cb: typeof finishWrite) =>
    cb(),
  );
  const done = run();
  send();
  child.stderr.emit("data", Buffer.alloc(8192, 120));
  child.emit("close", 0, null);
  await expect(done).resolves.toMatchObject({ Selection: reply().selection });
  expect(child.stdin.end).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});
it("bounds close observation even when signalling throws", async () => {
  child.kill.mockImplementation(() => {
    throw Error("private signal failure");
  });
  const done = run();
  const check = unknown(done);
  child.emit("error", Error("private launch failure"));
  await advance(1000);
  await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it.each([
  [1, null],
  [null, "SIGTERM"],
  [0, "SIGKILL"],
  [null, null],
] as const)("rejects actual close %s/%s", async (code, signal) => {
  const done = run();
  const check = unknown(done);
  send();
  child.emit("close", code, signal);
  finishWrite();
  await check;
  expect(child.kill).not.toHaveBeenCalled();
});
it.each(["none", "unterminated", "truncated"])(
  "rejects close with %s output",
  async (kind) => {
    const done = run();
    const check = unknown(done);
    if (kind !== "none")
      child.stdout.emit(
        "data",
        Buffer.from(kind === "unterminated" ? JSON.stringify(reply()) : "{"),
      );
    finishWrite();
    child.emit("close", 0, null);
    send();
    await check;
    expect(child.kill).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "keeps an original write error UNKNOWN (already closed: %s)",
  async (closed) => {
    const done = run();
    const check = unknown(done);
    send();
    if (closed) child.emit("close", 0, null);
    finishWrite(Error("private write failure"));
    if (!closed) child.emit("close", 0, null);
    await check;
    expect(child.kill).toHaveBeenCalledTimes(closed ? 0 : 1);
  },
);
it("keeps a synchronous original write exception UNKNOWN without another write", async () => {
  child.stdin.end.mockImplementation(() => {
    throw Error("private write failure");
  });
  const done = run();
  const check = unknown(done);
  child.emit("close", 0, null);
  await check;
  expect(child.stdin.end).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it.each(["stdin", "stdout", "stderr", "child"] as const)(
  "keeps late %s errors UNKNOWN while the write callback is pending",
  async (source) => {
    const done = run();
    const check = unknown(done);
    send();
    child.emit("close", 0, null);
    (source === "child" ? child : child[source]).emit(
      "error",
      Error("private error"),
    );
    finishWrite();
    await check;
    expect(child.kill).not.toHaveBeenCalled();
  },
);

it.each(["reply", "close", "write"] as const)(
  "checks monotonic expiry directly at %s before a lagging timer fires",
  async (point) => {
    const done = run();
    const check = unknown(done);
    if (point !== "reply") send();
    if (point === "write") child.emit("close", 0, null);
    if (point === "close") finishWrite();
    now = 8000; // No timer advance: original events queued behind a stalled loop.
    if (point === "reply") send();
    else if (point === "close") child.emit("close", 0, null);
    else finishWrite();
    if (point === "reply") child.emit("close", 0, null);
    await check;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(point === "reply" ? 1 : 0);
  },
);
it("charges validation to the original monotonic budget before any spawn", async () => {
  ports.now.mockReturnValueOnce(100).mockReturnValue(8100);
  await refuse(makeInput());
});
it("charges spawn time to the original budget without resetting the timer", async () => {
  ports.spawn.mockImplementation(() => {
    now = 7999;
    return child;
  });
  const done = run();
  const check = unknown(done);
  send();
  finishWrite();
  await advance(1);
  child.emit("close", 0, null);
  await check;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});
it("classifies synchronous launch exceptions as UNKNOWN without retry", async () => {
  ports.spawn.mockImplementation(() => {
    throw Error("private launch failure");
  });
  await expect(run()).rejects.toMatchObject({
    state: "unknown",
    code: "preserved_inspection_launch_unconfirmed",
  });
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});

it.each([
  { InstalledEmpty: true },
  { InstalledEmpty: false },
  { InstalledEmpty: undefined },
  { InstalledPreserved: true },
  { Preserved: [] },
  { UnacknowledgedDev: true },
  { ColdRestartBeforeBootSession: "boot" },
  { Interrupted: {} },
  { mode: "prepare" },
  { extra: 1 },
  { Profile: { ProfileID: "installed", Root: "", Device: 0, Inode: 0 } },
  { Profile: { ProfileID: "", Root: "/wrong", Device: 0, Inode: 0 } },
  { Profile: { ProfileID: "", Root: "", Device: 1, Inode: 0 } },
  { Profile: { ProfileID: "", Root: "", Device: 0, Inode: 1 } },
  { Profile: { ProfileID: "", Root: "", Device: 0, Inode: 0, extra: false } },
  { Profile: null },
  { Profile: undefined },
  { AccessDigest: Array(32).fill(0) },
  { OwnerID: "" },
  { ComputerID: "" },
  { Mutations: Array(129).fill({}) },
  { Mutations: [undefined] },
  { Mutations: Array(1) },
])(
  "refuses unsupported modes and invalid input before spawn %#",
  async (fields) => {
    await refuse({ ...makeInput(), ...fields });
  },
);
it("bounds the complete request including its newline at 64KiB", async () => {
  const input = makeInput();
  input.Mutations = [{ fixture: "" }];
  const spare = 65536 - Buffer.byteLength(`${JSON.stringify(input)}\n`);
  input.Mutations[0]!.fixture = "x".repeat(spare);
  const done = run(input);
  expect(Buffer.byteLength(child.stdin.end.mock.calls[0]![0] as string)).toBe(
    65536,
  );
  send();
  finishWrite();
  child.emit("close", 0, null);
  await done;
  ports.spawn.mockClear();
  input.Mutations[0]!.fixture += "x";
  await refuse(input);
});
it.each([
  ["device", "99"],
  ["inode", "99"],
  ["profileId", "wrong"],
  ["root", "relative"],
  ["root", "/bad\0path"],
] as const)("refuses crossed/invalid profile %s", async (key, value) => {
  await expect(
    inspectPreservedRecoveryChild(
      "/attested/backend",
      { ...profile, [key]: value },
      makeInput(),
      exact,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  expect(ports.spawn).not.toHaveBeenCalled();
});
it("refuses a reused generation and a relative executable", async () => {
  const input = makeInput();
  const currentGeneration = exact.current.Scope.BackendGeneration;
  input.Selection.Next.BackendGeneration = currentGeneration;
  await expect(
    inspectPreservedRecoveryChild("/attested/backend", profile, input, {
      ...exact,
      backendGeneration: currentGeneration,
    }),
  ).rejects.toMatchObject({ state: "refused" });
  await expect(
    inspectPreservedRecoveryChild("relative", profile, makeInput(), exact),
  ).rejects.toMatchObject({ state: "refused" });
  expect(ports.spawn).not.toHaveBeenCalled();
});
