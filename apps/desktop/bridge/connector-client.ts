import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import { BridgeError, RequestNotSentError } from "./client.ts";
import { Decoder, frame } from "./frame.ts";
import {
  maxFrameBytes,
  protocolMajor,
  protocolMinor,
  validate,
  type ComputerConnectorBinding,
  type ComputerConnectorEndpoint,
  type ComputerConnectorHello,
  type Context,
  type Identity,
  type Json,
  type Outcome,
  type Request,
  type Response,
} from "./wire.ts";

// Only stream IO is injectable. This seam cannot launch or select a backend.
export interface ConnectorSocket {
  readonly destroyed: boolean;
  readonly writable: boolean;
  readonly writableLength: number;
  on: EventEmitter["on"];
  off: EventEmitter["off"];
  write(bytes: Uint8Array): boolean;
  destroy(): void;
}
export type ConnectorSocketFactory = (socketPath: string) => ConnectorSocket;

type Pending = {
  resolve: (outcome: Outcome) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  submitted: boolean;
  handshake: boolean;
};
type Connection = {
  resolve: (identity: Identity) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
  submitted: boolean;
};
type Phase = "new" | "opening" | "binding" | "handshake" | "ready" | "stopped";

const workspaceMethods = new Set([
  "computer.workspace.read",
  "computer.workspace.list",
  "computer.workspace.search",
  "computer.workspace.catalogue",
  "computer.workspace.bootstrap",
  "computer.connector.verify",
]);
const validTimeout = (value: number): boolean =>
  Number.isFinite(value) && value > 0 && value <= 30000;

// Trusted host only. The constructor's protected endpoint is snapshotted once;
// no renderer endpoint, authority issuance, discovery, child or replay exists here.
export class SocketConnectorClient {
  readonly #endpoint: ComputerConnectorEndpoint;
  readonly #socketFactory: ConnectorSocketFactory;
  private phase: Phase = "new";
  #socket: ConnectorSocket | undefined;
  private decoder = new Decoder();
  private pending = new Map<string, Pending>();
  private used = new Set<string>();
  private connection: Connection | undefined;
  private context: Readonly<Context> | undefined;
  private identity: Readonly<Identity> | undefined;
  private writerBusy = false;

  constructor(
    endpoint: ComputerConnectorEndpoint,
    socketFactory: ConnectorSocketFactory = (path) =>
      createConnection({ path }),
  ) {
    try {
      if (!validate("ComputerConnectorEndpoint", endpoint)) throw Error();
      const selected = {
        binding: Object.freeze({ ...endpoint.binding }),
        socketPath: endpoint.socketPath,
        token: endpoint.token,
      };
      if (
        !validate("ComputerConnectorEndpoint", selected) ||
        !selected.socketPath.startsWith("/") ||
        selected.socketPath.includes("\0")
      )
        throw Error();
      this.#endpoint = Object.freeze(selected);
      this.#socketFactory = socketFactory;
    } catch {
      throw new BridgeError("refused", "invalid_connector_endpoint");
    }
  }

