import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import { Decoder, frame } from "./frame.ts";
import type { QualifiedProfileLaunch } from "./profile.ts";
import {
  protocolMajor,
  protocolMinor,
  validate,
  type Context,
  type EventData,
  type Handshake,
  type Identity,
  type Json,
  type Outcome,
  type Request,
  type Response,
} from "./wire.ts";

export class BridgeError extends Error {
  constructor(
    readonly state: "unavailable" | "unknown" | "refused" | "unsupported",
    readonly code: string,
  ) {
    super(code);
  }
}
// A local refusal before stdin.write, not a remote outcome or a pipe error.
// Keep this distinct from an identically named provider/protocol failure.
export class RequestNotSentError extends BridgeError {
  constructor(
    code: "backpressure" | "request_deadline_expired" = "backpressure",
  ) {
    super(code === "backpressure" ? "unavailable" : "refused", code);
  }
}
type Pending = {
  callerId: string;
  resolve: (outcome: Outcome) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutCheck?: ReturnType<typeof setImmediate>;
  operationId?: string;
  handshake?: Handshake;
  retirementHandoffId?: string;
};

// Facts observed on the original ChildProcess, not a clean-retirement decision.
// Go must separately qualify origin retirement and the initiating host's ACK.
export type ChildTerminalObservation = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
}>;

export type BackendLifecycleObservation = Readonly<{
  source: "go-backend";
  phase: "startup" | "active" | "closing";
  event: "failure" | "child-close" | "cleanup-unknown";
  code: BackendLifecycleCode;
  state: "observed" | "outcome_unknown" | "unavailable";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  hostLifetimeId: string | null;
  childLaunchId: string | null;
}>;
const lifecycleCodeValues = [
  "protocol_violation",
  "transport_ended",
  "truncated_frame",
  "transport_failed",
  "backend_unavailable",
  "response_timeout",
  "stale_event_context",
  "event_stream_budget",
  "event_sequence_regression",
  "invalid_response",
  "crossed_response_id",
  "crossed_response_context",
  "invalid_backend_identity",
  "wrong_backend_identity",
  "handshake_refused",
  "client_closed",
] as const;
type BackendLifecycleCode =
  | (typeof lifecycleCodeValues)[number]
  | "backend_unclassified_failure"
  | "backend_child_closed"
  | "backend_cleanup_unconfirmed";
const lifecycleCodes = new Set<string>(lifecycleCodeValues);
const lifecycleSignals = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGIOT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGSTKFLT",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPOLL",
  "SIGPWR",
  "SIGSYS",
  "SIGINFO",
  "SIGEMT",
  "SIGBREAK",
]);

