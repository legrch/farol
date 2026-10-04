import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Context,
  type Json,
  type Outcome,
  type SettingsStoreCommand,
  type SettingsStoreNextResult,
  type SettingsStorePending,
  type SettingsStoreRead,
  type SettingsStoreReadResult,
  type SettingsStoreReplace,
  type SettingsStoreReplaceResult,
  type SettingsStoreSnapshot,
} from "./wire.ts";

// The host must latch loss synchronously in fence(), before its first await.
// Go owns delivery decisions; this port supplies physical storage only.
export interface SettingsStoreDriver {
  read(input: SettingsStoreRead): Promise<SettingsStoreReadResult>;
  replace(input: SettingsStoreReplace): Promise<SettingsStoreReplaceResult>;
  fence(): Promise<void>;
}

const budgetMillis = 15000;
const commandLimit = 4096;
type FenceState = "none" | "pending" | "confirmed" | "failed";

// One handshaken peer, one physical call at a time, one attempt per command.
// Loss is permanent, including a known write whose reply ACK was lost.
export class SettingsStorePump {
  private stateValue: "idle" | "running" | "stopped" | "unknown" = "idle";
  private readonly consumed = new Set<string>();
  private context: Readonly<Context> | undefined;
  private loop: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private activeCommand = false;
  private interrupt: (() => void) | undefined;
  private fenceStateValue: FenceState = "none";
  private fenceErrorValue: unknown;
  private fenceWait: Promise<void> | undefined;

  constructor(
    private readonly client: Pick<Client, "request" | "verifiedContext">,
    private readonly driver: SettingsStoreDriver,
  ) {}

  get state() {
    return this.stateValue;
  }
  // Retained diagnostics: late success never clears unknown, and failure is
  // never retried. A pending fence is not proof of clean retirement.
  get fenceState(): FenceState {
    return this.fenceStateValue;
  }
  get fenceError(): unknown {
    return this.fenceErrorValue;
  }

  start(): void {
    if (this.stateValue !== "idle" || this.stopRequested)
      throw new BridgeError("refused", "settings_store_pump_already_started");
    const context = this.client.verifiedContext;
    if (!validate("Context", context))
      throw new BridgeError("refused", "settings_store_context_invalid");
    this.context = Object.freeze({ ...context });
    this.stateValue = "running";
    this.loop = this.poll();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopRequested = true;
    this.ensureFence();
    if (this.activeCommand) this.lose();
    this.stopPromise = this.retire();
    return this.stopPromise;
  }

  private async retire(): Promise<void> {
    // Go owner retirement followed by exchange quiescence wakes the normal
    // poll. This pump does not close/reconnect the shared client.
    await this.loop;
    if (this.stateValue !== "unknown") await this.fenceWait;
    if (this.stateValue !== "unknown") {
      if (this.fenceStateValue === "confirmed") this.stateValue = "stopped";
      else this.lose();
    }
  }

  private lose(interrupt = true): void {
    this.stateValue = "unknown";
    this.ensureFence();
    if (interrupt) this.interrupt?.();
  }

