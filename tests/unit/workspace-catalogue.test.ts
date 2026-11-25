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

  const refused = (code: string, source: string): CallToolResult => {
    const value = { ok: false, error: { code, source, retry: "never" } };
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: true,
    };
  };

  it("reports a refused folder on its own entry beside the usable ones", async () => {
    const result = await discoverWorkspaces(
      ["good", "bad", "gone"],
      async (id, operation) =>
        id === "bad"
          ? refused("WORKSPACE_PATH_REFUSED", "native-workspace")
          : id === "gone"
            ? refused("WORKSPACE_NOT_FOUND", "native-workspace")
            : response(id, operation),
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      workspaces: [
        { workspaceId: "good", root: "/fixture/project" },
        {
          workspaceId: "bad",
          refusal: {
            code: "WORKSPACE_PATH_REFUSED",
            source: "native-workspace",
          },
        },
        {
          workspaceId: "gone",
          refusal: { code: "WORKSPACE_NOT_FOUND", source: "native-workspace" },
        },
      ],
    });
    const entries = (
      result.structuredContent as { workspaces: Record<string, unknown>[] }
    ).workspaces;
    // A refused entry carries no root: the unverified records are not here.
    expect(entries[1]).not.toHaveProperty("root");
    expect(entries[1]).not.toHaveProperty("approvedRoot");
  });

  it.each([
    ["authority", refused("AUTHORITY_PATH_DENIED", "task-grant")],
    ["helper failure", refused("WORKSPACE_HELPER_FAILED", "native-workspace")],
    ["race", refused("WORKSPACE_RACE_DETECTED", "native-workspace")],
    [
      "refusal from another source",
      refused("WORKSPACE_PATH_REFUSED", "contract"),
    ],
  ])("still fails the whole call on %s", async (_label, failure) => {
    const result = await discoverWorkspaces(
      ["good", "bad"],
      async (id, operation) =>
        id === "bad" ? failure : response(id, operation),
    );
    expect(result).toBe(failure);
  });

  it("discards the catalogue when a refusal appears only on the second pass", async () => {
    let calls = 0;
    const result = await discoverWorkspaces(["a"], async (id, operation) =>
      ++calls === 1
        ? response(id, operation)
        : refused("WORKSPACE_PATH_REFUSED", "native-workspace"),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "COMPUTER_WORKSPACE_CONTEXT_CHANGED" },
      },
    });
  });

  it("discards the catalogue when a refusal changes its reason on the second pass", async () => {
    let calls = 0;
    const result = await discoverWorkspaces(["a"], async () =>
      ++calls === 1
        ? refused("WORKSPACE_NOT_FOUND", "native-workspace")
        : refused("WORKSPACE_PATH_REFUSED", "native-workspace"),
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "COMPUTER_WORKSPACE_CONTEXT_CHANGED" },
      },
    });
  });

  it("marks a root that other users can change", async () => {
    const result = await discoverWorkspaces(["a", "b"], async (id, operation) =>
      response(id, operation, {
        kind: "workspace.context",
        root: "/fixture/project",
        approvedRoot: { path: "/fixture", device: "1", inode: "2" },
        scope: "subtree",
        ...(id === "b" ? { writableByOthers: true } : {}),
      }),
    );
    const entries = (
      result.structuredContent as { workspaces: Record<string, unknown>[] }
    ).workspaces;
    expect(entries[0]).not.toHaveProperty("writableByOthers");
    expect(entries[1]).toMatchObject({ writableByOthers: true });
  });
});
