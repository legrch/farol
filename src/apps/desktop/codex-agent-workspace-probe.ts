import type {
  AgentWorkspaceProbe,
  AgentWorkspaceProbeReceipt,
  AgentWorkspaceProbeRequest,
} from "../../modules/agent/app/port/workspace-probe";
import type {
  AgentComputer,
  AgentComputerReceipt,
  AgentComputerRequest,
} from "../../modules/agent/app/port/computer";
import type { ReadonlyWorkspace } from "../../modules/computer/app/port/readonly-workspace";
import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";
import type {
  ComputerApproval,
  ParticipantAuthority,
} from "../../modules/computer/domain/execution-authority";
import { deriveTaskGrant } from "../../modules/computer/domain/execution-authority";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import type { ProductSettings } from "../../pkg/product-settings/contract";

type AuthorityBoundRequest = Readonly<
  Pick<AgentWorkspaceProbeRequest, "identity" | "authority">
>;

function probeFailure(
  code: Extract<AgentWorkspaceProbeReceipt, { status: "failed" }>["code"],
): AgentWorkspaceProbeReceipt {
  return { status: "failed", code };
}

function computerFailure(
  code: string,
  source: Extract<AgentComputerReceipt, { status: "failed" }>["source"],
): AgentComputerReceipt {
  return { status: "failed", code, source, retry: "never" };
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function relativePath(root: string, candidate: string): string | null {
  if (candidate === root) return ".";
  return inside(root, candidate) ? candidate.slice(root.length + 1) : null;
}

function participant(request: AuthorityBoundRequest): ParticipantAuthority {
  const authority = request.authority;
  return {
    participantId: authority.participantId,
    parentParticipantId: authority.parentParticipantId,
    role: authority.role,
    mutationOwnership: authority.mutationOwnership,
    grant: {
      authorityId: authority.authorityId,
      ownerId: authority.ownerId,
      sessionId: authority.sessionId,
      taskId: authority.taskId,
      taskEpoch: authority.taskEpoch,
      computerId: authority.computerId,
      computerGeneration: authority.computerGeneration,
      workspaces: authority.workspaces.map((workspace) =>
        workspace.mode === "subtree"
          ? { ...workspace, restrictionSource: "task-grant" as const }
          : {
              ...workspace,
              paths: [...workspace.paths],
              restrictionSource: "task-grant" as const,
            },
      ),
      excludedPaths: authority.excludedPaths.map((entry) => ({
        ...entry,
        restrictionSource: "task-grant" as const,
      })),
      capabilities: [...authority.capabilities],
      network: authority.network,
      commands: authority.commands,
      expiresAt: authority.expiresAt,
    },
  };
}

function approval(
  settings: ProductSettings,
  request: AuthorityBoundRequest,
): ComputerApproval | null {
  const authority = request.authority;
  if (
    authority.computerId !== settings.computer.computerId ||
    authority.computerGeneration !== settings.computer.generation
  ) {
    return null;
  }
  const workspaces = settings.computer.workspaces.filter(
    (workspace) => workspace.access === "read",
  );
  const capabilities: ComputerApproval["capabilities"] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    ...(settings.computer.commands === "verification"
      ? (["verification.run"] as const)
      : []),
  ];
  return {
    ownerId: authority.ownerId,
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: "read" as const,
    })),
    excludedPaths: workspaces.flatMap((workspace) =>
      workspace.excludedPaths.map((excluded) => ({
        workspaceId: workspace.workspaceId,
        path: excluded,
      })),
    ),
    capabilities,
    network: "none",
    commands: settings.computer.commands,
    expiresAt: authority.expiresAt,
  };
}

function authorityMatchesCurrentPolicy(
  request: AuthorityBoundRequest,
  selectedApproval: ComputerApproval,
  now: number,
): boolean {
  const authority = request.authority;
  const derived = deriveTaskGrant(
    selectedApproval,
    {
      authorityId: authority.authorityId,
      ownerId: authority.ownerId,
      sessionId: authority.sessionId,
      taskId: authority.taskId,
      taskEpoch: authority.taskEpoch,
      computerId: authority.computerId,
      computerGeneration: authority.computerGeneration,
      workspaces: authority.workspaces,
      excludedPaths: authority.excludedPaths,
      capabilities: authority.capabilities,
      network: authority.network,
      commands: authority.commands,
      expiresAt: authority.expiresAt,
    },
    now,
  );
  if (!derived.ok) return false;
  const grant = derived.value;
  const publicGrant = {
    ...grant,
    workspaces: grant.workspaces.map(
      ({ restrictionSource: _restrictionSource, ...workspace }) => workspace,
    ),
    excludedPaths: grant.excludedPaths.map(
      ({ restrictionSource: _restrictionSource, ...entry }) => entry,
    ),
  };
  return (
    JSON.stringify(publicGrant) ===
    JSON.stringify({
      authorityId: authority.authorityId,
      ownerId: authority.ownerId,
      sessionId: authority.sessionId,
      taskId: authority.taskId,
      taskEpoch: authority.taskEpoch,
      computerId: authority.computerId,
      computerGeneration: authority.computerGeneration,
      workspaces: authority.workspaces,
      excludedPaths: authority.excludedPaths,
      capabilities: authority.capabilities,
      network: authority.network,
      commands: authority.commands,
      expiresAt: authority.expiresAt,
    })
  );
}

