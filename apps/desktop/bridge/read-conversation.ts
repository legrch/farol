import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./client.ts";
import type { ChatBridge } from "./chat.ts";
import type { ReadIntentBridge } from "./read-intent.ts";
import {
  validate,
  type ChatReadIntentResolve,
  type ChatReadIntentResolved,
  type ChatStart,
  type ChatHandle,
  type ChatState,
  type ChatFrames,
  type ChatResult,
} from "./wire.ts";

export type ReadConversationProjection = Readonly<{
  handle: ChatHandle;
  state: ChatState;
  frames: ChatFrames["frames"];
  cursor: string;
  result?: ChatResult;
}>;
type ReadOwner = Pick<ReadIntentBridge, "resolve" | "promote">;
type ChatPort = Pick<
  ChatBridge,
  | "create"
  | "prepare"
  | "send"
  | "observe"
  | "events"
  | "state"
  | "result"
  | "acknowledgeFrame"
  | "acknowledgeResult"
> &
  Partial<Pick<ChatBridge, "start">>;
type TransportTurn = {
  handle: ChatHandle;
  sendAttempted: boolean;
  offered: bigint;
  acknowledged: bigint;
  offeredResultId?: string;
  acknowledgement?: { resultId: string; promise: Promise<void> };
  follow?: { prompt: string; promise: Promise<ReadConversationProjection> };
};
function fail(code: string, state: "refused" | "unknown" = "refused"): never {
  throw new BridgeError(state, code);
}
function promptBytes(prompt: string): void {
  if (
    typeof prompt !== "string" ||
    !prompt ||
    Buffer.byteLength(prompt, "utf8") > 8192 ||
    /[\ud800-\udfff]/u.test(prompt)
  )
    fail("read_chat_prompt_invalid");
}
function sameHandle(a: ChatHandle, b: ChatHandle): void {
  if (!isDeepStrictEqual(a, b)) fail("read_chat_handle_crossed", "unknown");
}

