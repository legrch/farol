import {
  FarolModelEndpoint,
  FarolModelEndpointPortConflictError,
  type FarolModelTurnHandler,
} from "./farol-model-endpoint";
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
// abort the rest of the app's own startup sequence.

export type FarolModelLifecycleStatus =
  | Readonly<{ state: "not_running" }>
  | Readonly<{ state: "port_conflict"; port: number }>
  | Readonly<{
      state: "listening" | "connected";
      port: number;
      requestsServed: number;
      lastAcceptedAtIso: string | undefined;
    }>;

export type FarolModelLifecycleOptions = Readonly<{
  /** Private state root: token, persisted port, liveness marker. */
  stateRoot: string;
  handler?: FarolModelTurnHandler;
  /** Host loopback address to bind; defaults to 127.0.0.1 (IPv4 only). */
  host?: string;
}>;

export class FarolModelLifecycle {
  private readonly state: FarolModelRuntimeState;
  private readonly options: FarolModelLifecycleOptions;
  private endpointInstance: FarolModelEndpoint | undefined;
  private portConflict: number | undefined;

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
      ...(this.options.handler ? { handler: this.options.handler } : {}),
      ...(this.options.host ? { host: this.options.host } : {}),
    });
    try {
      await endpoint.start();
    } catch (error) {
      if (error instanceof FarolModelEndpointPortConflictError) {
        this.portConflict = error.port;
        return;
      }
      throw error;
    }
    this.portConflict = undefined;
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
   * A snapshot for the Setup/Settings control. `connected` is reported
   * only once the endpoint has actually served a request from a host — a
   * written config file or a found executable is never evidence of a
   * connection.
   */
  status(): FarolModelLifecycleStatus {
    const endpoint = this.endpointInstance;
    if (!endpoint || endpoint.port === undefined) {
      if (this.portConflict !== undefined) {
        return { state: "port_conflict", port: this.portConflict };
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
}
