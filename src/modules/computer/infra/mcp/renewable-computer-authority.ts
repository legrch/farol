import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthorityRepository } from "../../app/port/authority-repository";
import type { ComputerApprovalRepository } from "../../app/port/computer-approval-repository";
import type {
  ComputerApproval,
  ParticipantAuthority,
} from "../../domain/execution-authority";
import {
  computerExecutionLease,
  reissueTaskGrant,
} from "../../domain/task-grant-lifetime";
import { COMPUTER_TASK_GRANT_LIFETIME_MS } from "../repo/owner-settings-computer-approval";
import {
  materializeReadonlyComputerLaunch,
  ReadonlyComputerLaunchContractSchema,
  type ReadonlyComputerLaunchContract,
} from "./launch-contract";

export type AdmittedComputerExecution = Readonly<{
  approval: ComputerApproval;
  participants: readonly ParticipantAuthority[];
  participant: ParticipantAuthority;
  deadlineAt: number;
  current(): Promise<boolean>;
}>;

function policy(approval: ComputerApproval): string {
  // Schema parsing may reorder object keys (notably Git metadata). Compare
  // policy values canonically; expiry alone is renewed, never permission.
  return JSON.stringify(
    { ...approval, expiresAt: 0 },
    (_key, value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return value;
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]]),
      );
    },
  );
}

// One current-policy issuer, using the existing TaskGrant derivation. Each
// execution receives an immutable snapshot in its own async context, so a
// concurrent request or reconnect cannot extend or replace admitted work.
export class RenewableComputerAuthority implements AuthorityRepository {
  private readonly execution =
    new AsyncLocalStorage<AdmittedComputerExecution>();
  constructor(
    private readonly ceiling: ReadonlyComputerLaunchContract,
    readonly approvals: ComputerApprovalRepository,
    private readonly now: () => number,
    private readonly grantLifetimeMs = COMPUTER_TASK_GRANT_LIFETIME_MS,
  ) {}

  async admitExecution(lifetimeMs: number): Promise<AdmittedComputerExecution> {
    const approval = await this.approvals.get(this.ceiling.approval.computerId);
    if (!approval) throw new Error("COMPUTER_APPROVAL_NOT_FOUND");
    if (policy(approval) !== policy(this.ceiling.approval)) {
      throw new Error("AUTHORITY_COMPUTER_MISMATCH");
    }
    const now = this.now();
    const grant = reissueTaskGrant(
      approval,
      this.ceiling.admission,
      now,
      this.grantLifetimeMs,
    );
    if (!grant.ok) throw new Error(grant.error.code);
    const launch = materializeReadonlyComputerLaunch(
      ReadonlyComputerLaunchContractSchema.parse({
        ...this.ceiling,
        approval,
        admission: {
          ...this.ceiling.admission,
          expiresAt: grant.value.expiresAt,
        },
      }),
      now,
    );
    const leases = launch.participants.map((participant) =>
      computerExecutionLease(participant, approval, now, lifetimeMs),
    );
    const participant = leases.at(-1)!;
    return {
      approval,
      participants: leases.map((lease) => lease.participant),
      participant: participant.participant,
      deadlineAt: participant.deadlineAt,
      current: async () => {
        const current = await this.approvals.get(approval.computerId);
        return (
          this.now() < participant.deadlineAt &&
          current !== null &&
          current.expiresAt >= this.now() &&
          policy(current) === policy(approval)
        );
      },
    };
  }

  run<T>(
    execution: AdmittedComputerExecution,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.execution.run(execution, action);
  }

  async get(participantId: string): Promise<ParticipantAuthority | null> {
    const execution = this.execution.getStore();
    if (!execution) return null;
    return (
      execution.participants.find(
        (participant) => participant.participantId === participantId,
      ) ?? null
    );
  }

  async admit(authority: ParticipantAuthority) {
    const existing = await this.get(authority.participantId);
    if (!existing) throw new Error("COMPUTER_PARTICIPANT_ADMISSION_DENIED");
    return { status: "existing" as const, authority: existing };
  }
}
