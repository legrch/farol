import { randomUUID } from "node:crypto";
import path from "node:path";
import { BridgeError, type Client } from "./client.ts";
import { ConnectorVerificationBridge } from "./connector-verification.ts";
import {
  validate,
  type Context,
  type Json,
  type ComputerConnectorOpen,
  type ComputerConnectorOpened,
  type ComputerConnectorClosed,
  type ComputerConnectorPollingSamples,
  type ComputerConnectorPollingState,
} from "./wire.ts";

type ConnectorHostMethod =
  "computer.connector.open" | "computer.connector.close";

export type ConnectorClosureReceipt = Readonly<{
  requestId: string;
  operationId: string;
  result: Readonly<ComputerConnectorClosed>;
}>;

// Identity of the original attempt, never permission to replay. "known" means
// only the exact Go refusal before publication; transport refusals stay unknown.
export class ConnectorHostError extends BridgeError {
  constructor(
    state: BridgeError["state"],
    code: string,
    readonly method: ConnectorHostMethod,
    readonly requestId: string,
    readonly operationId: string,
    readonly outcome: "known" | "unknown",
  ) {
    super(state, code);
    Object.freeze(this);
  }
}

// Preserve fixed diagnostics, never arbitrary exception text, wire error
// messages, response data, endpoint credentials or an unsanitized cause.
const failureCodes = new Set([
  "connector_open_refused_before_publication",
  "connector_open_unconfirmed",
  "connector_open_crossed",
  "connector_launch_unconfirmed",
  "connector_close_unconfirmed",
  "connector_close_crossed",
  "response_timeout",
  "transport_failed",
  "transport_ended",
  "truncated_frame",
  "backend_unavailable",
  "client_closed",
  "backpressure",
  "protocol_violation",
  "invalid_response",
  "crossed_response_id",
  "crossed_response_context",
]);

function failure(
  error: unknown,
  method: ConnectorHostMethod,
  requestId: string,
  operationId: string,
  outcome: "known" | "unknown" = "unknown",
): ConnectorHostError {
  return new ConnectorHostError(
    error instanceof BridgeError ? error.state : "unknown",
    error instanceof BridgeError && failureCodes.has(error.code)
      ? error.code
      : method === "computer.connector.open"
        ? "connector_open_unconfirmed"
        : "connector_close_unconfirmed",
    method,
    requestId,
    operationId,
    outcome,
  );
}

