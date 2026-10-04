import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import type { ChatBridge } from "./bridge/chat.ts";
import type { ChatCallerBridge } from "./bridge/chat-caller.ts";
import { BridgeError } from "./bridge/client.ts";
import {
  validate,
  type ChatCreate,
  type ChatHandle,
  type ChatCallerFunction,
  type ChatCallerHandle,
  type ChatCallerOutput,
  type ChatCallerScope,
  type Json,
} from "./bridge/wire.ts";
import { writeGoCallerDelivery } from "./go-chat-caller-delivery.ts";
import type {
  CodexCallerRelayRuntime,
  CodexCallerRelayTurn,
  CodexCallerRelayInvocation,
  CodexCallerRelayOwnedResult,
} from "../../src/apps/desktop/codex-caller-relay.ts";
import {
  canonicalJson,
  type ResolvedCodexNativeToolCall,
} from "../../src/apps/desktop/codex-native-tool-registry.ts";

export type GoChatIdentity = Omit<ChatCallerScope, "model">;
export type GoChatRequest = Readonly<{
  model: string;
  input: string | readonly unknown[];
  tools: readonly unknown[];
}>;
export type GoChatPreparedInput = Readonly<{
  prompt: string;
  // The original external identity/intent guard, before the first Go effect.
  admit(): Promise<boolean>;
  completed?: () => void;
}>;
export type GoChatResponses = Readonly<{
  serve(
    input: Readonly<{
      key: string;
      identity: GoChatIdentity;
      request: GoChatRequest;
      response: ServerResponse;
      prepareInitial(): Promise<GoChatPreparedInput | null>;
      onToolCall(): void;
    }>,
  ): Promise<void>;
  owns(threadId: string): boolean;
  readonly activeResponses: number;
  close(): Promise<void>;
}>;
export type GoChatResponsesOptions = Readonly<{
  chat: Pick<
    ChatBridge,
    "create" | "prepare" | "send" | "observe" | "events" | "result" | "cancel"
  >;
  caller: Pick<
    ChatCallerBridge,
    "begin" | "claim" | "issue" | "output" | "returned"
  >;
  relay?: Pick<CodexCallerRelayRuntime, "openTurn">;
  resolveCreate(
    input: Readonly<{ identity: GoChatIdentity; prompt: string }>,
  ):
    | Pick<ChatCreate, "selection" | "resolution" | "required">
    | Promise<Pick<ChatCreate, "selection" | "resolution" | "required">>;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A socket can disappear before its HTTP handler starts waiting.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(code: string): never {
  throw new Error(code);
}
function relayInstruction(turn: CodexCallerRelayTurn): string {
  return [
    "This Codex task's native tools are available only through the Farol Next connector tool farol_next_caller_tools,",
    `with ticket ${turn.ticket} and binding ${turn.binding}.`,
    'Describe them first with operation "describe". Invoke one tool at a time with operation "invoke" and a new stable operationId.',
    "Never repeat an invoke whose result you did not receive.",
  ].join(" ");
}

type Sink = {
  response: ServerResponse;
  done: ReturnType<typeof deferred<void>>;
  ending: boolean;
  detach(): void;
};
type CallerConnection = {
  call: ChatCallerFunction;
  token: ChatCallerHandle;
  output: ReturnType<typeof deferred<ChatCallerOutput>>;
  submitted: boolean;
};
// These records correlate transport endpoints with opaque Go handles. No output
// history, lifecycle projection, slot allocation or user request is retained.
type Connection = {
  key: string;
  scope: ChatCallerScope;
  handle?: ChatHandle;
  sink?: Sink;
  waitingSink?: Sink;
  cursor: string;
  fence: AbortController;
  relay?: CodexCallerRelayTurn;
  caller?: CallerConnection;
  barrier: boolean;
  io?: Promise<void>;
  pump?: Promise<void>;
  started: boolean;
  cancelStarted: boolean;
  completed?: () => void;
};

export function createGoChatResponses(
  options: GoChatResponsesOptions,
): GoChatResponses {
  const connections = new Map<string, Connection>();
  const handles = new Map<string, Connection>();
  const creating = new Set<Promise<void>>();
  let preparing = Promise.resolve();
  let closed = false;
  const deadline = () => String(Date.now() + 10000);

  const withdraw = async (c: Connection, error: unknown) => {
    // Deny locally before any awaited Go effect. No reconnect or Send retry.
    c.fence.abort();
    c.barrier = true;
    c.relay?.close();
    c.caller?.output.reject(error);
    for (const sink of [c.sink, c.waitingSink]) {
      if (sink) {
        sink.detach();
        sink.done.reject(error);
      }
    }
    if (c.handle && !c.cancelStarted) {
      c.cancelStarted = true;
      await options.chat.cancel(c.handle.handleId).catch(() => undefined);
    }
  };
  const current = (c: Connection) => !closed && !c.fence.signal.aborted;
  const bind = (c: Connection, response: ServerResponse): Sink => {
    let settled = false;
    const sink: Sink = {
      response,
      done: deferred<void>(),
      ending: false,
      detach: () => {
        settled = true;
        response.off("close", lost);
        response.off("error", lost);
        response.off("finish", finished);
        // Clear only this original binding. A terminal event from an old
        // response cannot remove a separately fenced waiting continuation.
        if (c.sink === sink) delete c.sink;
        if (c.waitingSink === sink) delete c.waitingSink;
      },
    };
    const lost = () => {
      if (!settled)
        void withdraw(c, new Error("FAROL_NEXT_HOST_DELIVERY_LOST"));
    };
    const finished = () => {
      if (settled) return;
      if (!sink.ending || !current(c)) {
        lost();
        return;
      }
      sink.detach();
      sink.done.resolve();
      // Local finish alone grants neither frame/result ACK nor Go return.
    };
    response.on("close", lost);
    response.on("error", lost);
    response.on("finish", finished);
    return sink;
  };
  const live = (sink: Sink) =>
    !sink.response.destroyed && !sink.response.writableEnded;
  const attach = (c: Connection, response: ServerResponse) => {
    if (!current(c) || c.sink || c.waitingSink)
      fail("FAROL_NEXT_CONTINUATION_STATE_INVALID");
    const sink = bind(c, response);
    c.sink = sink;
    if (!live(sink))
      void withdraw(c, new Error("FAROL_NEXT_HOST_DELIVERY_LOST"));
    return sink;
  };
  const attachContinuation = async (
    c: Connection,
    response: ServerResponse,
  ) => {
    if (!current(c) || c.waitingSink)
      fail("FAROL_NEXT_CONTINUATION_STATE_INVALID");
    const original = c.sink;
    if (!original) return attach(c, response);
    // A caller can parse issued bytes before their original HTTP response
    // finishes locally. Fence the new response without rebinding the old one.
    const waiting = bind(c, response);
    c.waitingSink = waiting;
    if (!live(waiting))
      void withdraw(c, new Error("FAROL_NEXT_HOST_DELIVERY_LOST"));
    await original.done.promise;
    if (!current(c) || c.sink || c.waitingSink !== waiting || !live(waiting))
      fail("FAROL_NEXT_HOST_DELIVERY_LOST");
    delete c.waitingSink;
    c.sink = waiting;
    return waiting;
  };
  const headers = (sink: Sink) => {
    if (!sink.response.headersSent)
      sink.response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
  };
  const end = (c: Connection) => {
    const sink = c.sink;
    if (!sink) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
    if (!current(c) || sink.ending) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
    // end() requests local completion; only this response's finish event may
    // resolve done/release its observers. Close/error before finish withdraws.
    sink.ending = true;
    sink.response.end();
  };
  const write = async (c: Connection, bytes: string) => {
    const sink = c.sink;
    if (
      !current(c) ||
      !sink ||
      sink.response.destroyed ||
      sink.response.writableEnded
    )
      fail("FAROL_NEXT_HOST_DELIVERY_LOST");
    headers(sink);
    let drained!: () => void;
    let lost!: () => void;
    const pending = new Promise<void>((resolve, reject) => {
      drained = resolve;
      lost = () => reject(new Error("FAROL_NEXT_HOST_DELIVERY_LOST"));
    });
    void pending.catch(() => undefined);
    sink.response.on("drain", drained);
    c.fence.signal.addEventListener("abort", lost, { once: true });
    try {
      if (!sink.response.write(bytes, "utf8")) await pending;
      if (!current(c)) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
    } finally {
      sink.response.off("drain", drained);
      c.fence.signal.removeEventListener("abort", lost);
    }
  };
  const pause = (c: Connection) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, 20);
      function done() {
        clearTimeout(timer);
        c.fence.signal.removeEventListener("abort", done);
        resolve();
      }
      c.fence.signal.addEventListener("abort", done, { once: true });
      if (!current(c)) done();
    });
  const drainFrames = async (c: Connection, beforeBegin = false) => {
    if (!c.handle) fail("FAROL_NEXT_GO_HANDLE_MISSING");
    const batch = await options.chat.events(c.handle.handleId, c.cursor);
    let terminal = false;
    for (const frame of batch.frames) {
      if (!current(c) || (c.barrier && !beforeBegin)) return false;
      if (
        BigInt(frame.sequence) !== BigInt(c.cursor) + 1n ||
        !object(frame.data) ||
        frame.data.type !== frame.kind ||
        String(frame.data.sequence_number) !== frame.sequence ||
        ![
          "response.created",
          "response.output_item.added",
          "response.content_part.added",
          "response.output_text.delta",
          "response.output_text.done",
          "response.content_part.done",
          "response.output_item.done",
          "response.completed",
          "response.failed",
        ].includes(frame.kind) ||
        (object(frame.data.item) && frame.data.item.type === "function_call")
      )
        fail("FAROL_NEXT_GO_FRAME_INVALID");
      await write(
        c,
        `event: ${frame.kind}\ndata: ${JSON.stringify(frame.data)}\n\n`,
      );
      c.cursor = frame.sequence;
      terminal ||=
        frame.kind === "response.completed" || frame.kind === "response.failed";
    }
    return terminal;
  };
  const pump = (c: Connection) => {
    if (c.pump || c.barrier || !current(c)) return;
    c.pump = (async () => {
      while (current(c) && !c.barrier && c.sink) {
        const handle = c.handle;
        if (!handle) fail("FAROL_NEXT_GO_HANDLE_MISSING");
        c.io = (async () => {
          // Send Empty is not provider acceptance: Go can already retain a
          // response.failed and an unknown result after the physical send.
          const terminal = await drainFrames(c);
          if (!current(c) || c.barrier) return;
          if (terminal) {
            // Result is published only at a terminal Go frame; pending/running
            // Result reads return Unsettled, not an observable request state.
            const result = await options.chat.result(handle.handleId);
            if (!isDeepStrictEqual(result.handle, handle))
              fail("FAROL_NEXT_GO_HANDLE_CROSSED");
            if (result.complete) c.completed?.();
            c.relay?.close();
            c.barrier = true;
            end(c);
            // HTTP writes are not a business ACK or a quiescence witness.
            // Retain opaque ownership; do not Follow or release a browser slot.
          } else {
            await options.chat.observe(handle.handleId, deadline());
          }
        })();
        try {
          await c.io;
        } finally {
          delete c.io;
        }
        if (current(c) && !c.barrier && c.sink) await pause(c);
      }
    })()
      .catch((error: unknown) => withdraw(c, error))
      .finally(() => {
        delete c.pump;
      });
  };
  const invoke = async (
    c: Connection,
    resolved: ResolvedCodexNativeToolCall,
    invocation: CodexCallerRelayInvocation,
    onToolCall: () => void,
  ): Promise<CodexCallerRelayOwnedResult> => {
    if (!current(c) || c.barrier || c.caller || !c.handle || !c.sink)
      fail("FAROL_NEXT_TOOL_CALL_STATE_INVALID");
    // Transport barrier BEFORE Begin, including the preceding text-done frames.
    c.barrier = true;
    try {
      await c.io;
      if (!current(c) || !c.sink) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
      // These frames existed before Begin; no caller tool group exists yet.
      if (await drainFrames(c, true))
        fail("FAROL_NEXT_TOOL_CALL_STATE_INVALID");
      const tag = createHash("sha256")
        .update(
          canonicalJson({
            sessionId: c.scope.sessionId,
            threadId: c.scope.threadId,
            turnId: c.scope.turnId,
            rootTurnId: c.scope.rootTurnId,
          }),
        )
        .digest("hex")
        .slice(0, 16);
      const call: ChatCallerFunction = {
        itemId: `fc_${randomUUID()}`,
        callId: `farol_next_call_${tag}${randomBytes(8).toString("hex")}`,
        name: resolved.name,
        arguments: resolved.encodedArguments,
        ...(resolved.namespace === null
          ? {}
          : { namespace: resolved.namespace }),
      };
      const token = await options.caller.begin({
        handleId: c.handle.handleId,
        scope: c.scope,
        call,
        producerOperationId: invocation.operationId,
        relayBinding: invocation.binding,
        requestSHA256: invocation.requestSHA256,
      });
      if (!current(c)) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
      await options.caller.claim(token);
      if (!current(c) || !c.sink) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
      c.caller = {
        token,
        call,
        output: deferred<ChatCallerOutput>(),
        submitted: false,
      };
      headers(c.sink);
      const issued = await writeGoCallerDelivery(
        options.caller,
        token,
        c.sink.response,
        c.fence.signal,
        c.cursor,
      );
      c.cursor = issued.lastSequence;
      onToolCall();
      end(c);
      const accepted = await c.caller.output.promise;
      let returned = false;
      return {
        status: "known",
        output: accepted.output,
        onReceived: async (receipt) => {
          if (
            !current(c) ||
            returned ||
            receipt.operationId !== invocation.operationId ||
            receipt.binding !== invocation.binding ||
            receipt.requestSHA256 !== invocation.requestSHA256 ||
            receipt.outputSHA256 !== accepted.receipt.outputSHA256 ||
            String(receipt.outputBytes) !== accepted.receipt.outputBytes
          )
            fail("FAROL_NEXT_CALLER_RECEIPT_CROSSED");
          returned = true;
          try {
            await options.caller.returned(accepted.receipt);
            if (!current(c)) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
            // Keep the barrier raised while the old pump unwinds. Otherwise
            // its pause can resume Observe and close the relay before this
            // original parsed receipt callback publishes its acknowledgement.
            await c.pump;
            if (!current(c)) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
            delete c.caller;
            c.barrier = false;
            setImmediate(() => pump(c));
            return "acknowledged";
          } catch (error) {
            await withdraw(c, error);
            throw error;
          }
        },
      };
    } catch (error) {
      await withdraw(c, error);
      throw error;
    }
  };
  const prepare = () => {
    const task = preparing.then(async () => {
      await Promise.all([...creating]);
      if (closed) return;
      const prepared = await options.chat.prepare(deadline());
      // PrepareNext is global. The returned handle, never slot ordinal or this
      // call's requester, selects the original waiting HTTP connection.
      const c = handles.get(prepared.handle.handleId);
      if (
        !c ||
        !isDeepStrictEqual(c.handle, prepared.handle) ||
        c.started ||
        !current(c)
      )
        fail("FAROL_NEXT_GO_PREPARED_OWNER_CROSSED");
      c.started = true;
      try {
        await options.chat.send(prepared.handle.handleId, deadline());
      } catch (error) {
        await withdraw(c, error);
        throw error;
      }
      if (!current(c)) return;
      pump(c);
    });
    preparing = task.catch(async (error: unknown) => {
      // A classified no-capacity refusal leaves Go's pending handles alone.
      // Unknown preparation is never retried or assigned to a call-local owner.
      if (
        error instanceof BridgeError &&
        error.state === "refused" &&
        error.code === "CHAT_CAPACITY"
      )
        return;
      await Promise.all(
        [...connections.values()]
          .filter((c) => !c.started)
          .map((c) => withdraw(c, error)),
      );
    });
    return task;
  };

  return {
    async serve(input) {
      if (closed) fail("FAROL_NEXT_PROVIDER_CLOSED");
      const previous = connections.get(input.key);
      if (previous) {
        const caller = previous.caller;
        if (
          !current(previous) ||
          !caller ||
          caller.submitted ||
          !Array.isArray(input.request.input)
        )
          fail("FAROL_NEXT_CONTINUATION_REQUIRED");
        const entries = input.request.input.filter(
          (item) =>
            object(item) &&
            (item.type === "function_call" ||
              item.type === "function_call_output"),
        );
        const calls = entries.filter(
          (item) => object(item) && item.type === "function_call",
        );
        const outputs = entries.filter(
          (item) => object(item) && item.type === "function_call_output",
        );
        const call = calls[0],
          output = outputs[0];
        if (
          calls.length !== 1 ||
          outputs.length !== 1 ||
          !object(call) ||
          !object(output) ||
          call.id !== caller.call.itemId ||
          call.call_id !== caller.call.callId ||
          call.name !== caller.call.name ||
          call.arguments !== caller.call.arguments ||
          (call.namespace ?? null) !== (caller.call.namespace ?? null) ||
          output.call_id !== caller.call.callId
        )
          fail("FAROL_NEXT_CONTINUATION_CALL_INVALID");
        const accepted = {
          handle: caller.token,
          scope: { ...input.identity, model: "chatgpt" as const },
          calls: [caller.call],
          outputs: [{ callId: caller.call.callId, raw: output.output as Json }],
        };
        if (!validate("ChatCallerAccept", accepted))
          fail("FAROL_NEXT_CONTINUATION_OUTPUT_INVALID");
        caller.submitted = true;
        try {
          const sink = await attachContinuation(previous, input.response);
          const result = await options.caller.output(accepted);
          if (!current(previous)) fail("FAROL_NEXT_HOST_DELIVERY_LOST");
          caller.output.resolve(result);
          await sink.done.promise;
        } catch (error) {
          await withdraw(previous, error);
          throw error;
        }
        return;
      }
      if (
        Array.isArray(input.request.input) &&
        input.request.input.some(
          (item) =>
            object(item) &&
            (item.type === "function_call" ||
              item.type === "function_call_output"),
        )
      )
        fail("FAROL_NEXT_CONTINUATION_NOT_FOUND");
      // No implicit next user turn: this adapter has no business result ACK or
      // settled browser quiescence witness for a previously retained thread.
      if (
        [...connections.values()].some(
          (c) => c.scope.threadId === input.identity.threadId,
        )
      )
        fail("FAROL_NEXT_GO_THREAD_UNSETTLED");
      const c: Connection = {
        key: input.key,
        scope: { ...input.identity, model: "chatgpt" },
        cursor: "0",
        fence: new AbortController(),
        barrier: false,
        started: false,
        cancelStarted: false,
      };
      // Reserve only the transport correlation while preparation is in flight.
      // Go remains the queue/lifecycle owner after the durable admission edge.
      connections.set(input.key, c);
      let admitted = false;
      try {
        const prepared = await input.prepareInitial();
        if (!prepared) return;
        if (prepared.completed) c.completed = prepared.completed;
        const onToolCall = input.onToolCall;
        if (input.request.tools.length) {
          if (!options.relay) fail("FAROL_NEXT_GO_CALLER_RELAY_UNAVAILABLE");
          c.relay = options.relay.openTurn({
            identity: input.identity,
            tools: input.request.tools,
            invoke: async () => fail("FAROL_NEXT_GO_LEGACY_EXECUTOR_DISABLED"),
            invokeOwned: (resolved, context) =>
              invoke(c, resolved, context, onToolCall),
          });
        }
        const prompt = c.relay
          ? `${prepared.prompt}\n\n${relayInstruction(c.relay)}`
          : prepared.prompt;
        const target = await options.resolveCreate({
          identity: input.identity,
          prompt,
        });
        const create: ChatCreate = {
          ...target,
          sessionId: input.identity.sessionId,
          prompt,
        };
        if (!validate("ChatCreate", create) || "previousHandle" in target)
          fail("FAROL_NEXT_GO_REQUEST_UNSUPPORTED");
        admitted = await prepared.admit();
        if (!admitted) {
          c.relay?.close();
          return;
        }
        if (closed || input.response.destroyed)
          fail("FAROL_NEXT_HOST_DELIVERY_LOST");
        // The durable external guard is retained on every subsequent failure,
        // including a lost Create reply. Submission reads do not release it.
        const sink = attach(c, input.response);
        const creation = (async () => {
          c.handle = await options.chat.create(create);
          handles.set(c.handle.handleId, c);
          if (!current(c))
            await withdraw(c, new Error("FAROL_NEXT_HOST_DELIVERY_LOST"));
        })();
        creating.add(creation);
        try {
          await creation;
        } finally {
          creating.delete(creation);
        }
        if (current(c)) void prepare().catch(() => undefined);
        await sink.done.promise;
      } catch (error) {
        c.relay?.close();
        if (admitted) await withdraw(c, error);
        throw error;
      } finally {
        if (!admitted && connections.get(input.key) === c)
          connections.delete(input.key);
      }
    },
    owns: (threadId) =>
      [...connections.values()].some((c) => c.scope.threadId === threadId),
    get activeResponses() {
      return [...connections.values()].filter((c) => c.sink).length;
    },
    async close() {
      closed = true;
      await Promise.all(
        [...connections.values()].map((c) =>
          withdraw(c, new Error("FAROL_NEXT_PROVIDER_CLOSED")),
        ),
      );
      await preparing;
    },
  };
}
