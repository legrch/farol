import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import {
  CALLER_RELAY_MAX_FRAME_BYTES,
  CALLER_RELAY_PROTOCOL,
  CodexCallerRelayRequestSchema,
  CodexCallerRelayWireResponseSchema,
  type CodexCallerRelayReceipt,
  type CodexCallerRelayWireResponse,
  type CodexCallerRelayEndpoint,
  type CodexCallerRelayRequest,
  type CodexCallerRelayResponse,
} from "../../pkg/caller-relay/protocol";
import {
  canonicalJson,
  CodexNativeToolRegistry,
  type CodexNativeToolInventoryEntry,
  type ResolvedCodexNativeToolCall,
} from "./codex-native-tool-registry";

const SOCKET_BASENAME = "caller-relay.sock";
const MAX_ACTIVE_TURNS = 8;
const MAX_OPERATIONS_PER_TURN = 8;
const MAX_OUTPUT_CHARACTERS = 512 * 1_024;
const DEFAULT_TURN_LIFETIME_MS = 15 * 60 * 1_000;

type TurnIdentity = Readonly<{
  sessionId: string;
  threadId: string;
  turnId: string;
  rootTurnId: string;
}>;

// Receipt state belongs to the existing bounded operation record. Unknown is
// sticky; a duplicate request never invokes the trusted callback a second time.
type OperationRecord = {
  fingerprint: string;
  result: Promise<CodexCallerRelayWireResponse>;
  owned: boolean;
  receipt: CodexCallerRelayReceipt | null;
  receiptState: "none" | "pending" | "receiving" | "acknowledged" | "unknown";
  onReceived: CodexCallerRelayOwnedResult["onReceived"] | null;
};
export type CodexCallerRelayInvocation = Readonly<
  Pick<CodexCallerRelayReceipt, "operationId" | "binding" | "requestSHA256">
>;
export type CodexCallerRelayOwnedResult = Readonly<{
  status: "known";
  output: string;
  // Return acknowledged only after the original Go owner reports known Resolve.
  // This callback performs no new tool execution; rejection/unknown is not retried.
  onReceived(
    receipt: Readonly<CodexCallerRelayReceipt>,
  ): Promise<"acknowledged">;
}>;
type OwnedInvoke = (
  request: ResolvedCodexNativeToolCall,
  context: CodexCallerRelayInvocation,
) => Promise<CodexCallerRelayOwnedResult>;

type ActiveTurn = {
  readonly binding: string;
  readonly expiresAt: number;
  readonly registry: CodexNativeToolRegistry;
  readonly invoke: (request: ResolvedCodexNativeToolCall) => Promise<string>;
  readonly invokeOwned: OwnedInvoke | undefined;
  readonly operations: Map<string, OperationRecord>;
  activeOperationId: string | null;
};

export type CodexCallerRelayTurn = Readonly<{
  ticket: string;
  binding: string;
  inventory: readonly CodexNativeToolInventoryEntry[];
  close(): void;
}>;

export type CodexCallerRelayRuntime = Readonly<{
  endpoint: CodexCallerRelayEndpoint;
  openTurn(
    input: Readonly<{
      identity: TurnIdentity;
      tools: readonly unknown[];
      invoke(request: ResolvedCodexNativeToolCall): Promise<string>;
      // Explicit trusted opt-in. When present it is the only selected executor;
      // no legacy invoke or fallback runs for this turn.
      invokeOwned?: OwnedInvoke;
      lifetimeMs?: number;
    }>,
  ): CodexCallerRelayTurn;
  diagnostics(): Readonly<{
    activeTurns: number;
    operations: number;
    refusedRequests: number;
    lastRefusalCode: string | null;
  }>;
  close(): Promise<void>;
}>;

