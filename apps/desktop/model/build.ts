import {
  BLOCK_BEGIN_MARKER,
  BLOCK_END_MARKER,
  SELECTION_BEGIN_MARKER,
  SELECTION_END_MARKER,
} from "./region";

/**
 * The host-side retry contract the managed block pins, so an ordinary Codex
 * never retries or re-streams a Farol turn on its own: these are the same
 * values `codex-app-server-process.ts` passes for the host Farol launches
 * itself. A retried turn would be a second submission of the same request.
 */
export const FAROL_MODEL_HOST_TUNING = Object.freeze({
  requiresOpenAiAuth: false,
  requestMaxRetries: 0,
  streamMaxRetries: 0,
  streamIdleTimeoutMs: 120_000,
});

/**
 * How the bearer credential reaches Codex. `env-key` names an environment
 * variable Codex reads once at process start — Farol uses this when it
 * starts the host itself, so the literal token never touches disk. A GUI
 * Codex the owner starts themselves has no shell to receive an environment
 * variable from, so that case carries the token literal in the file
 * (`experimental_bearer_token`, the only credential field codex-cli 0.153.4
 * accepts besides `env_key`) — gated on the file not being group- or
 * other-readable.
 */
export type FarolModelDelivery =
  | Readonly<{ mode: "env-key"; envKeyName: string }>
  | Readonly<{ mode: "bearer-token"; token: string }>;

/** The two values the consented selection region writes into the root table. */
export type FarolModelProviderSelection = Readonly<{
  /** The `model_providers.<name>` table name Farol owns. */
  providerName: string;
  /** The one model the Farol Model endpoint serves (the Route B model). */
  model: string;
}>;

export type FarolModelProviderSpec = FarolModelProviderSelection &
  Readonly<{
    displayName: string;
    baseUrl: string;
    wireApi: "responses";
    delivery: FarolModelDelivery;
  }>;

export function tomlString(value: string): string {
  // JSON escaping is a subset of TOML basic-string escaping.
  return JSON.stringify(value);
}

export function buildProviderBlockBody(spec: FarolModelProviderSpec): string {
  return [
    BLOCK_BEGIN_MARKER,
    `[model_providers.${spec.providerName}]`,
    `name = ${tomlString(spec.displayName)}`,
    `base_url = ${tomlString(spec.baseUrl)}`,
    spec.delivery.mode === "env-key"
      ? `env_key = ${tomlString(spec.delivery.envKeyName)}`
      : `experimental_bearer_token = ${tomlString(spec.delivery.token)}`,
    `wire_api = ${tomlString(spec.wireApi)}`,
    `requires_openai_auth = ${String(FAROL_MODEL_HOST_TUNING.requiresOpenAiAuth)}`,
    `request_max_retries = ${String(FAROL_MODEL_HOST_TUNING.requestMaxRetries)}`,
    `stream_max_retries = ${String(FAROL_MODEL_HOST_TUNING.streamMaxRetries)}`,
    `stream_idle_timeout_ms = ${String(FAROL_MODEL_HOST_TUNING.streamIdleTimeoutMs)}`,
    BLOCK_END_MARKER,
  ].join("\n");
}

export function buildSelectionBody(
  selection: FarolModelProviderSelection,
): string {
  return [
    SELECTION_BEGIN_MARKER,
    `model_provider = ${tomlString(selection.providerName)}`,
    `model = ${tomlString(selection.model)}`,
    SELECTION_END_MARKER,
  ].join("\n");
}
