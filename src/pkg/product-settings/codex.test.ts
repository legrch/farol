import { describe, expect, it } from "vitest";
import {
  CodexTaskSelectionSchema,
  CodexTaskSourceSchema,
  validateCodexReadSelection,
} from "./codex.ts";

const id = "11111111-1111-4111-8111-111111111111";
const sha = (c: string) => c.repeat(64);

describe("codex schemas", () => {
  it("requires a thread for an observation turn", () => {
    const issues: unknown[] = [];
    validateCodexReadSelection({ observeTurnId: "turn_1" }, {
      addIssue: (issue: unknown) => issues.push(issue),
    } as never);
    expect(issues).toHaveLength(1);
    validateCodexReadSelection({ observeThreadId: id }, {
      addIssue: (issue: unknown) => issues.push(issue),
    } as never);
    expect(issues).toHaveLength(1);
  });

  it("refuses task selection with an unknown key or turn without thread", () => {
    const selection = {
      transport: "codex-shared-proxy/v1",
      socketPath: "/s",
      expectedCodexHome: "/h",
      workspaceId: id,
      projectId: id,
      projectRoot: "/p",
      projectIdentity: { device: "1", inode: "2" },
      gitCommonDirectory: "/g",
      execution: { sandbox: "read-only", approvalPolicy: "untrusted" },
      harness: "codex",
      computerGeneration: 1,
      hostGeneration: 1,
      approvedAt: "2026-01-02T03:04:05.000Z",
      expiresAt: 1,
    };
    expect(CodexTaskSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      CodexTaskSelectionSchema.safeParse({ ...selection, extra: 1 }).success,
    ).toBe(false);
    expect(
      CodexTaskSelectionSchema.safeParse({ ...selection, observeTurnId: "t" })
        .success,
    ).toBe(false);
  });

  it("refuses task source witnesses that disagree", () => {
    const unavailable = {
      executablePath: "/c",
      executableSha256: sha("a"),
      baseSchemaSha256: sha("b"),
      status: "unavailable",
    };
    const changed = { ...unavailable, code: "CODEX_HOST_TASK_SOURCE_CHANGED" };
    const invalid = { ...unavailable, code: "CODEX_HOST_SCHEMA_INVALID" };
    expect(
      CodexTaskSourceSchema.safeParse({ handoff: invalid, followup: invalid })
        .success,
    ).toBe(true);
    expect(
      CodexTaskSourceSchema.safeParse({ handoff: changed, followup: invalid })
        .success,
    ).toBe(false);
  });
});
