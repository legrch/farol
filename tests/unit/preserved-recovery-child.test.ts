import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  preparePreservedRecoveryChild,
  type PreservedRecoveryPublication,
  type ExactPreservedRecoverySelection,
} from "../../apps/desktop/bridge/preserved-recovery-child.ts";

// CPU child/pipe events only. No executable, profile, native deadline support,
// host lease, durable Go acknowledgement or terminal recorder is qualified here.
const ports = vi.hoisted(() => ({ spawn: vi.fn(), now: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: ports.now } }));
vi.mock("node:child_process", () => ({ spawn: ports.spawn }));
const profile = {
  profileId: "profile",
  root: "/synthetic/go-core",
  home: "/synthetic/home",
  device: "1",
  inode: "2",
};
const expected: ExactPreservedRecoverySelection = {
  buildId: "b".repeat(64),
  operationId: "835a913b-bc20-42c6-bf56-9b83852cde3c",
  hostLifetimeId: "maintenance-host",
  childLaunchId: "maintenance-child",
  backendGeneration: "maintenance",
  current: {
    Scope: { ProfileID: "profile", BackendGeneration: "failed-generation" },
    ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
    ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
  },
};
const selectionInput = {
  Selection: {
    OperationID: expected.operationId,
    Current: expected.current,
    HandoffDigest: Array(32).fill(0),
    ResultsDigest: Array(32).fill(4),
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
    ProfileID: expected.current.Scope.ProfileID,
    ParentRoot: { ...expected.current.ParentRoot },
    BuildID: expected.buildId,
    BackendGeneration: expected.backendGeneration,
    HostLifetimeID: expected.hostLifetimeId,
    ChildLaunchID: expected.childLaunchId,
    ChatRoot: { Device: 1, Inode: 4, OwnerUID: 501 },
  },
  HandoffID: expected.operationId,
  ReceiptDigest: Array(32).fill(17),
} satisfies PreservedRecoveryPublication;
const acknowledgement = {
  handoffId: expected.operationId,
  receiptDigest: "11".repeat(32),
  ackDigest: "a".repeat(64),
};
const prepared = () => ({
  schema: "farol-preserved-recovery-prepared/1",
  buildId: expected.buildId,
  publication: structuredClone(publication),
});
const acknowledged = () => ({
  schema: "farol-preserved-recovery-acknowledged/1",
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
  ports.now.mockReset().mockReturnValue(0);
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
  preparePreservedRecoveryChild(
    "/attested/backend",
    profile,
    selectionInput,
    expected,
  );
const send = (value: unknown) =>
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
const deferAckWrite = () => {
  let callback: ((error?: Error) => void) | undefined;
  child.stdin.end.mockImplementation(
    (_bytes: string, cb: (error?: Error) => void) => {
      callback = cb;
    },
  );
  return (error?: Error) => {
    expect(callback).toBeDefined();
    callback!(error);
  };
};
const observeSettlement = (done: ReturnType<typeof run>) => {
  const settled = vi.fn();
  void done.then(settled, settled);
  return settled;
};

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
      "prepare-preserved-recovery",
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
  { UnacknowledgedDev: false },
  { UnacknowledgedDev: "true" },
  { UnacknowledgedDev: null },
  { UnacknowledgedDev: 1 },
  {
    UnacknowledgedDev: true,
    Interrupted: {
      OriginalHandoffID: "original-handoff",
      ExpectedACKDigest: Array(32).fill(4),
    },
  },
  { UnacknowledgedDev: true, unclassified: true },
])(
  "refuses invalid or competing recovery modes before spawn: %j",
  async (mode) => {
    await expect(
      preparePreservedRecoveryChild(
        "/attested/backend",
        profile,
        { ...selectionInput, ...mode } as unknown as Parameters<
          typeof preparePreservedRecoveryChild
        >[2],
        expected,
      ),
    ).rejects.toMatchObject({
      state: "refused",
      code: "preserved_recovery_selection_invalid",
    });
    expect(ports.spawn).not.toHaveBeenCalled();
  },
);

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
      message: "preserved_recovery_unconfirmed",
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
      code: "preserved_recovery_cleanup_unconfirmed",
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
      code: "preserved_recovery_cleanup_unconfirmed",
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
    code: "preserved_recovery_cleanup_unconfirmed",
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
    code: "preserved_recovery_cleanup_unconfirmed",
  });
  send(prepared());
  send(acknowledged());
  await vi.advanceTimersByTimeAsync(9000);
  await check;
  child.emit("close", 0, null);
  await expect(done).rejects.toMatchObject({
    code: "preserved_recovery_cleanup_unconfirmed",
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
it("keeps a missing host ACK write callback unknown at the original deadline", async () => {
  const finishWrite = deferAckWrite();
  const done = run();
  const settled = observeSettlement(done);
  const check = expect(done).rejects.toMatchObject({
    state: "unknown",
    code: "preserved_recovery_unconfirmed",
  });
  await vi.advanceTimersByTimeAsync(3000);
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await check;
  finishWrite();
  await expect(done).rejects.toMatchObject({ state: "unknown" });
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["separate", "coalesced"])(
  "accepts an exact ACK before the write callback in %s frames, then requires original close",
  async (frames) => {
    const finishWrite = deferAckWrite();
    const done = run();
    const settled = observeSettlement(done);
    if (frames === "coalesced") {
      child.stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify(prepared())}\n${JSON.stringify(acknowledged())}\n`,
        ),
      );
    } else {
      send(prepared());
      send(acknowledged());
    }
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith(
      `${JSON.stringify({ Publication: publication })}\n`,
      expect.any(Function),
    );
    finishWrite();
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await expect(done).resolves.toMatchObject({
      publication,
      acknowledgement,
      terminal: { exitCode: "0", signal: "", forced: false },
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("retains original normal close until a successful ACK write callback within the original deadline", async () => {
  const finishWrite = deferAckWrite();
  const done = run();
  const settled = observeSettlement(done);
  await vi.advanceTimersByTimeAsync(3000);
  send(prepared());
  send(acknowledged());
  child.emit("close", 0, null);
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  finishWrite();
  await expect(done).resolves.toMatchObject({
    publication,
    acknowledgement,
    terminal: { exitCode: "0", signal: "", forced: false },
  });
  expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])(
  "keeps a delayed ACK write error unknown (original close already observed: %s)",
  async (closed) => {
    const finishWrite = deferAckWrite();
    const done = run();
    const check = expect(done).rejects.toMatchObject({
      state: "unknown",
      code: "preserved_recovery_unconfirmed",
    });
    send(prepared());
    send(acknowledged());
    if (closed) child.emit("close", 0, null);
    finishWrite(Error("lost ACK"));
    expect(child.kill).toHaveBeenCalledTimes(closed ? 0 : 1);
    if (!closed) child.emit("close", 0, null);
    await check;
    finishWrite();
    await expect(done).rejects.toMatchObject({ state: "unknown" });
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("keeps a lost ACK callback unknown when the original child is still open", async () => {
  const finishWrite = deferAckWrite();
  const done = run();
  const check = expect(done).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send(acknowledged());
  await vi.advanceTimersByTimeAsync(8000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  finishWrite();
  child.emit("close", 0, null);
  await check;
});
it.each([
  ["handoff", { ...acknowledgement, handoffId: "wrong" }],
  ["receipt", { ...acknowledgement, receiptDigest: "b".repeat(64) }],
  ["digest", { ...acknowledgement, ackDigest: "not-hex" }],
  ["zero digest", { ...acknowledgement, ackDigest: "0".repeat(64) }],
  ["extra field", { ...acknowledgement, forced: false }],
] as const)(
  "rejects invalid acknowledgement %s even before the ACK write callback",
  async (_name, ack) => {
    const finishWrite = deferAckWrite();
    const done = run();
    const check = expect(done).rejects.toMatchObject({ state: "unknown" });
    send(prepared());
    send({ ...acknowledged(), acknowledgement: ack });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    finishWrite();
    child.emit("close", 0, null);
    await check;
  },
);
it("rejects duplicate ACK frames while the ACK write callback is pending", async () => {
  const finishWrite = deferAckWrite();
  const done = run();
  const check = expect(done).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  send(acknowledged());
  expect(child.kill).not.toHaveBeenCalled();
  send(acknowledged());
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  child.emit("close", 0, null);
  await check;
  finishWrite();
  await expect(done).rejects.toMatchObject({ state: "unknown" });
});
it.each([
  [1, null],
  [2, null],
  [null, "SIGTERM"],
] as const)(
  "cannot upgrade original close %s/%s with a delayed successful write callback",
  async (code, signal) => {
    const finishWrite = deferAckWrite();
    const done = run();
    const check = expect(done).rejects.toMatchObject({ state: "unknown" });
    send(prepared());
    send(acknowledged());
    child.emit("close", code, signal);
    await check;
    finishWrite();
    await expect(done).rejects.toMatchObject({ state: "unknown" });
    expect(child.kill).not.toHaveBeenCalled();
  },
);
it.each(["stdin", "stdout", "stderr", "child"])(
  "keeps %s errors after original close unknown while the write callback is pending",
  async (stream) => {
    const finishWrite = deferAckWrite();
    const done = run();
    const check = expect(done).rejects.toMatchObject({ state: "unknown" });
    send(prepared());
    send(acknowledged());
    child.emit("close", 0, null);
    (stream === "child"
      ? child
      : child[stream as "stdin" | "stdout" | "stderr"]
    ).emit("error", Error("private diagnostic"));
    await check;
    finishWrite();
    await expect(done).rejects.toMatchObject({ state: "unknown" });
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("requires both valid frames at original close even with a later successful write callback", async () => {
  const finishWrite = deferAckWrite();
  const done = run();
  const check = expect(done).rejects.toMatchObject({ state: "unknown" });
  send(prepared());
  child.emit("close", 0, null);
  await check;
  send(acknowledged());
  finishWrite();
  await expect(done).rejects.toMatchObject({ state: "unknown" });
  expect(child.kill).not.toHaveBeenCalled();
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
  const done = preparePreservedRecoveryChild(
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
    preparePreservedRecoveryChild(
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
    code: "preserved_recovery_launch_unconfirmed",
  });
  expect(ports.spawn).toHaveBeenCalledTimes(1);
});

it("refuses the legacy InstalledEmpty maintenance mode before any native call", async () => {
  await expect(
    preparePreservedRecoveryChild(
      "/attested/backend",
      profile,
      { ...selectionInput, InstalledEmpty: true } as unknown as Parameters<
        typeof preparePreservedRecoveryChild
      >[2],
      expected,
    ),
  ).rejects.toMatchObject({
    state: "refused",
    code: "preserved_recovery_selection_invalid",
  });
  expect(ports.spawn).not.toHaveBeenCalled();
});

it.each([
  { InstalledEmpty: false },
  { InstalledEmpty: "true" },
  { InstalledEmpty: null },
  { InstalledEmpty: true, UnacknowledgedDev: true },
  {
    InstalledEmpty: true,
    Interrupted: {
      OriginalHandoffID: "original",
      ExpectedACKDigest: Array(32).fill(1),
    },
  },
  { InstalledEmpty: true, Mutations: [{}] },
])(
  "refuses ambiguous or nonempty installed mode before spawn %#",
  async (mode) => {
    await expect(
      preparePreservedRecoveryChild(
        "/attested/backend",
        profile,
        { ...selectionInput, ...mode } as unknown as Parameters<
          typeof preparePreservedRecoveryChild
        >[2],
        expected,
      ),
    ).rejects.toMatchObject({
      state: "refused",
      code: "preserved_recovery_selection_invalid",
    });
    expect(ports.spawn).not.toHaveBeenCalled();
  },
);

it("refuses the legacy InstalledPreserved maintenance mode before any native call", async () => {
  await expect(
    preparePreservedRecoveryChild(
      "/attested/backend",
      profile,
      { ...selectionInput, InstalledPreserved: true } as unknown as Parameters<
        typeof preparePreservedRecoveryChild
      >[2],
      expected,
    ),
  ).rejects.toMatchObject({
    state: "refused",
    code: "preserved_recovery_selection_invalid",
  });
  expect(ports.spawn).not.toHaveBeenCalled();
});

it.each([
  { InstalledPreserved: false, Preserved: [{}] },
  { InstalledPreserved: true },
  { InstalledPreserved: true, Preserved: [] },
  { InstalledPreserved: true, Preserved: Array(129).fill({}) },
  { Preserved: [{}] },
  { InstalledPreserved: true, Preserved: [{}], InstalledEmpty: true },
  { InstalledPreserved: true, Preserved: [{}], UnacknowledgedDev: true },
  { InstalledPreserved: true, Preserved: [{}], Interrupted: {} },
  { InstalledPreserved: true, Preserved: [{}], Mutations: [{}] },
])("rejects ambiguous preserved selection before spawning %#", async (mode) => {
  await expect(
    preparePreservedRecoveryChild(
      "/attested/backend",
      profile,
      { ...selectionInput, ...mode } as unknown as Parameters<
        typeof preparePreservedRecoveryChild
      >[2],
      expected,
    ),
  ).rejects.toMatchObject({ state: "refused" });
  expect(ports.spawn).not.toHaveBeenCalled();
});

it.each(["prepared", "close", "write"] as const)(
  "refuses %s arriving after the original monotonic budget when its timer has not run",
  async (point) => {
    const finish = deferAckWrite();
    const done = run();
    const check = expect(done).rejects.toMatchObject({ state: "unknown" });
    if (point !== "prepared") {
      send(prepared());
      send(acknowledged());
      if (point === "write") child.emit("close", 0, null);
    }
    ports.now.mockReturnValue(8001);
    if (point === "prepared") send(prepared());
    else if (point === "close") {
      finish();
      child.emit("close", 0, null);
    } else finish();
    if (point === "prepared") expect(child.stdin.end).not.toHaveBeenCalled();
    if (point !== "write") child.emit("close", 0, null);
    await check;
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { InstalledEmpty: true },
  { InstalledPreserved: true },
  { Preserved: [] },
  { UnacknowledgedDev: true },
  { ColdRestartBeforeBootSession: "boot" },
  {
    Selection: {
      ...selectionInput.Selection,
      ResultsDigest: Array(32).fill(0),
    },
  },
  {
    Selection: {
      ...selectionInput.Selection,
      HandoffDigest: Array(32).fill(256),
    },
  },
  { Mutations: Array(129).fill({}) },
])(
  "refuses unsupported modes and invalid bounded input before a native call: %j",
  async (change) => {
    await expect(
      preparePreservedRecoveryChild(
        "/attested/backend",
        profile,
        { ...selectionInput, ...change } as unknown as Parameters<
          typeof preparePreservedRecoveryChild
        >[2],
        expected,
      ),
    ).rejects.toMatchObject({
      state: "refused",
      code: "preserved_recovery_selection_invalid",
    });
    expect(ports.spawn).not.toHaveBeenCalled();
  },
);
