import { createHash } from "node:crypto";
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
  type ComputerConnectorBinding,
  type ComputerConnectorExecution,
  type ComputerConnectorOpened,
  type ComputerConnectorWrite,
  type ComputerConnectorEdit,
  type ComputerConnectorMutationRead,
  type ComputerConnectorMutationResponse,
} from "./wire.ts";

export const connectorMutationMethods = Object.freeze([
  "computer.workspace.write",
  "computer.workspace.edit",
  "computer.workspace.mutation.read",
]);

// No discovery or fallback: the same Go owner must advertise the complete slice.
export function connectorSupportsMutations(identity: Identity): boolean {
  try {
    const selected = snapshot(identity) as unknown as Identity;
    if (!validate("Identity", selected)) throw Error();
    const count = connectorMutationMethods.filter((method) =>
      selected.capabilities.includes(method),
    ).length;
    if (count !== 0 && count !== 3) throw Error();
    return count === 3;
  } catch {
    throw new BridgeError("refused", "connector_mutation_capabilities_invalid");
  }
}

export type ConnectorWriteInput = Omit<
  ComputerConnectorWrite,
  "execution" | "callId"
>;
export type ConnectorEditInput = Omit<
  ComputerConnectorEdit,
  "execution" | "callId"
>;
export type ConnectorMutationReadInput = Omit<
  ComputerConnectorMutationRead,
  "execution" | "callId"