  private ensureFence(): void {
    if (this.fenceStateValue !== "none") return;
    this.fenceStateValue = "pending"; // Consume before calling host code.
    let finish!: () => void;
    this.fenceWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      this.lose();
      finish();
    }, budgetMillis);
    const failed = (error: unknown): void => {
      clearTimeout(timer);
      this.fenceErrorValue = error;
      this.fenceStateValue = "failed";
      this.lose();
      finish();
    };
    try {
      // Deliberately invoke inline: queued host writes must see the latch in
      // the same timeout/stop turn, not after a promise continuation.
      void this.driver.fence().then(() => {
        clearTimeout(timer);
        this.fenceStateValue = "confirmed";
        finish();
      }, failed);
    } catch (error) {
      failed(error);
    }
  }

  private async within<T>(
    deadline: bigint,
    call: () => Promise<T>,
  ): Promise<T> {
    const remaining = deadline - BigInt(Date.now());
    if (remaining <= 0n || remaining > BigInt(budgetMillis)) {
      this.lose();
      throw new BridgeError("unknown", "settings_store_deadline_invalid");
    }
    let interrupt!: () => void;
    const lost = new Promise<never>((_, reject) => {
      interrupt = () =>
        reject(new BridgeError("unknown", "settings_store_exchange_lost"));
    });
    this.interrupt = interrupt;
    const timer = setTimeout(() => this.lose(), Number(remaining));
    try {
      // Attach both race handlers even when host code throws synchronously.
      let work: Promise<T>;
      try {
        work = call();
      } catch (error) {
        work = Promise.reject(error);
      }
      const result = await Promise.race([work, lost]);
      if (BigInt(Date.now()) >= deadline) {
        this.lose();
        throw new BridgeError("unknown", "settings_store_response_late");
      }
      return result;
    } finally {
      clearTimeout(timer);
      if (this.interrupt === interrupt) this.interrupt = undefined;
    }
  }

  private samePeer(context: Readonly<Context>): boolean {
    return (
      context.profileId === this.context?.profileId &&
      context.backendGeneration === this.context.backendGeneration
    );
  }

  private validOutcome(
    outcome: Outcome,
    id: string,
    operationId?: string,
  ): boolean {
    return (
      validate("Outcome", outcome) &&
      outcome.status === "ok" &&
      outcome.requestId === id &&
      outcome.operationId === operationId &&
      this.samePeer(outcome.context) &&
      this.samePeer(this.client.verifiedContext)
    );
  }

  private async poll(): Promise<void> {
    try {
      while (!this.stopRequested && this.stateValue === "running") {
        if (!this.samePeer(this.client.verifiedContext))
          throw new BridgeError("unknown", "settings_store_peer_changed");
        const id = randomUUID();
        const now = Date.now();
        const result = await this.within(BigInt(now + budgetMillis), () =>
          this.client.request(
            "computer.settings.store.next",
            { deadlineMillis: String(now + 14000) },
            { id, timeoutMs: budgetMillis },
          ),
        );
        if (
          !this.validOutcome(result, id) ||
          !validate("SettingsStoreNextResult", result.data)
        )
          throw new BridgeError("unknown", "settings_store_poll_invalid");
        const command = (result.data as unknown as SettingsStoreNextResult)
          .command;
        if (!command) continue;
        this.activeCommand = true;
        try {
          if (
            this.stopRequested ||
            this.stateValue !== "running" ||
            this.consumed.has(command.commandId) ||
            this.consumed.size >= commandLimit
          )
            throw new BridgeError(
              "unknown",
              "settings_store_command_interrupted",
            );
          this.consumed.add(command.commandId);
          await this.execute(command);
        } finally {
          this.activeCommand = false;
        }
      }
    } catch {
      this.lose();
    }
  }

  private positiveSafe(value: string): boolean {
    const n = BigInt(value);
    return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER);
  }

  private validPending(pending: SettingsStorePending | undefined): boolean {
    return (
      !pending ||
      (pending.profileId === this.context?.profileId &&
        this.positiveSafe(pending.computerGeneration))
    );
  }

  private validSnapshot(snapshot: SettingsStoreSnapshot): boolean {
    return (
      snapshot.current.profileId === this.context?.profileId &&
      this.positiveSafe(snapshot.revision) &&
      this.positiveSafe(snapshot.current.generation) &&
      this.validPending(snapshot.pending)
    );
  }

  private async execute(command: SettingsStoreCommand): Promise<void> {
    const read = command.kind === "read";
    if (
      !validate(
        read ? "SettingsStoreRead" : "SettingsStoreReplace",
        command.body,
      )
    )
      throw new BridgeError("unknown", "settings_store_command_invalid");
    const input = command.body as unknown as
      SettingsStoreRead | SettingsStoreReplace;
    if (
      !this.samePeer(this.client.verifiedContext) ||
      (!read &&
        (!this.validSnapshot((input as SettingsStoreReplace).change.expected) ||
          !this.validPending((input as SettingsStoreReplace).change.next)))
    )
      throw new BridgeError("unknown", "settings_store_command_scope");
    const deadline = BigInt(input.deadlineMillis);
    const answer = await this.within<
      SettingsStoreReadResult | SettingsStoreReplaceResult
    >(deadline, () =>
      read
        ? this.driver.read(input)
        : this.driver.replace(input as SettingsStoreReplace),
    );
    if (
      this.stopRequested ||
      this.stateValue !== "running" ||
      BigInt(Date.now()) >= deadline ||
      !this.samePeer(this.client.verifiedContext) ||
      !validate(
        read ? "SettingsStoreReadResult" : "SettingsStoreReplaceResult",
        answer,
      ) ||
      (answer.status === (read ? "ok" : "committed")) !==
        (answer.snapshot !== undefined) ||
      (answer.snapshot !== undefined && !this.validSnapshot(answer.snapshot))
    )
      throw new BridgeError("unknown", "settings_store_answer_invalid");
    // Report the original unknown once to Go, while fencing host IO immediately.
    // Even a valid ACK cannot revive this pump or dispatch another command.
    if (answer.status === "unknown") this.lose(false);
    const id = randomUUID();
    const result = await this.within(deadline, () =>
      this.client.request(
        "computer.settings.store.reply",
        {
          commandId: command.commandId,
          kind: command.kind,
          body: answer as unknown as Json,
        },
        {
          id,
          operationId: command.commandId,
          timeoutMs: Number(deadline - BigInt(Date.now())),
        },
      ),
    );
    if (
      this.stopRequested ||
      BigInt(Date.now()) >= deadline ||
      !this.validOutcome(result, id, command.commandId) ||
      !validate("Empty", result.data)
    )
      throw new BridgeError("unknown", "settings_store_reply_ack_unknown");
  }
}
