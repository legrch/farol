import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";

import {
  CALLER_RELAY_MAX_FRAME_BYTES,
  CALLER_RELAY_PROTOCOL,
  CodexCallerRelayRequestSchema,
  CodexCallerRelayResponseSchema,
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

type OperationRecord = Readonly<{
  fingerprint: string;
  result: Promise<CodexCallerRelayResponse>;
}>;

type ActiveTurn = {
  readonly binding: string;
  readonly expiresAt: number;
  readonly registry: CodexNativeToolRegistry;
  readonly invoke: (request: ResolvedCodexNativeToolCall) => Promise<string>;
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
  ): Promise<CodexCallerRelayResponse> => {
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
    const result = Promise.resolve()
      .then(() => turn.invoke(resolved))
      .then((output): CodexCallerRelayResponse => {
        if (
          typeof output !== "string" ||
          output.length > MAX_OUTPUT_CHARACTERS
        ) {
          return refuse("CALLER_RELAY_OUTPUT_INVALID");
        }
        return {
          ok: true,
          operation: "invoke",
          operationId: request.operationId,
          output,
        };
      })
      .catch(() => refuse("CALLER_RELAY_NATIVE_TOOL_FAILED"))
      .finally(() => {
        if (turn.activeOperationId === request.operationId) {
          turn.activeOperationId = null;
        }
      });
    turn.operations.set(request.operationId, {
      fingerprint: operationFingerprint,
      result,
    });
    return result;
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let handled = false;
    const reply = (response: CodexCallerRelayResponse) => {
      if (socket.destroyed) return;
      const parsed = CodexCallerRelayResponseSchema.parse(response);
      socket.end(`${JSON.stringify(parsed)}\n`);
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
