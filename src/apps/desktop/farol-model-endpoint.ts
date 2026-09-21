import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { FarolModelRuntimeState } from "./farol-model-runtime-state";

// An OpenAI-compatible Responses API surface on 127.0.0.1, owned by this
// process. See Decisions.md N04. It starts and stops with the app: no
// LaunchAgent, no daemon, no autospawn, and it never listens on anything but
// loopback. The turn itself is delegated to an injected handler so this
// module stays independent of the specific product route that answers a
// model turn today; `routeBModelTurnHandler` below is the production one.
//
// Request pipeline, in this order and with no route dispatched before the
// caller is authenticated:
//   1. peer must be loopback                          → 403, anonymous body
//   2. no `Origin` header (a Codex host never sends one; a browser always
//      does)                                          → 403, anonymous body
//   2a. not sealed (S35-TA-2)                         → 401, anonymous body
//   3. bearer token, compared in constant time        → 401, anonymous body
//   4. route: POST /responses or GET /farol-model/identity → 404
//   5. body bounded at 1 MiB, refused while it is still arriving → 413
//   6. `model` must be the one model this endpoint serves → 422
//   7. the turn handler
// "Anonymous body" means a caller that has not authenticated sees no
// FAROL_* code, only a generic status, so a port scan cannot fingerprint
// Farol; the precise reason is kept in `evidence()` for the owner.

/** One SSE frame of an OpenAI Responses API stream. */
export type FarolModelSseEvent = Readonly<{
  event: string;
  data: unknown;
}>;

export type FarolModelTurnRequest = Readonly<{
  body: unknown;
  headers: Readonly<Record<string, string | undefined>>;
}>;

export type FarolModelTurnOutcome =
  | Readonly<{ ok: true; events: readonly FarolModelSseEvent[] }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Serves one model turn. Returns `{ ok: false }` — never throws — when the
 * product's existing turn route is unavailable; the endpoint turns that into
 * a precise, content-free HTTP error rather than leaking why.
 */
export type FarolModelTurnHandler = (
  request: FarolModelTurnRequest,
) => Promise<FarolModelTurnOutcome>;

const unavailableHandler: FarolModelTurnHandler = async () => ({
  ok: false,
  reason: "FAROL_MODEL_ROUTE_UNAVAILABLE",
});

export const FAROL_MODEL_RESPONSES_PATH = "/responses";
/** Authenticated identity probe: answers this endpoint's own instance nonce. */
export const FAROL_MODEL_IDENTITY_PATH = "/farol-model/identity";
export const FAROL_MODEL_MAX_BODY_BYTES = 1024 * 1024;
export const FAROL_MODEL_PRODUCT = "farol-model";

/** What `GET /farol-model/identity` answers to an authenticated caller. */
export type FarolModelIdentity = Readonly<{
  product: typeof FAROL_MODEL_PRODUCT;
  /** Fresh per endpoint instance; never persisted. */
  instance: string;
  pid: number;
  port: number;
}>;

export function isFarolModelIdentity(
  value: unknown,
): value is FarolModelIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.product === FAROL_MODEL_PRODUCT &&
    typeof candidate.instance === "string" &&
    candidate.instance.length > 0 &&
    typeof candidate.pid === "number" &&
    typeof candidate.port === "number"
  );
}

/** The already-running Route B provider this endpoint reaches as a client. */
export type RouteBModelEndpointTarget = Readonly<{
  baseUrl: string;
  token: string;
}>;

/**
 * Builds the endpoint's real production handler: an ordinary loopback HTTP
 * client of the product's own Route B provider (`startRouteBRuntime`), which
 * already implements the real chat-turn route — `RouteBAdmission`, the
 * task's `RouteBConversationSurface.runReadonlyTask`, and the tool relay —
 * behind its own OpenAI-compatible `/v1/responses` surface. This handler
 * never reimplements that machinery; it forwards the request body once, with
 * the provider's own internal token (never the caller's), and relays back
 * whatever the provider answers.
 *
 * Because it is the same running provider instance the product's own
 * internally-launched host also talks to, admission is not merely "the same
 * way" — it is the exact same `RouteBAdmission`, so a turn on a thread
 * admitted from either entry point refuses the other with
 * `ROUTE_B_THREAD_BUSY`, delivered exactly as the provider already renders
 * it: a `response.failed` SSE frame, never a queued second submission.
 *
 * `target` is read once per request (not captured at construction) because
 * the runtime starts after this endpoint does and can also close before it;
 * `target() === null` — runtime not started yet, or already closed — answers
 * `FAROL_MODEL_ROUTE_UNAVAILABLE`, matching the pre-wiring default exactly.
 * Exactly one fetch is attempted; a network failure, a body that fails
 * mid-read, or a non-2xx upstream answer is surfaced once, never retried and
 * never queued.
 */
