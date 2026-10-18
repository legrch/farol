export type ConnectorHealthStatus = "ok" | "degraded" | "unknown" | "disabled";
export type ConnectorRuntimeLifecycle = "starting" | "running" | "draining";
export type ConnectorFailureCategory =
  "http_error" | "timeout" | "canceled" | "network_error" | "request_error";
export type ControlPlaneState =
  "starting" | "polling" | "idle" | "backoff" | "backpressured" | "stopped";

export type ControlPlaneHealthDetails = Readonly<{
  lastAttemptMillis: number | null;
  lastSuccessMillis: number | null;
  lastErrorMillis: number | null;
  nextRetryMillis: number | null;
  consecutiveFailures: number;
  currentPollAgeSeconds: number;
  configuredWaitSeconds: number;
  effectiveWaitSeconds: number;
  deadlineSeconds: number;
  failureCategory: ConnectorFailureCategory | null;
  httpStatus: number | null;
}>;

export type ResponseDeliveryHealthDetails = Readonly<{
  inProgress: number;
  attempts: number;
  retries: number;
  accepted: number;
  completed: number;
  terminalFailures: number;
  lastAcceptedMillis: number | null;
  lastCompletedMillis: number | null;
  lastFailureMillis: number | null;
  disposition: string;
  failureCategory: ConnectorFailureCategory | null;
  httpStatus: number | null;
}>;

type ComponentHealth<State extends string, Details> = Readonly<{
  status: ConnectorHealthStatus;
  state: State;
  limited: boolean;
  observedAtMillis: number | null;
  details: Details | null;
}>;

export type ControlPlaneHealth = ComponentHealth<
  ControlPlaneState,
  ControlPlaneHealthDetails
>;
export type ResponseDeliveryHealth = ComponentHealth<
  string,
  ResponseDeliveryHealthDetails
>;

export type ConnectorHealthSnapshot = Readonly<{
  snapshotAtMillis: number;
  runtimeInstanceId: string;
  runtimeStartedAtMillis: number;
  runtimeLifecycle: ConnectorRuntimeLifecycle;
  runtimeLimited: boolean;
  live: boolean;
  ready: boolean;
  truncated: boolean;
  controlPlane: ControlPlaneHealth | null;
  responseDelivery: ResponseDeliveryHealth | null;
}>;

const MISSING = Symbol("missing health field");
const MAX_SECONDS = Number.MAX_SAFE_INTEGER / 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Inspect only named own data properties; ignore extras without invoking getters.
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return MISSING;
  return "value" in descriptor ? descriptor.value : undefined;
}

function identifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[^A-Za-z0-9_-]/u.test(value)
  );
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 35) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|\+00:00)$/u.exec(
      value,
    );
  if (match === null || match[0] !== value) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const result = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  if (!Number.isSafeInteger(result) || result <= 0) return null;
  const date = new Date(result);
  // Date.UTC normalizes invalid calendar values, so compare every source field.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  return result;
}

function optionalTimestamp(value: unknown): number | null | undefined {
  if (value === MISSING || value === null) return null;
  return timestamp(value) ?? undefined;
}

function optionalBoolean(value: unknown): boolean | null {
  return value === MISSING ? false : typeof value === "boolean" ? value : null;
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function seconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_SECONDS
  );
}

function status(value: unknown): ConnectorHealthStatus | null {
  switch (value) {
    case "ok":
    case "degraded":
    case "unknown":
    case "disabled":
      return value;
    default:
      return null;
  }
}

function lifecycle(value: unknown): ConnectorRuntimeLifecycle | null {
  switch (value) {
    case "starting":
    case "running":
    case "draining":
      return value;
    default:
      return null;
  }
}

function pollingState(value: unknown): ControlPlaneState | null {
  switch (value) {
    case "starting":
    case "polling":
    case "idle":
    case "backoff":
    case "backpressured":
    case "stopped":
      return value;
    default:
      return null;
  }
}

function failureCategory(
  value: unknown,
): ConnectorFailureCategory | null | undefined {
  if (value === MISSING || value === null) return null;
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "http_error":
    case "timeout":
    case "canceled":
    case "network_error":
    case "request_error":
      return value;
    default:
      return null;
  }
}

