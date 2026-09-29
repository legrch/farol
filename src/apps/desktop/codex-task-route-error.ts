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
