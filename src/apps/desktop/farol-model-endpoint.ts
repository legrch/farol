import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { FarolModelRuntimeState } from "./farol-model-runtime-state";

// An OpenAI-compatible Responses API surface on 127.0.0.1, owned by this
// process. See Decisions.md N04. It starts and stops with the app: no
// LaunchAgent, no daemon, no autospawn, and it never listens on anything but
// loopback. The turn itself is delegated to an injected handler so this
// module stays independent of the specific product route that answers a
// model turn today; wiring the real route is a separate, named follow-up
// (see the worker report for packet N04).

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
 * Exactly one fetch is attempted; a network failure or a non-2xx upstream
 * answer is surfaced once, never retried and never queued.
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
    const text = await response.text().catch(() => "");
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

export type FarolModelEndpointOptions = Readonly<{
  state: FarolModelRuntimeState;
  handler?: FarolModelTurnHandler;
  /** Host loopback address to bind; defaults to 127.0.0.1 (IPv4 only). */
  host?: string;
}>;

export class FarolModelEndpointPortConflictError extends Error {
  constructor(readonly port: number) {
    super(`FAROL_MODEL_ENDPOINT_PORT_CONFLICT:${port}`);
  }
}

/**
 * The loopback endpoint. `start()` binds the persisted port when one is
 * recorded (a conflict is reported, never silently moved onto another
 * port); with no persisted port yet, it binds an ephemeral one and persists
 * the choice for reuse across launches.
 */
export class FarolModelEndpoint {
  private readonly state: FarolModelRuntimeState;
  private readonly handler: FarolModelTurnHandler;
  private readonly host: string;
  private server: ReturnType<typeof http.createServer> | undefined;
  private boundPort: number | undefined;
  private requestsAccepted = 0;
  private requestsRejected = 0;
  private lastAcceptedAtIso: string | undefined;
  private lastRejectedReason: string | undefined;

  constructor(options: FarolModelEndpointOptions) {
    this.state = options.state;
    this.handler = options.handler ?? unavailableHandler;
    this.host = options.host ?? "127.0.0.1";
  }

  get port(): number | undefined {
    return this.boundPort;
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
    if (this.server) {
      return { port: this.expectPort() };
    }
    await this.state.ensureToken();
    const persisted = await this.state.persistedPort();
    const port = await this.bind(persisted ?? 0);
    if (persisted === undefined) await this.state.persistPort(port);
    this.boundPort = port;
    await this.state.markLive({
      pid: process.pid,
      port,
      startedAtIso: new Date().toISOString(),
    });
    return { port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.boundPort = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await this.state.clearLiveness();
  }

  private expectPort(): number {
    if (this.boundPort === undefined) {
      throw new Error("FAROL_MODEL_ENDPOINT_NOT_STARTED");
    }
    return this.boundPort;
  }

  private async bind(requestedPort: number): Promise<number> {
    const server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
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
      this.reject(response, 403, "FAROL_MODEL_NON_LOOPBACK");
      return;
    }
    if (request.method !== "POST" || request.url !== "/responses") {
      this.reject(response, 404, "FAROL_MODEL_ROUTE_NOT_FOUND");
      return;
    }
    const token = await this.state.currentToken();
    if (token === undefined) {
      this.reject(response, 401, "FAROL_MODEL_TOKEN_UNSET");
      return;
    }
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      this.reject(response, 401, "FAROL_MODEL_TOKEN_MISSING");
      return;
    }
    if (authorization !== `Bearer ${token}`) {
      this.reject(response, 401, "FAROL_MODEL_TOKEN_INVALID");
      return;
    }

    const body = await readJsonBody(request);
    const outcome = await this.handler({
      body,
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

  private reject(response: ServerResponse, status: number, reason: string) {
    this.requestsRejected += 1;
    this.lastRejectedReason = reason;
    // Content-free: the reason is a stable code, never upstream detail.
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: reason } }));
  }
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
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
