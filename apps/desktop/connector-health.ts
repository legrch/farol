import {
  parseConnectorHealthSnapshot,
  type ConnectorHealthSnapshot,
} from "./bridge/connector-health-snapshot.ts";
import {
  validate,
  type ComputerConnectorHealthSnapshot,
} from "./bridge/wire.ts";

const maximumBytes = 64 * 1024;

// Passive read of the original runtime locator. Never follows redirects or
// probes upstream, initializes a helper, retries an effect or retains raw errors.
export async function readConnectorHealth(
  base: string,
): Promise<ConnectorHealthSnapshot | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    const response = await fetch(new URL("/health?details=true", url), {
      redirect: "error",
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) return null;
      chunks.push(part.value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return parseConnectorHealthSnapshot(JSON.parse(text) as unknown);
  } catch {
    return null;
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}

const decimal = (value: number | null) =>
  value === null ? undefined : String(value);
// The producer reports nanosecond-derived seconds. Preserve that precision
// without exponent notation; the generated wire validator bounds this text.
const seconds = (value: number) =>
  value.toFixed(9).replace(/\.?0+$/u, "") || "0";

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Mechanical adapter mapping only. Go owns clock, identity and state policy.
export function connectorHealthWire(
  sample: ConnectorHealthSnapshot,
): ComputerConnectorHealthSnapshot | null {
  const poll = sample.controlPlane,
    delivery = sample.responseDelivery;
  const pd = poll?.details,
    dd = delivery?.details;
  const value: unknown = JSON.parse(
    JSON.stringify({
      snapshotAtMillis: decimal(sample.snapshotAtMillis),
      runtimeInstanceId: sample.runtimeInstanceId,
      runtimeStartedAtMillis: decimal(sample.runtimeStartedAtMillis),
      runtimeLifecycle: sample.runtimeLifecycle,
      runtimeLimited: sample.runtimeLimited,
      live: sample.live,
      ready: sample.ready,
      truncated: sample.truncated,
      controlPlane:
        poll === null
          ? undefined
          : {
              status: poll.status,
              state: poll.state,
              limited: poll.limited,
              observedAtMillis: decimal(poll.observedAtMillis),
              details:
                pd == null
                  ? undefined
                  : {
                      lastAttemptMillis: decimal(pd.lastAttemptMillis),
                      lastSuccessMillis: decimal(pd.lastSuccessMillis),
                      lastErrorMillis: decimal(pd.lastErrorMillis),
                      nextRetryMillis: decimal(pd.nextRetryMillis),
                      consecutiveFailures: decimal(pd.consecutiveFailures),
                      currentPollAgeSeconds: seconds(pd.currentPollAgeSeconds),
                      configuredWaitSeconds: seconds(pd.configuredWaitSeconds),
                      effectiveWaitSeconds: seconds(pd.effectiveWaitSeconds),
                      deadlineSeconds: seconds(pd.deadlineSeconds),
                      failureCategory: pd.failureCategory ?? undefined,
                      httpStatus: pd.httpStatus ?? undefined,
                    },
            },
      responseDelivery:
        delivery === null
          ? undefined
          : {
              status: delivery.status,
              state: delivery.state,
              limited: delivery.limited,
              observedAtMillis: decimal(delivery.observedAtMillis),
              details:
                dd == null
                  ? undefined
                  : {
                      inProgress: decimal(dd.inProgress),
                      attempts: decimal(dd.attempts),
                      retries: decimal(dd.retries),
                      accepted: decimal(dd.accepted),
                      completed: decimal(dd.completed),
                      terminalFailures: decimal(dd.terminalFailures),
                      lastAcceptedMillis: decimal(dd.lastAcceptedMillis),
                      lastCompletedMillis: decimal(dd.lastCompletedMillis),
                      lastFailureMillis: decimal(dd.lastFailureMillis),
                      disposition: dd.disposition,
                      failureCategory: dd.failureCategory ?? undefined,
                      httpStatus: dd.httpStatus ?? undefined,
                    },
            },
    }),
  ) as unknown;
  return validate("ComputerConnectorHealthSnapshot", value)
    ? freeze(value as ComputerConnectorHealthSnapshot)
    : null;
}
