import { describe, expect, it } from "vitest";

import {
  authorizeTaskAction,
  type AuthorityAction,
  type ExclusionRestrictionSource,
  type ParticipantAuthority,
  type WorkspaceRestrictionSource,
} from "../../src/modules/computer/domain/execution-authority";

// How a path denial reports the provenance of the restriction that denied
// it. `deriveTaskGrant` and `narrowTaskGrant` never produce "unknown", so
// the participants here are built by hand, the way an authority
// reconstructed from an external record is (see
// `codex-agent-workspace-probe.ts`'s `participant()`).

function participant(
  input: Readonly<{
    scopeSource: WorkspaceRestrictionSource;
    exclusionSource: ExclusionRestrictionSource;
  }>,
): ParticipantAuthority {
  return {
    participantId: "agent-a",
    parentParticipantId: "main-a",
    role: "agent",
    mutationOwnership: "none",
    grant: {
      authorityId: "authority-a",
      ownerId: "owner-a",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 1,
      computerId: "computer-a",
      computerGeneration: 1,
      workspaces: [
        {
          workspaceId: "workspace-a",
          mode: "subtree",
          root: "/workspace/a",
          access: "read",
          restrictionSource: input.scopeSource,
        },
      ],
      excludedPaths: [
        {
          workspaceId: "workspace-a",
          path: "/workspace/a/private",
          restrictionSource: input.exclusionSource,
        },
      ],
      capabilities: ["workspace.read"],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    },
  };
}

function read(workspaceId: string, path: string): AuthorityAction {
  return {
    ownerId: "owner-a",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 1,
    operation: { kind: "workspace.read", workspaceId, path },
  };
}

describe("authorizeTaskAction — the provenance a path denial reports", () => {
  it.each([
    ["computer-approval", "computer-approval"],
    ["task-grant", "task-grant"],
    ["owner-restriction", "owner-restriction"],
    ["unknown", "unverified-provenance"],
  ] as const)(
    "reports an excluded path denied by a %s exclusion as %s",
    (exclusionSource, reported) => {
      expect(
        authorizeTaskAction(
          participant({ scopeSource: "task-grant", exclusionSource }),
          read("workspace-a", "/workspace/a/private/secret.txt"),
          1_000,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: reported,
          retry: "never",
        },
      });
    },
  );

  it.each([
    ["task-grant", "task-grant"],
    ["owner-restriction", "owner-restriction"],
    ["unknown", "unverified-provenance"],
  ] as const)(
    "reports a path outside a %s scope as %s",
    (scopeSource, reported) => {
      expect(
        authorizeTaskAction(
          participant({ scopeSource, exclusionSource: "task-grant" }),
          read("workspace-a", "/elsewhere/file.txt"),
          1_000,
        ),
      ).toEqual({
        ok: false,
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: reported,
          retry: "never",
        },
      });
    },
  );

  it("leaves a workspace the grant never named as a plain task-grant denial, whatever the named scope's provenance", () => {
    expect(
      authorizeTaskAction(
        participant({ scopeSource: "unknown", exclusionSource: "unknown" }),
        read("workspace-foreign", "/workspace/a/README.md"),
        1_000,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: "AUTHORITY_PATH_DENIED",
        source: "task-grant",
        retry: "never",
      },
    });
  });

  it("permits an in-scope, non-excluded path whatever the provenance says", () => {
    const action = read("workspace-a", "/workspace/a/README.md");
    expect(
      authorizeTaskAction(
        participant({ scopeSource: "unknown", exclusionSource: "unknown" }),
        action,
        1_000,
      ),
    ).toEqual({ ok: true, value: action });
  });
});