export function routeBModelTurnHandler(
  target: () => RouteBModelEndpointTarget | null,
): FarolModelTurnHandler {
  return async (request) => {
    const upstream = target();
    if (!upstream) {
      return { ok: false, reason: "FAROL_MODEL_ROUTE_UNAVAILABLE" };
    }
    let response: Response;
    try {
      response = await fetch(`${upstream.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${upstream.token}`,
        },
        body: JSON.stringify(request.body ?? {}),
      });
    } catch {
      // No retry: the caller sees one truthful, content-free refusal.
      return { ok: false, reason: "FAROL_MODEL_ROUTE_UNREACHABLE" };
    }
    // S35-H2-2: a body that fails mid-read is not an empty body. Treating
    // it as one turned a 200 whose stream died into a successful SSE
    // response carrying no events at all — an answer the provider never
    // gave, counted as a served request. The read failing is exactly the
    // unreachable case: one truthful refusal, still no retry.
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, reason: "FAROL_MODEL_ROUTE_UNREACHABLE" };
    }
    if (!response.ok) {
      return { ok: false, reason: routeRefusalCode(response.status, text) };
    }
    // A 200 body may itself carry a `response.failed` frame (a refusal or an
    // `outcome_unknown` turn the provider already rendered) — relayed as-is,
    // never reinterpreted, so nothing here invents a certainty the route did
    // not report.
    return { ok: true, events: parseSseEvents(text) };
  };
}

function routeRefusalCode(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    if (typeof parsed.error?.code === "string") return parsed.error.code;
  } catch {
    // Falls through to the generic, content-free code below.
  }
  return `FAROL_MODEL_ROUTE_REFUSED_${status}`;
}

function parseSseEvents(text: string): FarolModelSseEvent[] {
  const events: FarolModelSseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let event: string | undefined;
    let rawData: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) rawData = line.slice("data: ".length);
    }
    if (event === undefined || rawData === undefined) continue;
    try {
      events.push({ event, data: JSON.parse(rawData) });
    } catch {
      events.push({ event, data: rawData });
    }
  }
  return events;
}

export type FarolModelEndpointEvidence = Readonly<{
  requestsAccepted: number;
  requestsRejected: number;
  lastAcceptedAtIso: string | undefined;
  lastRejectedReason: string | undefined;
}>;

/**
 * Bounds on how long a client may take to deliver a request. They cover the
 * request only — headers and body — never the time a model turn takes to
 * answer, so a slow turn is unaffected while a half-open connection cannot
 * hold a slot indefinitely.
 */
export type FarolModelEndpointTimeouts = Readonly<{
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** How often Node sweeps connections for the two timeouts above. */
  connectionsCheckingIntervalMs?: number;
}>;

export type FarolModelEndpointOptions = Readonly<{
  state: FarolModelRuntimeState;
  /** The one model this endpoint serves; any other `model` is refused (422). */
  model: string;
  handler?: FarolModelTurnHandler;
  /** Host loopback address to bind; defaults to 127.0.0.1 (IPv4 only). */
  host?: string;
  timeouts?: FarolModelEndpointTimeouts;
  /** Request-body bound in bytes; defaults to 1 MiB. */
  maxBodyBytes?: number;
}>;

export class FarolModelEndpointPortConflictError extends Error {
  constructor(readonly port: number) {
    super(`FAROL_MODEL_ENDPOINT_PORT_CONFLICT:${port}`);
  }
}

const DEFAULT_TIMEOUTS: Required<FarolModelEndpointTimeouts> = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  connectionsCheckingIntervalMs: 5_000,
};