// Inherited host pipe only. This adapter retains exact original replies; Go owns
// admission, policy and endpoint lifetime. No status-based recovery or replay.
export class ConnectorHostBridge {
  private current: ComputerConnectorOpened | undefined;
  private pending = false;
  private closeInFlight: Promise<void> | undefined;
  private blocked = false;
  private refusedBeforePublication = false;
  private proof: ConnectorVerificationBridge | undefined;
  private closure: ConnectorClosureReceipt | undefined;
  private closureConsumed = false;
  constructor(
    private readonly client: Pick<Client, "request">,
    private readonly context: Context,
    private readonly buildId: string,
  ) {
    if (!validate("Context", context) || !validate("text", buildId))
      throw new BridgeError("refused", "invalid_connector_host");
    this.context = Object.freeze({ ...context });
  }
  async open(input: ComputerConnectorOpen): Promise<ComputerConnectorOpened> {
    if (this.refusedBeforePublication)
      throw new BridgeError(
        "refused",
        "connector_open_refused_before_publication",
      );
    if (this.pending || this.blocked || this.current)
      throw new BridgeError("unavailable", "connector_host_unavailable");
    if (!validate("ComputerConnectorOpen", input))
      throw new BridgeError("refused", "invalid_connector_open");
    if (
      input.recoveryFrom &&
      (this.closureConsumed ||
        this.closure?.result.recovery !== "settled" ||
        Object.entries(this.closure.result.binding).some(
          ([key, value]) =>
            input.recoveryFrom![key as keyof typeof input.recoveryFrom] !==
            value,
        ))
    )
      throw new BridgeError("refused", "connector_recovery_unavailable");
    const body = Object.freeze({
      ...input,
      publication: Object.freeze({ ...input.publication }),
      ...(input.recoveryFrom
        ? { recoveryFrom: Object.freeze({ ...input.recoveryFrom }) }
        : {}),
    });
    // Keep the original acknowledgement observable, but never reuse it for
    // another admission after an Open attempt, including a lost reply.
    if (this.closure) this.closureConsumed = true;
    this.pending = true;
    const id = randomUUID();
    const operationId = randomUUID();
    try {
      const out = await this.client.request(
        "computer.connector.open",
        body as unknown as Json,
        { id, operationId, timeoutMs: 5000 },
      );
      if (
        !validate("Outcome", out) ||
        out.requestId !== id ||
        out.operationId !== operationId ||
        out.context.profileId !== this.context.profileId ||
        out.context.backendGeneration !== this.context.backendGeneration
      )
        throw new BridgeError("unknown", "connector_open_unconfirmed");
      if (
        out.status === "refused" &&
        out.code === "connector_open_refused_before_publication" &&
        !Object.hasOwn(out, "data")
      ) {
        // Only this original Go outcome proves no connector was published.
        // The claim stays consumed: close is a no-op, and open stays refused.
        this.refusedBeforePublication = true;
        throw new BridgeError("refused", out.code);
      }
      if (out.status !== "ok" || !validate("ComputerConnectorOpened", out.data))
        throw new BridgeError("unknown", "connector_open_unconfirmed");
      const value = out.data as unknown as ComputerConnectorOpened;
      const b = value.endpoint.binding;
      if (
        value.admissionOperationId !== operationId ||
        b.buildId !== this.buildId ||
        b.profileId !== this.context.profileId ||
        b.backendGeneration !== this.context.backendGeneration ||
        b.runtimeId !== body.runtimeId ||
        b.connectorGeneration !== body.connectorGeneration
      )
        throw new BridgeError("unknown", "connector_open_crossed");
      if (
        body.lifecycleRoot !== undefined &&
        (value.launchFile !==
          path.join(
            path.dirname(value.endpoint.socketPath),
            "computer-go-launch.json",
          ) ||
          value.launchSha256 === undefined)
      )
        throw new BridgeError("unknown", "connector_launch_unconfirmed");
      this.current = Object.freeze({
        ...value,
        execution: Object.freeze({ ...value.execution }),
        endpoint: Object.freeze({
          ...value.endpoint,
          binding: Object.freeze({ ...b }),
        }),
      });
      this.proof =
        body.challengeSha256 === undefined
          ? undefined
          : new ConnectorVerificationBridge(
              this.client,
              this.current,
              body.challengeSha256,
            );
      return this.current;
    } catch (error) {
      if (!this.refusedBeforePublication) this.blocked = true;
      throw failure(
        error,
        "computer.connector.open",
        id,
        operationId,
        this.refusedBeforePublication ? "known" : "unknown",
      );
    } finally {
      this.pending = false;
    }
  }
  async observePolling(
    samples: ComputerConnectorPollingSamples,
  ): Promise<ComputerConnectorPollingState> {
    const original = this.current;
    if (
      !original ||
      this.blocked ||
      this.pending ||
      this.closeInFlight ||
      !validate("ComputerConnectorPollingSamples", samples)
    )
      throw new BridgeError("unavailable", "connector_polling_unavailable");
    const id = randomUUID();
    const body = {
      binding: original.endpoint.binding,
      samples: { ...samples },
    };
    const outcome = await this.client.request(
      "computer.connector.polling",
      body as unknown as Json,
      { id, timeoutMs: 5000 },
    );
    if (this.current !== original || this.blocked || this.closeInFlight)
      throw new BridgeError("unavailable", "connector_polling_unavailable");
    if (
      !validate("Outcome", outcome) ||
      outcome.requestId !== id ||
      outcome.operationId !== undefined ||
      outcome.context.profileId !== this.context.profileId ||
      outcome.context.backendGeneration !== this.context.backendGeneration
    )
      throw new BridgeError("unknown", "crossed_connector_polling");
    if (outcome.status !== "ok")
      throw new BridgeError(outcome.status, "connector_polling_unavailable");
    if (
      outcome.code !== undefined ||
      !validate("ComputerConnectorPollingState", outcome.data)
    )
      throw new BridgeError("unknown", "invalid_connector_polling");
    const value = outcome.data as unknown as ComputerConnectorPollingState;
    if (
      Object.entries(original.endpoint.binding).some(
        ([key, field]) =>
          value.binding[key as keyof typeof value.binding] !== field,
      )
    )
      throw new BridgeError("unknown", "crossed_connector_polling");
    if (
      value.cycles !== body.samples.cycles ||
      value.errors !== body.samples.errors ||
      (value.ageSeconds !== undefined) !==
        (value.state === "recent" || value.state === "stale")
    )
      throw new BridgeError("unknown", "invalid_connector_polling");
    return Object.freeze({
      ...value,
      binding: Object.freeze({ ...value.binding }),
    });
  }

