import { describe, expect, it } from "vitest";

import type { AgentSpawnRequest } from "../../app/port/agent-host";
import {
  canonicalAbsolutePath,
  compatible,
  validDuration,
  within,
} from "./grant";

function base(): AgentSpawnRequest {
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
        {
          workspaceId: "farol",
          mode: "subtree",
          root: "/workspace/farol",
          access: "read",
        },
      ],
      excludedPaths: [
        { workspaceId: "farol", path: "/workspace/farol/private" },
      ],
      capabilities: ["workspace.list", "workspace.read"],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    },
    focus: { initialPaths: ["/workspace/farol/README.md"] },
    intent: { kind: "compatibility" },
  } as AgentSpawnRequest;
}

describe("path rules", () => {
  it("accepts only canonical absolute paths", () => {
    expect(canonicalAbsolutePath("/a/b")).toBe(true);
    expect(canonicalAbsolutePath("/")).toBe(true);
    for (const bad of ["a/b", "/a/", "/a/../b", "/a//b", "/a/./b", "/a\0b"]) {
      expect(canonicalAbsolutePath(bad)).toBe(false);
    }
  });

  it("checks containment by path segment", () => {
    expect(within("/a", "/a")).toBe(true);
    expect(within("/a", "/a/b")).toBe(true);
    expect(within("/a", "/ab")).toBe(false);
    expect(within("/a", "/a/../b")).toBe(false);
  });

  it("accepts only positive safe integer durations", () => {
    expect(validDuration(1)).toBe(true);
    expect(validDuration(0)).toBe(false);
    expect(validDuration(1.5)).toBe(false);
    expect(validDuration(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});

describe("compatible", () => {
  const ok = (request: AgentSpawnRequest) =>
    compatible(request, 1_000, "/runtime");

  it("admits the baseline request", () => {
    expect(ok(base())).toBe(true);
  });

  it("refuses expired authority and identity mismatch", () => {
    expect(compatible(base(), 10_001, "/runtime")).toBe(false);
    const request = base();
    expect(
      ok({
        ...request,
        identity: { ...request.identity, taskEpoch: 4 },
      }),
    ).toBe(false);
  });

  it("refuses focus on an excluded path or outside the workspace", () => {
    const request = base();
    for (const initialPaths of [
      ["/workspace/farol/private/x"],
      ["/elsewhere/x"],
      [],
      ["/workspace/farol/a", "/workspace/farol/a"],
    ]) {
      expect(ok({ ...request, focus: { initialPaths } })).toBe(false);
    }
  });

  it("refuses a workspace overlapping the runtime root", () => {
    expect(compatible(base(), 1_000, "/workspace")).toBe(false);
    expect(compatible(base(), 1_000, "/workspace/farol/rt")).toBe(false);
  });

  it("refuses network, mutation, write access and unknown capabilities", () => {
    const request = base();
    const authority = request.authority;
    for (const patch of [
      { network: "any" },
      { mutationOwnership: "task" },
      { capabilities: ["workspace.write"] },
      { commands: "verification" },
    ]) {
      expect(
        ok({
          ...request,
          authority: { ...authority, ...patch },
        } as unknown as AgentSpawnRequest),
      ).toBe(false);
    }
  });

  it("requires a bounded objective for product intent", () => {
    const request = base();
    const product = (objective: string) =>
      ok({
        ...request,
        intent: { kind: "product", objective },
      } as AgentSpawnRequest);
    expect(product("do it")).toBe(true);
    expect(product("   ")).toBe(false);
    expect(product("x".repeat(8_001))).toBe(false);
    expect(product("a\0b")).toBe(false);
  });
});
