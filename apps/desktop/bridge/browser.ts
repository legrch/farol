import { randomUUID } from "node:crypto";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Json,
  type BrowserCommand,
  type BrowserNextResult,
  type BrowserPrepare,
  type BrowserPrepared,
  type BrowserVerifySend,
  type BrowserVerified,
  type BrowserSend,
  type BrowserSent,
  type BrowserObserve,
  type BrowserObserved,
  type BrowserCancel,
  type BrowserCancelled,
  type BrowserDispose,
  type BrowserDisposed,
} from "./wire.ts";

// Only the trusted host implements these physical capabilities. There is no
// arbitrary invoke/eval/navigation method and no renderer-facing authority.
export interface BrowserDriver {
  prepare(input: BrowserPrepare): Promise<BrowserPrepared>;
  verifySend(input: BrowserVerifySend): Promise<BrowserVerified>;
  send(input: BrowserSend): Promise<BrowserSent>;
  observe(input: BrowserObserve): Promise<BrowserObserved>;
  cancel(input: BrowserCancel): Promise<BrowserCancelled>;
  dispose(input: BrowserDispose): Promise<BrowserDisposed>;
}
type BrowserBody =
  | BrowserPrepare
  | BrowserVerifySend
  | BrowserSend
  | BrowserObserve
  | BrowserCancel
  | BrowserDispose;
type BrowserAnswer =
  | BrowserPrepared
  | BrowserVerified
  | BrowserSent
  | BrowserObserved
  | BrowserCancelled
  | BrowserDisposed;
const shapes = {
  prepare: ["BrowserPrepare", "BrowserPrepared"],
  "verify-send": ["BrowserVerifySend", "BrowserVerified"],
  send: ["BrowserSend", "BrowserSent"],
  observe: ["BrowserObserve", "BrowserObserved"],
  cancel: ["BrowserCancel", "BrowserCancelled"],
  dispose: ["BrowserDispose", "BrowserDisposed"],
} as const;
export type BrowserPumpFailure = Readonly<{
  stage: "poll" | "execute";
  kind: BrowserCommand["kind"] | null;
  state: "unavailable" | "unknown" | "refused" | "unsupported";
  code: string;
}>;