  async verification() {
    const current = this.current;
    if (!current || !this.proof || this.pending || this.blocked)
      throw new BridgeError(
        "unavailable",
        "connector_verification_unavailable",
      );
    const result = await this.proof.observe();
    if (this.current !== current || this.pending || this.blocked)
      throw new BridgeError(
        "unavailable",
        "connector_verification_unavailable",
      );
    return result;
  }
  get currentBinding() {
    return this.current?.endpoint.binding;
  }
  get closureReceipt(): ConnectorClosureReceipt | undefined {
    return this.closure;
  }
  close(): Promise<void> {
    // Join the original request, including its exact failure, before checking
    // pending: an in-flight open still has no close promise and remains fenced.
    if (this.closeInFlight) return this.closeInFlight;
    if (this.blocked || this.pending)
      return Promise.reject(
        new BridgeError("unknown", "connector_close_unconfirmed"),
      );
    const current = this.current;
    if (!current) return Promise.resolve();
    this.pending = true;
    this.closeInFlight = this.closeCurrent(current).finally(() => {
      this.pending = false;
      this.closeInFlight = undefined;
    });
    return this.closeInFlight;
  }
  private async closeCurrent(current: ComputerConnectorOpened): Promise<void> {
    const id = randomUUID(),
      operationId = randomUUID();
    try {
      const out = await this.client.request(
        "computer.connector.close",
        { binding: current.endpoint.binding } as unknown as Json,
        { id, operationId, timeoutMs: 6000 },
      );
      if (
        out.status !== "ok" ||
        out.requestId !== id ||
        out.operationId !== operationId ||
        out.context.profileId !== this.context.profileId ||
        out.context.backendGeneration !== this.context.backendGeneration ||
        !validate("ComputerConnectorClosed", out.data)
      )
        throw new BridgeError("unknown", "connector_close_unconfirmed");
      const closed = out.data as unknown as ComputerConnectorClosed;
      if (
        !closed.closed ||
        Object.entries(current.endpoint.binding).some(
          ([key, value]) =>
            closed.binding[key as keyof typeof closed.binding] !== value,
        )
      )
        throw new BridgeError("unknown", "connector_close_crossed");
      this.current = undefined;
      this.proof = undefined;
      this.closure = Object.freeze({
        requestId: id,
        operationId,
        result: Object.freeze({
          ...closed,
          binding: Object.freeze({ ...closed.binding }),
        }),
      });
      this.closureConsumed = false;
    } catch (error) {
      this.blocked = true;
      throw failure(error, "computer.connector.close", id, operationId);
    }
  }
}
