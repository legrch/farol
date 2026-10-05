import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOME_CREDENTIAL_STORES,
  credentialStorePolicy,
} from "../../src/modules/computer/infra/native/home-secret-stores";
import { DEFAULT_DENIED_PATHS } from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { buildWorkspaceShellProfile } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";

const home = "/Users/example";
const rootDenials = [
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
];
function parameters(
  profile: ReturnType<typeof buildWorkspaceShellProfile>,
  label: string,
) {
  return profile.parameters
    .filter((value) => value.startsWith(label + "_"))
    .map((value) => value.slice(value.indexOf("=") + 1));
}

// Pure values only. These tests do not claim native helper or Seatbelt proof.
describe("pure repository config policy", () => {
  it("changes only root-relative .npmrc protection", () => {
    expect(DEFAULT_DENIED_PATHS).toEqual(rootDenials);
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
  });
  it.each([
    "/repo",
    home + "/code/repo",
    home + "/code/.npmrc",
    home + "/code/.NPMRC/ancestor/repo",
    home + "grown/.npmrc",
  ])("keeps ordinary %s roots outside HOME protection", (root) => {
    expect(credentialStorePolicy(root, home)).toEqual({
      kind: "outside",
      deniedPaths: [],
    });
  });
  it.each([
    home + "/.npmrc",
    "/USERS/EXAMPLE/.NPMRC",
    home + "/.NPMRC/child/repo",
  ])("refuses direct and ancestor HOME aliases at %s", (root) => {
    expect(credentialStorePolicy(root, home)).toEqual({ kind: "inside-store" });
  });
  it.each([home, "/Users", "/USERS/EXAMPLE"])(
    "carries HOME protection into enclosing %s roots",
    (root) => {
      const policy = credentialStorePolicy(root, home);
      expect(policy.kind).toBe("outside");
      if (policy.kind !== "outside") throw new Error("unexpected store root");
      expect(policy.deniedPaths).toContain(
        root === "/Users" ? "example/.npmrc" : ".npmrc",
      );
      expect(policy.deniedPaths).not.toContain("code/repo/.npmrc");
    },
  );
  it.each(["read", "write"] as const)(
    "compiles %s repository access with HOME and explicit exclusions",
    (access) => {
      for (const root of [
        home + "/code/repo",
        home + "/code/.npmrc/repo",
        home,
      ]) {
        const policy = credentialStorePolicy(root, home);
        if (policy.kind !== "outside") throw new Error("unexpected store root");
        const excluded = root + "/nested/.NPMRC";
        for (const write of [false, true]) {
          // Same absolute-denial handoff used by verifiedWorkspace. The pure
          // profile builder does not discover HOME or confer a shell grant.
          const profile = buildWorkspaceShellProfile(
            [
              {
                root,
                access,
                gitMetadata: undefined,
                gitHistoryApproved: false,
              },
            ],
            [
              ...policy.deniedPaths.map((relative) => ({
                path: path.join(root, relative),
              })),
              { path: excluded },
            ],
            "/fixture/scratch",
            write,
            [],
          );
          expect(parameters(profile, "ROOT")).toEqual([root]);
          expect(parameters(profile, "WRITE")).toEqual(
            write && access === "write" ? [root] : [],
          );
          expect(parameters(profile, "DENY")).toContain(excluded);
          for (const relative of rootDenials) {
            expect(parameters(profile, "DENY")).toContain(
              path.join(root, relative),
            );
          }
          if (root === home)
            expect(parameters(profile, "DENY")).toContain(home + "/.npmrc");
          else
            expect(parameters(profile, "DENY")).not.toContain(root + "/.npmrc");
          expect(profile.source).toContain("(deny default)");
          expect(profile.source).toContain("(deny network*)");
          expect(profile.source).toContain("\\.ssh");
          expect(profile.source).not.toContain("\\.npmrc");
        }
      }
    },
  );
});
