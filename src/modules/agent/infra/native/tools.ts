import type { AgentSpawnRequest } from "../../app/port/agent-host";

export function authorityDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_authority",
    description:
      "Confirm the exact Farol assignment authority after the parent waited for the correlated native child.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string" },
        authorityId: { type: "string" },
        participantId: { type: "string" },
        role: { type: "string", enum: ["agent", "critic"] },
        proof: { type: "string" },
      },
      required: [
        "assignmentId",
        "authorityId",
        "participantId",
        "role",
        "proof",
      ],
    },
  };
}

export function workspaceProbeDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_workspace_probe",
    description:
      "Run one fixed content-free Farol Computer workspace enforcement probe for the correlated native child.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string" },
        authorityId: { type: "string" },
        participantId: { type: "string" },
        proof: { type: "string" },
      },
      required: ["assignmentId", "authorityId", "participantId", "proof"],
    },
  };
}

export function agentComputerDynamicTool() {
  return {
    type: "function",
    name: "farol_agent_computer",
    description:
      "List, search, read, or run a fixed no-network verification in an approved Farol Computer workspace under the exact inherited TaskGrant. A file over 256 KiB cannot be read whole: read it in windows with range {offset, length} (bytes; length 4 to 262144) and continue at page.nextOffset until it is null.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        assignmentId: { type: "string" },
        authorityId: { type: "string" },
        participantId: { type: "string" },
        proof: { type: "string" },
        workspaceId: { type: "string" },
        operation: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.read" },
                relativePath: { type: "string" },
                range: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    offset: { type: "integer", minimum: 0 },
                    length: { type: "integer", minimum: 4, maximum: 262144 },
                  },
                  required: ["offset", "length"],
                },
              },
              required: ["kind", "relativePath"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.list" },
                relativePath: { type: "string" },
              },
              required: ["kind", "relativePath"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "workspace.search" },
                relativePath: { type: "string" },
                pattern: { type: "string" },
              },
              required: ["kind", "relativePath", "pattern"],
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { const: "verification.run" },
                command: { enum: ["git.status", "git.head"] },
                relativePath: { const: "." },
              },
              required: ["kind", "command", "relativePath"],
            },
          ],
        },
      },
      required: [
        "assignmentId",
        "authorityId",
        "participantId",
        "proof",
        "workspaceId",
        "operation",
      ],
    },
  };
}

export function dynamicTools(request: AgentSpawnRequest) {
  return [
    authorityDynamicTool(),
    request.intent.kind === "compatibility"
      ? workspaceProbeDynamicTool()
      : agentComputerDynamicTool(),
  ];
}
