import { BridgeError, type Client } from "./client.ts";
import type { ComputerCall } from "./computer.ts";
import { frame } from "./frame.ts";
import {
  maxFrameBytes,
  validate,
  validUnicode,
  type Json,
  type Context,
  type Identity,
  type Outcome,
  type ComputerConnectorExecution,
  type ComputerConnectorOpened,
  type ComputerConnectorProcessStart,
  type ComputerConnectorProcessStarted,
  type ComputerConnectorProcessRead,
  type ComputerConnectorProcessResult,
  type ComputerConnectorProcessCancel,
  type ComputerConnectorProcessCancelled,
} from "./wire.ts";

export const connectorProcessMethods = Object.freeze([
  "computer.process.start",
  "computer.process.read",
  "computer.process.cancel",
]);

// A single selected Go owner must advertise the complete process slice.
export function connectorSupportsProcesses(identity: Identity): boolean {
  try {
    const selected = snapshot(identity) as unknown as Identity;
    if (!validate("Identity", selected)) throw Error();
    const count = connectorProcessMethods.filter((method) =>
      selected.capabilities.includes(method),
    ).length;
    if (count !== 0 && count !== 3) throw Error();
    return count === 3;
  } catch {
    throw new BridgeError("refused", "connector_process_capabilities_invalid");
  }
}

export type ConnectorProcessStartInput = Omit<
  ComputerConnectorProcessStart,
  "execution" | "callId"
>;
export type ConnectorProcessReadInput = Omit<
  ComputerConnectorProcessRead,
  "execution" | "callId"
>;
export type ConnectorProcessCancelInput = Omit<
  ComputerConnectorProcessCancel,
  "execution" | "callId"
>;
export type ConnectorProcessData =
  | ComputerConnectorProcessStarted
  | ComputerConnectorProcessResult
  | ComputerConnectorProcessCancelled;
export type ConnectorProcessResult<
  T extends ConnectorProcessData = ConnectorProcessData,
> = Readonly<{
  status: Outcome["status"];
  requestId: string;
  context: Context;
  operationId: string;
  cancelOperationId?: string;
  data?: T;
  code?: string;
  retry?: "never";
}>;
type Kind = "start" | "read" | "cancel";
type Body =
  | ComputerConnectorProcessStart
  | ComputerConnectorProcessRead
  | ComputerConnectorProcessCancel;
const maximumOutput = 4n * 1024n * 1024n;
const windowBytes = 64 * 1024;
const safeCode = (code: unknown): code is string =>
  typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code);

