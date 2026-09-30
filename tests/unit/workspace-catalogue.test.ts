import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { discoverWorkspaces } from "../../src/modules/computer/infra/mcp/workspace-catalogue";
import type { ReadonlyComputerCallRequest } from "../../src/modules/computer/contract/readonly-computer-contract";

function response(
  workspaceId: string,
  operation: ReadonlyComputerCallRequest["operation"],
  output: unknown = {
    kind: "workspace.context",
    root: "/fixture/project",
    approvedRoot: { path: "/fixture", device: "1", inode: "2" },
    scope: "subtree",
  },
): CallToolResult {
  return {
    content: [],
    structuredContent: {
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      participantId: "main",
      turnId: "turn",
      generation: 1,
      callId: "call",
      workspaceId,
      relativePath: operation.relativePath,
      operation,
      output,
    },
  };
}

describe("workspace catalogue boundary", () => {
  it.each([
    ["duplicate", ["same", "same"]],
    ["oversized", Array.from({ length: 33 }, (_, i) => String(i))],
    ["empty ID", [""]],
    ["long ID", ["x".repeat(121)]],
  ])(
    "refuses %s candidate IDs before any native operation",
    async (_label, ids) => {
      const execute = vi.fn();
      const result = await discoverWorkspaces(ids as string[], execute);
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "COMPUTER_WORKSPACE_CATALOGUE_INVALID" },
        },
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("returns an explicit empty catalogue when no directory scopes were admitted", async () => {
    const execute = vi.fn();
    expect(await discoverWorkspaces([], execute)).toMatchObject({
      structuredContent: { ok: true, workspaces: [] },
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    [
      "different workspace",
      (_id: string, operation: ReadonlyComputerCallRequest["operation"]) =>
        response("foreign", operation),
    ],
    [
      "wrong output",
      (id: string, operation: ReadonlyComputerCallRequest["operation"]) =>
        response(id, operation, {
          kind: "workspace.entries",
          entries: ["private-name"],
          truncated: false,
        }),
    ],
    [
      "outside approved root",
      (id: string, operation: ReadonlyComputerCallRequest["operation"]) =>
        response(id, operation, {
          kind: "workspace.context",
          root: "/private/foreign",
          approvedRoot: { path: "/fixture", device: "1", inode: "2" },
          scope: "subtree",
        }),
    ],
  ])("discards %s contract data", async (_label, execute) => {
    const result = await discoverWorkspaces(
      ["selected"],
      async (id, operation) => execute(id, operation),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "COMPUTER_CONTRACT_INVALID" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/private/foreign");
    expect(JSON.stringify(result)).not.toContain("private-name");
  });
  it("discards every collected root when physical identity changes before final disclosure", async () => {
    let calls = 0;
    const result = await discoverWorkspaces(
      ["selected"],
      async (id, operation) => {
        calls++;
        return response(id, operation, {
          kind: "workspace.context",
          root: "/fixture/project",
          approvedRoot: { path: "/fixture", device: "1", inode: String(calls) },
          scope: "subtree",
        });
      },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "COMPUTER_WORKSPACE_CONTEXT_CHANGED" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/fixture");
  });
});
