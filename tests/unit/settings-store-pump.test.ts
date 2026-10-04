import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SettingsStorePump,
  type SettingsStoreDriver,
} from "../../apps/desktop/bridge/settings-store.ts";
import type { Client } from "../../apps/desktop/bridge/client.ts";
import type {
  Context,
  Json,
  Outcome,
  SettingsStoreCommand,
  SettingsStorePending,
  SettingsStoreRead,
  SettingsStoreReadResult,
  SettingsStoreReplace,
  SettingsStoreReplaceResult,
  SettingsStoreSnapshot,
} from "../../apps/desktop/bridge/wire.ts";

// Pure transport/storage doubles. No filesystem, backend, child process,
// Electron, browser, provider or delivery policy is exercised here.
const peer: Context = { profileId: "profile", backendGeneration: "backend" };
const pending: SettingsStorePending = {
  backend: "go-owner-v2",
  operationId: "operation",
  profileId: "profile",
  workspaceId: "workspace",
  relativePath: "note.md",
  computerGeneration: "4",
  beforeSHA256: "a".repeat(64),
  submittedAt: "2026-10-05T00:00:00Z",
};
const snapshot: SettingsStoreSnapshot = {
  revision: "2",
  current: {
    profileId: "profile",
    ownerId: "owner",
    computerId: "computer",
    generation: "4",
  },
  pending,
  verificationInvalidated: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function command(
  kind: "read" | "replace" = "replace",
  id = "command",
  duration = 1000,
): SettingsStoreCommand {
  const body: SettingsStoreRead | SettingsStoreReplace =
    kind === "read"
      ? { deadlineMillis: String(Date.now() + duration) }
      : {
          deadlineMillis: String(Date.now() + duration),
          change: {
            expected: snapshot,
            next: pending,
            invalidateVerification: true,
          },
        };
  return { commandId: id, kind, body: body as unknown as Json };
}
type Options = NonNullable<Parameters<Client["request"]>[2]>;
function outcome(options: Options, data: unknown = {}): Outcome {
  return {
    status: "ok",
    requestId: options.id!,
    context: { ...peer },
    ...(options.operationId !== undefined
      ? { operationId: options.operationId }
      : {}),
    data: data as Json,
  };
}
type MutableRecord = Record<string, unknown>;
function record(value: unknown): MutableRecord {
  return value as MutableRecord;
}
function fixture() {
  const polls: {
    wait: ReturnType<typeof deferred<Outcome>>;
    options: Options;
    body: Json;
  }[] = [];
  const replies: { body: Json; options: Options }[] = [];
  const readIO = vi.fn<SettingsStoreDriver["read"]>(async () => ({
    status: "ok",
    snapshot,
  }));
  const replaceIO = vi.fn<SettingsStoreDriver["replace"]>(async () => ({
    status: "committed",
    snapshot,
  }));
  const fenceIO = vi.fn<SettingsStoreDriver["fence"]>(async () => undefined);
  let replaceCalls = 0;
  let fenced = false;
  const client = {
    verifiedContext: { ...peer },
    request: vi.fn<Client["request"]>((method, body, options = {}) => {
      if (method === "computer.settings.store.next") {
        const wait = deferred<Outcome>();
        polls.push({ wait, options, body });
        return wait.promise;
      }
      if (method === "computer.settings.store.reply") {
        replies.push({ body, options });
        return ack(options);
      }
      throw new Error("unexpected_method");
    }),
  };
  const ack = vi.fn<(options: Options) => Promise<Outcome>>(async (options) =>
    outcome(options),
  );
  const pump = new SettingsStorePump(client, {
    read: readIO,
    replace: (input) => {
      replaceCalls++;
      return replaceIO(input);
    },
    fence: () => {
      fenced = true; // Model the host's synchronous loss latch.
      return fenceIO();
    },
  });
  return {
    pump,
    client,
    polls,
    replies,
    ack,
    readIO,
    replaceIO,
    fenceIO,
    get replaceCalls() {
      return replaceCalls;
    },
    get fenced() {
      return fenced;
    },
    deliver(value: unknown, index = polls.length - 1) {
      const poll = polls[index]!;
      poll.wait.resolve(outcome(poll.options, { command: value }));
    },
    quiesce() {
      const poll = polls.at(-1)!;
      poll.wait.resolve(outcome(poll.options));
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
async function cleanStop(f: Fixture) {
  const stop = f.pump.stop();
  f.quiesce();
  await stop;
  expect(f.pump.state).toBe("stopped");
  expect(f.pump.fenceState).toBe("confirmed");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("sequential one-shot Settings storage pump", () => {
  it.each(["read", "replace"] as const)(
    "exchanges the exact %s DTO and reciprocal IDs",
    async (kind) => {
      const f = fixture();
      expect(f.pump.state).toBe("idle");
      f.pump.start();
      const selected = command(kind);
      expect(f.polls[0]!.options).not.toHaveProperty("operationId");
      expect(f.polls[0]!.options.timeoutMs).toBe(15000);
      expect(f.polls[0]!.body).toEqual({
        deadlineMillis: String(Date.now() + 14000),
      });
      f.deliver(selected);
      await flush();
      const io = kind === "read" ? f.readIO : f.replaceIO;
      expect(io).toHaveBeenCalledExactlyOnceWith(selected.body);
      expect(io.mock.calls[0]![0]).toBe(selected.body);
      expect(f.replaceCalls).toBe(kind === "replace" ? 1 : 0);
      expect(f.replies).toHaveLength(1);
      expect(f.replies[0]!.body).toEqual({
        commandId: selected.commandId,
        kind,
        body: { status: kind === "read" ? "ok" : "committed", snapshot },
      });
      expect(f.replies[0]!.options.operationId).toBe(selected.commandId);
      expect(f.replies[0]!.options.id).not.toBe(f.polls[0]!.options.id);
      expect(f.replies[0]!.options.timeoutMs).toBe(1000);
      expect(f.polls).toHaveLength(2);
      expect(f.pump.state).toBe("running");
      await cleanStop(f);
    },
  );

  it("awaits driver and then ACK before asking for any second command", async () => {
    const f = fixture();
    const io = deferred<SettingsStoreReplaceResult>();
    const ack = deferred<Outcome>();
    f.replaceIO.mockReturnValue(io.promise);
    f.ack.mockReturnValue(ack.promise);
    f.pump.start();
    f.deliver(command());
    await flush();
    expect(f.polls).toHaveLength(1);
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(0);
    io.resolve({ status: "committed", snapshot });
    await flush();
    expect(f.polls).toHaveLength(1);
    expect(f.replies).toHaveLength(1);
    ack.resolve(outcome(f.replies[0]!.options));
    await flush();
    expect(f.polls).toHaveLength(2);
    f.ack.mockImplementation(async (options) => outcome(options));
    f.deliver(command("read", "second"));
    await flush();
    expect(f.readIO).toHaveBeenCalledTimes(1);
    expect(f.replaceCalls).toBe(1);
    await cleanStop(f);
  });

  it.each(["not_written", "unknown"] as const)(
    "retains %s and never fabricates a committed snapshot",
    async (status) => {
      const f = fixture();
      f.replaceIO.mockResolvedValue({ status });
      f.pump.start();
      f.deliver(command());
      await flush();
      expect(f.replaceCalls).toBe(1);
      expect(record(f.replies[0]!.body).body).toEqual({ status });
      if (status === "not_written") {
        expect(f.pump.state).toBe("running");
        expect(f.fenceIO).not.toHaveBeenCalled();
        await cleanStop(f);
      } else {
        expect(f.pump.state).toBe("unknown");
        expect(f.polls).toHaveLength(1);
        expect(f.fenced).toBe(true);
        expect(f.fenceIO).toHaveBeenCalledTimes(1);
        await f.pump.stop();
        expect(f.pump.state).toBe("unknown");
        expect(() => f.pump.start()).toThrow();
      }
    },
  );

  it.each(["unavailable", "unsupported"] as const)(
    "reports a known read %s without a snapshot",
    async (status) => {
      const f = fixture();
      f.readIO.mockResolvedValue({ status });
      f.pump.start();
      f.deliver(command("read"));
      await flush();
      expect(record(f.replies[0]!.body).body).toEqual({ status });
      expect(f.replaceCalls).toBe(0);
      await cleanStop(f);
    },
  );

  const invalidCommands: [string, (value: MutableRecord) => void][] = [
    [
      "kind",
      (c) => {
        c.kind = "delete";
      },
    ],
    [
      "read kind with replace body",
      (c) => {
        c.kind = "read";
      },
    ],
    [
      "ID",
      (c) => {
        c.commandId = "";
      },
    ],
    [
      "unknown envelope field",
      (c) => {
        c.settings = {};
      },
    ],
    [
      "null body",
      (c) => {
        c.body = null;
      },
    ],
    [
      "missing change",
      (c) => {
        delete record(c.body).change;
      },
    ],
    [
      "opaque settings",
      (c) => {
        record(c.body).settings = { enabled: true };
      },
    ],
    [
      "deadline type",
      (c) => {
        record(c.body).deadlineMillis = 12;
      },
    ],
    [
      "expired deadline",
      (c) => {
        record(c.body).deadlineMillis = String(Date.now());
      },
    ],
    [
      "excessive deadline",
      (c) => {
        record(c.body).deadlineMillis = String(Date.now() + 15001);
      },
    ],
    [
      "malformed deadline",
      (c) => {
        record(c.body).deadlineMillis = "1e12";
      },
    ],
    [
      "stale current profile",
      (c) => {
        record(record(record(c.body).change).expected).current = {
          ...snapshot.current,
          profileId: "other",
        };
      },
    ],
    [
      "stale pending profile",
      (c) => {
        record(record(record(c.body).change).expected).pending = {
          ...pending,
          profileId: "other",
        };
      },
    ],
    [
      "stale next profile",
      (c) => {
        record(record(c.body).change).next = { ...pending, profileId: "other" };
      },
    ],
    [
      "zero revision",
      (c) => {
        record(record(record(c.body).change).expected).revision = "0";
      },
    ],
    [
      "unsafe generation",
      (c) => {
        record(
          record(record(record(c.body).change).expected).current,
        ).generation = "9007199254740992";
      },
    ],
    [
      "zero next generation",
      (c) => {
        record(record(record(c.body).change).next).computerGeneration = "0";
      },
    ],
  ];
  it.each(invalidCommands)(
    "permanently fences %s before physical dispatch",
    async (_label, corrupt) => {
      const f = fixture();
      f.pump.start();
      const selected = structuredClone(command());
      corrupt(record(selected));
      f.deliver(selected);
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.replaceCalls).toBe(0);
      expect(f.readIO).not.toHaveBeenCalled();
      expect(f.replies).toHaveLength(0);
      expect(f.polls).toHaveLength(1);
      await f.pump.stop();
      expect(f.fenceIO).toHaveBeenCalledTimes(1);
    },
  );

  const invalidOutcomes: [string, (value: MutableRecord) => void][] = [
    [
      "crossed request ID",
      (v) => {
        v.requestId = "other";
      },
    ],
    [
      "stale profile",
      (v) => {
        v.context = { ...peer, profileId: "other" };
      },
    ],
    [
      "stale generation",
      (v) => {
        v.context = { ...peer, backendGeneration: "other" };
      },
    ],
    [
      "missing context",
      (v) => {
        delete v.context;
      },
    ],
    [
      "refused",
      (v) => {
        v.status = "refused";
      },
    ],
    [
      "unknown",
      (v) => {
        v.status = "unknown";
      },
    ],
    [
      "unavailable",
      (v) => {
        v.status = "unavailable";
      },
    ],
    [
      "unexpected data field",
      (v) => {
        record(v.data).extra = true;
      },
    ],
    [
      "missing data",
      (v) => {
        delete v.data;
      },
    ],
    [
      "null data",
      (v) => {
        v.data = null;
      },
    ],
    [
      "unknown envelope field",
      (v) => {
        v.extra = true;
      },
    ],
  ];
  it.each(invalidOutcomes)(
    "rejects a poll with %s",
    async (_label, corrupt) => {
      const f = fixture();
      f.pump.start();
      const poll = f.polls[0]!;
      const response = outcome(poll.options, { command: command() });
      corrupt(record(response));
      poll.wait.resolve(response);
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.replaceCalls).toBe(0);
      expect(f.polls).toHaveLength(1);
      await f.pump.stop();
    },
  );
  it("refuses an operation ID on a read poll", async () => {
    const f = fixture();
    f.pump.start();
    f.polls[0]!.wait.resolve({
      ...outcome(f.polls[0]!.options),
      operationId: "unexpected",
    });
    await flush();
    expect(f.pump.state).toBe("unknown");
    expect(f.replaceCalls).toBe(0);
    await f.pump.stop();
  });

  it.each(invalidOutcomes)(
    "retains a known write after reply ACK %s, with zero second dispatch",
    async (_label, corrupt) => {
      const f = fixture();
      f.ack.mockImplementation(async (options) => {
        const response = outcome(options);
        corrupt(record(response));
        return response;
      });
      f.pump.start();
      f.deliver(command());
      await flush();
      expect(f.replaceCalls).toBe(1);
      expect(f.replies).toHaveLength(1);
      expect(f.pump.state).toBe("unknown");
      expect(f.polls).toHaveLength(1);
      await f.pump.stop();
      expect(f.fenceIO).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["crossed", "missing"])(
    "refuses a %s reply operation ID",
    async (kind) => {
      const f = fixture();
      f.ack.mockImplementation(async (options) => {
        const response = outcome(options);
        if (kind === "crossed") record(response).operationId = "other";
        else delete record(response).operationId;
        return response;
      });
      f.pump.start();
      f.deliver(command());
      await flush();
      expect(f.replaceCalls).toBe(1);
      expect(f.pump.state).toBe("unknown");
      expect(f.polls).toHaveLength(1);
      await f.pump.stop();
    },
  );
  it("never retries a lost ACK after a known physical write", async () => {
    const f = fixture();
    f.ack.mockRejectedValue(new Error("lost_reply"));
    f.pump.start();
    f.deliver(command());
    await flush();
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(1);
    expect(f.polls).toHaveLength(1);
    expect(f.pump.state).toBe("unknown");
    await f.pump.stop();
  });

  it.each([
    ["read", { status: "ok" }],
    ["read", { status: "unavailable", snapshot }],
    ["read", { status: "unsupported", snapshot }],
    ["read", { status: "unknown" }],
    ["replace", { status: "committed" }],
    ["replace", { status: "not_written", snapshot }],
    ["replace", { status: "unknown", snapshot }],
    [
      "replace",
      {
        status: "committed",
        snapshot: {
          ...snapshot,
          current: { ...snapshot.current, profileId: "other" },
        },
      },
    ],
    [
      "read",
      {
        status: "ok",
        snapshot: { ...snapshot, pending: { ...pending, profileId: "other" } },
      },
    ],
    [
      "replace",
      { status: "committed", snapshot: { ...snapshot, revision: "0" } },
    ],
    [
      "read",
      {
        status: "ok",
        snapshot: {
          ...snapshot,
          current: { ...snapshot.current, generation: "9007199254740992" },
        },
      },
    ],
    [
      "read",
      {
        status: "ok",
        snapshot: {
          ...snapshot,
          pending: { ...pending, computerGeneration: "0" },
        },
      },
    ],
    ["replace", { status: "not_written", extra: true }],
    ["replace", null],
  ] as const)(
    "rejects a semantically invalid %s answer %j",
    async (kind, answer) => {
      const f = fixture();
      if (kind === "read")
        f.readIO.mockResolvedValue(
          answer as unknown as SettingsStoreReadResult,
        );
      else
        f.replaceIO.mockResolvedValue(
          answer as unknown as SettingsStoreReplaceResult,
        );
      f.pump.start();
      f.deliver(command(kind));
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.replaceCalls).toBe(kind === "replace" ? 1 : 0);
      expect(f.replies).toHaveLength(0);
      expect(f.polls).toHaveLength(1);
      await f.pump.stop();
    },
  );

  it("consumes a duplicate command before a second physical call", async () => {
    const f = fixture();
    f.pump.start();
    f.deliver(command());
    await flush();
    f.deliver(command());
    await flush();
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(1);
    expect(f.pump.state).toBe("unknown");
    expect(f.polls).toHaveLength(2);
    await f.pump.stop();
  });

  it("does not adopt a changed handshaken scope after polling", async () => {
    const f = fixture();
    f.pump.start();
    f.client.verifiedContext = { ...peer, backendGeneration: "new" };
    f.deliver(command());
    await flush();
    expect(f.replaceCalls).toBe(0);
    expect(f.pump.state).toBe("unknown");
    await f.pump.stop();
  });
  it("does not reply under a replaced context after driver IO", async () => {
    const f = fixture();
    const io = deferred<SettingsStoreReplaceResult>();
    f.replaceIO.mockReturnValue(io.promise);
    f.pump.start();
    f.deliver(command());
    await flush();
    f.client.verifiedContext = { ...peer, profileId: "other" };
    io.resolve({ status: "committed", snapshot });
    await flush();
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(0);
    expect(f.pump.state).toBe("unknown");
    await f.pump.stop();
  });

  it("never resets the original deadline across poll delivery, IO and ACK", async () => {
    const f = fixture();
    const selected = command("replace", "command", 1000);
    const io = deferred<SettingsStoreReplaceResult>();
    const ack = deferred<Outcome>();
    f.replaceIO.mockReturnValue(io.promise);
    f.ack.mockReturnValue(ack.promise);
    f.pump.start();
    await vi.advanceTimersByTimeAsync(400);
    f.deliver(selected);
    await flush();
    expect(f.replaceIO.mock.calls[0]![0]).toBe(selected.body);
    await vi.advanceTimersByTimeAsync(300);
    io.resolve({ status: "committed", snapshot });
    await flush();
    expect(f.replies[0]!.options.timeoutMs).toBe(300);
    vi.advanceTimersByTime(300);
    expect(f.fenced).toBe(true); // Fence latches inside the timeout callback.
    expect(f.pump.state).toBe("unknown");
    await flush();
    ack.resolve(outcome(f.replies[0]!.options));
    await flush();
    expect(f.replaceCalls).toBe(1);
    expect(f.polls).toHaveLength(1);
    await f.pump.stop();
    expect(f.pump.state).toBe("unknown");
  });

  it("fences a queued writer synchronously at the original driver deadline", async () => {
    const f = fixture();
    const queued = deferred<void>();
    let physicalWrites = 0;
    f.replaceIO.mockImplementation(async () => {
      await queued.promise;
      if (f.fenced) return { status: "not_written" };
      physicalWrites++;
      return { status: "committed", snapshot };
    });
    f.pump.start();
    f.deliver(command("replace", "command", 100));
    await flush();
    vi.advanceTimersByTime(100);
    expect(f.fenced).toBe(true);
    expect(f.pump.state).toBe("unknown");
    queued.resolve();
    await flush();
    expect(f.replaceCalls).toBe(1);
    expect(physicalWrites).toBe(0);
    expect(f.replies).toHaveLength(0);
    expect(f.polls).toHaveLength(1);
    await f.pump.stop();
  });

  it("rejects a late driver result even if the timer has not run", async () => {
    const f = fixture();
    const io = deferred<SettingsStoreReplaceResult>();
    f.replaceIO.mockReturnValue(io.promise);
    f.pump.start();
    f.deliver(command("replace", "command", 100));
    await flush();
    vi.setSystemTime(Date.now() + 100);
    io.resolve({ status: "committed", snapshot });
    await flush();
    expect(f.pump.state).toBe("unknown");
    expect(f.fenced).toBe(true);
    expect(f.replies).toHaveLength(0);
    expect(f.replaceCalls).toBe(1);
    await f.pump.stop();
  });

  it.each(["read", "replace"] as const)(
    "retains a rejected %s without dispatching a correction",
    async (kind) => {
      const f = fixture();
      if (kind === "read") f.readIO.mockRejectedValue(new Error("read_failed"));
      else f.replaceIO.mockRejectedValue(new Error("replace_failed"));
      f.pump.start();
      f.deliver(command(kind));
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.polls).toHaveLength(1);
      expect(f.replies).toHaveLength(0);
      await f.pump.stop();
    },
  );

  it("stops cleanly only after the normal poll wakes with quiescence and fence completes", async () => {
    const f = fixture();
    const fence = deferred<void>();
    f.fenceIO.mockReturnValue(fence.promise);
    f.pump.start();
    const stop = f.pump.stop();
    expect(f.fenced).toBe(true);
    expect(f.pump.stop()).toBe(stop);
    f.quiesce();
    await flush();
    expect(f.pump.state).toBe("running");
    expect(f.pump.fenceState).toBe("pending");
    fence.resolve();
    await stop;
    expect(f.pump.state).toBe("stopped");
    expect(f.fenceIO).toHaveBeenCalledTimes(1);
    expect(f.polls).toHaveLength(1);
    expect(f.replaceCalls).toBe(0);
    expect(() => f.pump.start()).toThrow();
  });

  it("marks stop crossing a delivered command unknown before dispatch", async () => {
    const f = fixture();
    f.pump.start();
    const stop = f.pump.stop();
    f.deliver(command());
    await stop;
    expect(f.pump.state).toBe("unknown");
    expect(f.replaceCalls).toBe(0);
    expect(f.fenceIO).toHaveBeenCalledTimes(1);
  });

  it.each(["driver", "ACK"])(
    "bounds stop crossing a hung %s and retains late completion",
    async (phase) => {
      const f = fixture();
      const io = deferred<SettingsStoreReplaceResult>();
      const ack = deferred<Outcome>();
      if (phase === "driver") f.replaceIO.mockReturnValue(io.promise);
      else f.ack.mockReturnValue(ack.promise);
      f.pump.start();
      f.deliver(command());
      await flush();
      const stop = f.pump.stop();
      expect(f.pump.state).toBe("unknown");
      expect(f.fenced).toBe(true);
      await stop;
      io.resolve({ status: "committed", snapshot });
      if (f.replies.length) ack.resolve(outcome(f.replies[0]!.options));
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.replaceCalls).toBe(1);
      expect(f.polls).toHaveLength(1);
      expect(f.replies).toHaveLength(phase === "driver" ? 0 : 1);
    },
  );

  it("bounds a poll that never wakes instead of reporting clean stop", async () => {
    const f = fixture();
    f.pump.start();
    const stop = f.pump.stop();
    await vi.advanceTimersByTimeAsync(15000);
    await stop;
    expect(f.pump.state).toBe("unknown");
    f.quiesce();
    await flush();
    expect(f.pump.state).toBe("unknown");
    expect(f.polls).toHaveLength(1);
    expect(f.replaceCalls).toBe(0);
  });

  it.each(["late success", "late failure"])(
    "bounds a hung fence and retains its %s without retry",
    async (result) => {
      const f = fixture();
      const fence = deferred<void>();
      f.fenceIO.mockReturnValue(fence.promise);
      f.pump.start();
      const stop = f.pump.stop();
      f.quiesce();
      await flush();
      await vi.advanceTimersByTimeAsync(15000);
      await stop;
      expect(f.pump.state).toBe("unknown");
      expect(f.pump.fenceState).toBe("pending");
      const error = new Error("late_fence_failure");
      if (result === "late success") fence.resolve();
      else fence.reject(error);
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.pump.fenceState).toBe(
        result === "late success" ? "confirmed" : "failed",
      );
      expect(f.pump.fenceError).toBe(
        result === "late success" ? undefined : error,
      );
      await f.pump.stop();
      expect(f.fenceIO).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["throw", "reject"])(
    "retains fence %s and never retries it",
    async (mode) => {
      const f = fixture();
      const error = new Error("fence_failed");
      if (mode === "throw")
        f.fenceIO.mockImplementation(() => {
          throw error;
        });
      else f.fenceIO.mockRejectedValue(error);
      f.pump.start();
      const stop = f.pump.stop();
      f.quiesce();
      await stop;
      expect(f.pump.state).toBe("unknown");
      expect(f.pump.fenceState).toBe("failed");
      expect(f.pump.fenceError).toBe(error);
      await f.pump.stop();
      expect(f.fenceIO).toHaveBeenCalledTimes(1);
    },
  );

  it("prevents start during idle retirement", async () => {
    const f = fixture();
    const stop = f.pump.stop();
    expect(() => f.pump.start()).toThrow();
    await stop;
    expect(f.pump.state).toBe("stopped");
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it.each(["throw", "reject"])(
    "fences a %s from the first poll without retry",
    async (mode) => {
      const f = fixture();
      const error = new Error("poll_lost");
      if (mode === "throw")
        f.client.request.mockImplementation(() => {
          throw error;
        });
      else f.client.request.mockRejectedValue(error);
      f.pump.start();
      await flush();
      expect(f.pump.state).toBe("unknown");
      expect(f.replaceCalls).toBe(0);
      expect(f.client.request).toHaveBeenCalledTimes(1);
      await f.pump.stop();
      expect(f.fenceIO).toHaveBeenCalledTimes(1);
    },
  );

  it("handles synchronous stop followed by a driver throw without an unhandled loss", async () => {
    const f = fixture();
    f.replaceIO.mockImplementation(() => {
      void f.pump.stop();
      throw new Error("driver_failed_after_stop");
    });
    f.pump.start();
    f.deliver(command());
    await flush();
    await f.pump.stop();
    expect(f.pump.state).toBe("unknown");
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(0);
    expect(f.polls).toHaveLength(1);
    expect(f.fenceIO).toHaveBeenCalledTimes(1);
  });

  it("returns from unknown stop with hung IO and fence, retaining both uncertainty and late fence failure", async () => {
    const f = fixture();
    const io = deferred<SettingsStoreReplaceResult>();
    const fence = deferred<void>();
    f.replaceIO.mockReturnValue(io.promise);
    f.fenceIO.mockReturnValue(fence.promise);
    f.pump.start();
    f.deliver(command());
    await flush();
    await f.pump.stop();
    expect(f.pump.state).toBe("unknown");
    expect(f.pump.fenceState).toBe("pending");
    const error = new Error("fence_lost");
    fence.reject(error);
    io.reject(new Error("late_io_failure"));
    await flush();
    expect(f.pump.state).toBe("unknown");
    expect(f.pump.fenceState).toBe("failed");
    expect(f.pump.fenceError).toBe(error);
    expect(f.fenceIO).toHaveBeenCalledTimes(1);
    expect(f.replaceCalls).toBe(1);
    expect(f.replies).toHaveLength(0);
    expect(f.polls).toHaveLength(1);
  });

  it("retains all 4096 consumed IDs and refuses command 4097 without eviction", async () => {
    const f = fixture();
    const fenced = deferred<void>();
    f.fenceIO.mockImplementation(async () => {
      fenced.resolve();
    });
    let nextCount = 0;
    let replyCount = 0;
    f.client.request.mockImplementation(async (method, _body, options = {}) => {
      if (method === "computer.settings.store.next") {
        nextCount++;
        return outcome(options, {
          command: command("replace", `command-${nextCount}`),
        });
      }
      replyCount++;
      return outcome(options);
    });
    f.pump.start();
    await fenced.promise;
    await f.pump.stop();
    expect(nextCount).toBe(4097);
    expect(replyCount).toBe(4096);
    expect(f.replaceCalls).toBe(4096);
    expect(f.pump.state).toBe("unknown");
    expect(f.fenceIO).toHaveBeenCalledTimes(1);
  });
});
