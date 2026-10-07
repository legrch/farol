import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  prepareEmptyRecoveryChild,
  type EmptyRecoveryPublication,
  type ExactEmptyRecoverySelection,
} from "../../apps/desktop/bridge/empty-recovery-child.ts";

// CPU child/pipe events only. No executable, profile, native deadline support,
// host lease, durable Go acknowledgement or terminal recorder is qualified here.
const ports = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: ports.spawn }));
const profile = {
  profileId: "profile",
  root: "/synthetic/go-core",
  home: "/synthetic/home",
  device: "1",
  inode: "2",
};
const expected: ExactEmptyRecoverySelection = {
  buildId: "b".repeat(64),
  operationId: "835a913b-bc20-42c6-bf56-9b83852cde3c",
  hostLifetimeId: "maintenance-host",
  childLaunchId: "maintenance-child",
  backendGeneration: "maintenance",
  current: {
    ProfileID: "profile",
    BackendGeneration: "failed-generation",
    BuildID: "old-build",
    HostLifetimeID: "failed-host",
    ChildLaunchID: "failed-child",
    ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
    ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
  },
};
const selectionInput = {
  Selection: {
    OperationID: expected.operationId,
    Current: expected.current,
    HeadDigest: Array(32).fill(1),
    LifecycleDigest: Array(32).fill(2),
    Next: {
      ProfileID: profile.profileId,
      BackendGeneration: expected.backendGeneration,
    },
    BuildID: expected.buildId,
    HostLifetimeID: expected.hostLifetimeId,
    ChildLaunchID: expected.childLaunchId,
  },
  OwnerID: "owner",
  ComputerID: "computer",
  AccessDigest: Array(32).fill(3),
  Mutations: [], // Go owns settlement validation; this fixture never runs it.
};
const publication = {
  Binding: {
    ...expected.current,
    ParentRoot: { ...expected.current.ParentRoot },
    BuildID: expected.buildId,
    BackendGeneration: expected.backendGeneration,
    HostLifetimeID: expected.hostLifetimeId,
    ChildLaunchID: expected.childLaunchId,
    ChatRoot: { Device: 1, Inode: 4, OwnerUID: 501 },
  },
  HandoffID: expected.operationId,
  ReceiptDigest: Array(32).fill(17),
} satisfies EmptyRecoveryPublication;
const acknowledgement = {
  handoffId: expected.operationId,
  receiptDigest: "11".repeat(32),
  ackDigest: "a".repeat(64),
};
const prepared = () => ({
  schema: "farol-empty-recovery-prepared/1",
  buildId: expected.buildId,
  publication: structuredClone(publication),
});
const acknowledged = () => ({
  schema: "farol-empty-recovery-acknowledged/1",
  buildId: expected.buildId,
  acknowledgement: { ...acknowledgement },
});
let child: EventEmitter & {
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn((_bytes: string, cb: (error?: Error) => void) => {
        cb();
        return true;
      }),
      end: vi.fn((_bytes: string, cb: (error?: Error) => void) => {
        cb();
      }),
    }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  ports.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());
const run = () =>
  prepareEmptyRecoveryChild(
    "/attested/backend",
    profile,
    selectionInput,
    expected,
  );
const send = (value: unknown) =>
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));

