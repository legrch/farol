import type { DelegateExecutionAuthority } from "../app/service/delegate-execution-authority";
import {
  ExecutionAuthorityDelegationRequestSchema,
  type ExecutionAuthorityContract,
  type ExecutionAuthorityDelegationResponse,
} from "../contract/execution-authority-contract";

export class ExecutionAuthorityContractHandler implements ExecutionAuthorityContract {
  constructor(private readonly service: DelegateExecutionAuthority) {}

  async delegate(
    request: unknown,
  ): Promise<ExecutionAuthorityDelegationResponse> {
    const parsed = ExecutionAuthorityDelegationRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "AUTHORITY_INVALID_REQUEST",
          source: "contract",
          retry: "never",
        },
      };
    }
    const value = parsed.data;
    const result = await this.service.execute({
      ownerId: value.ownerId,
      sessionId: value.sessionId,
      taskId: value.taskId,
      taskEpoch: value.taskEpoch,
      parentParticipantId: value.parentParticipantId,
      participantId: value.participantId,
      role: value.role,
      mutationOwnership: value.mutationOwnership,
      ...(value.narrowing ? { narrowing: value.narrowing } : {}),
    });
    if (!result.ok) return result;
    const authority = result.value;
    return {
      ok: true,
      value: {
        authorityId: authority.grant.authorityId,
        participantId: authority.participantId,
        parentParticipantId: authority.parentParticipantId ?? "",
        role: authority.role === "main" ? "agent" : authority.role,
        mutationOwnership: authority.mutationOwnership,
        ownerId: authority.grant.ownerId,
        sessionId: authority.grant.sessionId,
        taskId: authority.grant.taskId,
        taskEpoch: authority.grant.taskEpoch,
        computerId: authority.grant.computerId,
        computerGeneration: authority.grant.computerGeneration,
        workspaces: authority.grant.workspaces.map((scope) =>
          scope.mode === "subtree"
            ? {
                workspaceId: scope.workspaceId,
                mode: scope.mode,
                root: scope.root,
                access: scope.access,
              }
            : {
                workspaceId: scope.workspaceId,
                mode: scope.mode,
                root: scope.root,
                paths: [...scope.paths],
                access: scope.access,
              },
        ),
        capabilities: [...authority.grant.capabilities],
        network: authority.grant.network,
        commands: authority.grant.commands,
        expiresAt: authority.grant.expiresAt,
      },
    };
  }
}