/** How long a refused, still-arriving body is drained before the connection drops. */
const BODY_LINGER_MS = 2_000;

type BodyRead =
  | Readonly<{ ok: true; raw: string }>
  | Readonly<{ ok: false; reason: "too_large" | "aborted" }>;

/**
 * The loopback endpoint. `start()` binds the persisted port when one is
 * recorded (a conflict is reported, never silently moved onto another
 * port); with no persisted port yet, it binds an ephemeral one and persists
 * the choice for reuse across launches.
 */
export class FarolModelEndpoint {
  private readonly state: FarolModelRuntimeState;
  private readonly model: string;
  private readonly handler: FarolModelTurnHandler;
  private readonly host: string;
  private readonly timeouts: Required<FarolModelEndpointTimeouts>;
  private readonly maxBodyBytes: number;
  /** Identifies this exact endpoint instance to an authenticated prober. */
  readonly instanceNonce: string = randomBytes(16).toString("hex");
  private server: ReturnType<typeof http.createServer> | undefined;
  private boundPort: number | undefined;
  // S35-TA-2: the terminal fail-closed state. Set in memory, with no I/O
  // that can fail, the instant a caller decides this endpoint must accept
  // nothing — before any attempt to close the listener, because closing
  // can itself fail and would otherwise leave the endpoint serving a
  // literal nobody can account for. Nothing clears it; a sealed endpoint
  // is finished.
  private sealed = false;
  // Why the rollback of a failed start did not finish, when it did not.
  // Set once, never cleared: the endpoint is sealed either way, so this
  // records an outstanding obligation rather than a reason to retry.
  private startFailureCleanupError: Error | undefined;
  private requestsAccepted = 0;
  private requestsRejected = 0;
  private lastAcceptedAtIso: string | undefined;
  private lastRejectedReason: string | undefined;

  constructor(options: FarolModelEndpointOptions) {
    if (options.model.length === 0) {
      throw new Error("FAROL_MODEL_ENDPOINT_MODEL_REQUIRED");
    }
    this.state = options.state;
    this.model = options.model;
    this.handler = options.handler ?? unavailableHandler;
    this.host = options.host ?? "127.0.0.1";
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.maxBodyBytes = options.maxBodyBytes ?? FAROL_MODEL_MAX_BODY_BYTES;
    if (this.timeouts.headersTimeoutMs > this.timeouts.requestTimeoutMs) {
      throw new Error("FAROL_MODEL_ENDPOINT_TIMEOUTS_INVALID");
    }
  }

  get port(): number | undefined {
    return this.boundPort;
  }

  /**
   * Refuses every request from this moment on, synchronously and without
   * touching the filesystem. The caller uses this when it can no longer
   * guarantee what the token file holds: whatever that file now carries,
   * and whether or not the listener can be closed afterwards, nothing
   * authenticates against this endpoint again.
   */
  seal(): void {
    this.sealed = true;
  }

  /** Whether `seal()` has been called. Never returns to false. */
  get isSealed(): boolean {
    return this.sealed;
  }

  /**
   * The cleanup a failed start could not complete, when the rollback's own
   * close or liveness clear rejected. Undefined whenever startup succeeded
   * or its rollback finished; the endpoint is sealed in every failed case.
   */
  get failedStartCleanupError(): Error | undefined {
    return this.startFailureCleanupError;
  }

  /** The one model this endpoint serves. */
  get servedModel(): string {
    return this.model;
  }

  evidence(): FarolModelEndpointEvidence {
    return {
      requestsAccepted: this.requestsAccepted,
      requestsRejected: this.requestsRejected,
      lastAcceptedAtIso: this.lastAcceptedAtIso,
      lastRejectedReason: this.lastRejectedReason,
    };
  }

