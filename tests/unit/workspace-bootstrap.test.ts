import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ReadonlyComputerCallRequest } from "../../src/modules/computer/contract/readonly-computer-contract";
import { bootstrapWorkspace } from "../../src/modules/computer/infra/mcp/workspace-bootstrap";

type Operation = ReadonlyComputerCallRequest["operation"];
const binding = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  taskEpoch: 1,
  participantId: "main",
  turnId: "turn",
  generation: 1,
  callId: "call",
  workspaceId: "selected",
};
const context = {
  kind: "workspace.context",
  root: "/fixture/workspace",
  approvedRoot: { path: "/fixture/workspace", device: "1", inode: "2" },
  scope: "subtree",
};
function response(operation: Operation, output: unknown): CallToolResult {
  return {
    content: [],
    structuredContent: {
      ...binding,
      relativePath: operation.relativePath,
      operation,
      output,
    },
  };
}
function failed(operation: Operation, code: string): CallToolResult {
  return {
    content: [],
    isError: true,
    structuredContent: {
      ok: false,
      correlation: {
        ...binding,
        relativePath: operation.relativePath,
        operation,
      },
      error: { code, source: "native-workspace", retry: "never" },
    },
  };
}

describe("instruction bootstrap contract/lifecycle boundaries", () => {
  it.each([
    ["not absolute", { ...context, root: "relative" }],
    ["outside approved root", { ...context, root: "/other/workspace" }],
    ["traversal root", { ...context, root: "/fixture/workspace/../other" }],
    [
      "wrong output kind",
      { kind: "workspace.entries", entries: [], truncated: false },
    ],
    [
      "malformed root identity",
      {
        ...context,
        approvedRoot: { ...context.approvedRoot, inode: "not-an-inode" },
      },
    ],
  ])("rejects %s before reading instructions", async (_name, output) => {
    let reads = 0;
    const result = await bootstrapWorkspace(".", async (operation) => {
      if (operation.kind === "workspace.read") reads++;
      return response(operation, output);
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "COMPUTER_CONTRACT_INVALID" },
      },
    });
    expect(reads).toBe(0);
  });
  it.each([
    "WORKSPACE_REQUEST_CANCELLED",
    "WORKSPACE_ROOT_CHANGED",
    "WORKSPACE_HELPER_FAILED",
  ])("discards collected text on %s", async (code) => {
    const result = await bootstrapWorkspace("nested", async (operation) => {
      if (operation.kind === "workspace.context")
        return response(operation, context);
      if (operation.relativePath === "AGENTS.md")
        return response(operation, {
          kind: "workspace.text",
          text: "private rules",
          bytes: 13,
          sha256: createHash("sha256").update("private rules").digest("hex"),
        });
      return failed(operation, code);
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code } },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "private rules",
    );
  });
  it.each([
    { kind: "workspace.entries", entries: [], truncated: false },
    {
      kind: "workspace.text",
      text: "partial",
      bytes: 7,
      page: { offset: 0, size: 100, nextOffset: 7 },
    },
  ])(
    "never treats a malformed/windowed whole instruction as complete",
    async (output) => {
      const result = await bootstrapWorkspace(".", async (operation) =>
        response(
          operation,
          operation.kind === "workspace.context" ? context : output,
        ),
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { code: "COMPUTER_CONTRACT_INVALID" },
        },
      });
    },
  );
  it("does not turn an unparsed transport failure into an instruction absence", async () => {
    const failure = {
      content: [],
      isError: true,
      structuredContent: {
        ok: false,
        error: { code: "COMPUTER_CONTRACT_UNAVAILABLE" },
      },
    };
    const result = await bootstrapWorkspace(".", async (operation) =>
      operation.kind === "workspace.context"
        ? response(operation, context)
        : failure,
    );
    expect(result).toEqual(failure);
  });
  it.each(["refused", "rebound"])(
    "discards the chain when final context is %s",
    async (mode) => {
      let contexts = 0;
      const result = await bootstrapWorkspace(".", async (operation) => {
        if (operation.kind === "workspace.read")
          return response(operation, {
            kind: "workspace.text",
            text: "private rules",
            bytes: 13,
            sha256: createHash("sha256").update("private rules").digest("hex"),
          });
        if (++contexts === 1) return response(operation, context);
        return mode === "refused"
          ? failed(operation, "WORKSPACE_ROOT_CHANGED")
          : response(operation, {
              ...context,
              approvedRoot: { ...context.approvedRoot, inode: "3" },
            });
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code:
              mode === "refused"
                ? "WORKSPACE_ROOT_CHANGED"
                : "COMPUTER_WORKSPACE_CONTEXT_CHANGED",
          },
        },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "private rules",
      );
    },
  );

  it("projects validated full-read guidance to text and bytes only", async () => {
    const result = await bootstrapWorkspace(".", async (operation) =>
      response(
        operation,
        operation.kind === "workspace.context"
          ? context
          : {
              kind: "workspace.text",
              text: "rules\n",
              bytes: 6,
              sha256: createHash("sha256").update("rules\n").digest("hex"),
            },
      ),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      instructions: [
        {
          relativePath: "AGENTS.md",
          status: "read",
          text: "rules\n",
          bytes: 6,
        },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty(
      "instructions.0.sha256",
    );
    expect(result.structuredContent).not.toHaveProperty("instructions.0.page");
  });
});
