import { describe, expect, it } from "vitest";

import {
  authorityCallSchema,
  computerCallSchema,
  computerOperationSchema,
  parseHistoryItems,
  relativePathSchema,
  threadReadSchema,
  threadStartSchema,
  workspaceCallSchema,
} from "./wire";

const proof = "a".repeat(64);
const common = { threadId: "t", turnId: "u", callId: "c" };

describe("relativePathSchema", () => {
  it("accepts dot and clean relative paths", () => {
    for (const ok of [".", "a", "a/b.ts"]) {
      expect(relativePathSchema.safeParse(ok).success).toBe(true);
    }
  });

  it("refuses absolute, traversal, empty-segment and control paths", () => {
    for (const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      "./a",
      "a/../b",
      "a\\b",
      "a\nb",
    ]) {
      expect(relativePathSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("computerOperationSchema", () => {
  it("refuses reading the root and out-of-range windows", () => {
    expect(
      computerOperationSchema.safeParse({
        kind: "workspace.read",
        relativePath: ".",
      }).success,
    ).toBe(false);
    for (const length of [3, 256 * 1_024 + 1]) {
      expect(
        computerOperationSchema.safeParse({
          kind: "workspace.read",
          relativePath: "a",
          range: { offset: 0, length },
        }).success,
      ).toBe(false);
    }
    expect(
      computerOperationSchema.safeParse({
        kind: "workspace.read",
        relativePath: "a",
        range: { offset: 0, length: 4 },
      }).success,
    ).toBe(true);
  });

  it("is strict and limits verification to fixed commands", () => {
    expect(
      computerOperationSchema.safeParse({
        kind: "verification.run",
        command: "git.head",
        relativePath: ".",
      }).success,
    ).toBe(true);
    expect(
      computerOperationSchema.safeParse({
        kind: "verification.run",
        command: "rm",
        relativePath: ".",
      }).success,
    ).toBe(false);
    expect(
      computerOperationSchema.safeParse({
        kind: "workspace.list",
        relativePath: "a",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("call schemas", () => {
  it("accepts a well-formed authority call and refuses extra keys", () => {
    const call = {
      ...common,
      tool: "farol_agent_authority",
      arguments: {
        assignmentId: "a",
        authorityId: "b",
        participantId: "p",
        role: "agent",
        proof: "x",
      },
    };
    expect(authorityCallSchema.safeParse(call).success).toBe(true);
    expect(authorityCallSchema.safeParse({ ...call, more: 1 }).success).toBe(
      false,
    );
  });

  it("requires a 64-hex proof for workspace and computer calls", () => {
    const args = { assignmentId: "a", authorityId: "b", participantId: "p" };
    expect(
      workspaceCallSchema.safeParse({
        ...common,
        tool: "farol_agent_workspace_probe",
        arguments: { ...args, proof },
      }).success,
    ).toBe(true);
    expect(
      workspaceCallSchema.safeParse({
        ...common,
        tool: "farol_agent_workspace_probe",
        arguments: { ...args, proof: "short" },
      }).success,
    ).toBe(false);
    expect(
      computerCallSchema.safeParse({
        ...common,
        tool: "farol_agent_computer",
        arguments: {
          ...args,
          proof,
          workspaceId: "w",
          operation: { kind: "workspace.list", relativePath: "." },
        },
      }).success,
    ).toBe(true);
  });
});

describe("thread schemas", () => {
  it("restricts thread start models", () => {
    const thread = { id: "t" };
    expect(
      threadStartSchema.safeParse({ model: "chatgpt", thread }).success,
    ).toBe(true);
    expect(
      threadStartSchema.safeParse({ model: "other", thread }).success,
    ).toBe(false);
  });

  it("requires thread source and status in a read", () => {
    const thread = {
      id: "t",
      source: "x",
      status: { type: "idle" },
      turns: [],
    };
    expect(threadReadSchema.safeParse({ thread }).success).toBe(true);
    expect(
      threadReadSchema.safeParse({ thread: { ...thread, status: {} } }).success,
    ).toBe(false);
  });

  it("silently drops unparseable history items", () => {
    const parsed = parseHistoryItems({
      id: "u",
      status: "completed",
      items: [
        {
          id: "i",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: "t",
          receiverThreadIds: [],
          agentsStates: {},
        },
        { type: "nonsense" },
      ],
    });
    expect(parsed).toHaveLength(1);
  });
});
