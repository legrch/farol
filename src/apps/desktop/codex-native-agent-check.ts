import { createHash } from "node:crypto";
import type { AgentHost } from "../../modules/agent/app/port/agent-host";
import type { AssignmentRepository } from "../../modules/agent/app/port/assignment-repository";
import { AcknowledgeAgentResult } from "../../modules/agent/app/service/acknowledge-agent-result";
import { RunAgentAssignment } from "../../modules/agent/app/service/run-agent-assignment";
import { ComputerExecutionAuthorityPeer } from "../../modules/agent/infra/peer/computer-execution-authority-peer";
import { DelegateExecutionAuthority } from "../../modules/computer/app/service/delegate-execution-authority";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type AuthorityCapability,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { ExecutionAuthorityContractHandler } from "../../modules/computer/infra/authority-contract-handler";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import type {
  ProductConfigurationEvidence,
  ProductSettings,
} from "../../pkg/product-settings/contract";

type NativeAgentEvidence = Extract<
  ProductConfigurationEvidence,
  { kind: "host.codex-agent-lineage" }
>;

export type CodexNativeAgentCheckResult =
  | Readonly<{ status: "completed"; evidence: NativeAgentEvidence }>
  | Readonly<{
      status:
        "workspace_not_verified" | "running" | "failed" | "outcome_unknown";
      code: string;
    }>;

export type CodexNativeAgentCheckInput = Readonly<{
  host: AgentHost;
  assignments: AssignmentRepository;
  settings: ProductSettings;
  workspaceId: string;
  executableSha256: string;
  schemaSha256: string;
  buildId: string;
  now(): number;
  pause(): Promise<void>;
  maximumWaitCycles: number;
  boundedRunningObserved?: boolean;
}>;

const READ_CAPABILITIES: readonly AuthorityCapability[] = [
  "workspace.list",
  "workspace.read",
  "workspace.search",
];
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failure(
  status: Exclude<CodexNativeAgentCheckResult["status"], "completed">,
  code: string,
): CodexNativeAgentCheckResult {
  return { status, code };
}

function exactHostIsVerified(input: CodexNativeAgentCheckInput): boolean {
  const host = input.settings.nativeHosts.codex;
  const live = host?.liveVerification;
  return (
    SHA256.test(input.executableSha256) &&
    SHA256.test(input.schemaSha256) &&
    SHA256.test(input.buildId) &&
    host?.executableSha256 === input.executableSha256 &&
    host.schemaSha256 === input.schemaSha256 &&
    live?.model === "gpt-6-astra" &&
    live.executableSha256 === input.executableSha256 &&
    live.schemaSha256 === input.schemaSha256 &&
    live.buildId === input.buildId
  );
}

function verifiedWorkspace(input: CodexNativeAgentCheckInput) {
  const settings = input.settings;
  const workspace = settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === input.workspaceId,
  );
  const verification = settings.setup.computer.verified;
  return workspace?.access === "read" &&
    verification?.workspaceId === input.workspaceId &&
    verification.configRevision === settings.computer.generation &&
    verification.buildId === input.buildId &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown
    ? workspace
    : null;
}

function assignmentFingerprint(input: CodexNativeAgentCheckInput): string {
  return sha256(
    JSON.stringify([
      input.buildId,
      input.executableSha256,
      input.schemaSha256,
      input.settings.computer.computerId,
      input.settings.computer.generation,
      input.workspaceId,
      input.settings.computer.workspaces,
    ]),
  );
}

