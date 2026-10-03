import {
  deriveTaskGrant,
  type AuthorityResult,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
  type TaskGrant,
} from "./execution-authority";

// Reissue changes time only. The admitted task remains the ceiling, including
// its identity, generation, exclusions, roots and capabilities. Current owner
// policy must independently approve that entire ceiling.
export function reissueTaskGrant(
  approval: ComputerApproval,
  ceiling: TaskAdmission,
  now: number,
  lifetimeMs: number,
): AuthorityResult<TaskGrant> {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(lifetimeMs) ||
    now < 0 ||
    lifetimeMs <= 0 ||
    !Number.isSafeInteger(now + lifetimeMs)
  ) {
    return {
      ok: false,
      error: {
        code: "AUTHORITY_EXPIRED",
        source: "task-admission",
        retry: "never",
      },
    };
  }
  return deriveTaskGrant(
    approval,
    {
      ...ceiling,
      expiresAt: Math.min(approval.expiresAt, now + lifetimeMs),
    },
    now,
  );
}

export type ComputerExecutionLease = Readonly<{
  participant: ParticipantAuthority;
  deadlineAt: number;
}>;

// Call only after admitting a fresh outer grant against current owner policy.
// Its expiry controls new admission; this fixed deadline controls this one
// execution. Reissue never changes a lease that has already been returned.
export function computerExecutionLease(
  participant: ParticipantAuthority,
  approval: ComputerApproval,
  now: number,
  lifetimeMs: number,
): ComputerExecutionLease {
  const deadlineAt = Math.min(approval.expiresAt, now + lifetimeMs);
  return {
    deadlineAt,
    participant: {
      ...participant,
      grant: { ...participant.grant, expiresAt: deadlineAt },
    },
  };
}