function httpStatus(value: unknown): number | null | undefined {
  if (value === MISSING || value === null || value === 0) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function pollingDetails(value: unknown): ControlPlaneHealthDetails | null {
  try {
    const input = record(value);
    if (input === null) return null;
    const lastAttemptMillis = optionalTimestamp(field(input, "last_attempt"));
    const lastSuccessMillis = optionalTimestamp(field(input, "last_success"));
    const lastErrorMillis = optionalTimestamp(field(input, "last_error"));
    const nextRetryMillis = optionalTimestamp(field(input, "next_retry"));
    const consecutiveFailures = field(input, "consecutive_failures");
    const currentPollAgeSeconds = field(input, "current_poll_age_seconds");
    const configuredWaitSeconds = field(input, "configured_wait_seconds");
    const effectiveWaitSeconds = field(input, "effective_wait_seconds");
    const deadlineSeconds = field(input, "deadline_seconds");
    const category = failureCategory(field(input, "failure_category"));
    const code = httpStatus(field(input, "http_status"));
    if (
      lastAttemptMillis === undefined ||
      lastSuccessMillis === undefined ||
      lastErrorMillis === undefined ||
      nextRetryMillis === undefined ||
      !counter(consecutiveFailures) ||
      !seconds(currentPollAgeSeconds) ||
      !seconds(configuredWaitSeconds) ||
      !seconds(effectiveWaitSeconds) ||
      !seconds(deadlineSeconds) ||
      category === undefined ||
      code === undefined
    )
      return null;
    return Object.freeze({
      lastAttemptMillis,
      lastSuccessMillis,
      lastErrorMillis,
      nextRetryMillis,
      consecutiveFailures,
      currentPollAgeSeconds,
      configuredWaitSeconds,
      effectiveWaitSeconds,
      deadlineSeconds,
      failureCategory: category,
      httpStatus: code,
    });
  } catch {
    return null;
  }
}

function deliveryDetails(value: unknown): ResponseDeliveryHealthDetails | null {
  try {
    const input = record(value);
    if (input === null) return null;
    const inProgress = field(input, "in_progress");
    const attempts = field(input, "attempts");
    const retries = field(input, "retries");
    const accepted = field(input, "accepted");
    const completed = field(input, "completed");
    const terminalFailures = field(input, "terminal_failures");
    const lastAcceptedMillis = optionalTimestamp(field(input, "last_accepted"));
    const lastCompletedMillis = optionalTimestamp(
      field(input, "last_completed"),
    );
    const lastFailureMillis = optionalTimestamp(field(input, "last_failure"));
    const disposition = field(input, "disposition");
    const category = failureCategory(field(input, "failure_category"));
    const code = httpStatus(field(input, "http_status"));
    if (
      !counter(inProgress) ||
      !counter(attempts) ||
      !counter(retries) ||
      !counter(accepted) ||
      !counter(completed) ||
      !counter(terminalFailures) ||
      lastAcceptedMillis === undefined ||
      lastCompletedMillis === undefined ||
      lastFailureMillis === undefined ||
      !identifier(disposition, 32) ||
      category === undefined ||
      code === undefined
    )
      return null;
    return Object.freeze({
      inProgress,
      attempts,
      retries,
      accepted,
      completed,
      terminalFailures,
      lastAcceptedMillis,
      lastCompletedMillis,
      lastFailureMillis,
      disposition,
      failureCategory: category,
      httpStatus: code,
    });
  } catch {
    return null;
  }
}

function component<State extends string, Details>(
  value: unknown,
  parseState: (value: unknown) => State | null,
  parseDetails: (value: unknown) => Details | null,
): ComponentHealth<State, Details> | null {
  try {
    const input = record(value);
    if (input === null) return null;
    const componentStatus = status(field(input, "status"));
    const state = parseState(field(input, "state"));
    const limited = field(input, "limited");
    const observedAtMillis = optionalTimestamp(field(input, "observed_at"));
    if (
      componentStatus === null ||
      state === null ||
      typeof limited !== "boolean" ||
      observedAtMillis === undefined
    )
      return null;
    return Object.freeze({
      status: componentStatus,
      state,
      limited,
      observedAtMillis,
      details: parseDetails(field(input, "details")),
    });
  } catch {
    return null;
  }
}

/** Converts schema-v1 aggregate health data without freshness or connection policy. */
export function parseConnectorHealthSnapshot(
  value: unknown,
): ConnectorHealthSnapshot | null {
  try {
    const input = record(value);
    if (input === null || field(input, "schema_version") !== 1) return null;
    const live = field(input, "live");
    const ready = field(input, "ready");
    const snapshotAtMillis = timestamp(field(input, "snapshot_at"));
    const runtime = record(field(input, "runtime"));
    const truncated = optionalBoolean(field(input, "truncated"));
    if (
      typeof live !== "boolean" ||
      typeof ready !== "boolean" ||
      snapshotAtMillis === null ||
      runtime === null ||
      truncated === null
    )
      return null;
    const runtimeInstanceId = field(runtime, "instance_id");
    const runtimeStartedAtMillis = timestamp(field(runtime, "started_at"));
    const runtimeLifecycle = lifecycle(field(runtime, "lifecycle"));
    const runtimeLimited = optionalBoolean(field(runtime, "limited"));
    if (
      !identifier(runtimeInstanceId, 128) ||
      runtimeStartedAtMillis === null ||
      runtimeLifecycle === null ||
      runtimeLimited === null
    )
      return null;
    const components = record(field(input, "components"));
    return Object.freeze({
      snapshotAtMillis,
      runtimeInstanceId,
      runtimeStartedAtMillis,
      runtimeLifecycle,
      runtimeLimited,
      live,
      ready,
      truncated,
      controlPlane: component(
        components === null ? MISSING : field(components, "control_plane"),
        pollingState,
        pollingDetails,
      ),
      responseDelivery: component(
        components === null ? MISSING : field(components, "response_delivery"),
        (state) => (identifier(state, 32) ? state : null),
        deliveryDetails,
      ),
    });
  } catch {
    return null;
  }
}
