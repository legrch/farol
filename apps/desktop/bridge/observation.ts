import {
  HealthObservationExpiredError,
  PollingObservationExpiredError,
  type BridgeError,
} from "./errors.ts";
import {
  validate,
  type ComputerConnectorHealthRequest,
  type ComputerConnectorHealthState,
  type ComputerConnectorPollingRequest,
  type ComputerConnectorPollingState,
  type Outcome,
} from "./wire.ts";

export type PollingObservation = Readonly<
  ComputerConnectorPollingRequest & { deadlineMillis: number }
>;
export type HealthObservation = Readonly<
  Pick<ComputerConnectorHealthRequest, "binding" | "expectedInstanceId"> & {
    deadlineMillis: number;
    sampleAtMillis?: string;
  }
>;

export type DiagnosticObservation =
  | Readonly<{ kind: "health"; value: HealthObservation }>
  | Readonly<{ kind: "polling"; value: PollingObservation }>;

export function diagnosticObservation(
  pending: Readonly<{
    healthObservation?: HealthObservation;
    observation?: PollingObservation;
  }>,
): DiagnosticObservation | null {
  if (pending.healthObservation)
    return { kind: "health", value: pending.healthObservation };
  if (pending.observation)
    return { kind: "polling", value: pending.observation };
  return null;
}

// The response envelope is validated and correlated before this function.
// A valid pure-read refusal remains a refusal; discarding it grants nothing.
export function matchesDiagnostic(
  result: Outcome,
  original: DiagnosticObservation,
): boolean {
  if (result.operationId !== undefined) return false;
  if (result.status !== "ok") return result.data === undefined;
  if (result.code !== undefined) return false;
  if (original.kind === "health") {
    if (!validate("ComputerConnectorHealthState", result.data)) return false;
    const observed = result.data as unknown as ComputerConnectorHealthState;
    return (
      Object.entries(original.value.binding).every(
        ([key, value]) =>
          observed.binding[key as keyof typeof observed.binding] === value,
      ) &&
      observed.expectedInstanceId === original.value.expectedInstanceId &&
      observed.sampleAtMillis === original.value.sampleAtMillis
    );
  }
  if (!validate("ComputerConnectorPollingState", result.data)) return false;
  const observed = result.data as unknown as ComputerConnectorPollingState;
  return (
    Object.entries(original.value.binding).every(
      ([key, value]) =>
        observed.binding[key as keyof typeof observed.binding] === value,
    ) &&
    observed.cycles === original.value.samples.cycles &&
    observed.errors === original.value.samples.errors &&
    (observed.ageSeconds !== undefined) ===
      (observed.state === "recent" || observed.state === "stale")
  );
}

export function diagnosticExpired(
  original: DiagnosticObservation,
): BridgeError {
  return original.kind === "health"
    ? new HealthObservationExpiredError()
    : new PollingObservationExpiredError();
}