type StartOptions = Readonly<{
  root: string;
  token?: string;
  now?: () => number;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSecret(left: string, right: string): boolean {
  const expected = Buffer.from(left, "utf8");
  const supplied = Buffer.from(right, "utf8");
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

function failed(code: string): CodexCallerRelayResponse {
  return { ok: false, error: { code, retry: "never" } };
}

function safeRoot(root: string): boolean {
  return path.isAbsolute(root) && !root.includes("\0") && root !== "/";
}

async function prepareRoot(root: string): Promise<void> {
  if (!safeRoot(root)) throw new Error("CALLER_RELAY_ROOT_INVALID");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    throw new Error("CALLER_RELAY_ROOT_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await fs.chmod(root, 0o700);
}

async function assertSocketAvailable(socketPath: string): Promise<void> {
  try {
    await fs.lstat(socketPath);
    throw new Error("CALLER_RELAY_SOCKET_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export async function startCodexCallerRelay(
  options: StartOptions,
): Promise<CodexCallerRelayRuntime> {
  const now = options.now ?? Date.now;
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 32 || token.length > 512 || /[\0\r\n]/u.test(token)) {
    throw new Error("CALLER_RELAY_TOKEN_INVALID");
  }
  await prepareRoot(options.root);
  const socketPath = path.join(options.root, SOCKET_BASENAME);
  if (Buffer.byteLength(socketPath) > 100) {
    throw new Error("CALLER_RELAY_SOCKET_PATH_TOO_LONG");
  }
  await assertSocketAvailable(socketPath);

  const turns = new Map<string, ActiveTurn>();
  const sockets = new Set<Socket>();
  let refusedRequests = 0;
  let lastRefusalCode: string | null = null;
  let closed = false;

  const refuse = (code: string): CodexCallerRelayResponse => {
    refusedRequests += 1;
    lastRefusalCode = code;
    return failed(code);
  };

  const dispatch = async (
    request: CodexCallerRelayRequest,
  ): Promise<CodexCallerRelayWireResponse> => {
    if (!sameSecret(token, request.token)) {
      return refuse("CALLER_RELAY_UNAUTHORIZED");
    }
    const key = digest(request.ticket);
    const turn = turns.get(key);
    if (!turn) return refuse("CALLER_RELAY_TICKET_NOT_FOUND");
    if (!sameSecret(turn.binding, request.binding)) {
      return refuse("CALLER_RELAY_BINDING_INVALID");
    }
    if (now() > turn.expiresAt) {
      turns.delete(key);
      return refuse("CALLER_RELAY_TICKET_EXPIRED");
    }
    if (request.operation === "describe") {
      return {
        ok: true,
        operation: "describe",
        catalogue: turn.registry.describe(),
      };
    }

    if (request.operation === "received") {
      const record = turn.operations.get(request.operationId);
      if (!record?.owned || !record.receipt)
        return refuse("CALLER_RELAY_RECEIPT_UNAVAILABLE");
      if (record.receiptState !== "pending")
        return refuse("CALLER_RELAY_RECEIPT_ALREADY_USED");
      const expected = record.receipt;
      if (
        request.binding !== expected.binding ||
        request.operationId !== expected.operationId ||
        request.requestSHA256 !== record.fingerprint ||
        request.requestSHA256 !== expected.requestSHA256 ||
        !sameSecret(request.receiptId, expected.receiptId) ||
        request.outputSHA256 !== expected.outputSHA256 ||
        request.outputBytes !== expected.outputBytes
      ) {
        record.receiptState = "unknown";
        return refuse("CALLER_RELAY_RECEIPT_INVALID");
      }
      // Consume before unlocked callback IO. Duplicate, cancel/close or lost Go
      // acknowledgement can never repeat this original callback or tool effect.
      record.receiptState = "receiving";
      try {
        const outcome = await record.onReceived?.({ ...expected });
        if (
          outcome !== "acknowledged" ||
          closed ||
          turns.get(key) !== turn ||
          now() > turn.expiresAt ||
          turn.operations.get(request.operationId) !== record
        ) {
          record.receiptState = "unknown";
          return refuse("CALLER_RELAY_RECEIPT_UNKNOWN");
        }
        record.receiptState = "acknowledged";
        if (turn.activeOperationId === request.operationId)
          turn.activeOperationId = null;
        return {
          ok: true,
          operation: "received",
          operationId: request.operationId,
          receiptId: expected.receiptId,
        };
      } catch {
        record.receiptState = "unknown";
        return refuse("CALLER_RELAY_RECEIPT_UNKNOWN");
      }
    }

    const operationFingerprint = digest(
      canonicalJson({
        name: request.name,
        namespace: request.namespace,
        arguments: request.arguments,
      }),
    );
    const previous = turn.operations.get(request.operationId);
    if (previous) {
      if (previous.fingerprint !== operationFingerprint) {
        return refuse("CALLER_RELAY_OPERATION_CHANGED");
      }
      if (previous.owned)
        return refuse("CALLER_RELAY_OPERATION_ALREADY_DISPATCHED");
      return previous.result;
    }

    let resolved: ResolvedCodexNativeToolCall;
    try {
      resolved = turn.registry.resolve({
        name: request.name,
        ...(request.namespace === null ? {} : { namespace: request.namespace }),
        arguments: request.arguments,
      });
    } catch (error) {
      const code =
        error instanceof Error && /^CODEX_TOOL_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "CODEX_TOOL_CALL_INVALID";
      return refuse(code);
    }
    if (turn.operations.size >= MAX_OPERATIONS_PER_TURN) {
      return refuse("CALLER_RELAY_OPERATION_LIMIT");
    }
    if (turn.activeOperationId !== null) {
      return refuse("CALLER_RELAY_OPERATION_IN_PROGRESS");
    }
    turn.activeOperationId = request.operationId;
    let record: OperationRecord;
    const result = Promise.resolve()
      .then(async (): Promise<CodexCallerRelayWireResponse> => {
        const context = {
          operationId: request.operationId,
          binding: turn.binding,
          requestSHA256: operationFingerprint,
        };
        // Dispatch queued this original invocation. Recheck withdrawal at the
        // actual callback boundary, before any owned Go effect can start. There
        // is no await between this fence and invoking the selected callback.
        if (
          turn.invokeOwned &&
          (closed ||
            turns.get(key) !== turn ||
            request.binding !== turn.binding ||
            now() > turn.expiresAt ||
            turn.operations.get(request.operationId) !== record ||
            turn.activeOperationId !== request.operationId ||
            record.fingerprint !== operationFingerprint ||
            record.receiptState !== "pending" ||
            !record.owned)
        ) {
          record.receiptState = "unknown";
          return refuse("CALLER_RELAY_RECEIPT_UNKNOWN");
        }
        const owned = turn.invokeOwned
          ? await turn.invokeOwned(resolved, context)
          : null;
        // An owned callback is explicitly selected, never followed by legacy execution.
        const output = turn.invokeOwned
          ? owned?.output
          : await turn.invoke(resolved);
        if (
          typeof output !== "string" ||
          output.length > MAX_OUTPUT_CHARACTERS
        ) {
          if (record.owned) record.receiptState = "unknown";
          return refuse("CALLER_RELAY_OUTPUT_INVALID");
        }
        let receipt: CodexCallerRelayReceipt | null = null;
        if (record.owned) {
          if (
            !owned ||
            owned.status !== "known" ||
            typeof owned.onReceived !== "function" ||
            closed ||
            turns.get(key) !== turn ||
            now() > turn.expiresAt ||
            Buffer.from(output, "utf8").toString("utf8") !== output
          ) {
            record.receiptState = "unknown";
            return refuse("CALLER_RELAY_RECEIPT_UNKNOWN");
          }
          receipt = {
            ...context,
            receiptId: randomBytes(32).toString("hex"),
            outputSHA256: digest(output),
            outputBytes: Buffer.byteLength(output, "utf8"),
          };
        }
        const response: CodexCallerRelayWireResponse = {
          ok: true,
          operation: "invoke",
          operationId: request.operationId,
          output,
          ...(receipt ? { receipt } : {}),
        };
        if (
          Buffer.byteLength(`${JSON.stringify(response)}\n`, "utf8") >
          CALLER_RELAY_MAX_FRAME_BYTES
        ) {
          if (record.owned) record.receiptState = "unknown";
          return refuse("CALLER_RELAY_OUTPUT_TOO_LARGE");
        }
        if (receipt && owned) {
          record.receipt = receipt;
          record.onReceived = owned.onReceived;
        }
        return response;
      })
      .catch(() => {
        if (record.owned) record.receiptState = "unknown";
        return refuse("CALLER_RELAY_NATIVE_TOOL_FAILED");
      })
      .finally(() => {
        // Owned work remains outstanding until the actual parsed-peer receipt
        // AND known original Go callback settlement, not a queued socket write.
        if (!record.owned && turn.activeOperationId === request.operationId)
          turn.activeOperationId = null;
      });
    record = {
      fingerprint: operationFingerprint,
      result,
      owned: turn.invokeOwned !== undefined,
      receipt: null,
      receiptState: turn.invokeOwned ? "pending" : "none",
      onReceived: null,
    };
    turn.operations.set(request.operationId, record);
    return result;
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let handled = false;
    const reply = (response: CodexCallerRelayWireResponse) => {
      if (socket.destroyed) return;
      const parsed = CodexCallerRelayWireResponseSchema.parse(response);
      const encoded = `${JSON.stringify(parsed)}\n`;
      if (Buffer.byteLength(encoded, "utf8") > CALLER_RELAY_MAX_FRAME_BYTES) {
        socket.end(
          `${JSON.stringify(
            CodexCallerRelayWireResponseSchema.parse(
              refuse("CALLER_RELAY_RESPONSE_TOO_LARGE"),
            ),
          )}\n`,
        );
        return;
      }
      socket.end(encoded);
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CALLER_RELAY_MAX_FRAME_BYTES) {
        handled = true;
        reply(refuse("CALLER_RELAY_REQUEST_TOO_LARGE"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      socket.pause();
      if (
        buffer
          .subarray(newline + 1)
          .toString("utf8")
          .trim().length > 0
      ) {
        reply(refuse("CALLER_RELAY_REQUEST_INVALID"));
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        reply(refuse("CALLER_RELAY_REQUEST_INVALID"));
        return;
      }
      const parsed = CodexCallerRelayRequestSchema.safeParse(raw);
      if (!parsed.success) {
        reply(refuse("CALLER_RELAY_REQUEST_INVALID"));
        return;
      }
      void dispatch(parsed.data).then(reply, () =>
        reply(refuse("CALLER_RELAY_FAILED")),
      );
    });
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => sockets.delete(socket));
  });

  server.listen(socketPath);
  try {
    await Promise.race([
      once(server, "listening"),
      once(server, "error").then(([error]) => Promise.reject(error)),
    ]);
    await fs.chmod(socketPath, 0o600);
  } catch {
    server.close();
    await fs.rm(socketPath, { force: true }).catch(() => undefined);
    throw new Error("CALLER_RELAY_BIND_FAILED");
  }

  const endpoint: CodexCallerRelayEndpoint = {
    protocol: CALLER_RELAY_PROTOCOL,
    socketPath,
    token,
  };
  return {
    endpoint,
    openTurn: (input) => {
      if (closed) throw new Error("CALLER_RELAY_CLOSED");
      if (turns.size >= MAX_ACTIVE_TURNS) {
        throw new Error("CALLER_RELAY_BUSY");
      }
      const lifetimeMs = input.lifetimeMs ?? DEFAULT_TURN_LIFETIME_MS;
      if (
        !Number.isSafeInteger(lifetimeMs) ||
        lifetimeMs < 1 ||
        lifetimeMs > DEFAULT_TURN_LIFETIME_MS
      ) {
        throw new Error("CALLER_RELAY_TURN_OPTIONS_INVALID");
      }
      const registry = CodexNativeToolRegistry.parse(input.tools);
      const ticket = randomBytes(32).toString("hex");
      const key = digest(ticket);
      const binding = digest(
        canonicalJson({
          identity: input.identity,
          catalogue: registry.fingerprint,
          ticket: key,
        }),
      );
      const turn: ActiveTurn = {
        binding,
        expiresAt: now() + lifetimeMs,
        registry,
        invoke: input.invoke,
        invokeOwned: input.invokeOwned,
        operations: new Map(),
        activeOperationId: null,
      };
      turns.set(key, turn);
      let turnClosed = false;
      return {
        ticket,
        binding,
        inventory: registry.inventory(),
        close: () => {
          if (turnClosed) return;
          turnClosed = true;
          if (turns.get(key) === turn) turns.delete(key);
        },
      };
    },
    diagnostics: () => ({
      activeTurns: turns.size,
      operations: [...turns.values()].reduce(
        (count, turn) => count + turn.operations.size,
        0,
      ),
      refusedRequests,
      lastRefusalCode,
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      turns.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      await fs.rm(socketPath, { force: true }).catch(() => undefined);
    },
  };
}