>;
export type ConnectorMutationResult = Readonly<{
  status: Outcome["status"];
  requestId: string;
  context: Context;
  operationId: string;
  data?: ComputerConnectorMutationResponse;
  code?: string;
  retry?: "never";
}>;

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
function path(value: string): boolean {
  return (
    !value.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/u.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function text(value: string): boolean {
  return (
    validUnicode(value) &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 262144
  );
}
const safeCode = (code: unknown): code is string =>
  typeof code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(code);
const failureCodes = new Set([
  "WORKSPACE_INVALID_REQUEST",
  "WORKSPACE_POLICY_TOO_LARGE",
  "WORKSPACE_MUTATION_CANCELLED",
  "WORKSPACE_HELPER_UNTRUSTED",
  "WORKSPACE_INTERPRETER_UNTRUSTED",
  "WORKSPACE_PATH_REFUSED",
  "WORKSPACE_ROOT_CHANGED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_A_FILE",
  "WORKSPACE_FILE_TOO_LARGE",
  "WORKSPACE_MUTATION_CONFLICT",
  "WORKSPACE_NOT_TEXT",
  "WORKSPACE_EDIT_NO_MATCH",
  "WORKSPACE_EDIT_NOT_UNIQUE",
  "WORKSPACE_EDIT_OVERLAP",
  "WORKSPACE_HELPER_FAILED",
  "COMPUTER_AUTHORITY_STORE_UNAVAILABLE",
  "COMPUTER_PARTICIPANT_NOT_FOUND",
  "COMPUTER_APPROVAL_NOT_FOUND",
  "AUTHORITY_OWNER_MISMATCH",
  "AUTHORITY_TASK_MISMATCH",
  "AUTHORITY_COMPUTER_MISMATCH",
  "AUTHORITY_EXPIRED",
  "AUTHORITY_INFLATION_DENIED",
  "AUTHORITY_CAPABILITY_DENIED",
  "AUTHORITY_PATH_DENIED",
  "AUTHORITY_NETWORK_DENIED",
  "AUTHORITY_COMMAND_DENIED",
  "AUTHORITY_MUTATION_OWNERSHIP_DENIED",
]);
const failureSources = new Set([
  "native-workspace",
  "operation-store",
  "computer-approval",
  "task-admission",
  "task-grant",
  "owner-restriction",
  "role",
  "computer-policy",
  "native-host",
  "authority-store",
]);

// Codec only; the selected SocketConnectorClient and Go owner execute/retain work.
export class ConnectorMutationBridge {
  private readonly binding: ComputerConnectorBinding;
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
      this.binding = selected.endpoint.binding;
      this.execution = selected.execution;
      this.context = backend;
    } catch {
      throw new BridgeError("refused", "invalid_connector_mutation_binding");
    }
  }
  write(
    input: ConnectorWriteInput,
    operationId: string,
    call: ComputerCall,
  ): Promise<ConnectorMutationResult> {
    return this.request("write", input, operationId, call);
  }
  edit(
    input: ConnectorEditInput,
    operationId: string,
    call: ComputerCall,
  ): Promise<ConnectorMutationResult> {
    return this.request("edit", input, operationId, call);
  }
  read(
    input: ConnectorMutationReadInput,
    call: ComputerCall,
  ): Promise<ConnectorMutationResult> {
    return this.request("read", input, undefined, call);
  }

  private async request(
    kind: "write" | "edit" | "read",
    input: unknown,
    suppliedOperationId: string | undefined,
    call: ComputerCall,
  ): Promise<ConnectorMutationResult> {
    let current: ComputerCall;
    let body:
      | ComputerConnectorWrite
      | ComputerConnectorEdit
      | ComputerConnectorMutationRead;
    let operationId: string;
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
      if (clean === null || typeof clean !== "object" || Array.isArray(clean))
        throw Error();
      // Input cannot override the host's current execution/call.
      if (Object.hasOwn(clean, "execution") || Object.hasOwn(clean, "callId"))
        throw Error();
      body = Object.freeze({
        ...clean,
        execution: this.execution,
        callId: current.requestId,
      }) as unknown as typeof body;
      operationId =
        kind === "read"
          ? (body as ComputerConnectorMutationRead).operationId
          : suppliedOperationId!;
      if (!validate("id", operationId)) throw Error();
      if (kind === "edit") {
        const edit = body as ComputerConnectorEdit;
        if (
          !validate("ComputerConnectorEdit", body) ||
          !Array.isArray(edit.edits) ||
          edit.edits.length < 1 ||
          edit.edits.length > 256
        )
          throw Error();
        let total = 0;
        for (const entry of edit.edits) {
          if (
            !validate("ComputerTextEdit", entry) ||
            !text(entry.oldText) ||
            !text(entry.newText) ||
            entry.oldText === "" ||
            entry.oldText === entry.newText
          )
            throw Error();
          total +=
            Buffer.byteLength(entry.oldText, "utf8") +
            Buffer.byteLength(entry.newText, "utf8");
        }
        if (total > 262144) throw Error();
      } else if (
        !validate(
          kind === "write"
            ? "ComputerConnectorWrite"
            : "ComputerConnectorMutationRead",
          body,
        ) ||
        (kind === "write" && !text((body as ComputerConnectorWrite).content))
      )
        throw Error();
      if (
        !path(body.relativePath) ||
        Buffer.byteLength(JSON.stringify(body), "utf8") > 512 * 1024
      )
        throw Error();
      frame({
        jsonrpc: "2.0",
        id: current.requestId,
        method:
          kind === "read"
            ? "computer.workspace.mutation.read"
            : `computer.workspace.${kind}`,
        params: {
          body,
          context: this.context,
          ...(kind === "read" ? {} : { operationId }),
        },
      });
    } catch {
      throw new BridgeError("refused", "invalid_connector_mutation_request");
    }
    const failure = (
      status: Outcome["status"],
      code: string,
    ): ConnectorMutationResult =>
      Object.freeze({
        status,
        requestId: current.requestId,
        context: this.context,
        operationId,
        code,
        retry: "never",
      });
    try {
      const out = snapshot(
        await this.client.request(
          kind === "read"
            ? "computer.workspace.mutation.read"
            : `computer.workspace.${kind}`,
          body as unknown as Json,
          {
            id: current.requestId,
            timeoutMs: current.timeoutMs ?? 10000,
            ...(kind === "read" ? {} : { operationId }),
          },
        ),
      ) as unknown as Outcome;
      if (
        !validate("Outcome", out) ||
        out.requestId !== current.requestId ||
        !same(this.context, out.context) ||
        (kind === "read"
          ? out.operationId !== undefined
          : out.operationId !== operationId)
      )
        throw Error();
      if (out.status !== "ok") {
        if (out.data !== undefined || !safeCode(out.code)) throw Error();
        return failure(out.status, out.code);
      }
      if (
        out.code !== undefined ||
        !validate("ComputerConnectorMutationResponse", out.data)
      )
        throw Error();
      const data = out.data as unknown as ComputerConnectorMutationResponse;
      const origin = data.origin;
      if (
        !same(this.execution, data.execution) ||
        data.callId !== current.requestId ||
        data.workspaceId !== body.workspaceId ||
        data.relativePath !== body.relativePath ||
        data.operationId !== operationId ||
        origin.execution.ownerId !== this.execution.ownerId ||
        origin.binding.profileId !== this.context.profileId ||
        BigInt(origin.binding.connectorGeneration) === 0n
      )
        throw Error();
      if (
        kind !== "read" &&
        (!same(this.binding, origin.binding) ||
          !same(this.execution, origin.execution) ||
          origin.callId !== current.requestId ||
          origin.operation !== kind)
      )
        throw Error();
      if (data.phase === "completed") {
        const receipt = data.receipt;
        if (
          !receipt ||
          data.failure !== undefined ||
          receipt.operation !== origin.operation ||
          receipt.relativePath !== body.relativePath ||
          BigInt(receipt.bytes) > 8n * 1024n * 1024n ||
          (receipt.operation === "write"
            ? receipt.replacements !== 0
            : receipt.replacements < 1 ||
              receipt.replacements > 256 ||
              receipt.beforeSHA256 === undefined)
        )
          throw Error();
        if (
          kind !== "read" &&
          receipt.beforeSHA256 !==
            (body as ComputerConnectorWrite | ComputerConnectorEdit)
              .expectedSHA256
        )
          throw Error();
        if (
          kind === "write" &&
          (receipt.bytes !==
            String(
              Buffer.byteLength(
                (body as ComputerConnectorWrite).content,
                "utf8",
              ),
            ) ||
            receipt.afterSHA256 !==
              createHash("sha256")
                .update((body as ComputerConnectorWrite).content)
                .digest("hex"))
        )
          throw Error();
        if (
          kind === "edit" &&
          receipt.replacements !== (body as ComputerConnectorEdit).edits.length
        )
          throw Error();
      } else {
        const f = data.failure;
        if (
          data.receipt !== undefined ||
          !f ||
          (data.phase === "outcome_unknown"
            ? f.code !== "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" ||
              !["native-workspace", "operation-store"].includes(f.source)
            : !failureCodes.has(f.code) || !failureSources.has(f.source))
        )
          throw Error();
      }
      return Object.freeze({
        status:
          data.phase === "completed"
            ? "ok"
            : data.phase === "failed"
              ? "refused"
              : "unknown",
        requestId: current.requestId,
        context: this.context,
        operationId,
        data,
        ...(data.failure
          ? { code: data.failure.code, retry: "never" as const }
          : {}),
      });
    } catch (error) {
      return failure(
        error instanceof BridgeError ? error.state : "unknown",
        error instanceof BridgeError && safeCode(error.code)
          ? error.code
          : "invalid_connector_mutation_response",
      );
    }
  }
}
