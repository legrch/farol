import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { AuthorityRepository } from "../port/authority-repository";
import {
  delegateParticipantAuthority,
  type AuthorityErrorCode,
  type AuthorityFailureSource,
  type AuthorityNarrowing,
  type ParticipantAuthority,
} from "../../domain/execution-authority";

export type DelegateAuthorityCommand = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  parentParticipantId: string;
  participantId: string;
  role: "agent" | "critic";
  mutationOwnership: "none" | "task";
  narrowing?: AuthorityNarrowing;
}>;

export type DelegateAuthorityErrorCode =
  | AuthorityErrorCode
  | "AUTHORITY_PARENT_NOT_FOUND"
  | "AUTHORITY_PARTICIPANT_CONFLICT"
  | "AUTHORITY_STORE_UNAVAILABLE";

export type DelegateAuthorityResult =
  | Readonly<{ ok: true; value: ParticipantAuthority }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: DelegateAuthorityErrorCode;
        source: AuthorityFailureSource | "authority-store";
        retry: "never";
      }>;
    }>;

function failure(
  code: DelegateAuthorityErrorCode,
  source: AuthorityFailureSource | "authority-store",
): DelegateAuthorityResult {
  return { ok: false, error: { code, source, retry: "never" } };
}

function sameAuthority(
  left: ParticipantAuthority,
  right: ParticipantAuthority,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DelegateExecutionAuthority {
  constructor(
    private readonly authorities: AuthorityRepository,
    private readonly clock: Clock,
  ) {}

  async execute(
    command: DelegateAuthorityCommand,
  ): Promise<DelegateAuthorityResult> {
    let parent: ParticipantAuthority | null;
    try {
      parent = await this.authorities.get(command.parentParticipantId);
    } catch {
      return failure("AUTHORITY_STORE_UNAVAILABLE", "authority-store");
    }
    if (!parent) {
      return failure("AUTHORITY_PARENT_NOT_FOUND", "authority-store");
    }
    if (this.clock.now() > parent.grant.expiresAt) {
      return failure("AUTHORITY_EXPIRED", "task-grant");
    }
    if (parent.grant.ownerId !== command.ownerId) {
      return failure("AUTHORITY_OWNER_MISMATCH", "task-grant");
    }
    if (
      parent.grant.sessionId !== command.sessionId ||
      parent.grant.taskId !== command.taskId ||
      parent.grant.taskEpoch !== command.taskEpoch
    ) {
      return failure("AUTHORITY_TASK_MISMATCH", "task-grant");
    }

    const delegated = delegateParticipantAuthority(parent, {
      participantId: command.participantId,
      role: command.role,
      mutationOwnership: command.mutationOwnership,
      ...(command.narrowing ? { narrowing: command.narrowing } : {}),
    });
    if (!delegated.ok) return delegated;

    try {
      const admission = await this.authorities.admit(delegated.value);
      if (
        admission.status === "existing" &&
        !sameAuthority(admission.authority, delegated.value)
      ) {
        return failure("AUTHORITY_PARTICIPANT_CONFLICT", "authority-store");
      }
      return { ok: true, value: admission.authority };
    } catch {
      return failure("AUTHORITY_STORE_UNAVAILABLE", "authority-store");
    }
  }
}
