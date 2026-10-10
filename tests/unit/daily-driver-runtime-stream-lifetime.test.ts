import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../../src/modules/chat/contract/client-event";

// Actual stream/projection callbacks, actual caller loop and runtime codec.
// Fetch/read settlements and host sends are controlled, with no I/O or native
// lifecycle, provider, durable Computer authority or effect qualification.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
function functionNode(name: string) {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  if (!node || node.type !== "FunctionDeclaration" || !node.body)
    throw new Error(`STREAM_FUNCTION_MISSING:${name}`);
  return node;
}
function bytes(node: { start?: number | null; end?: number | null }) {
  if (node.start == null || node.end == null)
    throw new Error("STREAM_SOURCE_RANGE_MISSING");
  return source.slice(node.start, node.end);
}
const callbacks = [
  "consumeSse",
  "stopStreams",
  "failTaskSurface",
  "publishTaskSurfaceStatus",
].map((name) => bytes(functionNode(name)));
const create = functionNode("createWindow");
const callerLoop = create.body.body.find(
  (node) =>
    node.type === "ForOfStatement" && bytes(node).includes("consumeSse("),
);
const hostFence = create.body.body.find(
  (node) =>
    node.type === "VariableDeclaration" &&
    node.declarations.some(
      (declaration) =>
        declaration.id.type === "Identifier" &&
        declaration.id.name === "startupIsCurrent",
    ),
);
if (!callerLoop || !hostFence) throw new Error("STREAM_CALLER_SOURCE_MISSING");
const callerLoopSource = bytes(callerLoop);
const hostFenceSource = bytes(hostFence);

type Task = {
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  readToken: string;
};
type Requested = Extract<ClientEventDto, { kind: "computer.requested" }>;
type Read = { done: false; value: Uint8Array } | { done: true };
type Response = {
  ok: boolean;
  body: { getReader(): { read(): Promise<Read> } } | null;
};

