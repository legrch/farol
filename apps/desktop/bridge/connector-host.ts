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
} from "./wire.ts";

// Inherited host pipe only. This adapter retains exact original replies; Go owns
// admission, policy and endpoint lifetime. No status-based recovery or replay.
export class ConnectorHostBridge {
  private current: ComputerConnectorOpened | undefined;
  private pending = false;
  private blocked = false;
  private refusedBeforePublication = false;
  private proof: ConnectorVerificationBridge | undefined;
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
    const body = Object.freeze({
      ...input,
      publication: Object.freeze({ ...input.publication }),
    });
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
      throw error;
    } finally {
      this.pending = false;
    }
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
  async close(): Promise<void> {
    if (this.blocked || this.pending)
      throw new BridgeError("unknown", "connector_close_unconfirmed");
    const current = this.current;
    if (!current) return;
    this.pending = true;
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
    } catch (error) {
      this.blocked = true;
      throw error;
    } finally {
      this.pending = false;
    }
  }
}
