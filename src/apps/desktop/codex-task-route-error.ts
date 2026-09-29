import {
  CodexProxyFailure,
  CodexSocketAdmissionError,
} from "../../modules/chat/infra/native/shared-codex-proxy-host";
import type { ProductConfigurationResult } from "../../pkg/product-settings/contract";

/** Only closed socket and proxy lifecycle codes cross the desktop IPC boundary. */
export function codexTaskRouteFailureCode(
  error: unknown,
): Extract<ProductConfigurationResult, { ok: false }>["error"] {
  if (error instanceof CodexSocketAdmissionError) return error.code;
  if (error instanceof CodexProxyFailure) {
    switch (error.diagnostic.result) {
      case "launch_failed":
        return "CODEX_SHARED_PROXY_LAUNCH_FAILED";
      case "pipe_failed":
        return "CODEX_SHARED_PROXY_PIPE_FAILED";
      case "exited":
        return "CODEX_SHARED_PROXY_EXITED";
      case "timeout":
        return "CODEX_SHARED_PROXY_TIMEOUT";
      case "invalid_identity":
        return "CODEX_SHARED_PROXY_INVALID_IDENTITY";
      case "invalid_protocol":
        return "CODEX_SHARED_PROXY_PROTOCOL_ERROR";
      case "rpc_error":
        return "CODEX_SHARED_PROXY_RPC_ERROR";
      case "closed":
        break;
    }
  }
  return "CODEX_TASK_ROUTE_UNAVAILABLE";
}

/** Non-secret, bounded terminal record for the owning launch handle. */
export function codexTaskRouteFailureRecord(error: unknown): string {
  const code = codexTaskRouteFailureCode(error);
  if (error instanceof CodexProxyFailure) {
    const { phase, method, result, rpcCode } = error.diagnostic;
    // Methods originate in the fixed proxy method catalogue, never a payload.
    const safeMethod =
      /^(initialize|model\/list|project\/list|thread\/(start|read|list|name\/set|turns\/list|items\/list)|turn\/(start|steer)|multiple|none)$/u.test(
        method,
      )
        ? method
        : "unknown";
    return JSON.stringify({
      code,
      phase,
      method: safeMethod,
      result,
      ...(Number.isSafeInteger(rpcCode) ? { rpcCode } : {}),
    });
  }
  if (error instanceof CodexSocketAdmissionError) {
    return JSON.stringify({
      code,
      phase: error.phase,
      ...(error.errno ? { errno: error.errno } : {}),
    });
  }
  return JSON.stringify({ code });
}