  async start(): Promise<Readonly<{ port: number }>> {
    // S35-TA-2: a sealed endpoint is not restartable. Binding again would
    // put the poisoned token back into service under a fresh socket.
    if (this.sealed) throw new Error("FAROL_MODEL_ENDPOINT_SEALED");
    if (this.server) {
      return { port: this.expectPort() };
    }
    await this.state.ensureToken();
    const persisted = await this.state.persistedPort();
    const port = await this.bind(persisted ?? 0);
    // Ownership begins with the listener, not with the last durable step.
    // Everything after `bind` therefore leaves through the rollback below,
    // because a socket this method opened and then walked away from would
    // go on serving turns for an endpoint no caller retained, no status
    // reported as running, and nothing could stop.
    this.boundPort = port;
    try {
      if (persisted === undefined) await this.state.persistPort(port);
      await this.state.markLive({
        pid: process.pid,
        port,
        startedAtIso: new Date().toISOString(),
      });
    } catch (error) {
      await this.abandonStartedListener();
      throw error;
    }
    return { port };
  }

  /**
   * Give up a listener whose startup never committed.
   *
   * The seal comes first and cannot fail, so from this instant the endpoint
   * refuses every request whether or not the socket can still be closed.
   * The close is then attempted; one that fails is recorded on
   * `failedStartCleanupError` rather than swallowed, and the caller still
   * receives the startup failure, which is the one it can act on. A sealed
   * endpoint is finished, so this instance is never started again.
   */
  private async abandonStartedListener(): Promise<void> {
    this.seal();
    try {
      await this.stop();
    } catch (error) {
      this.startFailureCleanupError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Resolves only once the server has actually stopped listening; a close
   * that fails rejects and leaves this endpoint still holding its server,
   * rather than reporting a stop that did not happen. In-flight requests
   * are allowed to finish, as they always were — only idle connections are
   * closed underneath them.
   *
   * S35-TA-2: a caller that needs a guarantee rather than best effort
   * seals the endpoint first. `stop()` rejecting then costs nothing,
   * because a sealed endpoint refuses every request whether or not its
   * socket is still bound.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.boundPort = undefined;
    await this.state.clearLiveness();
  }

  private expectPort(): number {
    if (this.boundPort === undefined) {
      throw new Error("FAROL_MODEL_ENDPOINT_NOT_STARTED");
    }
    return this.boundPort;
  }

  private async bind(requestedPort: number): Promise<number> {
    const server = http.createServer(
      {
        requestTimeout: this.timeouts.requestTimeoutMs,
        headersTimeout: this.timeouts.headersTimeoutMs,
        connectionsCheckingInterval:
          this.timeouts.connectionsCheckingIntervalMs,
      },
      (request, response) => {
        this.handleRequest(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error) => reject(error));
        server.listen(requestedPort, this.host, () => resolve());
      });
    } catch (error) {
      server.removeAllListeners();
      if (
        requestedPort !== 0 &&
        (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ) {
        throw new FarolModelEndpointPortConflictError(requestedPort);
      }
      throw error;
    }
    server.removeAllListeners("error");
    server.on("error", () => undefined);
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const remote = request.socket.remoteAddress;
    if (!isLoopbackAddress(remote)) {
      this.refuseAnonymously(response, 403, "FAROL_MODEL_NON_LOOPBACK");
      return;
    }
    if (request.headers.origin !== undefined) {
      this.refuseAnonymously(response, 403, "FAROL_MODEL_ORIGIN_PRESENT");
      return;
    }
    // S35-TA-2: before the token file is even read. Whatever it holds, a
    // sealed endpoint accepts nothing, and it refuses through exactly the
    // path an endpoint with no token at all uses — same status, same
    // anonymous body, no extra work for an unauthenticated caller to time.
    if (this.sealed) {
      this.refuseAnonymously(response, 401, "FAROL_MODEL_SEALED");
      return;
    }
    const token = await this.state.currentToken();
    if (token === undefined) {
      this.refuseAnonymously(response, 401, "FAROL_MODEL_TOKEN_UNSET");
      return;
    }
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      this.refuseAnonymously(response, 401, "FAROL_MODEL_TOKEN_MISSING");
      return;
    }
    if (!bearerMatches(authorization, token)) {
      this.refuseAnonymously(response, 401, "FAROL_MODEL_TOKEN_INVALID");
      return;
    }

    // Authenticated from here on: codes may name Farol.
    const url = request.url ?? "";
    if (request.method === "GET" && url === FAROL_MODEL_IDENTITY_PATH) {
      const identity: FarolModelIdentity = {
        product: FAROL_MODEL_PRODUCT,
        instance: this.instanceNonce,
        pid: process.pid,
        port: this.expectPort(),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(identity));
      return;
    }
    if (request.method !== "POST" || url !== FAROL_MODEL_RESPONSES_PATH) {
      this.reject(response, 404, "FAROL_MODEL_ROUTE_NOT_FOUND");
      return;
    }

