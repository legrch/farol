import type { IncomingMessage } from "node:http";

/**
 * The only caller headers the bridge relays to the inner provider. The
 * compaction identity travels in `x-codex-turn-metadata` (the inner codec
 * accepts header-only identity and refuses a header that disagrees with the
 * embedded one), so dropping it would change what the inner validator sees.
 * The caller's own `authorization`, `origin` and everything else never
 * cross: the bridge speaks to the provider with its own internal token.
 */
export const FAROL_MODEL_FORWARDED_HEADERS: readonly string[] = [
  "x-codex-turn-metadata",
];

export function forwardedHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FAROL_MODEL_FORWARDED_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) forwarded[name] = value;
  }
  return forwarded;
}

export function flattenHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}
