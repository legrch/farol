import { describe, expect, it } from "vitest";
import {
  authorizeComputerAction,
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import {
  HOME_CREDENTIAL_STORES,
  credentialStorePolicy,
} from "../../src/modules/computer/infra/native/home-secret-stores";
import { DEFAULT_DENIED_PATHS } from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { buildWorkspaceShellProfile } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";

// Pure policy/profile tests: no filesystem effects and no claim of native
// Seatbelt enforcement or installed-tool qualification.
const home = "/Users/example";
const scratch = "/fixture/scratch";
function effective(root: string, access: "read" | "write" = "write") {
  return { root, access, gitMetadata: undefined, gitHistoryApproved: false };
}
function parameters(
  profile: ReturnType<typeof buildWorkspaceShellProfile>,
  label: string,
) {
  return profile.parameters
    .filter((value) => value.startsWith(label + "_"))
    .map((value) => value.slice(value.indexOf("=") + 1));
}

describe("agent store owner-controlled access", () => {
  it.each([".codex", ".claude", ".Codex", ".CLAUDE"])(
    "does not veto the approved %s root or its descendants",
    (directory) => {
      for (const suffix of ["", "/worktrees/task/repo", "/sessions"]) {
        expect(
          credentialStorePolicy(home + "/" + directory + suffix, home),
        ).toEqual({ kind: "outside", deniedPaths: [] });
      }
    },
  );
  it("keeps the exact HOME and root mandatory lists", () => {
    expect(HOME_CREDENTIAL_STORES).toEqual([
      ".ssh",
      ".aws",
      ".gnupg",
      ".git-credentials",
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".docker/config.json",
      ".kube/config",
      "Library/Keychains",
    ]);
    expect(DEFAULT_DENIED_PATHS).toEqual([
      ".env",
      ".ssh",
      ".aws",
      ".gnupg",
      ".git",
      ".git-credentials",
      ".netrc",
      ".pypirc",
      ".docker/config.json",
      ".kube/config",
      "Library/Keychains",
    ]);
  });
  it.each([home, "/Users"])("keeps an enclosing %s grant ordinary", (root) => {
    const policy = credentialStorePolicy(root, home);
    expect(policy.kind).toBe("outside");
    if (policy.kind !== "outside") throw new Error("unexpected refusal");
    const prefix = root === home ? "" : "example/";
    expect(policy.deniedPaths).not.toContain(prefix + ".codex");
    expect(policy.deniedPaths).not.toContain(prefix + ".claude");
    expect(policy.deniedPaths).toContain(prefix + ".ssh");
  });
  it.each([
    ".ssh",
    ".AWS/profiles",
    ".gnupg",
    "Library/Keychains",
    ".\u017f\u017fh/.codex",
  ])("keeps the unrelated home store %s protected", (directory) => {
    expect(credentialStorePolicy(home + "/" + directory, home)).toEqual({
      kind: "inside-store",
    });
  });
  it.each([".codex", ".claude"])(
    "compiles the %s shell grant without a blanket denial",
    (directory) => {
      const root = home + "/" + directory;
      const profile = buildWorkspaceShellProfile(
        [effective(root)],
        [],
        scratch,
        true,
        [],
      );
      expect(parameters(profile, "ROOT")).toEqual([root]);
      expect(parameters(profile, "WRITE")).toEqual([root]);
      expect(profile.source).not.toContain(".codex");
      expect(profile.source).not.toContain(".claude");
      expect(profile.source).toContain(".ssh");
      expect(profile.source).toContain("(deny default)");
      expect(profile.source).toContain("(deny network*)");
      expect(parameters(profile, "DENY")).toContain(root + "/.git");
    },
  );
  it.each([
    ["read", false, false],
    ["read", true, false],
    ["write", false, false],
    ["write", true, true],
  ] as const)(
    "keeps %s access with write=%s distinct",
    (access, write, writable) => {
      const root = home + "/.codex/worktrees/task/repo";
      const profile = buildWorkspaceShellProfile(
        [effective(root, access)],
        [],
        scratch,
        write,
        [],
      );
      expect(parameters(profile, "ROOT")).toEqual([root]);
      expect(parameters(profile, "WRITE")).toEqual(writable ? [root] : []);
      // Ancestor metadata traversal is not a read/write grant for siblings.
      expect(parameters(profile, "ROOT")).not.toContain(home);
      expect(parameters(profile, "WRITE")).not.toContain(home);
    },
  );
  it("keeps explicit owner exclusions, unrelated stores and empty scopes closed", () => {
    const excluded = home + "/.codex/private";
    const profile = buildWorkspaceShellProfile(
      [effective(home)],
      [{ path: excluded }],
      scratch,
      true,
      [],
    );
    const denies = parameters(profile, "DENY");
    expect(denies).toContain(excluded);
    expect(denies).toContain(home + "/.ssh");
    expect(denies).not.toContain(home + "/.codex");
    expect(denies).not.toContain(home + "/.claude");
    expect(profile.source).toContain("(deny file-read* file-write*");
    const empty = buildWorkspaceShellProfile([], [], scratch, true, []);
    expect(parameters(empty, "ROOT")).toEqual([]);
    expect(parameters(empty, "WRITE")).toEqual([]);
  });
});

describe("ordinary authority still governs agent stores", () => {
  it.each([".codex", ".claude"])(
    "requires an unexpired, unrevoked matching grant for %s",
    (directory) => {
      const root = home + "/" + directory;
      const identity = {
        ownerId: "owner-test",
        sessionId: "session-test",
        taskId: "task-test",
        taskEpoch: 1,
      };
      for (const access of ["read", "write"] as const) {
        const approval: ComputerApproval = {
          ownerId: identity.ownerId,
          computerId: "computer-test",
          generation: 1,
          workspaces: [
            {
              workspaceId: "agent",
              root,
              access,
              rootIdentity: { device: "1", inode: "2" },
            },
          ],
          excludedPaths: [{ workspaceId: "agent", path: root + "/private" }],
          capabilities: [
            "workspace.read",
            ...(access === "write" ? ["workspace.write" as const] : []),
          ],
          network: "none",
          commands: "none",
          expiresAt: 20_000,
        };
        const admission: TaskAdmission = {
          authorityId: "agent-access-test",
          ...identity,
          computerId: approval.computerId,
          computerGeneration: approval.generation,
          workspaces: [{ workspaceId: "agent", mode: "subtree", root, access }],
          capabilities: approval.capabilities,
          network: "none",
          commands: "none",
          expiresAt: 10_000,
        };
        const grant = deriveTaskGrant(approval, admission, 1_000);
        if (!grant.ok) throw new Error(grant.error.code);
        const participant = createParticipantAuthority(grant.value, {
          participantId: "main-test",
          role: "main",
          mutationOwnership: access === "write" ? "task" : "none",
        });
        if (!participant.ok) throw new Error(participant.error.code);
        const action = (
          kind: "workspace.read" | "workspace.write",
          path: string,
        ) => ({
          ...identity,
          operation: { kind, workspaceId: "agent", path },
        });
        const read = action("workspace.read", root + "/config.toml");
        expect(
          authorizeComputerAction(participant.value, approval, read, 1_000).ok,
        ).toBe(true);
        expect(
          authorizeComputerAction(
            participant.value,
            approval,
            action("workspace.write", root + "/config.toml"),
            1_000,
          ).ok,
        ).toBe(access === "write");
        for (const outside of [
          home + "/other.txt",
          root + "/private/value",
          root + "-other/value",
        ]) {
          expect(
            authorizeComputerAction(
              participant.value,
              approval,
              action("workspace.read", outside),
              1_000,
            ).ok,
          ).toBe(false);
        }
        expect(
          authorizeComputerAction(participant.value, approval, read, 10_001).ok,
        ).toBe(false);
        expect(
          authorizeComputerAction(
            participant.value,
            { ...approval, generation: 2 },
            read,
            1_000,
          ).ok,
        ).toBe(false);
        expect(
          authorizeComputerAction(
            participant.value,
            approval,
            { ...read, taskEpoch: 2 },
            1_000,
          ).ok,
        ).toBe(false);
      }
    },
  );
});