it("writes a separate exact ACK only after actual publication, then waits for original close", async () => {
  const done = run();
  let settled = false;
  void done.then(() => {
    settled = true;
  });
  expect(child.stdin.end).not.toHaveBeenCalled();
  expect(JSON.parse(child.stdin.write.mock.calls[0]![0] as string)).toEqual(
    selectionInput,
  );
  expect(ports.spawn).toHaveBeenCalledExactlyOnceWith(
    "/attested/backend",
    [
      "prepare-empty-recovery",
      "--profile",
      "profile",
      "--profile-root",
      "/synthetic/go-core",
      "--profile-device",
      "1",
      "--profile-inode",
      "2",
      "--expected-build",
      expected.buildId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const bytes = Buffer.from(`${JSON.stringify(prepared())}\n`);
  child.stdout.emit("data", bytes.subarray(0, 23));
  expect(child.stdin.end).not.toHaveBeenCalled();
  child.stdout.emit("data", bytes.subarray(23));
  expect(child.stdin.end).toHaveBeenCalledTimes(1);
  expect(child.stdin.end.mock.calls[0]![0]).toBe(
    `${JSON.stringify({ Publication: publication })}\n`,
  );
  send(acknowledged());
  child.emit("exit", 0, null); // Exit or EOF alone cannot qualify the child.
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 0, null);
  await expect(done).resolves.toEqual({
    publication,
    acknowledgement,
    terminal: {
      ...acknowledgement,
      backendGeneration: expected.backendGeneration,
      hostLifetimeId: expected.hostLifetimeId,
      childLaunchId: expected.childLaunchId,
      exitCode: "0",
      signal: "",
      forced: false,
    },
  });
  expect(child.kill).not.toHaveBeenCalled();
});

it.each([
  [
    "build",
    (v: ReturnType<typeof prepared>) => {
      v.buildId = "wrong";
    },
  ],
  [
    "operation",
    (v: ReturnType<typeof prepared>) => {
      v.publication.HandoffID = "wrong";
    },
  ],
  [
    "profile",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ProfileID = "wrong";
    },
  ],
  [
    "host",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.HostLifetimeID = "wrong";
    },
  ],
  [
    "child",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ChildLaunchID = "wrong";
    },
  ],
  [
    "generation",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.BackendGeneration = "wrong";
    },
  ],
  [
    "parent",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ParentRoot.Inode = 9;
    },
  ],
  [
    "old Chat",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ChatRoot.Inode = 3;
    },
  ],
  [
    "root UID",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ChatRoot.OwnerUID = 0;
    },
  ],
  [
    "unsafe inode",
    (v: ReturnType<typeof prepared>) => {
      v.publication.Binding.ChatRoot.Inode = 2 ** 53;
    },
  ],
  [
    "digest byte",
    (v: ReturnType<typeof prepared>) => {
      v.publication.ReceiptDigest[0] = 256;
    },
  ],
] as const)(
  "rejects crossed/invalid publication %s before host ACK",
  async (_name, change) => {
    const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
    const v = prepared();
    change(v);
    send(v);
    expect(child.stdin.end).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", 0, null);
    await check;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["handoff", { ...acknowledgement, handoffId: "wrong" }],
  ["receipt", { ...acknowledgement, receiptDigest: "b".repeat(64) }],
  ["digest", { ...acknowledgement, ackDigest: "not-hex" }],
  ["zero digest", { ...acknowledgement, ackDigest: "0".repeat(64) }],
  ["extra field", { ...acknowledgement, forced: false }],
] as const)("rejects invalid acknowledgement %s", async (_name, ack) => {
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send({ ...acknowledged(), acknowledgement: ack });
  child.emit("close", 0, null);
  await check;
});

it.each([
  "duplicate",
  "invalid UTF8",
  "out of order",
  "extra",
  "trailing",
  "truncated",
])("rejects %s stdout", async (kind) => {
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  if (kind === "duplicate") {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify(prepared()).replace(
          '"buildId":',
          '"buildId":"crossed","buildId":',
        ) + "\n",
      ),
    );
  } else if (kind === "invalid UTF8") {
    child.stdout.emit("data", Buffer.from([255, 10]));
  } else if (kind === "out of order") send(acknowledged());
  else {
    send(prepared());
    if (kind !== "truncated") send(acknowledged());
    if (kind === "extra") send(acknowledged());
    if (kind === "trailing" || kind === "truncated")
      child.stdout.emit("data", Buffer.from("{"));
  }
  child.emit("close", 0, null);
  await check;
});

