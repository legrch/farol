import {
  FAROL_MODEL_IDENTITY_PATH,
  FarolModelEndpoint,
  FarolModelEndpointPortConflictError,
  isFarolModelIdentity,
  type FarolModelEndpointTimeouts,
  type FarolModelTurnHandler,
} from "./farol-model-endpoint";
import type {
  FarolModelConfigApplyResult,
  FarolModelConfigPreview,
  FarolModelProviderSpec,
} from "./farol-model-config-block";
import { FarolModelRuntimeState } from "./farol-model-runtime-state";

// Owns the Farol Model endpoint's app-level lifecycle. See Decisions.md
// N04, item 1: the endpoint starts with the app and stops with the app —
// no LaunchAgent, no daemon, and nothing ever autospawns it on a request
// from a host that finds it not listening. When the app is not running,
// `start()` was simply never called: a connecting host gets an ordinary
// connection failure on the persisted port, and Farol's own UI reads
// `status()` to say the endpoint is not running rather than guessing from
// a stale file.
//
// A port conflict at `start()` is recorded as a readable status — never a
// silent rebind onto a different port, and never a thrown error that would
// abort the rest of the app's own startup sequence. `checkStatus()` then
// says what holds the port: another Farol answering the authenticated
// identity probe with this product's token, something that is not this
// Farol, or nothing any more.

/**
 * What `checkStatus()` found on a conflicting port. `unprobed` — nothing
 * has looked yet; `farol` — another Farol Model endpoint sharing this
 * state root answered the identity probe with this token; `foreign` —
 * something answered, or held the connection, but not as this Farol;
 * `vacated` — the port refused the connection, so whatever held it at
 * start is gone.
 */
export type FarolModelPortOccupant =
  "unprobed" | "farol" | "foreign" | "vacated";

export type FarolModelLifecycleStatus =
  | Readonly<{ state: "not_running" }>
  | Readonly<{
      state: "port_conflict";
      port: number;
      occupant: FarolModelPortOccupant;
    }>
  | Readonly<{
      state: "listening" | "connected";
      port: number;
      requestsServed: number;
      lastAcceptedAtIso: string | undefined;
    }>;

export type FarolModelLifecycleOptions = Readonly<{
  /** Private state root: token, persisted port, liveness marker. */
  stateRoot: string;
  /** The one model the endpoint serves (the Route B model). */
  model: string;
  handler?: FarolModelTurnHandler;
  /** Host loopback address to bind; defaults to 127.0.0.1 (IPv4 only). */
  host?: string;
  timeouts?: FarolModelEndpointTimeouts;
  /** How long the identity probe waits for a conflicting port; default 1500 ms. */
  probeTimeoutMs?: number;
}>;

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

/** What `rotateAndRewrite` reports about the managed Codex config block. */
export type FarolModelBlockStatus =
  | FarolModelConfigPreview["status"]
  | FarolModelConfigApplyResult["status"]
  | "not_present";

export type FarolModelRotateOutcome =
  | Readonly<{
      ok: true;
      providerBlockUpdated: boolean;
      providerBlockStatus: FarolModelBlockStatus;
    }>
  | Readonly<{
      ok: false;
      code:
        "MODEL_ENDPOINT_UNAVAILABLE" | "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED";
      providerBlockStatus?: FarolModelBlockStatus;
    }>;

/**
 * Everything `rotateAndRewrite` needs from outside itself: where the
 * owner's Codex config lives, how to describe this endpoint right now
 * (`spec` is read twice, because the token it carries changes underneath),
 * and the two config-block operations. Injected rather than imported so
 * the orchestration can be driven without a running Electron app.
 */
export type FarolModelRotatePorts = Readonly<{
  configPath: string;
  spec: () => Promise<FarolModelProviderSpec | null>;
  preview: (
    configPath: string,
    spec: FarolModelProviderSpec,
  ) => Promise<FarolModelConfigPreview>;
  apply: (
    configPath: string,
    spec: FarolModelProviderSpec,
  ) => Promise<FarolModelConfigApplyResult>;
}>;

