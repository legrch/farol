import { CHATGPT_MODEL_ID } from "../../../../pkg/model-route/contract";
import type { AgentSpawnRequest } from "../../app/port/agent-host";
import { computerProof, workspaceProof } from "./proof";

export function assignmentEnvelope(request: AgentSpawnRequest) {
  const identity = request.identity;
  const authority = request.authority;
  return {
    schema: 1,
    kind: "farol_task_grant",
    assignment: {
      assignmentId: identity.assignmentId,
      ownerId: identity.ownerId,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      taskEpoch: identity.taskEpoch,
      generation: identity.generation,
    },
    authority: {
      authorityId: authority.authorityId,
      participantId: authority.participantId,
      parentParticipantId: authority.parentParticipantId,
      role: authority.role,
      mutationOwnership: authority.mutationOwnership,
      ownerId: authority.ownerId,
      sessionId: authority.sessionId,
      taskId: authority.taskId,
      taskEpoch: authority.taskEpoch,
      computerId: authority.computerId,
      computerGeneration: authority.computerGeneration,
      workspaces: authority.workspaces.map((workspace) =>
        workspace.mode === "subtree"
          ? {
              workspaceId: workspace.workspaceId,
              mode: workspace.mode,
              root: workspace.root,
              access: workspace.access,
            }
          : {
              workspaceId: workspace.workspaceId,
              mode: workspace.mode,
              root: workspace.root,
              paths: [...workspace.paths],
              access: workspace.access,
            },
      ),
      excludedPaths: authority.excludedPaths.map((entry) => ({ ...entry })),
      capabilities: [...authority.capabilities],
      network: authority.network,
      commands: authority.commands,
      expiresAt: authority.expiresAt,
    },
    focus: { initialPaths: [...request.focus.initialPaths] },
  };
}

export function childPrompt(request: AgentSpawnRequest): string {
  const identity = request.identity;
  const authority = request.authority;
  const envelope = assignmentEnvelope(request);
  if (request.intent.kind === "product") {
    const operations = request.authority.capabilities.join(", ");
    const exactFilesOnly = request.authority.workspaces.every(
      (workspace) => workspace.mode === "exact",
    );
    const scopeGuidance = exactFilesOnly
      ? "Initial paths are the exact file authority boundary. Do not list, search, or discover any other path."
      : "Initial paths are focus, not the authority boundary. You may discover other relevant files inside a granted subtree without asking for per-file approval.";
    const verificationGuidance = request.authority.capabilities.includes(
      "verification.run",
    )
      ? "verification.run is permitted only through farol_agent_computer and exposes no caller-controlled executable or arguments."
      : "verification.run is not granted for this assignment.";
    return [
      "FAROL_NATIVE_AGENT_TASK_V2",
      JSON.stringify({ ...envelope, objective: request.intent.objective }),
      `Complete this exact owner assignment: ${request.intent.objective}`,
      `For every permitted Farol Computer operation, call farol_agent_computer with assignmentId ${identity.assignmentId}, authorityId ${authority.authorityId}, participantId ${authority.participantId}, and computer proof ${computerProof({ assignmentId: identity.assignmentId, authorityId: authority.authorityId, participantId: authority.participantId })}.`,
      `Use only these operations allowed by the supplied TaskGrant: ${operations}.`,
      scopeGuidance,
      `Do not inspect files directly, run native or arbitrary commands, use the web, create descendants, or call any other tool. ${verificationGuidance}`,
      "Return a concise answer to the owner assignment.",
    ].join("\n");
  }
  return [
    "FAROL_NATIVE_AGENT_TASK_V1",
    JSON.stringify(envelope),
    `Call farol_agent_workspace_probe exactly once with assignmentId ${identity.assignmentId}, authorityId ${authority.authorityId}, participantId ${authority.participantId}, and workspace proof ${workspaceProof({ assignmentId: identity.assignmentId, authorityId: authority.authorityId, participantId: authority.participantId })}.`,
    "This fixed probe may list only the approved focus through Farol Computer and returns no file names or contents.",
    "Do not inspect files directly, run commands, use the web, create descendants, or call any other tool.",
    "Reply only FAROL_NATIVE_AGENT_CHILD_OK.",
  ].join("\n");
}

export function baseInstructions(request: AgentSpawnRequest): string {
  return request.intent.kind === "compatibility"
    ? "This is a bounded Farol compatibility assignment. Neither parent nor child may inspect files directly, run commands, or use the web. A spawned child must not create descendants and may call only farol_agent_workspace_probe exactly once. Only the root thread may spawn one child and later call farol_agent_authority."
    : "This is a bounded Farol product assignment. The root thread may spawn exactly one child and must wait for that same child before calling farol_agent_authority. The child must not create descendants and may call only farol_agent_computer. Neither thread may inspect workspaces directly, run native or arbitrary commands, or use the web. Any permitted fixed verification runs only through farol_agent_computer under the inherited TaskGrant.";
}

export function parentPrompt(
  request: AgentSpawnRequest,
  proof: string,
  exactChildPrompt: string,
  model: string,
): string {
  return [
    "Use the native collaboration tools to spawn exactly one child, then wait for that same child to finish.",
    ...(model === CHATGPT_MODEL_ID
      ? [
          "Omit model and reasoning_effort overrides when spawning the child: inherit this parent's exact Farol provider route and effort. Native override validation uses a different model catalogue.",
          "Set fork_context=false and supply only the exact child prompt below. Never substitute a built-in model or another provider. Farol independently verifies the retained child route.",
        ]
      : []),
    `The Farol responsibility role is ${request.authority.role}.`,
    "Set the child's prompt to exactly the text between the markers, byte-for-byte, without either marker or any additional text.",
    "FAROL_CHILD_PROMPT_BEGIN",
    exactChildPrompt,
    "FAROL_CHILD_PROMPT_END",
    "After that exact child completes, wait for it.",
    `Then you, the parent, must call farol_agent_authority exactly once with assignmentId ${request.identity.assignmentId}, authorityId ${request.authority.authorityId}, participantId ${request.authority.participantId}, role ${request.authority.role}, and proof ${proof}.`,
    "After FAROL_AGENT_AUTHORITY_OK, reply only FAROL_NATIVE_AGENT_OK.",
  ].join("\n");
}