it.each(["stdout", "stderr"] as const)(
  "bounds %s without disclosing text",
  async (stream) => {
    const check = expect(run()).rejects.toMatchObject({
      state: "unknown",
      message: "empty_recovery_unconfirmed",
    });
    child[stream].emit(
      "data",
      Buffer.alloc(stream === "stdout" ? 16385 : 8193, 120),
    );
    child.emit("close", 0, null);
    await check;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  },
);
it.each(["stdin", "stdout", "stderr", "child"])(
  "requires original close after %s error",
  async (stream) => {
    const done = run();
    const check = expect(done).rejects.toMatchObject({
      code: "empty_recovery_cleanup_unconfirmed",
    });
    (stream === "child"
      ? child
      : child[stream as "stdin" | "stdout" | "stderr"]
    ).emit("error", Error("private diagnostic"));
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
    await expect(done).rejects.toMatchObject({
      code: "empty_recovery_cleanup_unconfirmed",
    });
  },
);
it.each([
  [1, null],
  [2, null],
  [null, "SIGTERM"],
] as const)("rejects original close %s/%s", async (code, signal) => {
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send(acknowledged());
  child.emit("close", code, signal);
  await check;
});
it("rejects normal close without the acknowledged message", async () => {
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  child.emit("close", 0, null);
  await check;
});
it("keeps cleanup unknown when the retained handle cannot be signalled", async () => {
  child.kill.mockImplementation(() => {
    throw Error("signal refused");
  });
  const check = expect(run()).rejects.toMatchObject({
    code: "empty_recovery_cleanup_unconfirmed",
  });
  await vi.advanceTimersByTimeAsync(9000);
  await check;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});
it("cannot upgrade a forced zero close or late replies to success", async () => {
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  await vi.advanceTimersByTimeAsync(8000);
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it("keeps missing original close unknown, even with both valid messages", async () => {
  const done = run();
  const check = expect(done).rejects.toMatchObject({
    code: "empty_recovery_cleanup_unconfirmed",
  });
  send(prepared());
  send(acknowledged());
  await vi.advanceTimersByTimeAsync(9000);
  await check;
  child.emit("close", 0, null);
  await expect(done).rejects.toMatchObject({
    code: "empty_recovery_cleanup_unconfirmed",
  });
});
it("requires ACK write completion and refuses a lost host ACK", async () => {
  child.stdin.end.mockImplementation(
    (_bytes: string, cb: (error?: Error) => void) => cb(Error("lost ACK")),
  );
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await check;
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it("rejects an acknowledgement before the host ACK write callback", async () => {
  child.stdin.end.mockImplementation(() => {});
  const check = expect(run()).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await check;
});
it("waits for delayed publication without ending selection stdin early", async () => {
  const done = run();
  await vi.advanceTimersByTimeAsync(3000);
  expect(child.stdin.end).not.toHaveBeenCalled();
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await done;
});
it("snapshots caller correlation before spawn", async () => {
  const copy = {
    ...expected,
    current: {
      ...expected.current,
      ChatRoot: { ...expected.current.ChatRoot },
    },
  };
  const done = prepareEmptyRecoveryChild(
    "/attested/backend",
    profile,
    selectionInput,
    copy,
  );
  copy.current.ChatRoot.Inode = 999;
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await done;
});
it("refuses crossed input before spawning and never retries a launch exception", async () => {
  await expect(
    prepareEmptyRecoveryChild(
      "/attested/backend",
      profile,
      {
        ...selectionInput,
        Selection: { ...selectionInput.Selection, OperationID: "wrong" },
      },
      expected,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  expect(ports.spawn).not.toHaveBeenCalled();
  ports.spawn.mockImplementation(() => {
    throw Error("private launch error");
  });
  await expect(run()).rejects.toMatchObject({
    code: "empty_recovery_launch_unconfirmed",
  });
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});
