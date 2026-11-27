import { describe, expect, it } from "vitest";

import type { AgentSpawnRequest } from "../../app/port/agent-host";
import { dynamicTools } from "./tools";

function requestOf(kind: "compatibility" | "product"): AgentSpawnRequest {
  return { intent: { kind } } as unknown as AgentSpawnRequest;
}

describe("native agent dynamic tools", () => {
  it("offers the authority tool first and the workspace probe for compatibility", () => {
    expect(dynamicTools(requestOf("compatibility")).map((t) => t.name)).toEqual(
      ["farol_agent_authority", "farol_agent_workspace_probe"],
    );
  });

  it("offers the computer tool for product assignments", () => {
    expect(dynamicTools(requestOf("product")).map((t) => t.name)).toEqual([
      "farol_agent_authority",
      "farol_agent_computer",
    ]);
  });

  it("keeps every tool schema closed and function typed", () => {
    for (const tool of dynamicTools(requestOf("product"))) {
      expect(tool.type).toBe("function");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const computer = dynamicTools(requestOf("product"))[1]!;
    expect(computer.inputSchema.required).toEqual([
      "assignmentId",
      "authorityId",
      "participantId",
      "proof",
      "workspaceId",
      "operation",
    ]);
  });
});