export async function runCodexNativeAgentCheck(
  input: CodexNativeAgentCheckInput,
): Promise<CodexNativeAgentCheckResult> {
  if (
    !Number.isSafeInteger(input.maximumWaitCycles) ||
    input.maximumWaitCycles < 1 ||
    input.maximumWaitCycles > 10_000 ||
    !exactHostIsVerified(input)
  ) {
    return failure("failed", "AGENT_CHECK_INPUT_INVALID");
  }
  const selectedWorkspace = verifiedWorkspace(input);
  if (!selectedWorkspace) {
    return failure("workspace_not_verified", "AGENT_WORKSPACE_NOT_VERIFIED");
  }
  const workspaces = input.settings.computer.workspaces.filter(
    (workspace) => workspace.access === "read",
  );
  if (workspaces.length === 0) {
    return failure("workspace_not_verified", "AGENT_WORKSPACE_NOT_VERIFIED");
  }

  const fingerprint = assignmentFingerprint(input);
  const suffix = fingerprint.slice(0, 32);
  const ownerId = "owner-desktop";
  const sessionId = `native-agent-session-${suffix}`;
  const taskId = `native-agent-task-${suffix}`;
  const mainParticipantId = `main-${suffix}`;
  const agentParticipantId = `agent-${suffix}`;
  const criticParticipantId = `critic-${suffix}`;
  const expiresAt = input.now() + 5 * 60_000;
  const excludedPaths = workspaces.flatMap((workspace) =>
    workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
  );
  const approval: ComputerApproval = {
    ownerId,
    computerId: input.settings.computer.computerId,
    generation: input.settings.computer.generation,
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: "read" as const,
    })),
    excludedPaths,
    capabilities: READ_CAPABILITIES,
    network: "none",
    commands: "none",
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: `authority-${suffix}`,
    ownerId,
    sessionId,
    taskId,
    taskEpoch: input.settings.computer.generation,
    computerId: input.settings.computer.computerId,
    computerGeneration: input.settings.computer.generation,
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      mode: "subtree" as const,
      root: workspace.root,
      access: "read" as const,
    })),
    excludedPaths,
    capabilities: READ_CAPABILITIES,
    network: "none",
    commands: "none",
    expiresAt,
  };
  const taskGrant = deriveTaskGrant(approval, admission, input.now());
  if (!taskGrant.ok) return failure("failed", taskGrant.error.code);
  const main = createParticipantAuthority(taskGrant.value, {
    participantId: mainParticipantId,
    role: "main",
    mutationOwnership: "none",
  });
  if (!main.ok) return failure("failed", main.error.code);

  const authorities = new InMemoryAuthorityRepository([main.value]);
  const delegator = new DelegateExecutionAuthority(authorities, {
    now: input.now,
  });
  const agent = await delegator.execute({
    ownerId,
    sessionId,
    taskId,
    taskEpoch: admission.taskEpoch,
    parentParticipantId: mainParticipantId,
    participantId: agentParticipantId,
    role: "agent",
    mutationOwnership: "none",
  });
  if (!agent.ok) return failure("failed", agent.error.code);
  if (JSON.stringify(agent.value.grant) !== JSON.stringify(main.value.grant)) {
    return failure("failed", "AGENT_AUTHORITY_CONTINUITY_INVALID");
  }

  const identity = {
    assignmentId: `assignment-${suffix}`,
    ownerId,
    sessionId,
    taskId,
    taskEpoch: admission.taskEpoch,
    generation: 1,
  } as const;
  const runner = new RunAgentAssignment(
    input.host,
    input.assignments,
    new ComputerExecutionAuthorityPeer(
      new ExecutionAuthorityContractHandler(delegator),
    ),
  );
  const command = {
    identity,
    delegation: {
      parentParticipantId: agentParticipantId,
      participantId: criticParticipantId,
      role: "critic" as const,
      mutationOwnership: "none" as const,
    },
    focus: { initialPaths: [selectedWorkspace.root] },
  };
  let boundedRunning = input.boundedRunningObserved ?? false;
  for (let cycle = 0; cycle < input.maximumWaitCycles; cycle += 1) {
    const run = await runner.execute(command);
    if (!run.ok) return failure("failed", run.error.code);
    const receipt = run.value;
    const assignment = receipt.assignment;
    if (assignment.phase === "running") {
      boundedRunning = true;
      if (cycle + 1 >= input.maximumWaitCycles) {
        return failure("running", "AGENT_STILL_RUNNING");
      }
      await input.pause();
      continue;
    }
    if (assignment.phase === "outcome_unknown") {
      return failure(
        "outcome_unknown",
        assignment.terminalReason?.code ?? "AGENT_OUTCOME_UNKNOWN",
      );
    }
    if (assignment.phase === "failed") {
      return failure(
        "failed",
        assignment.terminalReason?.code ?? "AGENT_LIVE_FAILED",
      );
    }
    if (assignment.phase !== "completed") {
      return failure("failed", "AGENT_STATE_INVALID");
    }
    if (
      !boundedRunning ||
      receipt.resultRetention !== "durable" ||
      !receipt.resultRef ||
      !receipt.resultRef.startsWith("codex-app-server://") ||
      !assignment.parentThreadId ||
      !assignment.childId ||
      !assignment.delegationDigest
    ) {
      return failure("failed", "AGENT_EVIDENCE_INCOMPLETE");
    }
    const correlation = {
      ...assignment.identity,
      authorityId: assignment.authority.authorityId,
      participantId: assignment.authority.participantId,
      role: assignment.authority.role,
      parentThreadId: assignment.parentThreadId,
      childId: assignment.childId,
      hostRole: assignment.hostRole,
      delegationDigest: assignment.delegationDigest,
    };
    const acknowledged = await new AcknowledgeAgentResult(
      input.assignments,
    ).execute({
      correlation,
      parentParticipantId: assignment.authority.parentParticipantId,
      resultRef: receipt.resultRef,
    });
    if (!acknowledged.ok) {
      return failure("failed", acknowledged.error.code);
    }
    if (acknowledged.value.parentDelivery !== "acknowledged") {
      return failure("failed", "AGENT_DELIVERY_UNACKNOWLEDGED");
    }
    return {
      status: "completed",
      evidence: {
        kind: "host.codex-agent-lineage",
        model: "gpt-6-astra",
        executableSha256: input.executableSha256,
        schemaSha256: input.schemaSha256,
        buildId: input.buildId,
        workspaceId: input.workspaceId,
        computerGeneration: input.settings.computer.generation,
        transport: "codex-native-agent/spawn-prompt-sha256-v1",
        authorityRole: assignment.authority.role,
        hostRole: assignment.hostRole,
        delegationDigest: assignment.delegationDigest,
        parentThreadSha256: sha256(assignment.parentThreadId),
        childThreadSha256: sha256(assignment.childId),
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      },
    };
  }
  return failure("failed", "AGENT_WAIT_BUDGET_INVALID");
}
