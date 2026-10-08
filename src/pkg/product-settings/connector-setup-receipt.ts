/** Content-free terminal progress for the existing connector setup owners. */
export const connectorSetupCodes = [
  "SETTINGS_UNAVAILABLE",
  "SETTINGS_INPUT_INVALID",
  "SETTINGS_WRITE_FAILED",
  "AUTHORITY_CHANGE_IN_PROGRESS",
  "CONNECTOR_ALREADY_RUNNING",
  "CONNECTOR_STOP_REQUIRED",
  "CONNECTOR_STOP_UNCONFIRMED",
  "CONNECTOR_CONFIGURE_FAILED",
  "CONNECTOR_CREDENTIAL_REQUIRED",
  "CONNECTOR_CREDENTIAL_STORE_FAILED",
  "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
  "CONNECTOR_WORKSPACE_REQUIRED",
  "CONNECTOR_WORKSPACE_LIMIT",
  "CONNECTOR_DOCTOR_FAILED",
  "CONNECTOR_START_FAILED",
  "CONNECTOR_RUNTIME_UNREACHABLE",
  "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  "COMPUTER_FENCE_UNHELD",
  "WORKSPACE_VERIFICATION_REQUIRED",
  "WORKSPACE_ROOT_CHANGED",
  "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
  "TUNNEL_CLIENT_INCOMPATIBLE",
  "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
  "CONNECTOR_SETUP_BINDING_CHANGED",
  "CONNECTOR_SETUP_STEP_UNCONFIRMED",
] as const;
export type ConnectorSetupCode = (typeof connectorSetupCodes)[number];
export type ConnectorSetupStep = "credentials" | "connection";
export type ConnectorSetupStage =
  | "credential-admission"
  | "credentials"
  | "connection-admission"
  | "connection"
  | "complete";
export type ConnectorSetupAttempt = Readonly<{
  method: "computer.connector.open";
  requestId: string;
  operationId: string;
  outcome: "known" | "unknown";
}>;
export type ConnectorSetupStepResult =
  | Readonly<{ state: "completed"; code: null }>
  | Readonly<{
      state: "refused" | "unknown";
      code: ConnectorSetupCode;
      connectorAttempt?: ConnectorSetupAttempt;
    }>;
export type ConnectorSetupIdentity = Readonly<{
  operationId: string;
  buildId: string;
}>;
export type ConnectorSetupReceipt = Readonly<{
  kind: "connector.save-and-connect";
  operationId: string;
  buildId: string;
  state: "completed" | "refused" | "unknown";
  stoppedAt: ConnectorSetupStage;
  credentials: "not-started" | "saved" | "refused" | "unknown";
  connection: "not-started" | "connected" | "refused" | "unknown";
  code: ConnectorSetupCode | null;
  // Local tunnel readiness is not a receipt from external ChatGPT.
  externalVerification: "not-proven";
  connectorAttempt?: ConnectorSetupAttempt;
}>;

const codes = new Set<string>(connectorSetupCodes);
const uncertainCodes = new Set<ConnectorSetupCode>([
  "SETTINGS_WRITE_FAILED",
  "CONNECTOR_STOP_UNCONFIRMED",
  "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
  "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
  "CONNECTOR_SETUP_STEP_UNCONFIRMED",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha256 = /^[0-9a-f]{64}$/u;
const identifier = /^[!-~]{1,160}$/u;
const unconfirmed = (): ConnectorSetupStepResult => ({
  state: "unknown",
  code: "CONNECTOR_SETUP_STEP_UNCONFIRMED",
});

// Reject additional data instead of copying it into evidence. Do not read
// accessor properties; even a getter could expose a secret or mutate a value.
function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property))
      return null;
    output[key] = property.value;
  }
  return output;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function attempt(value: unknown): ConnectorSetupAttempt | null {
  const item = record(value);
  if (
    !item ||
    Object.keys(item).length !== 4 ||
    !exactKeys(item, ["method", "requestId", "operationId", "outcome"]) ||
    item.method !== "computer.connector.open" ||
    typeof item.requestId !== "string" ||
    !identifier.test(item.requestId) ||
    typeof item.operationId !== "string" ||
    !identifier.test(item.operationId) ||
    (item.outcome !== "known" && item.outcome !== "unknown")
  )
    return null;
  return Object.freeze({
    method: item.method,
    requestId: item.requestId,
    operationId: item.operationId,
    outcome: item.outcome,
  });
}