// The block states a rotation may proceed over: absent, or present in a
// shape this product can rewrite. `symlink`, `malformed`, `conflict` and
// `insecure_permissions` are the states that used to be skipped silently.
const REWRITABLE: ReadonlySet<string> = new Set([
  "not_present",
  "install",
  "update",
  "noop",
]);

export class FarolModelLifecycle {
  private readonly state: FarolModelRuntimeState;
  private readonly options: FarolModelLifecycleOptions;
  private endpointInstance: FarolModelEndpoint | undefined;
  private portConflict: number | undefined;
  private occupant: FarolModelPortOccupant = "unprobed";

  constructor(options: FarolModelLifecycleOptions) {
    this.options = options;
    this.state = new FarolModelRuntimeState(options.stateRoot);
  }

  /** The private runtime state this lifecycle owns (token, persisted port). */
  get runtimeState(): FarolModelRuntimeState {
    return this.state;
  }

  /** The live endpoint once `start()` has succeeded — absent on a port conflict. */
  get endpoint(): FarolModelEndpoint | undefined {
    return this.endpointInstance;
  }

  /**
   * Starts the endpoint on the persisted port (or binds and persists a
   * fresh one on first run). A port already held by something else is
   * recorded via `status()` as `port_conflict` rather than thrown — the
   * caller's own startup sequence continues either way. Calling `start()`
   * again while already running is a no-op.
   */
  async start(): Promise<void> {
    if (this.endpointInstance) return;
    const endpoint = new FarolModelEndpoint({
      state: this.state,
      model: this.options.model,
      ...(this.options.handler ? { handler: this.options.handler } : {}),
      ...(this.options.host ? { host: this.options.host } : {}),
      ...(this.options.timeouts ? { timeouts: this.options.timeouts } : {}),
    });
    try {
      await endpoint.start();
    } catch (error) {
      if (error instanceof FarolModelEndpointPortConflictError) {
        this.portConflict = error.port;
        this.occupant = "unprobed";
        return;
      }
      throw error;
    }
    this.portConflict = undefined;
    this.occupant = "unprobed";
    this.endpointInstance = endpoint;
  }

  /** Stops the endpoint and clears its liveness marker. A no-op when not running. */
  async stop(): Promise<void> {
    const endpoint = this.endpointInstance;
    this.endpointInstance = undefined;
    if (!endpoint) return;
    await endpoint.stop();
  }

  /**
   * Mints a fresh token; the previous one stops authenticating with the
   * very next request, because the endpoint reads the token per request.
   * A config block that carries the old literal must be re-applied by the
   * caller (the block apply is idempotent and rewrites in place).
   *
   * Prefer `rotateAndRewrite` for the owner-facing rotation: rotating on
   * its own, while an installed block carries the old literal, is exactly
   * the state this product must not leave behind.
   */
  async rotateToken(): Promise<string> {
    return this.state.rotateToken();
  }