export class CodexAgentWorkspaceProbe
  implements AgentWorkspaceProbe, AgentComputer
{
  constructor(
    private readonly settings: ProductSettings,
    private readonly workspace: ReadonlyWorkspace,
    private readonly now: () => number,
  ) {}

  async verify(
    request: AgentWorkspaceProbeRequest,
  ): Promise<AgentWorkspaceProbeReceipt> {
    const selected = request.authority.workspaces.find(
      (workspace) =>
        workspace.access === "read" &&
        inside(workspace.root, request.focusPath) &&
        (workspace.mode === "subtree" ||
          workspace.paths.includes(request.focusPath)),
    );
    const selectedApproval = approval(this.settings, request);
    if (
      !selected ||
      !selectedApproval ||
      !authorityMatchesCurrentPolicy(request, selectedApproval, this.now())
    ) {
      return probeFailure("AGENT_WORKSPACE_BINDING_INVALID");
    }
    const relative = relativePath(selected.root, request.focusPath);
    if (relative === null) {
      return probeFailure("AGENT_WORKSPACE_BINDING_INVALID");
    }

    const action = new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([participant(request)]),
      new InMemoryComputerApprovalRepository([selectedApproval]),
      this.workspace,
      { now: this.now },
    );
    const base = {
      ownerId: request.identity.ownerId,
      sessionId: request.identity.sessionId,
      taskId: request.identity.taskId,
      taskEpoch: request.identity.taskEpoch,
      participantId: request.authority.participantId,
      turnId: request.turnId,
      generation: request.identity.generation,
    } as const;
    const allowed = await action.execute({
      ...base,
      callId: request.callId,
      workspaceId: selected.workspaceId,
      operation: { kind: "workspace.list", relativePath: relative },
    });
    if (!allowed.ok || allowed.value.output.kind !== "workspace.entries") {
      return probeFailure("AGENT_WORKSPACE_ALLOWED_PROBE_FAILED");
    }

    const outside = await action.execute({
      ...base,
      callId: `${request.callId}-outside`,
      workspaceId: "farol-next-ungranted-workspace",
      operation: { kind: "workspace.list", relativePath: "." },
    });
    if (
      outside.ok ||
      outside.error.code !== "AUTHORITY_PATH_DENIED" ||
      outside.error.source !== "task-grant"
    ) {
      return probeFailure("AGENT_WORKSPACE_OUTSIDE_GRANT_ALLOWED");
    }

    const exclusion = request.authority.excludedPaths.find(
      (entry) => entry.workspaceId === selected.workspaceId,
    );
    if (exclusion) {
      const excludedRelative = relativePath(selected.root, exclusion.path);
      if (excludedRelative === null) {
        return probeFailure("AGENT_WORKSPACE_BINDING_INVALID");
      }
      const denied = await action.execute({
        ...base,
        callId: `${request.callId}-excluded`,
        workspaceId: selected.workspaceId,
        operation: {
          kind: "workspace.list",
          relativePath: excludedRelative,
        },
      });
      if (
        denied.ok ||
        denied.error.code !== "AUTHORITY_PATH_DENIED" ||
        denied.error.source !== "task-grant"
      ) {
        return probeFailure("AGENT_WORKSPACE_EXCLUSION_ALLOWED");
      }
    }
    return { status: "verified" };
  }

  async execute(request: AgentComputerRequest): Promise<AgentComputerReceipt> {
    const selected = request.authority.workspaces.find(
      (workspace) => workspace.workspaceId === request.workspaceId,
    );
    const selectedApproval = approval(this.settings, request);
    if (
      !selected ||
      !selectedApproval ||
      !authorityMatchesCurrentPolicy(request, selectedApproval, this.now())
    ) {
      return computerFailure(
        "AGENT_COMPUTER_BINDING_INVALID",
        "owner-restriction",
      );
    }

    const action = new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([participant(request)]),
      new InMemoryComputerApprovalRepository([selectedApproval]),
      this.workspace,
      { now: this.now },
    );
    const result = await action.execute(
      {
        ownerId: request.identity.ownerId,
        sessionId: request.identity.sessionId,
        taskId: request.identity.taskId,
        taskEpoch: request.identity.taskEpoch,
        participantId: request.authority.participantId,
        turnId: request.turnId,
        generation: request.identity.generation,
        callId: request.callId,
        workspaceId: request.workspaceId,
        operation: request.operation,
      },
      request.signal ? { signal: request.signal } : {},
    );
    if (!result.ok) {
      return computerFailure(result.error.code, result.error.source);
    }
    return { status: "completed", output: result.value.output };
  }
}