const task: Task = {
  ownerId: "controlled-owner",
  sessionId: "controlled-session",
  taskId: "same-task",
  turnId: "turn-one",
  generation: 1,
  readToken: "controlled-only",
};
function requested(identity = task, callId = "old-call"): Requested {
  const { ownerId, sessionId, taskId, turnId, generation } = identity;
  return {
    ownerId,
    sessionId,
    taskId,
    turnId,
    generation,
    at: 1000,
    kind: "computer.requested",
    callId,
    operation: "workspace.read",
  };
}
function event(
  kind: "computer.requested" | "computer.completed" | "turn.terminal",
) {
  const request = requested();
  if (kind === "computer.requested") return request;
  const { operation: _operation, callId, ...identity } = request;
  const value =
    kind === "computer.completed"
      ? { ...identity, kind, callId }
      : { ...identity, kind, phase: "completed", code: "TURN_FINISHED" };
  expect(ClientEventSchema.safeParse(value).success).toBe(true);
  return value;
}
function packet(...events: unknown[]): Read {
  return {
    done: false,
    value: new TextEncoder().encode(
      events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function host() {
  const sends: { host: string; channel: string; value: unknown }[] = [];
  let onSend: (() => void) | undefined;
  function window(label: string) {
    return {
      label,
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      webContents: {
        send(channel: string, value: unknown) {
          sends.push({ host: label, channel, value });
          onSend?.();
        },
      },
    };
  }
  function channel(signal: AbortSignal) {
    const fetched = deferred<Response>();
    const firstRead = deferred<void>();
    const reads: ReturnType<typeof deferred<Read>>[] = [];
    let readerCalls = 0;
    const response: Response = {
      ok: true,
      body: {
        getReader() {
          readerCalls++;
          return {
            read() {
              const pending = deferred<Read>();
              reads.push(pending);
              firstRead.resolve(undefined);
              return pending.promise;
            },
          };
        },
      },
    };
    return {
      signal,
      fetched,
      reads,
      response,
      firstRead: firstRead.promise,
      readerCalls: () => readerCalls,
    };
  }
  const channels: ReturnType<typeof channel>[] = [];
  const promises: Promise<void>[] = [];
  const context = {
    runtime: { port: 1, tasks: [task] },
    runtimeState: "ready",
    window: window("original-window"),
    quitInProgress: false,
    installedUpdateAdmission: false,
    streamControllers: new Map<string, AbortController>(),
    pendingComputer: new Map<string, Requested>(),
    taskSurfaceFailures: new Map<string, string>(),
    ClientEventSchema,
    AbortController,
    TextDecoder,
    Error,
    encodeURIComponent,
    channels: {
      runtimeEvent: "controlled-event",
      taskSurfaceState: "controlled-status",
    },
    admittedPromises: promises,
    fetch: (_url: string, options: { signal: AbortSignal }) => {
      const pending = channel(options.signal);
      channels.push(pending);
      return pending.fetched.promise;
    },
  };
  const api = vm.runInNewContext(
    stripTypeScriptTypes(`
    ${callbacks.join("\n")}
    const originalConsume = consumeSse;
    consumeSse = (...args) => {
      const promise = originalConsume(...args);
      admittedPromises.push(promise);
      return promise;
    };
    ({ consume: consumeSse, stop: stopStreams, start: () => {
      const taskViewHost = window;
      ${hostFenceSource}
      ${callerLoopSource}
    } })
  `),
    context,
  ) as {
    consume(identity: Task): Promise<void>;
    stop(): void;
    start(): void;
  };
  function observe(promise: Promise<void>) {
    return promise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
  }
  function started(promise: Promise<void>, identity = task) {
    const pending = channels.at(-1);
    if (!pending) throw new Error("CONTROLLED_STREAM_NOT_DISPATCHED");
    return {
      promise,
      outcome: observe(promise),
      channel: pending,
      identity,
      controller: context.streamControllers.get(identity.taskId)!,
    };
  }
  function start(identity = task) {
    return started(api.consume(identity), identity);
  }
  function startCaller() {
    api.start();
    const admitted = promises.at(-1);
    if (!admitted) throw new Error("CONTROLLED_CALLER_NOT_DISPATCHED");
    return started(admitted);
  }
  async function toRead(stream: ReturnType<typeof started>) {
    stream.channel.fetched.resolve(stream.channel.response);
    await stream.channel.firstRead;
  }
  async function finish(stream: ReturnType<typeof started>) {
    stream.controller.abort();
    stream.channel.reads.at(-1)?.resolve({ done: true });
    return stream.outcome;
  }
  return {
    api,
    start,
    startCaller,
    toRead,
    finish,
    sends,
    channels,
    context,
    window,
    onSend: (callback: () => void) => {
      onSend = callback;
    },
  };
}

it("retains current correlated frames and cleans only their own controller", async () => {
  const h = host();
  const current = h.start();
  await h.toRead(current);
  current.channel.reads[0]!.resolve(packet(requested()));
  await flush();
  expect(h.context.pendingComputer.get(task.taskId)?.callId).toBe("old-call");
  expect(h.sends).toHaveLength(1);
  expect(h.sends[0]?.host).toBe("original-window");
  expect(await h.finish(current)).toEqual({ status: "fulfilled" });
  expect(h.context.streamControllers.size).toBe(0);
});

it.each(["quitInProgress", "installedUpdateAdmission"] as const)(
  "refuses new stream dispatch while %s holds admission",
  async (flag) => {
    const h = host();
    h.context[flag] = true;
    await expect(h.api.consume(task)).resolves.toBeUndefined();
    expect(h.channels).toHaveLength(0);
    expect(h.context.streamControllers.size).toBe(0);
    expect(h.sends).toHaveLength(0);
  },
);

it.each(
  (["quitInProgress", "installedUpdateAdmission"] as const).flatMap((flag) =>
    (["fetch", "read"] as const).map((stage) => ({ flag, stage })),
  ),
)(
  "retains an admitted $stage observation while $flag temporarily holds new admission",
  async ({ flag, stage }) => {
    const h = host();
    const current = h.start();
    let settled = false;
    void current.outcome.then(() => {
      settled = true;
    });
    if (stage === "read") await h.toRead(current);
    h.context[flag] = true;
    if (stage === "fetch") {
      current.channel.fetched.resolve(current.channel.response);
      await flush();
    }
    current.channel.reads[0]?.resolve(
      packet(requested(task, "during-admission-hold")),
    );
    await flush();
    const snapshot = () => ({
      settled,
      sameController:
        h.context.streamControllers.get(task.taskId) === current.controller,
      aborted: current.controller.signal.aborted,
      callId: h.context.pendingComputer.get(task.taskId)?.callId,
      reads: current.channel.reads.length,
      sends: h.sends.length,
    });
    const held = snapshot();
    h.context[flag] = false;
    if (!settled) {
      current.channel.reads
        .at(-1)
        ?.resolve(packet(requested(task, "after-admission-release")));
      await flush();
    }
    const released = snapshot();
    // A held admission is not StopStreams, abort, runtime/window replacement
    // or task withdrawal. Explicitly end this controlled reader after capture.
    expect(await h.finish(current)).toEqual({ status: "fulfilled" });
    expect(held).toEqual({
      settled: false,
      sameController: true,
      aborted: false,
      callId: "during-admission-hold",
      reads: 2,
      sends: 1,
    });
    expect(released).toEqual({
      settled: false,
      sameController: true,
      aborted: false,
      callId: "after-admission-release",
      reads: 3,
      sends: 2,
    });
  },
);

it.each(["ownerId", "sessionId", "taskId", "turnId", "generation"] as const)(
  "retains current %s correlation rejection",
  async (field) => {
    const h = host();
    const current = h.start();
    await h.toRead(current);
    const mismatch = {
      ...task,
      [field]: field === "generation" ? 2 : "foreign",
    };
    current.channel.reads[0]!.resolve(packet(requested(mismatch)));
    expect(await current.outcome).toMatchObject({
      status: "rejected",
      error: { message: "RUNTIME_EVENT_CORRELATION" },
    });
    expect(h.context.pendingComputer.size).toBe(0);
    expect(h.sends).toHaveLength(0);
    h.api.stop();
  },
);

it("retains current runtime schema rejection", async () => {
  const h = host();
  const current = h.start();
  await h.toRead(current);
  current.channel.reads[0]!.resolve(
    packet({ ...event("turn.terminal"), phase: "running" }),
  );
  expect(await current.outcome).toMatchObject({
    status: "rejected",
    error: { message: "RUNTIME_EVENT_INVALID" },
  });
  expect(h.sends).toHaveLength(0);
  h.api.stop();
});

it("does not resurrect projection when an already-dispatched read fulfills after stop", async () => {
  const h = host();
  const old = h.start();
  await h.toRead(old);
  h.api.stop();
  old.channel.reads[0]!.resolve(packet(requested()));
  expect(await old.outcome).toEqual({ status: "fulfilled" });
  expect(h.context.pendingComputer.size).toBe(0);
  expect(h.sends).toHaveLength(0);
});

it("does not start a reader after a stopped pending fetch fulfills", async () => {
  const h = host();
  const old = h.start();
  h.api.stop();
  old.channel.fetched.resolve(old.channel.response);
  expect(await old.outcome).toEqual({ status: "fulfilled" });
  expect(old.channel.reads).toHaveLength(0);
  expect(h.sends).toHaveLength(0);
});

it("preserves the original rejected fetch after stop", async () => {
  const h = host();
  const old = h.start();
  h.api.stop();
  const failure = new Error("CONTROLLED_FETCH_FAILURE");
  old.channel.fetched.reject(failure);
  expect(await old.outcome).toEqual({ status: "rejected", error: failure });
  expect(h.context.streamControllers.size).toBe(0);
});

it.each(["controller-only", "rebound"] as const)(
  "rejects late requested from a %s replacement",
  async (replacement) => {
    const h = host();
    const old = h.start();
    await h.toRead(old);
    const nextTask =
      replacement === "controller-only"
        ? task
        : { ...task, generation: 2, turnId: "turn-two" };
    if (replacement === "rebound") {
      h.context.runtime = { port: 2, tasks: [nextTask] };
      h.context.window = h.window("rebound-window");
    }
    const next = h.start(nextTask);
    await h.toRead(next);
    next.channel.reads[0]!.resolve(packet(requested(nextTask, "new-call")));
    await flush();
    const before = h.sends.length;
    old.channel.reads[0]!.resolve(packet(requested()));
    expect(await old.outcome).toEqual({ status: "fulfilled" });
    expect(h.context.pendingComputer.get(task.taskId)?.callId).toBe("new-call");
    expect(h.sends).toHaveLength(before);
    expect(h.context.streamControllers.get(task.taskId)).toBe(next.controller);
    await h.finish(next);
  },
);

it.each(["computer.completed", "turn.terminal"] as const)(
  "rejects a rebound old %s removal",
  async (kind) => {
    const h = host();
    const old = h.start();
    await h.toRead(old);
    const nextTask = { ...task, generation: 2, turnId: "turn-two" };
    h.context.runtime = { port: 2, tasks: [nextTask] };
    h.context.window = h.window("rebound-window");
    const next = h.start(nextTask);
    await h.toRead(next);
    next.channel.reads[0]!.resolve(packet(requested(nextTask, "new-call")));
    await flush();
    const before = h.sends.length;
    old.channel.reads[0]!.resolve(packet(event(kind)));
    expect(await old.outcome).toEqual({ status: "fulfilled" });
    expect(h.context.pendingComputer.get(task.taskId)?.callId).toBe("new-call");
    expect(h.sends).toHaveLength(before);
    expect(h.context.streamControllers.get(task.taskId)).toBe(next.controller);
    await h.finish(next);
  },
);

it.each(["runtime", "window"] as const)(
  "requires its original %s even without controller abort",
  async (replacement) => {
    const h = host();
    const old = h.start();
    await h.toRead(old);
    if (replacement === "runtime")
      h.context.runtime = { port: 2, tasks: [task] };
    else h.context.window = h.window("rebound-window");
    old.channel.reads[0]!.resolve(packet(requested()));
    // Baseline has no owner fence and starts another pending read; stop it
    // after observing this returned frame so the regression itself stays bounded.
    await flush();
    old.controller.abort();
    old.channel.reads.at(-1)?.resolve({ done: true });
    expect(await old.outcome).toEqual({ status: "fulfilled" });
    expect(h.context.pendingComputer.size).toBe(0);
    expect(h.sends).toHaveLength(0);
  },
);

it("rechecks ownership between returned frames when send withdraws synchronously", async () => {
  const h = host();
  const old = h.start();
  await h.toRead(old);
  h.onSend(() => {
    h.api.stop();
    h.context.pendingComputer.clear();
  });
  old.channel.reads[0]!.resolve(
    packet(requested(task, "first"), requested(task, "second")),
  );
  expect(await old.outcome).toEqual({ status: "fulfilled" });
  expect(h.sends).toHaveLength(1);
  expect(h.context.pendingComputer.size).toBe(0);
});

it.each(["generic", "AbortError"] as const)(
  "preserves an old same-host %s rejection without failing its replacement",
  async (kind) => {
    const h = host();
    const old = h.startCaller();
    await h.toRead(old);
    const next = h.start();
    await h.toRead(next);
    next.channel.reads[0]!.resolve(packet(requested(task, "new-call")));
    await flush();
    const failure = new Error("CONTROLLED_OLD_READ_FAILURE");
    if (kind === "AbortError") failure.name = "AbortError";
    old.channel.reads[0]!.reject(failure);
    expect(await old.outcome).toEqual({ status: "rejected", error: failure });
    await flush();
    expect(next.controller.signal.aborted).toBe(false);
    expect(h.context.streamControllers.get(task.taskId)).toBe(next.controller);
    expect(h.context.pendingComputer.get(task.taskId)?.callId).toBe("new-call");
    expect(h.context.taskSurfaceFailures.size).toBe(0);
    await h.finish(next);
  },
);

it("retains the captured-host protection against an old rebound-window generic failure", async () => {
  const h = host();
  const old = h.startCaller();
  await h.toRead(old);
  const nextTask = { ...task, generation: 2, turnId: "turn-two" };
  h.context.runtime = { port: 2, tasks: [nextTask] };
  h.context.window = h.window("rebound-window");
  const next = h.start(nextTask);
  await h.toRead(next);
  next.channel.reads[0]!.resolve(packet(requested(nextTask, "new-call")));
  await flush();
  const failure = new Error("CONTROLLED_OLD_READ_FAILURE");
  old.channel.reads[0]!.reject(failure);
  expect(await old.outcome).toEqual({ status: "rejected", error: failure });
  await flush();
  expect(next.controller.signal.aborted).toBe(false);
  expect(h.context.pendingComputer.get(task.taskId)?.callId).toBe("new-call");
  expect(h.context.taskSurfaceFailures.size).toBe(0);
  await h.finish(next);
});

it("retains current generic read failure classification", async () => {
  const h = host();
  const current = h.startCaller();
  await h.toRead(current);
  current.channel.reads[0]!.resolve(packet(requested()));
  await flush();
  const failure = new Error("CONTROLLED_CURRENT_READ_FAILURE");
  current.channel.reads[1]!.reject(failure);
  expect(await current.outcome).toEqual({ status: "rejected", error: failure });
  await flush();
  expect(current.controller.signal.aborted).toBe(true);
  expect(h.context.streamControllers.size).toBe(0);
  expect(h.context.pendingComputer.size).toBe(0);
  expect(h.context.taskSurfaceFailures.get(task.taskId)).toBe(
    "TASK_STREAM_FAILED",
  );
  expect(h.sends.at(-1)).toMatchObject({
    host: "original-window",
    channel: "controlled-status",
  });
});
