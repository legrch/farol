import { failure, type Result } from "../../pkg/kernel/domain/result";
import type { ProductSettings } from "../../pkg/product-settings/contract";
import type { ProductTask } from "../../modules/chat/contract/product-task";
import type { AgentHost } from "../../modules/agent/app/port/agent-host";
import type { AssignmentRepository } from "../../modules/agent/app/port/assignment-repository";
import {
  RunAgentAssignment,
  type AgentRunReceipt,
} from "../../modules/agent/app/service/run-agent-assignment";
import type { AssignmentErrorCode } from "../../modules/agent/domain/assignment";
import { ComputerExecutionAuthorityPeer } from "../../modules/agent/infra/peer/computer-execution-authority-peer";
import { DelegateExecutionAuthority } from "../../modules/computer/app/service/delegate-execution-authority";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { ExecutionAuthorityContractHandler } from "../../modules/computer/infra/authority-contract-handler";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import type { ProductAgentInput } from "./product-agent-store";
import {
  productAgentInitialPaths,
  productAgentScopeMatchesWorkspace,
} from "./product-agent-scope";

export type ProductAgentAssignmentResult = Result<
  AgentRunReceipt,
  AssignmentErrorCode
>;

export type ProductAgentAssignmentDependencies = Readonly<{
  host: AgentHost;
  assignments: AssignmentRepository;
  now(): number;
}>;

function denied(): ProductAgentAssignmentResult {
  return failure("AGENT_AUTHORITY_DENIED");
}

function currentInput(
  settings: ProductSettings,
  task: ProductTask,
  input: ProductAgentInput,
  now: number,
): boolean {
  return (
    task.provider === "chatgpt" &&
    task.taskId === input.taskId &&
    task.sessionId === input.sessionId &&
    settings.computer.generation === input.computerGeneration &&
    input.taskEpoch === input.computerGeneration &&
    input.expiresAt >= now
  );
}

export async function runProductAgentAssignment(
  settings: ProductSettings,
  task: ProductTask,
  input: ProductAgentInput,
  dependencies: ProductAgentAssignmentDependencies,
  admissionMode: "new" | "rejoin" = "new",
): Promise<ProductAgentAssignmentResult> {
  const now = dependencies.now();
  if (!currentInput(settings, task, input, now)) return denied();
  const selected = settings.computer.workspaces.find(
    (workspace) => workspace.workspaceId === input.workspaceId,
  );
  if (
    !selected ||
    selected.access !== "read" ||
    !productAgentScopeMatchesWorkspace(
      selected.root,
      selected.excludedPaths,
      input,
    )
  ) {
    return denied();
  }
  const readWorkspaces = settings.computer.workspaces.filter(
    (workspace) => workspace.access === "read",
  );
  const exactFilesOnly = input.scope.mode === "exact";
  const capabilities: ComputerApproval["capabilities"] = exactFilesOnly
    ? ["workspace.read"]
    : [
        "workspace.list",
        "workspace.read",
        "workspace.search",
        ...(settings.computer.commands === "verification"
          ? (["verification.run"] as const)
          : []),
      ];
  const commands = exactFilesOnly
    ? ("none" as const)
    : settings.computer.commands;
  const approval: ComputerApproval = {
    ownerId: "owner-desktop",
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: readWorkspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: "read" as const,
    })),
    excludedPaths: readWorkspaces.flatMap((workspace) =>
      workspace.excludedPaths.map((excluded) => ({
        workspaceId: workspace.workspaceId,
        path: excluded,
      })),
    ),
    capabilities,
    network: "none",
    commands,
    expiresAt: input.expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: input.authorityId,
    ownerId: approval.ownerId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    taskEpoch: input.taskEpoch,
    computerId: approval.computerId,
    computerGeneration: approval.generation,
    workspaces: [
      {
        workspaceId: selected.workspaceId,
        mode: "subtree",
        root: selected.root,
        access: "read",
      },
    ],
    excludedPaths: selected.excludedPaths.map((excluded) => ({
      workspaceId: selected.workspaceId,
      path: excluded,
    })),
    capabilities,
    network: "none",
    commands,
    expiresAt: input.expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, now);
  if (!grant.ok) return denied();
  const main = createParticipantAuthority(grant.value, {
    participantId: input.parentParticipantId,
    role: "main",
    mutationOwnership: "none",
  });
  if (!main.ok) return denied();
  const authorities = new InMemoryAuthorityRepository([main.value]);
  const delegate = new DelegateExecutionAuthority(authorities, {
    now: dependencies.now,
  });
  const runner = new RunAgentAssignment(
    dependencies.host,
    dependencies.assignments,
    new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(delegate),
    ),
  );
  const narrowedWorkspace =
    input.scope.mode === "subtree"
      ? {
          workspaceId: selected.workspaceId,
          mode: "subtree" as const,
          root: input.scope.root,
          access: "read" as const,
        }
      : {
          workspaceId: selected.workspaceId,
          mode: "exact" as const,
          root: input.scope.root,
          paths: [...input.scope.paths],
          access: "read" as const,
        };
  const explicitlyNarrowed =
    input.scope.mode === "exact" ||
    input.scope.root !== selected.root ||
    input.excludedPaths.length > 0;
  return runner.execute({
    identity: {
      assignmentId: input.assignmentId,
      ownerId: approval.ownerId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskEpoch: input.taskEpoch,
      generation: input.generation,
    },
    delegation: {
      parentParticipantId: input.parentParticipantId,
      participantId: input.agentParticipantId,
      role: "agent",
      mutationOwnership: "none",
      ...(explicitlyNarrowed
        ? {
            narrowing: {
              workspaces: [narrowedWorkspace],
              excludedPaths: input.excludedPaths.map((excluded) => ({
                workspaceId: selected.workspaceId,
                path: excluded,
              })),
              capabilities,
              network: "none" as const,
              commands,
            },
          }
        : {}),
    },
    focus: { initialPaths: productAgentInitialPaths(input.scope) },
    intent: { kind: "product", objective: input.objective },
    admission: admissionMode,
  });
}