  // One attempt, one deadline covering socket opening, binding ACK and handshake.
  // Identity always derives from the selected endpoint, never another caller DTO.
  connect(timeoutMs = 2000): Promise<Identity> {
    if (this.phase !== "new")
      return Promise.reject(
        new BridgeError("refused", "connector_already_used"),
      );
    if (!validTimeout(timeoutMs))
      return Promise.reject(new BridgeError("refused", "invalid_deadline"));
    this.phase = "opening";
    return new Promise((resolve, reject) => {
      this.connection = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail("connector_timeout"), timeoutMs),
        submitted: false,
      };
      try {
        this.#socket = this.#socketFactory(this.#endpoint.socketPath);
        this.#socket.on("error", this.onError);
        this.#socket.on("close", this.onClose);
        this.#socket.on("end", this.onEnd);
        this.#socket.on("data", this.onData);
        this.#socket.on("drain", this.onDrain);
        this.#socket.on("connect", this.onConnect);
      } catch {
        this.fail("connector_unavailable");
      }
    });
  }

  get verifiedContext(): Readonly<Context> {
    if (this.phase === "stopped")
      throw new BridgeError("unavailable", "connector_unavailable");
    if (this.phase !== "ready" || !this.context)
      throw new BridgeError("unavailable", "handshake_required");
    return this.context;
  }

  // Structurally compatible with Pick<Client, "request"> for ComputerBridge.
  request(
    method: string,
    body: Json,
    options: { id?: string; operationId?: string; timeoutMs?: number } = {},
  ): Promise<Outcome> {
    if (this.phase === "stopped")
      return Promise.reject(
        new BridgeError("unavailable", "connector_unavailable"),
      );
    if (this.phase !== "ready")
      return Promise.reject(
        new BridgeError("unavailable", "handshake_required"),
      );
    if (!workspaceMethods.has(method))
      return Promise.reject(
        new BridgeError("unsupported", "connector_method_unsupported"),
      );
    if (options.operationId !== undefined)
      return Promise.reject(
        new BridgeError("refused", "connector_operation_id_forbidden"),
      );
    return this.send(
      method,
      body,
      options.id ?? randomUUID(),
      options.timeoutMs ?? 2000,
    );
  }

  // Closes this exact stream only. It cannot settle or cancel backend-owned work.
  close(): Promise<void> {
    this.fail("connector_closed");
    return Promise.resolve();
  }

  private onConnect = (): void => {
    if (this.phase !== "opening") {
      if (this.phase !== "stopped") this.fail("unexpected_connector_connect");
      return;
    }
    const hello: ComputerConnectorHello = {
      binding: this.#endpoint.binding,
      token: this.#endpoint.token,
    };
    let bytes: Buffer;
    try {
      if (!validate("ComputerConnectorHello", hello)) throw Error();
      bytes = frame(hello);
      if (bytes.length > 8192 + 4) throw Error();
    } catch {
      this.fail("invalid_connector_hello", "refused");
      return;
    }
    if (!this.canWrite(bytes.length)) {
      this.fail("connector_unavailable");
      return;
    }
    this.phase = "binding";
    this.write(bytes);
  };
  private onData = (bytes: Buffer): void => {
    if (this.phase === "stopped") return;
    try {
      this.decoder.push(bytes, (value) => this.receive(value));
    } catch {
      this.fail("connector_protocol_violation");
    }
  };
  private onEnd = (): void => {
    try {
      this.decoder.finish();
      this.fail("connector_transport_ended");
    } catch {
      this.fail("connector_truncated_frame");
    }
  };
  private onError = (): void => this.fail("connector_transport_failed");
  private onDrain = (): void => {
    this.writerBusy = false;
  };
  private onClose = (): void => {
    this.fail("connector_transport_closed");
    this.#socket?.off("error", this.onError);
    this.#socket?.off("close", this.onClose);
    this.#socket = undefined;
  };

  private canWrite(size: number): boolean {
    const socket = this.#socket;
    return (
      !!socket &&
      !socket.destroyed &&
      socket.writable &&
      !this.writerBusy &&
      Number.isSafeInteger(socket.writableLength) &&
      socket.writableLength >= 0 &&
      socket.writableLength + size <= maxFrameBytes + 4
    );
  }
  private write(bytes: Buffer): void {
    try {
      // false still means submitted; drain only permits a future, new request.
      if (!this.#socket!.write(bytes)) this.writerBusy = true;
    } catch {
      // Entering write may have submitted bytes before a synchronous failure.
      this.fail("connector_transport_failed");
    }
  }
  private send(
    method: string,
    body: Json,
    id: string,
    timeoutMs: number,
    handshake = false,
  ): Promise<Outcome> {
    if (this.phase === "stopped")
      return Promise.reject(
        new BridgeError("unavailable", "connector_unavailable"),
      );
    if (this.pending.size >= 32 || this.used.size >= 4096 || this.writerBusy)
      return Promise.reject(new RequestNotSentError());
    if (this.used.has(id))
      return Promise.reject(new BridgeError("refused", "duplicate_request_id"));
    if (!validTimeout(timeoutMs))
      return Promise.reject(new BridgeError("refused", "invalid_deadline"));
    const request: Request = {
      jsonrpc: "2.0",
      id,
      method,
      params: { body, ...(handshake ? {} : { context: this.context! }) },
    };
    let bytes: Buffer;
    try {
      if (!validate("Request", request))
        return Promise.reject(new BridgeError("refused", "invalid_request"));
      bytes = frame(request);
    } catch {
      return Promise.reject(
        new BridgeError("refused", "invalid_request_frame"),
      );
    }
    if (!this.#socket?.writable || this.#socket.destroyed) {
      this.fail("connector_unavailable");
      return Promise.reject(
        new BridgeError("unavailable", "connector_unavailable"),
      );
    }
    if (!this.canWrite(bytes.length))
      return Promise.reject(new RequestNotSentError());
    this.used.add(id);
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        handshake,
        submitted: false,
        timer: setTimeout(() => this.fail("response_timeout"), timeoutMs),
      };
      this.pending.set(id, pending);
      pending.submitted = true;
      if (handshake && this.connection) this.connection.submitted = true;
      this.write(bytes);
    });
  }

  private receive(value: unknown): void {
    if (this.phase === "stopped") return;
    if (this.phase === "binding") {
      if (!validate("ComputerConnectorBinding", value)) {
        this.fail("invalid_connector_ack", "refused");
        return;
      }
      const ack = value as ComputerConnectorBinding;
      if (
        Object.entries(this.#endpoint.binding).some(
          ([key, expected]) =>
            ack[key as keyof ComputerConnectorBinding] !== expected,
        )
      ) {
        this.fail("crossed_connector_ack", "refused");
        return;
      }
      this.phase = "handshake";
      void this.send(
        "core.handshake",
        {
          protocolMajor,
          protocolMinor,
          buildId: ack.buildId,
          profileId: ack.profileId,
        },
        randomUUID(),
        30000,
        true,
      ).catch((error: BridgeError) => {
        this.fail(
          error.code,
          error.state === "refused" ? "refused" : undefined,
        );
      });
      return;
    }
    if (!validate("Response", value)) {
      this.fail("invalid_connector_response");
      return;
    }
    const response = value as Response;
    const pending =
      response.id === null ? undefined : this.pending.get(response.id);
    if (!pending) {
      this.fail("crossed_response_id");
      return;
    }
    const result = response.result;
    if (!result) {
      // Raw peer messages/data are never copied into diagnostics.
      clearTimeout(pending.timer);
      this.pending.delete(response.id!);
      pending.reject(new BridgeError("refused", "connector_protocol_refused"));
      if (pending.handshake) this.fail("connector_protocol_refused", "refused");
      return;
    }
    const binding = this.#endpoint.binding;
    if (
      result.requestId !== response.id ||
      Object.hasOwn(result, "operationId") ||
      result.context.profileId !== binding.profileId ||
      result.context.backendGeneration !== binding.backendGeneration
    ) {
      this.fail("crossed_response_context");
      return;
    }
    if (pending.handshake) {
      if (result.status !== "ok" || !validate("Identity", result.data)) {
        this.fail("invalid_backend_identity", "refused");
        return;
      }
      const identity = result.data as unknown as Identity;
      if (
        identity.protocolMajor !== protocolMajor ||
        identity.protocolMinor !== protocolMinor ||
        identity.buildId !== binding.buildId ||
        identity.profileId !== binding.profileId ||
        identity.backendGeneration !== binding.backendGeneration ||
        identity.maxFrameBytes !== maxFrameBytes
      ) {
        this.fail("wrong_backend_identity", "refused");
        return;
      }
      this.identity = Object.freeze({
        ...identity,
        capabilities: Object.freeze([...identity.capabilities]),
      });
      this.context = Object.freeze({ ...result.context });
      this.phase = "ready";
      if (this.connection) {
        clearTimeout(this.connection.timer);
        this.connection.resolve(this.identity);
        this.connection = undefined;
      }
    }
    clearTimeout(pending.timer);
    this.pending.delete(response.id!);
    pending.resolve(result);
  }

  private fail(code: string, connectionState?: "refused"): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    if (this.connection) {
      clearTimeout(this.connection.timer);
      this.connection.reject(
        new BridgeError(
          connectionState ??
            (this.connection.submitted ? "unknown" : "unavailable"),
          code,
        ),
      );
      this.connection = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BridgeError(pending.submitted ? "unknown" : "unavailable", code),
      );
    }
    this.pending.clear();
    this.used.clear();
    this.context = undefined;
    this.identity = undefined;
    this.decoder = new Decoder();
    const socket = this.#socket;
    if (!socket) return;
    socket.off("connect", this.onConnect);
    socket.off("data", this.onData);
    socket.off("end", this.onEnd);
    socket.off("drain", this.onDrain);
    // Keep the non-diagnostic error guard until close: destroy may queue an error.
    if (!socket.destroyed) {
      try {
        socket.destroy();
      } catch {
        /* No reconnect or cleanup retry. */
      }
    }
  }
}