// A single renderer client's mechanical correlation and one-shot RPC attempts.
// It does not own a queue, allocate workers, store results, infer settlement or
// choose models. Every positive lifecycle decision comes from the same Go owner.
export class ReadConversationClient {
  private startAttempt?:
    | {
        kind: "read";
        input: ChatReadIntentResolve;
        prompt: string;
        promise: Promise<ReadConversationProjection>;
      }
    | {
        kind: "authorized";
        input: ChatStart;
        promise: Promise<ReadConversationProjection>;
      };
  private selected?: Pick<
    ChatReadIntentResolved,
    "selection" | "resolution" | "required"
  >;
  private current?: TransportTurn;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed: { error: unknown } | undefined;
  private resolutionRefused = false;
  constructor(
    private readonly owner: ReadOwner | null,
    private readonly chat: ChatPort,
    private readonly now: () => number = Date.now,
  ) {}
  private deadline(): string {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(n + 12000))
      fail("read_chat_clock_invalid");
    return String(n + 12000);
  }
  // Only a known refusal of the original read-only resolution proves that no
  // promotion was attempted. The Go owner must still confirm exact withdrawal.
  canWithdrawAdmission(): boolean {
    return this.resolutionRefused;
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.failed) throw this.failed.error;
    if (this.pending >= 32) fail("read_chat_request_backpressure");
    this.pending += 1;
    // Serialize this client's RPCs so an explicit result ACK can follow a poll.
    // This transport ordering neither allocates nor releases a Go worker.
    const result = this.tail.then(async () => {
      if (this.failed) throw this.failed.error;
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof BridgeError) || error.state !== "refused")
          this.failed = { error };
        throw error;
      }
    });
    this.tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.pending -= 1;
      });
    return result;
  }
  start(
    input: ChatReadIntentResolve,
    prompt: string,
  ): Promise<ReadConversationProjection> {
    promptBytes(prompt);
    if (!validate("ChatReadIntentResolve", input))
      fail("read_chat_request_invalid");
    const copied = structuredClone(input);
    if (this.startAttempt) {
      if (
        this.startAttempt.kind !== "read" ||
        this.startAttempt.prompt !== prompt ||
        !isDeepStrictEqual(this.startAttempt.input, copied)
      )
        fail("read_chat_start_crossed");
      return this.startAttempt.promise;
    }
    const owner = this.owner;
    if (!owner) fail("read_chat_owner_unavailable");
    const promise = Promise.resolve().then(() =>
      this.exclusive(async () => {
        let selected: ChatReadIntentResolved;
        try {
          selected = await owner.resolve(structuredClone(copied));
        } catch (error) {
          this.resolutionRefused =
            error instanceof BridgeError && error.state === "refused";
          throw error;
        }
        if (!isDeepStrictEqual(selected.admission, copied.admission))
          fail("read_chat_owner_crossed", "unknown");
        this.selected = structuredClone(selected);
        const handle = await owner.promote({ ...selected, prompt });
        this.current = {
          handle: structuredClone(handle),
          sendAttempted: false,
          offered: 0n,
          acknowledged: 0n,
        };
        await this.advance(this.current);
        return this.project(this.current, 0n);
      }),
    );
    this.startAttempt = { kind: "read", input: copied, prompt, promise };
    return promise;
  }
  // Ordinary owner-authorized admission uses Go's captured selection and handle.
  // The same client must remain the sole active host PrepareNext consumer.
  startAuthorized(input: ChatStart): Promise<ReadConversationProjection> {
    if (!validate("ChatStart", input)) fail("read_chat_request_invalid");
    promptBytes(input.prompt);
    if (input.confirmedPrincipalKey !== input.observation.principalKey)
      fail("read_chat_principal_crossed");
    const copied = structuredClone(input);
    if (this.startAttempt) {
      if (
        this.startAttempt.kind !== "authorized" ||
        !isDeepStrictEqual(this.startAttempt.input, copied)
      )
        fail("read_chat_start_crossed");
      return this.startAttempt.promise;
    }
    const start = this.chat.start;
    if (!start) fail("read_chat_start_unavailable");
    const promise = Promise.resolve().then(() =>
      this.exclusive(async () => {
        // ChatBridge correlates the host context and operation. Keep our replay
        // capture separate from the port input and detach its authoritative reply.
        const response = await start.call(this.chat, structuredClone(copied));
        if (!validate("ChatStarted", response))
          fail("read_chat_start_invalid", "unknown");
        const started = structuredClone(response);
        if (
          started.handle.binding.sessionId !== copied.sessionId ||
          started.handle.binding.turnGeneration !== "1" ||
          started.selection.accountId !== copied.confirmedPrincipalKey ||
          !isDeepStrictEqual(started.selection, started.resolution.resolved)
        )
          fail("read_chat_start_result_crossed", "unknown");
        this.selected = {
          selection: started.selection,
          resolution: started.resolution,
          required: started.required,
        };
        this.current = {
          handle: started.handle,
          sendAttempted: false,
          offered: 0n,
          acknowledged: 0n,
        };
        await this.advance(this.current);
        return this.project(this.current, 0n);
      }),
    );
    // Pin before the deferred call can admit, prepare or Send, including failures.
    this.startAttempt = { kind: "authorized", input: copied, promise };
    return promise;
  }
  private turn(handleId: string): TransportTurn {
    const t = this.current;
    if (!t || t.handle.handleId !== handleId) fail("read_chat_turn_not_owned");
    return t;
  }
  private stillCurrent(t: TransportTurn): void {
    if (this.current !== t) fail("read_chat_turn_superseded");
  }
  private async advance(t: TransportTurn): Promise<void> {
    if (t.sendAttempted) return;
    let prepared;
    try {
      prepared = await this.chat.prepare(this.deadline());
    } catch (error) {
      // Go explicitly proves capacity refusal precedes preparation. The original
      // turn stays queued. A later deliberate progress request can ask again.
      if (
        error instanceof BridgeError &&
        error.state === "refused" &&
        error.code === "CHAT_CAPACITY"
      )
        return;
      throw error;
    }
    sameHandle(prepared.handle, t.handle);
    t.sendAttempted = true;
    await this.chat.send(t.handle.handleId, this.deadline());
  }
  private cursor(t: TransportTurn, after: string): bigint {
    if (!/^(0|[1-9][0-9]{0,19})$/u.test(after))
      fail("read_chat_cursor_invalid");
    const n = BigInt(after);
    if (n < t.acknowledged || n > t.offered)
      fail("read_chat_cursor_not_offered");
    return n;
  }
  async progress(
    handleId: string,
    deliveredCursor: string,
  ): Promise<ReadConversationProjection> {
    const t = this.turn(handleId);
    return this.exclusive(async () => {
      this.stillCurrent(t);
      const after = this.cursor(t, deliveredCursor);
      while (after > t.acknowledged) {
        // The renderer supplies only the cursor it adopted from the previous reply.
        // This ACK is transport delivery, never acknowledgement of the final result.
        const next = t.acknowledged + 1n;
        const ack = await this.chat.acknowledgeFrame(
          t.handle.handleId,
          String(next),
        );
        if (ack.status !== "acknowledged" && ack.status !== "duplicate")
          fail("read_chat_frame_ack_unconfirmed", "unknown");
        t.acknowledged = next;
      }
      await this.advance(t);
      const state = await this.chat.state(t.handle);
      sameHandle(state.handle, t.handle);
      if (t.sendAttempted && !state.released && state.phase !== "unknown")
        await this.chat.observe(t.handle.handleId, this.deadline());
      return this.project(t, after);
    });
  }
  private async project(
    t: TransportTurn,
    after: bigint,
  ): Promise<ReadConversationProjection> {
    const state = await this.chat.state(t.handle);
    sameHandle(state.handle, t.handle);
    const frames = await this.chat.events(t.handle.handleId, String(after));
    let cursor = after;
    for (const frame of frames.frames) {
      const next = BigInt(frame.sequence);
      if (next !== cursor + 1n) fail("read_chat_stream_gap", "unknown");
      cursor = next;
    }
    let result: ChatResult | undefined;
    if (state.hasResult) {
      result = await this.chat.result(t.handle.handleId);
      sameHandle(result.handle, t.handle);
      if (
        result.conversationId !== state.conversationId ||
        result.acknowledged !== state.deliveryAcknowledged
      )
        fail("read_chat_result_crossed", "unknown");
    }
    t.offered = cursor > t.offered ? cursor : t.offered;
    if (result) t.offeredResultId = result.resultId;
    return structuredClone({
      handle: t.handle,
      state,
      frames: frames.frames,
      cursor: String(cursor),
      ...(result ? { result } : {}),
    });
  }
  snapshot(
    handleId: string,
    deliveredCursor: string,
  ): Promise<ReadConversationProjection> {
    const t = this.turn(handleId);
    return this.exclusive(() => {
      this.stillCurrent(t);
      return this.project(t, this.cursor(t, deliveredCursor));
    });
  }
  acknowledge(handleId: string, resultId: string): Promise<void> {
    const t = this.turn(handleId);
    if (t.offeredResultId !== resultId) fail("read_chat_result_not_offered");
    if (t.acknowledgement) {
      if (t.acknowledgement.resultId !== resultId)
        fail("read_chat_result_crossed");
      return t.acknowledgement.promise;
    }
    const promise = Promise.resolve().then(() =>
      this.exclusive(async () => {
        this.stillCurrent(t);
        const result = await this.chat.result(handleId);
        sameHandle(result.handle, t.handle);
        if (result.resultId !== resultId) fail("read_chat_result_not_owned");
        await this.chat.acknowledgeResult(handleId, resultId);
      }),
    );
    t.acknowledgement = { resultId, promise };
    return promise;
  }
  follow(
    handleId: string,
    prompt: string,
  ): Promise<ReadConversationProjection> {
    promptBytes(prompt);
    const previous = this.turn(handleId);
    if (previous.follow) {
      if (previous.follow.prompt !== prompt) fail("read_chat_follow_crossed");
      return previous.follow.promise.then((value) => structuredClone(value));
    }
    const promise = Promise.resolve().then(() =>
      this.exclusive(async () => {
        this.stillCurrent(previous);
        const state = await this.chat.state(previous.handle);
        sameHandle(state.handle, previous.handle);
        if (!state.followReady) {
          // No Create request was made. A later explicit click may check Go's
          // readiness again. Once Create is attempted its promise stays pinned.
          delete previous.follow;
          fail("read_chat_follow_not_ready");
        }
        const selected = this.selected;
        if (!selected) fail("read_chat_selection_missing");
        const handle = await this.chat.create({
          previousHandle: previous.handle.handleId,
          sessionId: previous.handle.binding.sessionId,
          prompt,
          selection: selected.selection,
          resolution: selected.resolution,
          required: selected.required,
        });
        const old = previous.handle.binding,
          b = handle.binding;
        for (const key of [
          "profileId",
          "backendGeneration",
          "ownerId",
          "sessionId",
          "taskId",
          "taskEpoch",
          "participantId",
        ] as const) {
          if (b[key] !== old[key])
            fail("read_chat_follow_owner_crossed", "unknown");
        }
        if (
          handle.handleId === previous.handle.handleId ||
          b.turnId === old.turnId ||
          b.operationId === old.operationId ||
          BigInt(b.turnGeneration) <= BigInt(old.turnGeneration)
        )
          fail("read_chat_follow_turn_crossed", "unknown");
        const next: TransportTurn = {
          handle: structuredClone(handle),
          sendAttempted: false,
          offered: 0n,
          acknowledged: 0n,
        };
        this.current = next;
        await this.advance(next);
        return this.project(next, 0n);
      }),
    );
    previous.follow = { prompt, promise };
    return promise.then((value) => structuredClone(value));
  }
}
