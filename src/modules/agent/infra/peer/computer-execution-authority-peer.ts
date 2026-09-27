import type {
  AgentAuthorityDecision,
  AgentAuthorityFailureSource,
  AgentAuthorityPort,
  AgentDelegationRequest,
  AgentAuthorityCapability,
} from "../../app/port/execution-authority";
import {
  ExecutionAuthorityDelegationResponseSchema,
  type ExecutionAuthorityContract,
} from "../../../computer/contract/execution-authority-contract";

function mapSource(source: string): AgentAuthorityFailureSource {
  switch (source) {
    case "computer-approval":
    case "task-admission":
    case "task-grant":
    case "owner-restriction":
    case "unverified-provenance":
    case "role":
    case "computer-policy":
    case "native-host":
      return source;
    default:
      return "authority-store";
  }
}

export class ComputerExecutionAuthorityPeer implements AgentAuthorityPort {
  constructor(private readonly contract: ExecutionAuthorityContract) {}

  async delegate(
    request: AgentDelegationRequest,
  ): Promise<AgentAuthorityDecision> {
    const answer = await this.contract.delegate({
      ownerId: request.identity.ownerId,
      sessionId: request.identity.sessionId,
      taskId: request.identity.taskId,
      taskEpoch: request.identity.taskEpoch,
      parentParticipantId: request.parentParticipantId,
      participantId: request.participantId,
      role: request.role,
      mutationOwnership: request.mutationOwnership,
      ...(request.narrowing ? { narrowing: request.narrowing } : {}),
    });
    // The answer crosses a module boundary: it is parsed here, not trusted
    // for having the contract's type.
    const parsed = ExecutionAuthorityDelegationResponseSchema.safeParse(answer);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "AGENT_AUTHORITY_UNAVAILABLE",
          source: "authority-store",
          retry: "never",
        },
      };
    }
    const response = parsed.data;
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code:
            response.error.code === "AUTHORITY_STORE_UNAVAILABLE"
              ? "AGENT_AUTHORITY_UNAVAILABLE"
              : "AGENT_AUTHORITY_DENIED",
          source: mapSource(response.error.source),
          retry: "never",
        },
      };
    }
    // Agent assignments never acquire the ordinary owner's shell grant.
    // Reject an unexpected response rather than erasing the capability and
    // pretending that the provider narrowed it.
    if (
      response.value.commands === "workspace" ||
      response.value.capabilities.includes("workspace.shell")
    ) {
      return {
        ok: false,
        error: {
          code: "AGENT_AUTHORITY_UNAVAILABLE",
          source: "authority-store",
          retry: "never",
        },
      };
    }
    return {
      ok: true,
      value: {
        ...response.value,
        capabilities: response.value.capabilities.filter(
          (capability): capability is AgentAuthorityCapability =>
            capability !== "workspace.shell",
        ),
      },
    };
  }
}
