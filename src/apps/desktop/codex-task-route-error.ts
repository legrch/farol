import { CodexSocketAdmissionError } from "../../modules/chat/infra/native/shared-codex-proxy-host";
import type { ProductConfigurationResult } from "../../pkg/product-settings/contract";

/** Only closed socket-admission codes cross the desktop IPC boundary. */
export function codexTaskRouteFailureCode(
  error: unknown,
): Extract<ProductConfigurationResult, { ok: false }>["error"] {
  return error instanceof CodexSocketAdmissionError
    ? error.code
    : "CODEX_TASK_ROUTE_UNAVAILABLE";
}