  /**
   * The owner-facing rotation, as one operation: mint a new token AND make
   * the owner's Codex config carry it, or change nothing.
   *
   * S35-H2-1: rotating first and rewriting afterwards was two operations
   * pretending to be one. When the installed block could not be rewritten
   * — a torn END marker, a conflict, a symlinked config, insecure
   * permissions — the rotation had already happened and the rewrite was
   * simply skipped, yet the result said `ok`. The owner's Codex kept a
   * literal the endpoint no longer accepts, and nothing said so.
   *
   * The block is therefore inspected BEFORE the token moves. A block that
   * cannot be rewritten refuses with `FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED`
   * and the old token still authenticates. A block that is simply not
   * installed is still not installed by this action, and the rotation
   * proceeds. If the rewrite fails after the rotation anyway, the previous
   * token is put back, so the owner's config and the endpoint agree either
   * way — the one outcome this operation will not produce is a config that
   * authenticates nowhere.
   */
  async rotateAndRewrite(
    ports: FarolModelRotatePorts,
  ): Promise<FarolModelRotateOutcome> {
    const previousToken = await this.state.currentToken();
    const before = await ports.spec();
    if (!before) return { ok: false, code: "MODEL_ENDPOINT_UNAVAILABLE" };

    const preflight = await ports.preview(ports.configPath, before);
    if (!REWRITABLE.has(preflight.status)) {
      // Nothing has moved: the endpoint still accepts the token the
      // owner's config carries.
      return {
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        providerBlockStatus: preflight.status,
      };
    }
    // `noop` means an installed block already carries the current literal;
    // after the rotation it must become an `update`. Both are "installed".
    const installed =
      preflight.status === "update" || preflight.status === "noop";

    await this.state.rotateToken();
    const restore = async (): Promise<void> => {
      if (previousToken !== undefined) {
        await this.state.restoreToken(previousToken);
      }
    };

    if (!installed) {
      return {
        ok: true,
        providerBlockUpdated: false,
        providerBlockStatus: preflight.status,
      };
    }

    const after = await ports.spec();
    if (!after) {
      await restore();
      return {
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        providerBlockStatus: "not_present",
      };
    }
    const planned = await ports.preview(ports.configPath, after);
    if (planned.status !== "update") {
      await restore();
      return {
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        providerBlockStatus: planned.status,
      };
    }
    const applied = await ports.apply(ports.configPath, after);
    if (applied.status !== "applied") {
      await restore();
      return {
        ok: false,
        code: "FAROL_MODEL_ROTATE_BLOCK_NOT_UPDATED",
        providerBlockStatus: applied.status,
      };
    }
    return {
      ok: true,
      providerBlockUpdated: true,
      providerBlockStatus: "update",
    };
  }

  /**
   * A snapshot for the Setup/Settings control. `connected` is reported
   * only once the endpoint has actually served a request from a host — a
   * written config file or a found executable is never evidence of a
   * connection.
   */
  status(): FarolModelLifecycleStatus {
    const endpoint = this.endpointInstance;
    if (!endpoint || endpoint.port === undefined) {
      if (this.portConflict !== undefined) {
        return {
          state: "port_conflict",
          port: this.portConflict,
          occupant: this.occupant,
        };
      }
      return { state: "not_running" };
    }
    const evidence = endpoint.evidence();
    return {
      state: evidence.requestsAccepted > 0 ? "connected" : "listening",
      port: endpoint.port,
      requestsServed: evidence.requestsAccepted,
      lastAcceptedAtIso: evidence.lastAcceptedAtIso,
    };
  }

  /**
   * `status()`, plus — on a port conflict — one loopback probe of the
   * conflicting port: an authenticated `GET /farol-model/identity` with
   * this state root's token. Only a Farol Model endpoint answers it with a
   * well-formed identity; anything else is reported as not this Farol.
   * The probe never signals, binds, or retries; it is read-only.
   */
  async checkStatus(): Promise<FarolModelLifecycleStatus> {
    const current = this.status();
    if (current.state !== "port_conflict") return current;
    this.occupant = await this.probeOccupant(current.port);
    return this.status();
  }

  private async probeOccupant(
    port: number,
  ): Promise<Exclude<FarolModelPortOccupant, "unprobed">> {
    const token = await this.state.currentToken();
    const host = this.options.host ?? "127.0.0.1";
    const authority = host.includes(":") ? `[${host}]` : host;
    let response: Response;
    try {
      response = await fetch(
        `http://${authority}:${port}${FAROL_MODEL_IDENTITY_PATH}`,
        {
          method: "GET",
          headers:
            token === undefined ? {} : { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(
            this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          ),
        },
      );
    } catch (error) {
      return connectionRefused(error) ? "vacated" : "foreign";
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return "foreign";
    }
    const payload: unknown = await response.json().catch(() => undefined);
    return isFarolModelIdentity(payload) ? "farol" : "foreign";
  }
}

function connectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return cause?.code === "ECONNREFUSED";
}