/** Normalize only validated host step classifications, never raw thrown errors. */
function parseStepResult(value: unknown): ConnectorSetupStepResult | null {
  try {
    const item = record(value);
    if (!item || !exactKeys(item, ["state", "code", "connectorAttempt"]))
      return null;
    if (item.state === "completed") {
      return item.code === null && Object.keys(item).length === 2
        ? Object.freeze({ state: "completed", code: null })
        : null;
    }
    if (
      (item.state !== "refused" && item.state !== "unknown") ||
      typeof item.code !== "string" ||
      !codes.has(item.code)
    )
      return null;
    const original = Object.hasOwn(item, "connectorAttempt")
      ? attempt(item.connectorAttempt)
      : undefined;
    if (original === null) return null;
    const code = item.code as ConnectorSetupCode;
    return Object.freeze({
      state:
        item.state === "unknown" ||
        uncertainCodes.has(code) ||
        original?.outcome === "unknown"
          ? "unknown"
          : "refused",
      code,
      ...(original ? { connectorAttempt: original } : {}),
    });
  } catch {
    return null;
  }
}

/** Normalize unknown/malformed replies conservatively without exposing them. */
export function connectorSetupStepResult(
  value: unknown,
): ConnectorSetupStepResult {
  return parseStepResult(value) ?? unconfirmed();
}

/** Validate request correlation only; this is never authority or provenance proof. */
export function readConnectorSetupIdentity(
  value: unknown,
): ConnectorSetupIdentity | null {
  try {
    const input = record(value);
    if (
      !input ||
      Object.keys(input).length !== 2 ||
      !exactKeys(input, ["operationId", "buildId"]) ||
      typeof input.operationId !== "string" ||
      !uuid.test(input.operationId) ||
      typeof input.buildId !== "string" ||
      !sha256.test(input.buildId)
    )
      return null;
    return Object.freeze({
      operationId: input.operationId,
      buildId: input.buildId,
    });
  } catch {
    return null;
  }
}

/** Strict readback of THIS protocol; additional receipt fields are refused. */
export function readConnectorSetupReceipt(
  value: unknown,
): ConnectorSetupReceipt | null {
  try {
    const item = record(value);
    if (
      !item ||
      !exactKeys(item, [
        "kind",
        "operationId",
        "buildId",
        "state",
        "stoppedAt",
        "credentials",
        "connection",
        "code",
        "externalVerification",
        "connectorAttempt",
      ]) ||
      Object.keys(item).length < 9 ||
      item.kind !== "connector.save-and-connect" ||
      typeof item.operationId !== "string" ||
      !uuid.test(item.operationId) ||
      typeof item.buildId !== "string" ||
      !sha256.test(item.buildId) ||
      item.externalVerification !== "not-proven" ||
      typeof item.credentials !== "string" ||
      typeof item.connection !== "string" ||
      typeof item.stoppedAt !== "string"
    )
      return null;
    const normalized = parseStepResult({
      state: item.state,
      code: item.code,
      ...(Object.hasOwn(item, "connectorAttempt")
        ? { connectorAttempt: item.connectorAttempt }
        : {}),
    });
    // Readback validates a receipt; it must not silently repair a false state.
    if (
      !normalized ||
      normalized.state !== item.state ||
      normalized.code !== item.code
    )
      return null;
    const pair = [item.credentials, item.connection].join(":");
    const expected =
      item.stoppedAt === "complete" && normalized.state === "completed"
        ? "saved:connected"
        : normalized.state === "completed"
          ? null
          : item.stoppedAt === "credential-admission"
            ? "not-started:not-started"
            : item.stoppedAt === "credentials"
              ? `${normalized.state}:not-started`
              : item.stoppedAt === "connection-admission"
                ? "saved:not-started"
                : item.stoppedAt === "connection"
                  ? `saved:${normalized.state}`
                  : null;
    if (pair !== expected) return null;
    if ("connectorAttempt" in normalized && item.stoppedAt !== "connection")
      return null;
    return Object.freeze({
      kind: item.kind,
      operationId: item.operationId,
      buildId: item.buildId,
      state: normalized.state,
      stoppedAt: item.stoppedAt as ConnectorSetupStage,
      credentials: item.credentials as ConnectorSetupReceipt["credentials"],
      connection: item.connection as ConnectorSetupReceipt["connection"],
      code: normalized.code,
      externalVerification: "not-proven",
      ...("connectorAttempt" in normalized && normalized.connectorAttempt
        ? { connectorAttempt: normalized.connectorAttempt }
        : {}),
    });
  } catch {
    return null;
  }
}
