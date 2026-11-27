import type { PortFailure } from "../../domain/github-release-contract";

export type TransportFailure = PortFailure &
  Readonly<{
    certainty: "known" | "unknown";
    reason:
      | "invalid_url"
      | "redirect"
      | "http_status"
      | "network"
      | "cancelled"
      | "timeout"
      | "invalid_json"
      | "content_length"
      | "content_encoding"
      | "stream"
      | "limit"
      | "private_state"
      | "stage_cleanup"
      | "invalid_handle"
      | "stage_capacity"
      | "verification";
  }>;
export type TransportResult<T> =
  Readonly<{ ok: true; value: T }> | TransportFailure;

export function fail(
  kind: PortFailure["kind"],
  reason: TransportFailure["reason"],
  certainty: "known" | "unknown" = "known",
): TransportFailure {
  return { ok: false, kind, reason, certainty };
}

export function header(
  value: string | readonly string[] | undefined,
): string | null {
  return typeof value === "string" ? value : null;
}