// Trusted Electron host only. No renderer IPC, endpoint discovery or automatic restart.
export class Client {
  private decoder = new Decoder();
  private pending = new Map<string, Pending>();
  private used = new Set<string>();
  // Only the two reciprocal, read-only host polls use constant-space ordered
  // wire IDs. Effect/command IDs keep their lifetime replay fence.
  private readonly pollNonce = randomUUID();
  private readonly polls = new Map<string, bigint>();
  private stopped = false;
  private context: Context | undefined;
  private identity: Identity | undefined;
  private connecting = false;
  private sequences = new Map<string, bigint>();
  private stale = new Set<string>();
  private listeners = new Set<(event: EventData, stale: boolean) => void>();
  private diagnosticBytes = 0;
  private writerBusy = false;
  private childClosed = false;
  private terminal: ChildTerminalObservation | undefined;
  private terminalObservation: Promise<ChildTerminalObservation> | undefined;
  private forcedTermination = false;
  private detachStreams: (() => void)[] = [];
  private onDrain = (): void => {
    this.writerBusy = false;
  };
  private cleanupPromise: Promise<void> | undefined;
  private resourceReleased = false;
  private resourceError: BridgeError | undefined;
  private cleanup: "none" | "pending" | "confirmed" | "unknown" = "none";
  private retirementPrepared = false;
  private closeRequested = false;
  private readonly lifecycle = new Map<
    BackendLifecycleObservation["event"],
    BackendLifecycleObservation
  >();
  private readonly lifecycleIdentity:
    Readonly<{ hostLifetimeId: string; childLaunchId: string }> | undefined;
  constructor(
    private child: ChildProcessWithoutNullStreams,
    private owned = false,
    private releaseResource?: () => void,
    private readonly onLifecycleObservation?: (
      observation: BackendLifecycleObservation,
    ) => void,
    lifecycleIdentity?: Readonly<{
      hostLifetimeId: string;
      childLaunchId: string;
    }>,
  ) {
    const safeIdentity = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
    try {
      const fields: PropertyDescriptorMap = lifecycleIdentity
        ? Object.getOwnPropertyDescriptors(lifecycleIdentity)
        : {};
      const host = fields.hostLifetimeId?.value;
      const child = fields.childLaunchId?.value;
      if (
        typeof host === "string" &&
        typeof child === "string" &&
        safeIdentity.test(host) &&
        safeIdentity.test(child)
      )
        this.lifecycleIdentity = Object.freeze({
          hostLifetimeId: host,
          childLaunchId: child,
        });
    } catch {
      /* Missing diagnostic identity must not change launch behavior. */
    }
    const onData = (data: Buffer): void => {
      try {
        this.decoder.push(data, (value) => this.receive(value));
      } catch {
        this.fail("protocol_violation");
      }
    };
    const onEnd = (): void => {
      try {
        this.decoder.finish();
        this.fail("transport_ended");
      } catch {
        this.fail("truncated_frame");
      }
    };
    const onStreamError = (): void => this.fail("transport_failed");
    const onDiagnostic = (data: Buffer): void => {
      this.diagnosticBytes = Math.min(
        65536,
        this.diagnosticBytes + data.length,
      );
    };
    const onError = (): void =>
      this.fail(
        "backend_unavailable",
        child.pid === undefined ? "unavailable" : "unknown",
      );
    const onClose = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      this.terminal = Object.freeze({
        exitCode,
        signal,
        forced: this.forcedTermination,
      });
      this.childClosed = true;
      this.observeLifecycle(
        "child-close",
        "backend_child_closed",
        "observed",
        exitCode,
        signal,
      );
      this.fail("backend_unavailable");
    };
    child.stdout.on("data", onData);
    child.stdout.on("end", onEnd);
    child.stdout.on("error", onStreamError);
    child.stdin.on("error", onStreamError);
    child.stderr.on("data", onDiagnostic);
    child.once("error", onError);
    child.once("close", onClose);
    this.detachStreams = [
      () => {
        child.stdout.off("data", onData);
      },
      () => {
        child.stdout.off("end", onEnd);
      },
      () => {
        child.stdout.off("error", onStreamError);
      },
      () => {
        child.stdin.off("error", onStreamError);
      },
      () => {
        child.stdin.off("drain", this.onDrain);
      },
      () => {
        child.stderr.off("data", onDiagnostic);
      },
      () => {
        child.off("error", onError);
      },
      () => {
        child.off("close", onClose);
      },
    ];
  }
  async handshake(expected: Handshake, timeoutMs: number): Promise<Identity> {
    if (this.context || this.identity || this.connecting)
      throw new BridgeError("refused", "already_connected");
    if (!validate("Handshake", expected))
      throw new BridgeError("refused", "invalid_handshake");
    const hello = Object.freeze({ ...expected });
    this.connecting = true;
    try {
      await this.send(
        "core.handshake",
        hello as unknown as Json,
        randomUUID(),
        timeoutMs,
        undefined,
        hello,
      );
      if (this.stopped || !this.identity)
        throw new BridgeError("unknown", "backend_unavailable");
      return this.identity;
    } finally {
      this.connecting = false;
    }
  }

  // Trusted host composition consumes the already validated handshake context.
  // This never issues another handshake or derives identity from caller input.
  get verifiedContext(): Readonly<Context> {
    if (this.stopped)
      throw new BridgeError("unavailable", "backend_unavailable");
    if (!this.context)
      throw new BridgeError("unavailable", "handshake_required");
    return this.context;
  }

  request(
    method: string,
    body: Json,
    options: {
      id?: string;
      operationId?: string;
      timeoutMs?: number;
      // Trusted host budget only; never sent as transport or provider authority.
      deadlineAtMillis?: number;
    } = {},
  ): Promise<Outcome> {
    if (!this.context)
      return Promise.reject(
        new BridgeError("unavailable", "handshake_required"),
      );
    return this.send(
      method,
      body,
      options.id ?? randomUUID(),
      options.timeoutMs ?? 2000,
      options.operationId,
      undefined,
      options.deadlineAtMillis,
    );
  }
  subscribe(listener: (event: EventData, stale: boolean) => void): () => void {
    if (this.listeners.size >= 32)
      throw new BridgeError("unavailable", "observer_budget");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  get cleanupState(): "none" | "pending" | "confirmed" | "unknown" {
    return this.cleanup;
  }
  get diagnosticByteCount(): number {
    return this.diagnosticBytes;
  }
  get lifecycleObservations(): readonly BackendLifecycleObservation[] {
    return Object.freeze([...this.lifecycle.values()]);
  }
  private observeLifecycle(
    event: BackendLifecycleObservation["event"],
    code: BackendLifecycleCode,
    state: BackendLifecycleObservation["state"],
    exitCode: unknown = null,
    signal: unknown = null,
  ): void {
    if (this.lifecycle.has(event)) return;
    const safeExitCode =
      typeof exitCode === "number" &&
      Number.isInteger(exitCode) &&
      exitCode >= -2147483648 &&
      exitCode <= 2147483647
        ? exitCode
        : null;
    const safeSignal =
      typeof signal === "string" && lifecycleSignals.has(signal)
        ? (signal as NodeJS.Signals)
        : null;
    const terminalKnown = (safeExitCode === null) !== (safeSignal === null);
    const observation: BackendLifecycleObservation = Object.freeze({
      source: "go-backend",
      phase: this.closeRequested
        ? "closing"
        : this.context
          ? "active"
          : "startup",
      event,
      code,
      state:
        event === "child-close" && !terminalKnown ? "outcome_unknown" : state,
      exitCode: terminalKnown ? safeExitCode : null,
      signal: terminalKnown ? safeSignal : null,
      forced: this.forcedTermination,
      hostLifetimeId: this.lifecycleIdentity?.hostLifetimeId ?? null,
      childLaunchId: this.lifecycleIdentity?.childLaunchId ?? null,
    });
    this.lifecycle.set(event, observation);
    try {
      void Promise.resolve(this.onLifecycleObservation?.(observation)).catch(
        () => undefined,
      );
    } catch {
      // Diagnostics cannot alter original cleanup, admission or UNKNOWN.
    }
  }
  private send(
    method: string,
    body: Json,
    id: string,
    timeoutMs: number,
    operationId?: string,
    handshake?: Handshake,
    deadlineAtMillis?: number,
  ): Promise<Outcome> {
    if (this.stopped)
      return Promise.reject(
        new BridgeError("unavailable", "backend_unavailable"),
      );
    const pollLane =
      method === "chat.browser.next"
        ? "browser"
        : method === "computer.settings.store.next"
          ? "settings"
          : undefined;
    const retiring =
      method === "computer.connector.close" ||
      (this.retirementPrepared && method === "computer.authority.deactivate") ||
      method === "core.retirement.prepare" ||
      method === "core.retirement.ack";
    // Reserve eight one-shot control calls so reaching the ordinary history
    // bound cannot prevent authority withdrawal, connector closure, and the
    // original retirement ACK. Withdrawal joins this reserve only after an
    // exact prepare ACK, so ordinary Settings changes cannot spend it.
    // All keep their lifetime one-shot ID fence.
    if (
      this.pending.size >= 32 ||
      this.writerBusy ||
      (pollLane === undefined && this.used.size >= (retiring ? 4096 : 4088))
    )
      return Promise.reject(new RequestNotSentError());
    if (id.startsWith("desktop-poll-"))
      return Promise.reject(new BridgeError("refused", "reserved_request_id"));
    if (this.used.has(id))
      return Promise.reject(new BridgeError("refused", "duplicate_request_id"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
      return Promise.reject(new BridgeError("refused", "invalid_deadline"));
    if (
      deadlineAtMillis !== undefined &&
      !Number.isSafeInteger(deadlineAtMillis)
    )
      return Promise.reject(new BridgeError("refused", "invalid_deadline"));
    if (
      !validate("id", id) ||
      (pollLane !== undefined &&
        (operationId !== undefined ||
          !validate(
            pollLane === "browser" ? "BrowserNext" : "SettingsStoreNext",
            body,
          )))
    )
      return Promise.reject(new BridgeError("refused", "invalid_request"));
    const params = {
      body,
      ...(this.context ? { context: this.context } : {}),
      ...(operationId !== undefined ? { operationId } : {}),
    };
    const sequence =
      pollLane === undefined
        ? undefined
        : (this.polls.get(pollLane) ?? 0n) + 1n;
    if (sequence !== undefined && sequence > 18446744073709551615n)
      return Promise.reject(new RequestNotSentError());
    const wireId =
      sequence === undefined
        ? id
        : `desktop-poll-${pollLane}:${this.pollNonce}:${sequence}`;
    const request: Request = { jsonrpc: "2.0", id: wireId, method, params };
    if (!validate("Request", request))
      return Promise.reject(new BridgeError("refused", "invalid_request"));
    let bytes: Buffer;
    try {
      bytes = frame(request);
    } catch {
      return Promise.reject(new BridgeError("refused", "oversized_request"));
    }
    // Framing consumes the original host budget. Refuse before write without
    // consuming the caller ID or stopping this Client when no time remains.
    const remainingMs =
      deadlineAtMillis === undefined
        ? timeoutMs
        : Math.min(timeoutMs, deadlineAtMillis - Date.now());
    if (!Number.isFinite(remainingMs) || remainingMs <= 0)
      return Promise.reject(
        new RequestNotSentError("request_deadline_expired"),
      );
    if (pollLane === undefined) this.used.add(id);
    else this.polls.set(pollLane, sequence!);
    return new Promise((resolve, reject) => {
      const expire = () => {
        this.pending.delete(wireId);
        reject(new BridgeError("unknown", "response_timeout"));
        this.fail("response_timeout");
      };
      const timer = setTimeout(() => {
        // After a desktop event-loop stall, timers can precede an original
        // reply already waiting on stdout. Give only the settings poll one
        // IO turn to observe that reply. This sends nothing and keeps its ID;
        // the pump still rejects every expired physical command.
        if (pollLane === "settings") {
          const pending = this.pending.get(wireId);
          if (pending) pending.timeoutCheck = setImmediate(expire);
        } else expire();
      }, remainingMs);
      this.pending.set(wireId, {
        callerId: id,
        resolve,
        reject,
        timer,
        ...(operationId !== undefined ? { operationId } : {}),
        ...(handshake ? { handshake } : {}),
        ...(method === "core.retirement.prepare" &&
        operationId !== undefined &&
        validate("CoreRetirementPrepare", body)
          ? { retirementHandoffId: (body as { handoffId: string }).handoffId }
          : {}),
      });
      try {
        if (!this.child.stdin.write(bytes)) {
          this.writerBusy = true;
          this.child.stdin.once("drain", this.onDrain);
        }
      } catch {
        this.fail("transport_failed");
      }
    });
  }
  private receive(value: unknown): void {
    if (this.stopped) return;
    if (validate("Event", value)) {
      const event = (value as { params: EventData }).params;
      if (
        !this.context ||
        event.context.profileId !== this.context.profileId ||
        event.context.backendGeneration !== this.context.backendGeneration
      ) {
        this.fail("stale_event_context");
        return;
      }
      if (!this.sequences.has(event.stream) && this.sequences.size >= 64) {
        this.fail("event_stream_budget");
        return;
      }
      const previous = this.sequences.get(event.stream) ?? 0n;
      const sequence = BigInt(event.sequence);
      if (sequence <= previous) {
        this.fail("event_sequence_regression");
        return;
      }
      if (sequence !== previous + 1n || event.kind === "gap")
        this.stale.add(event.stream);
      this.sequences.set(event.stream, sequence);
      for (const listener of this.listeners) {
        try {
          listener(event, this.stale.has(event.stream));
        } catch {
          // A local observer failure cannot invalidate wire data or pending work.
          this.listeners.delete(listener);
        }
      }
      return;
    }
    if (!validate("Response", value)) {
      this.fail("invalid_response");
      return;
    }
    const response = value as Response;
    if (!response.id || !this.pending.has(response.id)) {
      this.fail("crossed_response_id");
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.result) {
      const result = response.result;
      if (
        result.requestId !== response.id ||
        result.operationId !== pending.operationId ||
        (this.context &&
          (result.context.profileId !== this.context.profileId ||
            result.context.backendGeneration !==
              this.context.backendGeneration))
      ) {
        this.fail("crossed_response_context");
        return;
      }
      if (pending.handshake) {
        const expected = pending.handshake;
        let code: string | undefined;
        if (result.status !== "ok" || !validate("Identity", result.data)) {
          code = "invalid_backend_identity";
        } else {
          const identity = result.data as unknown as Identity;
          if (
            identity.protocolMajor !== expected.protocolMajor ||
            identity.protocolMinor < expected.protocolMinor ||
            identity.buildId !== expected.buildId ||
            identity.profileId !== expected.profileId ||
            result.context.backendGeneration !== identity.backendGeneration ||
            result.context.profileId !== identity.profileId
          ) {
            code = "wrong_backend_identity";
          } else {
            // Adopt verified identity before the decoder handles the next frame.
            this.identity = Object.freeze(identity);
            this.context = Object.freeze({ ...result.context });
          }
        }
        if (code) {
          clearTimeout(pending.timer);
          clearImmediate(pending.timeoutCheck);
          this.pending.delete(response.id);
          pending.reject(new BridgeError("refused", code));
          this.fail(code);
          return;
        }
      }
      clearTimeout(pending.timer);
      clearImmediate(pending.timeoutCheck);
      this.pending.delete(response.id);
      if (
        pending.retirementHandoffId !== undefined &&
        result.status === "ok" &&
        validate("CoreRetirementPrepared", result.data) &&
        (result.data as { handoffId: string }).handoffId ===
          pending.retirementHandoffId &&
        /^[a-f0-9]{64}$/u.test(
          (result.data as { receiptDigest: string }).receiptDigest,
        )
      )
        this.retirementPrepared = true;
      // Validate the exact original wire reply above before translating the
      // private poll correlation back to its host caller. Never map effects.
      pending.resolve(
        result.requestId === pending.callerId
          ? result
          : { ...result, requestId: pending.callerId },
      );
    } else {
      clearTimeout(pending.timer);
      clearImmediate(pending.timeoutCheck);
      this.pending.delete(response.id);
      pending.reject(
        new BridgeError(
          "refused",
          response.error?.message ?? "protocol_refused",
        ),
      );
      if (pending.handshake) this.fail("handshake_refused");
    }
  }
  private fail(
    code: string,
    state: "unknown" | "unavailable" = "unknown",
  ): void {
    if (this.stopped) return;
    this.stopped = true;
    this.observeLifecycle(
      "failure",
      lifecycleCodes.has(code)
        ? (code as BackendLifecycleCode)
        : "backend_unclassified_failure",
      state === "unavailable" ? "unavailable" : "outcome_unknown",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      clearImmediate(pending.timeoutCheck);
      pending.reject(new BridgeError(state, code));
    }
    this.pending.clear();
    if (!this.owned) {
      for (const detach of this.detachStreams) detach();
      this.detachStreams = [];
      this.listeners.clear();
    }
    // Admission cannot recover this pipe. Cleanup never resubmits work or proves
    // cancellation of a module-owned OS/provider operation.
    void this.cleanupOwned().catch(() => {
      /* close() exposes unconfirmed cleanup. */
    });
  }
  private terminateOwned(): Promise<void> {
    if (!this.owned) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;
    if (
      this.childClosed ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    ) {
      this.cleanup = "confirmed";
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      return Promise.resolve();
    }
    this.cleanup = "pending";
    this.cleanupPromise = new Promise<void>((resolve, reject) => {
      const kill = setTimeout(() => {
        this.forcedTermination = true;
        this.child.kill("SIGKILL");
      }, 1000);
      const deadline = setTimeout(() => {
        clearTimeout(kill);
        this.cleanup = "unknown";
        this.observeLifecycle(
          "cleanup-unknown",
          "backend_cleanup_unconfirmed",
          "outcome_unknown",
        );
        reject(new BridgeError("unknown", "backend_cleanup_unconfirmed"));
      }, 2000);
      this.child.once("close", () => {
        clearTimeout(kill);
        clearTimeout(deadline);
        this.cleanup = "confirmed";
        resolve();
      });
      this.child.stdin.end();
    });
    return this.cleanupPromise;
  }
  private async cleanupOwned(): Promise<void> {
    await this.terminateOwned();
    // Retain the profile if exact child termination is unknown. Closing these
    // descriptors is not a clean-retirement or successor-admission proof.
    if (this.owned && this.cleanup === "confirmed" && !this.resourceReleased) {
      this.resourceReleased = true;
      try {
        this.releaseResource?.();
      } catch {
        this.resourceError = new BridgeError(
          "unknown",
          "profile_cleanup_unconfirmed",
        );
      }
    }
    if (this.resourceError) throw this.resourceError;
  }
  async close(): Promise<void> {
    this.closeRequested = true;
    this.fail("client_closed");
    this.listeners.clear();
    await this.cleanupOwned();
  }

  // Repeated observation returns the same retained facts without another signal.
  // exitCode/signalCode properties or cleanupState alone are not this witness.
  closeAndObserve(): Promise<ChildTerminalObservation> {
    if (!this.terminalObservation)
      this.terminalObservation = this.closeAndObserveOnce();
    return this.terminalObservation;
  }
  private async closeAndObserveOnce(): Promise<ChildTerminalObservation> {
    if (!this.owned)
      throw new BridgeError("refused", "backend_child_not_owned");
    await this.close();
    if (!this.childClosed || !this.terminal)
      throw new BridgeError("unknown", "backend_terminal_unobserved");
    return this.terminal;
  }
}

// Trusted launcher input only, naming the existing native host slot and temp
// parent. Neither field comes from renderer IPC or a read request.
export type NativeCodexReadSelection = Readonly<{
  hostId: "codex";
  trustedTemp: string;
}>;

// Copy only this optional launcher value, without invoking caller accessors.
// Go validates path semantics; this projection issues no Task/native authority.
export function copyNativeCodexReadLaunch(
  launch: object,
): NativeCodexReadSelection | undefined {
  const refuse = (): never => {
    throw new BridgeError("refused", "invalid_codex_read_launch");
  };
  const field = Object.getOwnPropertyDescriptor(launch, "codexRead");
  if (field === undefined) {
    if (Reflect.has(launch, "codexRead")) refuse();
    return undefined;
  }
  if (!Object.hasOwn(field, "value")) refuse();
  const value: unknown = field.value;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return refuse();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(fields);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(fields, "hostId") ||
    !Object.hasOwn(fields, "trustedTemp") ||
    !Object.hasOwn(fields.hostId!, "value") ||
    !Object.hasOwn(fields.trustedTemp!, "value") ||
    fields.hostId!.value !== "codex" ||
    typeof fields.trustedTemp!.value !== "string"
  )
    return refuse();
  return Object.freeze({
    hostId: "codex",
    trustedTemp: fields.trustedTemp!.value as string,
  });
}

// The profile qualifier is held for this exact trusted backend lifetime.
export interface NativeCoreLaunch {
  readonly profile: QualifiedProfileLaunch;
  readonly ownerId: string;
  readonly computerId: string;
  readonly storeMode: "create" | "open";
  readonly settingsMutations?: boolean;
  readonly previousHostDrainConfirmed?: boolean;
  readonly hostLifetimeId?: string;
  readonly childLaunchId?: string;
  readonly codexRead?: NativeCodexReadSelection;
  // Produced by the independently verified packaged host. The private Go
  // decoder binds these bytes to this exact profile/build/host/child launch.
  readonly shellMetadata?: Uint8Array;
  readonly onLifecycleObservation?: (
    observation: BackendLifecycleObservation,
  ) => void;
}

export async function spawnCore(
  executable: string,
  profileId: string,
  buildId: string,
  timeoutMs = 2000,
  native?: NativeCoreLaunch,
): Promise<Client> {
  const profileOwner = native?.profile;
  let released = false;
  const release = (): void => {
    if (!profileOwner || released) return;
    released = true;
    const result = profileOwner.close();
    if (result.state !== "closed")
      throw new BridgeError(result.state, result.code);
  };
  let child: ChildProcessWithoutNullStreams;
  let shellMetadata: Buffer | undefined;
  try {
    const codexRead = native ? copyNativeCodexReadLaunch(native) : undefined;
    if (!isAbsolute(executable))
      throw new BridgeError("refused", "executable_path_required");
    if (
      !validate("Handshake", {
        protocolMajor,
        protocolMinor,
        buildId,
        profileId,
      })
    )
      throw new BridgeError("refused", "invalid_handshake");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000)
      throw new BridgeError("refused", "invalid_deadline");
    const args = ["serve", "--profile", profileId];
    if (native) {
      const id = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
      if (
        typeof native.ownerId !== "string" ||
        typeof native.computerId !== "string" ||
        !id.test(native.ownerId) ||
        !id.test(native.computerId) ||
        ((native.hostLifetimeId !== undefined ||
          native.childLaunchId !== undefined) &&
          (typeof native.hostLifetimeId !== "string" ||
            typeof native.childLaunchId !== "string" ||
            !id.test(native.hostLifetimeId) ||
            !id.test(native.childLaunchId))) ||
        (native.storeMode !== "create" && native.storeMode !== "open") ||
        (native.settingsMutations !== undefined &&
          typeof native.settingsMutations !== "boolean")
      )
        throw new BridgeError("refused", "invalid_native_launch");
      if (!profileOwner)
        throw new BridgeError("refused", "invalid_native_launch");
      const selected = profileOwner.beforeSpawn();
      if (selected.state !== "qualified")
        throw new BridgeError(selected.state, selected.code);
      const binding = selected.binding;
      if (binding.profileId !== profileId)
        throw new BridgeError("refused", "profile_binding_mismatch");
      args.push(
        "--profile-root",
        binding.root,
        "--profile-device",
        binding.device,
        "--profile-inode",
        binding.inode,
        "--owner",
        native.ownerId,
        "--computer",
        native.computerId,
        "--home",
        binding.home,
        "--store-mode",
        native.storeMode,
      );
      if (
        native.hostLifetimeId !== undefined &&
        native.childLaunchId !== undefined
      )
        args.push(
          "--host-lifetime",
          native.hostLifetimeId,
          "--child-launch",
          native.childLaunchId,
        );
    }
    if (native?.previousHostDrainConfirmed === true)
      args.push("--previous-host-drain-confirmed");
    if (native?.settingsMutations === true) args.push("--settings-mutations");
    if (codexRead)
      args.push(
        "--codex-read-host",
        codexRead.hostId,
        "--codex-read-temp",
        codexRead.trustedTemp,
      );
    if (native?.shellMetadata !== undefined) {
      if (
        !(native.shellMetadata instanceof Uint8Array) ||
        native.shellMetadata.byteLength === 0 ||
        native.shellMetadata.byteLength > 256 * 1024 ||
        native.settingsMutations !== true ||
        native.hostLifetimeId === undefined ||
        native.childLaunchId === undefined
      )
        throw new BridgeError("refused", "invalid_shell_launch_metadata");
      shellMetadata = Buffer.from(native.shellMetadata);
      args.push("--shell-support-fd", "3");
    }
    // stdin/stdout/stderr remain pipes in both variants. The fourth stream is
    // private startup input only, never part of the ordinary RPC protocol.
    child = spawn(executable, args, {
      stdio: shellMetadata
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    // No child was returned: release only this launch's qualified descriptors.
    release();
    throw error;
  }
  const client = new Client(
    child,
    true,
    release,
    native?.onLifecycleObservation,
    native?.hostLifetimeId !== undefined && native.childLaunchId !== undefined
      ? {
          hostLifetimeId: native.hostLifetimeId,
          childLaunchId: native.childLaunchId,
        }
      : undefined,
  );
  let metadataPipe: Writable | undefined;
  try {
    const startupDeadline = performance.now() + timeoutMs;
    if (shellMetadata) {
      const stream = child.stdio[3];
      if (!stream || !("end" in stream) || typeof stream.end !== "function")
        throw new BridgeError("unavailable", "shell_metadata_pipe_unavailable");
      metadataPipe = stream as Writable;
      await writeShellMetadata(metadataPipe, shellMetadata, timeoutMs);
    }
    const handshakeBudget = shellMetadata
      ? startupDeadline - performance.now()
      : timeoutMs;
    if (handshakeBudget <= 0)
      throw new BridgeError("unavailable", "shell_metadata_startup_timeout");
    await client.handshake(
      { protocolMajor, protocolMinor, buildId, profileId },
      handshakeBudget,
    );
    return client;
  } catch (error) {
    metadataPipe?.destroy();
    await client.close();
    throw error;
  }
}

// One bounded end/write. A successful callback proves only local pipe delivery;
// the SAME child's subsequent handshake proves it accepted startup. Keep an error
// listener after settlement so a late error never becomes an unhandled exception.
function writeShellMetadata(
  stream: Writable,
  bytes: Buffer,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed)
        reject(
          new BridgeError("unavailable", "shell_metadata_delivery_failed"),
        );
      else resolve();
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    stream.on("error", () => finish(true));
    stream.once("close", () => finish(true));
    try {
      stream.end(bytes, (error?: Error | null) =>
        finish(error != null || stream.errored != null),
      );
    } catch {
      finish(true);
    }
  });
}
