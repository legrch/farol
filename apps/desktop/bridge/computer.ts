import { BridgeError, type Client } from "./client.ts";
import { frame } from "./frame.ts";
import {
  maxFrameBytes,
  validate,
  validUnicode,
  type Json,
  type Context,
  type Outcome,
  type ComputerCatalogueRequest,
  type ComputerCatalogueResponse,
  type ComputerCatalogueEntry,
  type ComputerCatalogueRefusal,
  type ComputerBootstrapRequest,
  type ComputerBootstrapResponse,
  type ComputerBootstrapRefusal,
  type ComputerInstructionRead,
  type ComputerInstructionMissing,
  type ComputerInstructionUnavailable,
  type ComputerReadRequest,
  type ComputerReadResponse,
  type ComputerReadRefusal,
  type ComputerListRequest,
  type ComputerListResponse,
  type ComputerListRefusal,
} from "./wire.ts";

export type ComputerCall = Readonly<{
  requestId: string;
  context: Context;
  timeoutMs?: number;
}>;
export type ComputerInstruction =
  | ComputerInstructionRead
  | ComputerInstructionMissing
  | ComputerInstructionUnavailable;
export type ComputerCatalogue = Omit<
  ComputerCatalogueResponse,
  "workspaces"
> & {
  readonly workspaces: readonly ComputerCatalogueEntry[];
};
export type ComputerBootstrap = Omit<
  ComputerBootstrapResponse,
  "complete" | "instructions"
> & {
  readonly complete: boolean;
  readonly instructions: readonly ComputerInstruction[];
};
type Refusal =
  | ComputerCatalogueRefusal
  | ComputerBootstrapRefusal
  | ComputerReadRefusal
  | ComputerListRefusal;
export type ComputerList = Omit<ComputerListResponse, "entries"> & {
  readonly entries: readonly string[];
};
export type ComputerResult<T> =
  | Readonly<{ status: "ok"; requestId: string; context: Context; data: T }>
  | Readonly<{
      status: "refused";
      requestId: string;
      context: Context;
      code: string;
      retry: "never";
      refusal?: Refusal;
    }>
  | Readonly<{
      status: "unknown" | "unavailable" | "unsupported";
      requestId: string;
      context: Context;
      code: string;
      retry: "never";
    }>;

const names = {
  catalogue: "ComputerCatalogue",
  bootstrap: "ComputerBootstrap",
  read: "ComputerRead",
  list: "ComputerList",
} as const;

// Snapshot JSON values within the wire budget before recursive schema validation.
// Accessors, custom prototypes, sparse arrays and cycles are not wire JSON.
function snapshot(value: unknown): Json {
  let remaining = maxFrameBytes;
  let nodes = 8192;
  const ancestors = new Set<object>();
  const charge = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw Error("computer_json_bound");
  };
  const visit = (item: unknown, depth: number): Json => {
    if (--nodes < 0 || depth > 32) throw Error("computer_json_bound");
    if (item === null || typeof item === "boolean") {
      charge(5);
      return item;
    }
    if (typeof item === "string") {
      if (item.length > maxFrameBytes || !validUnicode(item))
        throw Error("invalid_computer_json");
      charge(Buffer.byteLength(JSON.stringify(item), "utf8"));
      return item;
    }
    if (
      typeof item === "number" &&
      Number.isFinite(item) &&
      Math.abs(item) <= Number.MAX_SAFE_INTEGER
    ) {
      charge(Buffer.byteLength(String(item), "utf8"));
      return item;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw Error("invalid_computer_json");
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (
      prototype !== (array ? Array.prototype : Object.prototype) &&
      !(prototype === null && !array)
    )
      throw Error("invalid_computer_json");
    const keys = Reflect.ownKeys(item);
    if (keys.length > nodes || keys.some((key) => typeof key !== "string"))
      throw Error("computer_json_bound");
    ancestors.add(item);
    charge(2);
    const result: Json[] | Record<string, Json> = array
      ? []
      : (Object.create(null) as Record<string, Json>);
    if (array && (keys.length !== item.length + 1 || item.length > nodes))
      throw Error("invalid_computer_json");
    for (const key of keys) {
      if (typeof key !== "string" || (array && key === "length")) continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        !validUnicode(key)
      )
        throw Error("invalid_computer_json");
      charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 2);
      const child = visit(descriptor.value as unknown, depth + 1);
      if (Array.isArray(result)) {
        if (key !== String(result.length)) throw Error("invalid_computer_json");
        result.push(child);
      } else result[key] = child;
    }
    ancestors.delete(item);
    return Object.freeze(result);
  };
  return visit(value, 0);
}

