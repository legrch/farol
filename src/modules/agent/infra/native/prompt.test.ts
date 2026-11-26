import { describe, expect, it } from "vitest";

import type { AgentSpawnRequest } from "../../app/port/agent-host";
import {
  assignmentEnvelope,
  baseInstructions,
  childPrompt,
  parentPrompt,
} from "./prompt";
import { computerProof, workspaceProof } from "./proof";

function requestOf(
  intent: AgentSpawnRequest["intent"],
  mode: "subtree" | "exact" = "subtree",
  capabilities: readonly string[] = ["workspace.read"],
): AgentSpawnRequest {
  return {
    identity: {
      assignmentId: "assignment-a",
      ownerId: "owner-a",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      generation: 5,
    },
    authority: {
      authorityId: "authority-a",
      participantId: "critic-a",
      parentParticipantId: "main-a",
      role: "critic",
      mutationOwnership: "none",
      ownerId: "owner-a",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      computerId: "computer-a",
      computerGeneration: 7,
      workspaces: [
        mode === "subtree"
          ? { workspaceId: "w", mode, root: "/w", access: "read" }
          : {
              workspaceId: "w",
              mode,
              root: "/w",
              paths: ["/w/a"],
              access: "read",
            },
      ],
      excludedPaths: [{ workspaceId: "w", path: "/w/x" }],
      capabilities,
      network: "none",
      commands: "none",
      expiresAt: 10,
    },
    focus: { initialPaths: ["/w/a"] },
    intent,
  } as unknown as AgentSpawnRequest;
}

describe("assignmentEnvelope", () => {
  it("projects subtree and exact workspaces with their own keys", () => {
    const subtree = assignmentEnvelope(requestOf({ kind: "compatibility" }));
    expect(subtree.authority.workspaces[0]).toEqual({
      workspaceId: "w",
      mode: "subtree",
      root: "/w",
      access: "read",
    });
    const exact = assignmentEnvelope(
      requestOf({ kind: "compatibility" }, "exact"),
    );
    expect(exact.authority.workspaces[0]).toEqual({
      workspaceId: "w",
      mode: "exact",
      root: "/w",
      paths: ["/w/a"],
      access: "read",
    });
    expect(exact.schema).toBe(1);
    expect(exact.kind).toBe("farol_task_grant");
    expect(exact.focus).toEqual({ initialPaths: ["/w/a"] });
  });
});

describe("childPrompt", () => {
  it("emits the compatibility probe prompt with the workspace proof", () => {
    const request = requestOf({ kind: "compatibility" });
    const lines = childPrompt(request).split("\n");
    expect(lines[0]).toBe("FAROL_NATIVE_AGENT_TASK_V1");
    expect(lines).toHaveLength(6);
    expect(lines[2]).toContain(
      workspaceProof({
        assignmentId: "assignment-a",
        authorityId: "authority-a",
        participantId: "critic-a",
      }),
    );
    expect(lines[5]).toBe("Reply only FAROL_NATIVE_AGENT_CHILD_OK.");
  });

  it("emits the product prompt with scope and verification guidance", () => {
    const subtree = childPrompt(
      requestOf({ kind: "product", objective: "Review it" }),
    ).split("\n");
    expect(subtree[0]).toBe("FAROL_NATIVE_AGENT_TASK_V2");
    expect(JSON.parse(subtree[1]!).objective).toBe("Review it");
    expect(subtree[2]).toBe("Complete this exact owner assignment: Review it");
    expect(subtree[3]).toContain(
      computerProof({
        assignmentId: "assignment-a",
        authorityId: "authority-a",
        participantId: "critic-a",
      }),
    );
    expect(subtree[4]).toBe(
      "Use only these operations allowed by the supplied TaskGrant: workspace.read.",
    );
    expect(subtree[5]).toContain("focus, not the authority boundary");
    expect(subtree[6]).toContain("verification.run is not granted");

    const exact = childPrompt(
      requestOf({ kind: "product", objective: "Review it" }, "exact", [
        "workspace.read",
        "verification.run",
      ]),
    ).split("\n");
    expect(exact[5]).toContain("exact file authority boundary");
    expect(exact[6]).toContain(
      "verification.run is permitted only through farol_agent_computer",
    );
  });
});

describe("baseInstructions and parentPrompt", () => {
  it("selects instructions by intent kind", () => {
    expect(baseInstructions(requestOf({ kind: "compatibility" }))).toContain(
      "compatibility assignment",
    );
    expect(
      baseInstructions(requestOf({ kind: "product", objective: "o" })),
    ).toContain("product assignment");
  });

  it("adds route guidance only for the neutral chatgpt model", () => {
    const request = requestOf({ kind: "compatibility" });
    const neutral = parentPrompt(request, "proof-1", "CHILD", "chatgpt");
    const legacy = parentPrompt(request, "proof-1", "CHILD", "gpt-6-astra");
    expect(neutral).toContain("Set fork_context=false");
    expect(legacy).not.toContain("fork_context");
    for (const text of [neutral, legacy]) {
      expect(text).toContain(
        "FAROL_CHILD_PROMPT_BEGIN\nCHILD\nFAROL_CHILD_PROMPT_END",
      );
      expect(text).toContain("The Farol responsibility role is critic.");
      expect(text).toContain("role critic, and proof proof-1.");
    }
  });
});
