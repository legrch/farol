import { recordableOperationCode } from "../renderer/operations-vocabulary";

/** The content-free code for a non-2xx answer from the inner provider. */
export function routeRefusalCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    if (parsed.error?.code !== undefined)
      return recordableOperationCode(parsed.error.code) ?? "provider_error";
  } catch {
    // Falls through to the generic, content-free code below.
  }
  return "FAROL_MODEL_ROUTE_REFUSED";
}

/** Status and body of a refusal an authenticated caller may read. */
export function readableRefusal(
  status: number,
  reason: string,
  detail?: Readonly<Record<string, string>>,
): Readonly<{ status: number; headers: Record<string, string>; body: string }> {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: { code: reason, ...(detail ?? {}) } }),
  };
}

/**
 * A refusal for a caller that has not authenticated. The body names no
 * product and no FAROL_* code.
 */
export function anonymousRefusal(
  status: 401 | 403,
): Readonly<{ status: number; headers: Record<string, string>; body: string }> {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
    },
    body: JSON.stringify({
      error: { code: status === 401 ? "unauthorized" : "forbidden" },
    }),
  };
}