function dto<T>(name: string, value: unknown): T {
  if (!validate(name, value)) throw Error("invalid_computer_result");
  return value as T;
}

function catalogue(value: unknown): ComputerCatalogue {
  const data = dto<ComputerCatalogueResponse>(
    "ComputerCatalogueResponse",
    value,
  );
  if (!Array.isArray(data.workspaces) || data.workspaces.length > 32)
    throw Error("invalid_computer_result");
  const entries = data.workspaces.map((entry: unknown) =>
    dto<ComputerCatalogueEntry>("ComputerCatalogueEntry", entry),
  );
  if (
    new Set(entries.map((entry) => entry.workspaceId)).size !== entries.length
  )
    throw Error("invalid_computer_result");
  return Object.freeze({ ...data, workspaces: Object.freeze(entries) });
}

function bootstrap(value: unknown): ComputerBootstrap {
  const data = dto<ComputerBootstrapResponse>(
    "ComputerBootstrapResponse",
    value,
  );
  if (
    typeof data.complete !== "boolean" ||
    !Array.isArray(data.instructions) ||
    data.instructions.length > 33
  )
    throw Error("invalid_computer_result");
  let bytes = 0n;
  const instructions = data.instructions.map(
    (entry: unknown): ComputerInstruction => {
      if (validate("ComputerInstructionRead", entry)) {
        const read = entry as ComputerInstructionRead;
        const length = BigInt(Buffer.byteLength(read.text, "utf8"));
        const count = BigInt(read.bytes);
        if (count !== length && count !== length + 3n)
          throw Error("invalid_computer_result");
        bytes += count;
        return read;
      }
      if (validate("ComputerInstructionMissing", entry))
        return entry as ComputerInstructionMissing;
      return dto<ComputerInstructionUnavailable>(
        "ComputerInstructionUnavailable",
        entry,
      );
    },
  );
  if (
    bytes > 65536n ||
    data.complete !==
      !instructions.some((entry) => entry.status === "unavailable")
  )
    throw Error("invalid_computer_result");
  return Object.freeze({
    ...data,
    complete: data.complete,
    instructions: Object.freeze(instructions),
  });
}

function read(value: unknown): ComputerReadResponse {
  const data = dto<ComputerReadResponse>("ComputerReadResponse", value);
  const bytes = BigInt(data.bytes);
  const length = BigInt(Buffer.byteLength(data.text, "utf8"));
  // Native text may omit the three-byte BOM; counters remain decimal strings.
  if (bytes > 262144n || (bytes !== length && bytes !== length + 3n))
    throw Error("invalid_computer_result");
  return data;
}

function list(value: unknown): ComputerList {
  const data = dto<ComputerListResponse>("ComputerListResponse", value);
  if (!Array.isArray(data.entries) || data.entries.length > 500)
    throw Error("invalid_computer_list");
  const seen = new Set<string>();
  const entries = data.entries.map((entry) => {
    if (typeof entry !== "string" || !validUnicode(entry))
      throw Error("invalid_computer_list");
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (
      !name ||
      name === "." ||
      name === ".." ||
      /[\\/\u0000-\u001f\u007f]/u.test(name) ||
      Buffer.byteLength(name, "utf8") > 255 ||
      seen.has(name)
    )
      throw Error("invalid_computer_list");
    seen.add(name);
    return entry;
  });
  return Object.freeze({ ...data, entries: Object.freeze(entries) });
}

// Caller supplies an already selected, legitimate operation and verified context.
// IDs/text/roots returned here are correlation/data, never positive admission.
// Pick retains the real Client.request signature and permits injected unit transport.
// No handshake, child startup, authority selection, replay or filesystem operation.
export class ComputerBridge {
  constructor(private readonly client: Pick<Client, "request">) {}

  catalogue(
    request: ComputerCatalogueRequest,
    call: ComputerCall,
  ): Promise<ComputerResult<ComputerCatalogue>> {
    return this.invoke("catalogue", request, call, catalogue);
  }
  bootstrap(
    request: ComputerBootstrapRequest,
    call: ComputerCall,
  ): Promise<ComputerResult<ComputerBootstrap>> {
    return this.invoke("bootstrap", request, call, bootstrap);
  }
  read(
    request: ComputerReadRequest,
    call: ComputerCall,
  ): Promise<ComputerResult<ComputerReadResponse>> {
    return this.invoke("read", request, call, read);
  }

