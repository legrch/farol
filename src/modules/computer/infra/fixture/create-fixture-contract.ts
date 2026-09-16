import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { Clock } from "../../../../pkg/kernel/app/clock";
import { RunReadonlyComputerAction } from "../../app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../domain/execution-authority";
import type { ReadonlyComputerContract } from "../../contract/readonly-computer-contract";
import { ReadonlyComputerContractHandler } from "../readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../repo/in-memory-computer-approvals";
import {
  FIXTURE_WORKSPACE_ID,
  FIXTURE_WORKSPACE_ROOT,
  FixtureReadonlyWorkspace,
} from "./fixture-readonly-workspace";

export type FixtureComputerIdentity = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  generation: number;
}>;

export type FixtureComputerContract = Readonly<{
  contract: ReadonlyComputerContract;
  binding: Readonly<{ taskEpoch: number; participantId: string }>;
}>;

export function createFixtureComputerContract(
  identity: FixtureComputerIdentity,
  approval: DeferredGate,
  clock: Clock,
): FixtureComputerContract {
  const expiresAt = clock.now() + 3_600_000;
  const computerApproval: ComputerApproval = {
    ownerId: identity.ownerId,
    computerId: "preview-fixture-computer",
    generation: identity.generation,
    workspaces: [
      {
        workspaceId: FIXTURE_WORKSPACE_ID,
        root: FIXTURE_WORKSPACE_ROOT,
        access: "read",
      },
    ],
    capabilities: ["workspace.read"],
    network: "none",
    commands: "none",
    expiresAt,
  };
  const taskEpoch = 0;
  const admission: TaskAdmission = {
    authorityId: `${identity.taskId}:fixture-authority`,
    ownerId: identity.ownerId,
    sessionId: identity.sessionId,
    taskId: identity.taskId,
    taskEpoch,
    computerId: computerApproval.computerId,
    computerGeneration: computerApproval.generation,
    workspaces: [
      {
        workspaceId: FIXTURE_WORKSPACE_ID,
        mode: "subtree",
        root: FIXTURE_WORKSPACE_ROOT,
        access: "read",
      },
    ],
    capabilities: ["workspace.read"],
    network: "none",
    commands: "none",
    expiresAt,
  };
  const grant = deriveTaskGrant(computerApproval, admission, clock.now());
  if (!grant.ok) throw new Error("FIXTURE_TASK_GRANT_INVALID");
  const participantId = `${identity.taskId}:main`;
  const participant = createParticipantAuthority(grant.value, {
    participantId,
    role: "main",
    mutationOwnership: "none",
  });
  if (!participant.ok) throw new Error("FIXTURE_PARTICIPANT_INVALID");
  return {
    contract: new ReadonlyComputerContractHandler(
      new RunReadonlyComputerAction(
        new InMemoryAuthorityRepository([participant.value]),
        new InMemoryComputerApprovalRepository([computerApproval]),
        new FixtureReadonlyWorkspace(approval),
        clock,
      ),
    ),
    binding: { taskEpoch, participantId },
  };
}