    const body = await this.readBody(request);
    if (!body.ok) {
      if (body.reason === "too_large") {
        // Refused while the body is still arriving. The rest of it is
        // drained, never buffered, for a bounded moment so the 413 reaches a
        // peer that is mid-upload instead of being pre-empted by the TCP
        // reset an immediate close would cause; then the connection drops.
        this.reject(response, 413, "FAROL_MODEL_BODY_TOO_LARGE");
        this.lingerThenClose(request);
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = body.raw.length === 0 ? undefined : JSON.parse(body.raw);
    } catch {
      this.reject(response, 400, "FAROL_MODEL_BODY_INVALID");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { model?: unknown }).model !== this.model
    ) {
      this.reject(response, 422, "FAROL_MODEL_MODEL_MISMATCH", {
        expected_model: this.model,
        message: `This Farol Model endpoint serves only model ${JSON.stringify(this.model)}; the Farol-managed selection in config.toml sets it.`,
      });
      return;
    }

    const outcome = await this.handler({
      body: parsed,
      headers: flattenHeaders(request.headers),
    });
    if (!outcome.ok) {
      this.reject(response, 502, outcome.reason);
      return;
    }

    this.requestsAccepted += 1;
    this.lastAcceptedAtIso = new Date().toISOString();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const frame of outcome.events) {
      response.write(`event: ${frame.event}\n`);
      response.write(`data: ${JSON.stringify(frame.data)}\n\n`);
    }
    response.end();
  }

  /**
   * Buffers the request body up to `maxBodyBytes`. The bound is checked on
   * the declared length first and then on every chunk, so an oversized
   * body is refused as soon as it crosses the line, not after it has all
   * been read into memory.
   */
  private readBody(request: IncomingMessage): Promise<BodyRead> {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      return Promise.resolve({ ok: false, reason: "too_large" });
    }
    return new Promise<BodyRead>((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const settle = (value: BodyRead) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      request.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          chunks.length = 0;
          settle({ ok: false, reason: "too_large" });
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () =>
        settle({ ok: true, raw: Buffer.concat(chunks).toString("utf8") }),
      );
      request.on("error", () => settle({ ok: false, reason: "aborted" }));
      request.on("close", () => settle({ ok: false, reason: "aborted" }));
    });
  }

  /**
   * After an early refusal of a body still in flight: keep reading and
   * discarding what the client sends until its body ends or the linger
   * bound passes, then drop the connection. Nothing read here is kept.
   */
  private lingerThenClose(request: IncomingMessage): void {
    const close = () => {
      clearTimeout(timer);
      request.socket.destroy();
    };
    const timer = setTimeout(close, BODY_LINGER_MS);
    timer.unref();
    if (request.readableEnded || request.complete) {
      close();
      return;
    }
    request.once("end", close);
    request.once("close", () => clearTimeout(timer));
    request.resume();
  }

  /** A refusal an authenticated caller may read: a stable FAROL_* code. */
  private reject(
    response: ServerResponse,
    status: number,
    reason: string,
    detail?: Readonly<Record<string, string>>,
  ) {
    this.requestsRejected += 1;
    this.lastRejectedReason = reason;
    // Content-free beyond the code: never upstream detail.
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: { code: reason, ...(detail ?? {}) } }),
    );
  }

  /**
   * A refusal for a caller that has not authenticated. The body names no
   * product and no FAROL_* code; the reason is recorded for `evidence()`
   * only.
   */
  private refuseAnonymously(
    response: ServerResponse,
    status: 401 | 403,
    reason: string,
  ) {
    this.requestsRejected += 1;
    this.lastRejectedReason = reason;
    response.writeHead(status, {
      "content-type": "application/json",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    });
    response.end(
      JSON.stringify({
        error: { code: status === 401 ? "unauthorized" : "forbidden" },
      }),
    );
  }
}

/** Constant-time bearer comparison; digesting first hides the length too. */
function bearerMatches(authorization: string, token: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const presented = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(expected, presented);
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