// One-shot physical dispatch for one already handshaken child. Go owns leases,
// queueing and durable intent. Failure latches this pump; it never reconnects,
// reissues a command or manufactures a browser result after an unknown effect.
export class BrowserPump {
  private stateValue: "idle" | "running" | "stopped" | "unknown" = "idle";
  private readonly consumed = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private loop: Promise<void> | undefined;
  private stopRequested = false;
  private failureValue: BrowserPumpFailure | undefined;
  constructor(
    private readonly client: Client,
    private readonly driver: BrowserDriver,
    private readonly onFailure?: (failure: BrowserPumpFailure) => void,
  ) {}
  get state() {
    return this.stateValue;
  }
  private failed(
    stage: BrowserPumpFailure["stage"],
    kind: BrowserPumpFailure["kind"],
    error: unknown,
  ): void {
    this.stateValue = "unknown";
    this.stopRequested = true;
    if (this.failureValue) return;
    // Retain only local machine classification. Never expose a command body,
    // prompt, identity, URL, raw error message or stack in this diagnostic.
    const classified = error instanceof BridgeError;
    this.failureValue = Object.freeze({
      stage,
      kind,
      state: classified ? error.state : "unknown",
      code:
        classified &&
        /^(?:browser_|chat_browser_|host_browser_|host_chat_browser_|backend_)[a-z_]{1,80}$/u.test(
          error.code,
        )
          ? error.code
          : "browser_unclassified_failure",
    });
    try {
      this.onFailure?.(this.failureValue);
    } catch {
      // Diagnostic publication cannot alter the original permanent fence.
    }
  }
  start(): void {
    if (this.stateValue !== "idle")
      throw new BridgeError("refused", "browser_pump_already_started");
    void this.client.verifiedContext;
    this.stateValue = "running";
    this.loop = this.poll();
  }
  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.loop;
    await Promise.allSettled([...this.active]);
    if (this.stateValue !== "unknown") this.stateValue = "stopped";
  }
  private async poll(): Promise<void> {
    try {
      while (!this.stopRequested && this.stateValue === "running") {
        if (this.active.size >= 8) {
          await Promise.race(this.active);
          continue;
        }
        const requestId = randomUUID();
        const result = await this.client.request(
          "chat.browser.next",
          { deadlineMillis: String(Date.now() + 14000) },
          { id: requestId, timeoutMs: 15000 },
        );
        const expected = this.client.verifiedContext;
        if (
          result.status !== "ok" ||
          result.requestId !== requestId ||
          result.operationId !== undefined ||
          result.context.profileId !== expected.profileId ||
          result.context.backendGeneration !== expected.backendGeneration ||
          !validate("BrowserNextResult", result.data)
        )
          throw new BridgeError("unknown", "browser_poll_invalid");
        const command = (result.data as unknown as BrowserNextResult).command;
        if (!command) continue;
        if (this.stopRequested || this.stateValue !== "running")
          throw new BridgeError(
            "unknown",
            "browser_command_delivery_interrupted",
          );
        if (this.consumed.has(command.commandId) || this.consumed.size >= 4096)
          throw new BridgeError("unknown", "browser_command_replayed");
        this.consumed.add(command.commandId);
        const work = this.execute(command).catch((error: unknown) =>
          this.failed("execute", command.kind, error),
        );
        this.active.add(work);
        void work.finally(() => this.active.delete(work));
      }
    } catch (error) {
      this.failed("poll", null, error);
    }
  }
  private async execute(command: BrowserCommand): Promise<void> {
    const [requestShape, replyShape] = shapes[command.kind];
    if (!validate(requestShape, command.body))
      throw new BridgeError("refused", "browser_command_invalid");
    const body = command.body as unknown as BrowserBody;
    const lease = "lease" in body ? body.lease : body.binding.lease;
    const context = this.client.verifiedContext;
    if (
      lease.identity.profileId !== context.profileId ||
      lease.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("refused", "browser_command_context");
    const remaining = BigInt(body.deadlineMillis) - BigInt(Date.now());
    if (remaining <= 0n || remaining > 15000n)
      throw new BridgeError("refused", "browser_command_deadline");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const unknown = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BridgeError("unknown", "browser_driver_deadline")),
          Number(remaining),
        );
      });
      const answer = await Promise.race([
        this.dispatch(command.kind, body),
        unknown,
      ]);
      if (
        !validate(replyShape, answer) ||
        BigInt(Date.now()) >= BigInt(body.deadlineMillis)
      )
        throw new BridgeError("unknown", "browser_reply_invalid");
      const requestId = randomUUID();
      const result = await this.client.request(
        "chat.browser.reply",
        {
          commandId: command.commandId,
          kind: command.kind,
          body: answer as unknown as Json,
        },
        {
          id: requestId,
          operationId: command.commandId,
          timeoutMs: Math.max(
            1,
            Number(BigInt(body.deadlineMillis) - BigInt(Date.now())),
          ),
        },
      );
      if (
        result.status !== "ok" ||
        result.requestId !== requestId ||
        result.operationId !== command.commandId ||
        result.context.profileId !== context.profileId ||
        result.context.backendGeneration !== context.backendGeneration ||
        !validate("Empty", result.data)
      )
        throw new BridgeError("unknown", "browser_reply_ack_unknown");
    } finally {
      clearTimeout(timer);
    }
  }
  private dispatch(
    kind: BrowserCommand["kind"],
    body: BrowserBody,
  ): Promise<BrowserAnswer> {
    switch (kind) {
      case "prepare":
        return this.driver.prepare(body as BrowserPrepare);
      case "verify-send":
        return this.driver.verifySend(body as BrowserVerifySend);
      case "send":
        return this.driver.send(body as BrowserSend);
      case "observe":
        return this.driver.observe(body as BrowserObserve);
      case "cancel":
        return this.driver.cancel(body as BrowserCancel);
      case "dispose":
        return this.driver.dispose(body as BrowserDispose);
    }
  }
}