// Detached, bounded JSON only. Never call an accessor or retain mutable peer data.
function snapshot(value: unknown): Json {
  let bytes = maxFrameBytes;
  let nodes = 8192;
  const seen = new Set<object>();
  const charge = (count: number) => {
    if ((bytes -= count) < 0) throw Error();
  };
  const visit = (item: unknown, depth: number): Json => {
    if (--nodes < 0 || depth > 32) throw Error();
    if (item === null || typeof item === "boolean") {
      charge(5);
      return item;
    }
    if (typeof item === "string") {
      if (item.length > maxFrameBytes || !validUnicode(item)) throw Error();
      charge(Buffer.byteLength(JSON.stringify(item), "utf8"));
      return item;
    }
    if (typeof item === "number" && Number.isSafeInteger(item)) {
      charge(24);
      return item;
    }
    if (typeof item !== "object" || item === null || seen.has(item))
      throw Error();
    const array = Array.isArray(item);
    const proto: unknown = Object.getPrototypeOf(item);
    if (
      proto !== (array ? Array.prototype : Object.prototype) &&
      !(proto === null && !array)
    )
      throw Error();
    const keys = Reflect.ownKeys(item);
    if (keys.length > nodes || keys.some((key) => typeof key !== "string"))
      throw Error();
    const length = array
      ? (Object.getOwnPropertyDescriptor(item, "length")?.value as unknown)
      : undefined;
    if (array && (typeof length !== "number" || keys.length !== length + 1))
      throw Error();
    seen.add(item);
    charge(2);
    const copy: Json[] | Record<string, Json> = array
      ? []
      : (Object.create(null) as Record<string, Json>);
    for (const key of keys) {
      if (typeof key !== "string" || (array && key === "length")) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !validUnicode(key)
      )
        throw Error();
      charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 2);
      const child = visit(descriptor.value as unknown, depth + 1);
      if (Array.isArray(copy)) {
        if (key !== String(copy.length)) throw Error();
        copy.push(child);
      } else copy[key] = child;
    }
    seen.delete(item);
    return Object.freeze(copy);
  };
  return visit(value, 0);
}
function same(expected: object, actual: object): boolean {
  return Object.entries(expected).every(
    ([key, value]) => (actual as Record<string, unknown>)[key] === value,
  );
}
function cwd(value: string): boolean {
  return (
    value === "." ||
    (!value.startsWith("/") &&
      !/[\\\u0000-\u001f\u007f]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."))
  );
}
function boundedOffset(value: string): boolean {
  return validate("decimal", value) && BigInt(value) <= maximumOutput;
}
function window(
  base64: string,
  offset: string,
  next: string,
  bytes: string,
): boolean {
  if (![offset, next, bytes].every(boundedOffset)) return false;
  const decoded = Buffer.from(base64, "base64");
  return (
    decoded.length <= windowBytes &&
    decoded.toString("base64") === base64 &&
    BigInt(next) === BigInt(offset) + BigInt(decoded.length) &&
    BigInt(next) <= BigInt(bytes)
  );
}
function observation(
  data: ComputerConnectorProcessResult,
  input: ComputerConnectorProcessRead,
): boolean {
  if (
    data.stdoutOffset !== input.stdoutOffset ||
    data.stderrOffset !== input.stderrOffset ||
    !window(
      data.stdoutBase64,
      data.stdoutOffset,
      data.stdoutNext,
      data.stdoutBytes,
    ) ||
    !window(
      data.stderrBase64,
      data.stderrOffset,
      data.stderrNext,
      data.stderrBytes,
    ) ||
    BigInt(data.stdoutBytes) + BigInt(data.stderrBytes) > maximumOutput
  )
    return false;
  // Mirror app/services/process/read.go, including its sticky unknown state.
  if (data.rootState === "running") {
    if (
      data.rootWaited ||
      data.exitCode !== undefined ||
      data.exitSignal !== 0 ||
      data.groupCleanup === "confirmed" ||
      data.descendantCleanup === "confirmed"
    )
      return false;
  } else if (
    !data.rootWaited ||
    data.groupCleanup === "pending" ||
    data.descendantCleanup === "pending" ||
    !(data.exitCode !== undefined
      ? data.exitCode <= 255 && data.exitSignal === 0
      : data.exitSignal >= 1 && data.exitSignal <= 128)
  )
    return false;
  // A supervisor exit witnesses root exit and drained output, not cleanup.
  if (
    data.supervisorState === "exited" &&
    (data.rootState !== "exited" || !data.outputDrained)
  )
    return false;
  const cleanupUnverified =
    data.groupCleanup === "unverified" ||
    data.descendantCleanup === "unverified";
  const terminal =
    data.rootState === "exited" &&
    data.groupCleanup === "confirmed" &&
    data.descendantCleanup === "confirmed" &&
    data.outputDrained;
  switch (data.state) {
    case "unknown":
      return true;
    case "terminal":
      return (
        terminal &&
        (data.supervisorState === undefined ||
          data.supervisorState === "exited")
      );
    case "exited":
      return (
        data.rootState === "exited" &&
        data.outputDrained &&
        data.supervisorState === "exited" &&
        cleanupUnverified
      );
    case "running":
      return (
        data.rootState === "running" &&
        !cleanupUnverified &&
        (data.supervisorState === undefined ||
          data.supervisorState === "running")
      );
  }
}

// Pure one-shot codec. No engine, store, process, discovery, replay or fallback.
// A terminal observation makes no claim about durable result retention.
export class ConnectorProcessBridge {
  private readonly execution: ComputerConnectorExecution;
  private readonly context: Context;
  constructor(
    private readonly client: Pick<Client, "request">,
    opened: ComputerConnectorOpened,
    context: Context,
  ) {
    try {
      const selected = snapshot(opened) as unknown as ComputerConnectorOpened;
      const backend = snapshot(context) as unknown as Context;
      if (
        !validate("ComputerConnectorOpened", selected) ||
        !validate("Context", backend) ||
        !same(backend, selected.endpoint.binding) ||
        BigInt(selected.endpoint.binding.connectorGeneration) === 0n
      )
        throw Error();
      this.execution = selected.execution;
      this.context = backend;
    } catch {
      throw new BridgeError("refused", "invalid_connector_process_binding");
    }
  }
  start(
    input: ConnectorProcessStartInput,
    operationId: string,
    call: ComputerCall,
  ): Promise<ConnectorProcessResult<ComputerConnectorProcessStarted>> {
    return this.request<ComputerConnectorProcessStarted>(
      "start",
      input,
      operationId,
      call,
    );
  }
  read(
    input: ConnectorProcessReadInput,
    call: ComputerCall,
  ): Promise<ConnectorProcessResult<ComputerConnectorProcessResult>> {
    return this.request<ComputerConnectorProcessResult>(
      "read",
      input,
      undefined,
      call,
    );
  }
  cancel(
    input: ConnectorProcessCancelInput,
    cancelOperationId: string,
    call: ComputerCall,
  ): Promise<ConnectorProcessResult<ComputerConnectorProcessCancelled>> {
    return this.request<ComputerConnectorProcessCancelled>(
      "cancel",
      input,
      cancelOperationId,
      call,
    );
  }
  private async request<T extends ConnectorProcessData>(
    kind: Kind,
    input: unknown,
    effectOperationId: string | undefined,
    call: ComputerCall,
  ): Promise<ConnectorProcessResult<T>> {
    let current: ComputerCall;
    let body: Body;
    let operationId: string;
    const method = `computer.process.${kind}`;
    try {
      const clean = snapshot(input);
      current = snapshot(call) as unknown as ComputerCall;
      if (
        !validate("id", current.requestId) ||
        !validate("Context", current.context) ||
        !same(this.context, current.context) ||
        (current.timeoutMs !== undefined &&
          (!Number.isFinite(current.timeoutMs) ||
            current.timeoutMs <= 0 ||
            current.timeoutMs > 30000))
      )
        throw Error();
      if (
        clean === null ||
        typeof clean !== "object" ||
        Array.isArray(clean) ||
        Object.hasOwn(clean, "execution") ||
        Object.hasOwn(clean, "callId")
      )
        throw Error();
      body = Object.freeze({
        ...clean,
        execution: this.execution,
        callId: current.requestId,
      }) as unknown as Body;
      operationId =
        kind === "start"
          ? effectOperationId!
          : (
              body as
                ComputerConnectorProcessRead | ComputerConnectorProcessCancel
            ).operationId;
      if (
        !validate("id", operationId) ||
        (kind !== "read" && !validate("id", effectOperationId)) ||
        (kind === "cancel" && effectOperationId === operationId)
      )
        throw Error();
      if (kind === "start") {
        const start = body as ComputerConnectorProcessStart;
        if (
          !validate("ComputerConnectorProcessStart", start) ||
          !cwd(start.relativeCwd) ||
          start.command.includes("\0")
        )
          throw Error();
      } else if (
        !validate(
          kind === "read"
            ? "ComputerConnectorProcessRead"
            : "ComputerConnectorProcessCancel",
          body,
        ) ||
        (kind === "read" &&
          ![
            (body as ComputerConnectorProcessRead).stdoutOffset,
            (body as ComputerConnectorProcessRead).stderrOffset,
          ].every(boundedOffset))
      )
        throw Error();
      // Go processMethods bounds the serialized body separately from the frame.
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 512 * 1024)
        throw Error();
      frame({
        jsonrpc: "2.0",
        id: current.requestId,
        method,
        params: {
          body,
          context: this.context,
          ...(kind === "read" ? {} : { operationId: effectOperationId }),
        },
      });
    } catch {
      throw new BridgeError("refused", "invalid_connector_process_request");
    }
    const failure = (
      status: Outcome["status"],
      code: string,
    ): ConnectorProcessResult<T> =>
      Object.freeze({
        status,
        requestId: current.requestId,
        context: this.context,
        operationId,
        ...(kind === "cancel" ? { cancelOperationId: effectOperationId! } : {}),
        code,
        retry: "never",
      });
    try {
      const out = snapshot(
        await this.client.request(method, body as unknown as Json, {
          id: current.requestId,
          timeoutMs: current.timeoutMs ?? 10000,
          ...(kind === "read" ? {} : { operationId: effectOperationId! }),
        }),
      ) as unknown as Outcome;
      if (
        !validate("Outcome", out) ||
        out.requestId !== current.requestId ||
        !same(this.context, out.context) ||
        (kind === "read"
          ? out.operationId !== undefined
          : out.operationId !== effectOperationId)
      )
        throw Error();
      if (out.status !== "ok") {
        if (out.data !== undefined || !safeCode(out.code)) throw Error();
        return failure(out.status, out.code);
      }
      const definition =
        kind === "start"
          ? "ComputerConnectorProcessStarted"
          : kind === "read"
            ? "ComputerConnectorProcessResult"
            : "ComputerConnectorProcessCancelled";
      if (out.code !== undefined || !validate(definition, out.data))
        throw Error();
      const data = out.data as unknown as T;
      if (
        !same(this.execution, data.execution) ||
        data.callId !== current.requestId ||
        data.operationId !== operationId ||
        (kind !== "start" &&
          data.handle !==
            (
              body as
                ComputerConnectorProcessRead | ComputerConnectorProcessCancel
            ).handle)
      )
        throw Error();
      if (
        kind === "read" &&
        !observation(
          data as ComputerConnectorProcessResult,
          body as ComputerConnectorProcessRead,
        )
      )
        throw Error();
      if (
        kind === "cancel" &&
        (data as ComputerConnectorProcessCancelled).cancelOperationId !==
          effectOperationId
      )
        throw Error();
      const unknown =
        kind === "read"
          ? (data as ComputerConnectorProcessResult).state === "unknown"
          : kind === "cancel" &&
            (data as ComputerConnectorProcessCancelled).status === "unknown";
      return Object.freeze({
        status: unknown ? "unknown" : "ok",
        requestId: current.requestId,
        context: this.context,
        operationId,
        ...(kind === "cancel" ? { cancelOperationId: effectOperationId! } : {}),
        data,
        ...(unknown
          ? {
              code:
                kind === "read"
                  ? "PROCESS_OBSERVATION_UNKNOWN"
                  : "PROCESS_CANCEL_UNKNOWN",
              retry: "never" as const,
            }
          : {}),
      });
    } catch (error) {
      // Once handed to the selected transport, a thrown/refused/malformed reply
      // cannot establish that an effect did not happen. Never resend.
      let code = "invalid_connector_process_response";
      // Exception metadata is another untrusted boundary; do not read getters.
      try {
        if (error instanceof BridgeError) {
          const descriptor = Object.getOwnPropertyDescriptor(error, "code");
          if (
            descriptor &&
            Object.hasOwn(descriptor, "value") &&
            safeCode(descriptor.value)
          )
            code = descriptor.value;
        }
      } catch {
        code = "invalid_connector_process_response";
      }
      return failure("unknown", code);
    }
  }
}