  list(
    request: ComputerListRequest,
    call: ComputerCall,
  ): Promise<ComputerResult<ComputerList>> {
    return this.invoke("list", request, call, list);
  }

  private async invoke<T>(
    method: keyof typeof names,
    input: unknown,
    selection: ComputerCall,
    parse: (data: unknown) => T,
  ): Promise<ComputerResult<T>> {
    let body: Json;
    let call: ComputerCall;
    try {
      body = snapshot(input);
      if (!validate(`${names[method]}Request`, body))
        throw Error("invalid_computer_request");
    } catch {
      throw new BridgeError("refused", "invalid_computer_request");
    }
    try {
      const candidate = snapshot(selection);
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).some(
          (key) => !["requestId", "context", "timeoutMs"].includes(key),
        )
      )
        throw Error("invalid_computer_call");
      const selected = candidate as unknown as ComputerCall;
      if (
        !validate("id", selected.requestId) ||
        !validate("Context", selected.context) ||
        (selected.timeoutMs !== undefined &&
          (!Number.isFinite(selected.timeoutMs) ||
            selected.timeoutMs <= 0 ||
            selected.timeoutMs > 30000))
      )
        throw Error("invalid_computer_call");
      call = selected;
    } catch {
      throw new BridgeError("refused", "invalid_computer_call");
    }
    const identity = { requestId: call.requestId, context: call.context };
    const failure = (
      status: "refused" | "unknown" | "unavailable" | "unsupported",
      code: string,
    ): ComputerResult<T> =>
      Object.freeze({ ...identity, status, code, retry: "never" });
    let raw: unknown;
    try {
      raw = await this.client.request(
        `computer.workspace.${method}`,
        body,
        Object.freeze({
          id: call.requestId,
          ...(call.timeoutMs !== undefined
            ? { timeoutMs: call.timeoutMs }
            : {}),
        }),
      );
    } catch (error) {
      if (
        error instanceof BridgeError &&
        ["refused", "unknown", "unavailable", "unsupported"].includes(
          error.state,
        ) &&
        validate("text", error.code)
      )
        return failure(error.state, error.code);
      return failure("unknown", "computer_transport_failed");
    }
    try {
      const result = dto<Outcome>("Outcome", snapshot(raw));
      // Bound the complete response, with its JSON-RPC envelope and escaping.
      frame({ jsonrpc: "2.0", id: call.requestId, result });
      if (
        result.requestId !== call.requestId ||
        result.context.profileId !== call.context.profileId ||
        result.context.backendGeneration !== call.context.backendGeneration ||
        Object.hasOwn(result, "operationId")
      )
        return failure("unknown", "crossed_computer_response");
      if (result.status === "ok") {
        if (Object.hasOwn(result, "code"))
          throw Error("invalid_computer_result");
        const data = parse(result.data);
        if (!matches(body, data, false))
          return failure("unknown", "crossed_computer_response");
        return Object.freeze({ ...identity, status: "ok", data });
      }
      if (!validate("text", result.code))
        throw Error("invalid_computer_result");
      const code = result.code as string;
      if (result.status === "refused" && Object.hasOwn(result, "data")) {
        const refusal = dto<Refusal>(`${names[method]}Refusal`, result.data);
        if (
          refusal.code !== code ||
          (refusal.request !== undefined &&
            !matches(body, refusal.request, true))
        )
          return failure("unknown", "crossed_computer_response");
        return Object.freeze({
          ...identity,
          status: "refused",
          code,
          retry: "never",
          refusal,
        });
      }
      if (Object.hasOwn(result, "data")) throw Error("invalid_computer_result");
      return failure(result.status, code);
    } catch {
      return failure("unknown", "invalid_computer_result");
    }
  }
}

function matches(request: Json, response: unknown, refusal: boolean): boolean {
  const body = request as Record<string, Json>;
  const data = response as Record<string, unknown>;
  return (
    Object.entries(body).every(([key, value]) => {
      if (key !== "range") return data[key] === value;
      if (!refusal) return true;
      const range = data.range as ComputerReadRequest["range"];
      const expected = value as unknown as NonNullable<
        ComputerReadRequest["range"]
      >;
      return (
        range?.offset === expected.offset && range.length === expected.length
      );
    }) &&
    (!refusal || Object.keys(body).length === Object.keys(data).length)
  );
}
