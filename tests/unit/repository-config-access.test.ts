import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HOME_CREDENTIAL_STORES,
  credentialStorePolicy,
} from "../../src/modules/computer/infra/native/home-secret-stores";
import {
  DEFAULT_DENIED_PATHS,
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { buildWorkspaceShellProfile } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";
import { approvedRootOf } from "../fixtures/root-identity";

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

// Native cases require a separate Lead grant. Select only ^pure for pure runs.
// All HOME/config contents below are disposable synthetic fixtures. These cases
// exercise real helper IO, not live owner state or native shell qualification.
describe("native repository config filesystem", () => {
  async function fixture(
    run: (
      native: NativeReadonlyWorkspace,
      base: string,
      home: string,
      repo: string,
    ) => Promise<void>,
  ) {
    const base = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-repository-config-")),
    );
    const home = path.join(base, "home");
    const repo = path.join(home, "code", "repo");
    try {
      await fs.mkdir(repo, { recursive: true, mode: 0o700 });
      await run(
        new NativeReadonlyWorkspace({
          helperPath: path.resolve(
            import.meta.dirname,
            "../../resources/native/safe_open.py",
          ),
          helper: NEXT_SAFE_OPEN_HELPER,
          attestInterpreter: async () => "/usr/bin/python3",
          homeDirectory: home,
        }),
        base,
        home,
        repo,
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
  function descriptor(root: string, deniedPaths: string[] = []) {
    return {
      workspaceId: "repository-config",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths,
    };
  }
  function mutable(
    workspace: ReturnType<typeof descriptor>,
    writeDeniedPaths: string[] = [],
  ) {
    return { ...workspace, writeDeniedPaths };
  }
  const refused = {
    ok: false,
    error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
  };
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");

  it("reads, lists, searches, creates and edits root and nested repository copies", async () => {
    await fixture(async (native, _base, _home, repo) => {
      for (const relativePath of [".npmrc", "nested/.NPMRC"]) {
        const workspace = descriptor(repo);
        await expect(
          native.mutate({
            workspace: mutable(workspace),
            operation: {
              kind: "workspace.write",
              relativePath,
              content: "repository-marker=before\n",
              expectedSha256: null,
            },
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          native.execute({
            workspace,
            operation: { kind: "workspace.read", relativePath },
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: { text: "repository-marker=before\n" },
        });
        await expect(
          native.execute({
            workspace,
            operation: {
              kind: "workspace.list",
              relativePath: path.dirname(relativePath),
            },
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            entries: expect.arrayContaining([path.basename(relativePath)]),
          },
        });
        await expect(
          native.execute({
            workspace,
            operation: {
              kind: "workspace.search",
              relativePath,
              pattern: "repository-marker",
            },
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            matches: [{ path: relativePath, text: "repository-marker=before" }],
          },
        });
        await expect(
          native.mutate({
            workspace: mutable(workspace),
            operation: {
              kind: "workspace.edit",
              relativePath,
              edits: [{ oldText: "before", newText: "after" }],
              expectedSha256: digest("repository-marker=before\n"),
            },
          }),
        ).resolves.toMatchObject({ ok: true });
        await expect(
          fs.readFile(path.join(repo, relativePath), "utf8"),
        ).resolves.toBe("repository-marker=after\n");
      }
    });
  });

  it("keeps HOME, enclosing roots, case aliases and explicit exclusions closed", async () => {
    await fixture(async (native, base, home, repo) => {
      await fs.writeFile(path.join(home, ".npmrc"), "synthetic-home-marker\n", {
        mode: 0o600,
      });
      await fs.writeFile(
        path.join(repo, ".npmrc"),
        "repository-marker=before\n",
        {
          mode: 0o600,
        },
      );
      for (const [root, relativePath] of [
        [home, ".npmrc"],
        [base, "home/.NPMRC"],
        [repo, ".npmrc"],
      ] as const) {
        const workspace = descriptor(root, root === repo ? [".NPMRC"] : []);
        await expect(
          native.execute({
            workspace,
            operation: { kind: "workspace.read", relativePath },
          }),
        ).resolves.toEqual(refused);
        await expect(
          native.execute({
            workspace,
            operation: {
              kind: "workspace.search",
              relativePath,
              pattern: "marker",
            },
          }),
        ).resolves.toEqual(refused);
        for (const operation of [
          {
            kind: "workspace.write" as const,
            relativePath,
            content: "blocked\n",
            expectedSha256: null,
          },
          {
            kind: "workspace.edit" as const,
            relativePath,
            edits: [{ oldText: "before", newText: "blocked" }],
            expectedSha256: digest("repository-marker=before\n"),
          },
        ])
          await expect(
            native.mutate({ workspace: mutable(workspace), operation }),
          ).resolves.toEqual(refused);
        const listed = await native.execute({
          workspace,
          operation: { kind: "workspace.list", relativePath: "." },
        });
        expect(listed).toMatchObject({ ok: true });
        if (
          root !== base &&
          listed.ok &&
          listed.value.kind === "workspace.entries"
        )
          expect(listed.value.entries).not.toContain(".npmrc");
      }
      await expect(
        native.mutate({
          workspace: mutable(descriptor(repo), [".NPMRC"]),
          operation: {
            kind: "workspace.write",
            relativePath: ".npmrc",
            content: "blocked",
            expectedSha256: digest("repository-marker=before\n"),
          },
        }),
      ).resolves.toEqual(refused);
      await expect(
        fs.readFile(path.join(home, ".npmrc"), "utf8"),
      ).resolves.toBe("synthetic-home-marker\n");
      await expect(
        fs.readFile(path.join(repo, ".npmrc"), "utf8"),
      ).resolves.toBe("repository-marker=before\n");
      // A protected direct root is refused before treating the file as a directory.
      await expect(
        native.execute({
          workspace: descriptor(path.join(home, ".npmrc")),
          operation: { kind: "workspace.list", relativePath: "." },
        }),
      ).resolves.toEqual(refused);
      await fs.unlink(path.join(home, ".npmrc"));
      await fs.mkdir(path.join(home, ".NPMRC", "child"), {
        recursive: true,
        mode: 0o700,
      });
      await expect(
        native.execute({
          workspace: descriptor(path.join(home, ".NPMRC", "child")),
          operation: { kind: "workspace.list", relativePath: "." },
        }),
      ).resolves.toEqual(refused);
    });
  });

  it("preserves symlink, hardlink, ancestor and approved-root identity refusals", async () => {
    await fixture(async (native, base, home, repo) => {
      await fs.writeFile(path.join(home, ".npmrc"), "synthetic-home-marker\n", {
        mode: 0o600,
      });
      await fs.symlink(path.join(home, ".npmrc"), path.join(repo, ".npmrc"));
      await fs.link(path.join(home, ".npmrc"), path.join(repo, "hard.npmrc"));
      await fs.symlink(home, path.join(repo, "alias"));
      for (const relativePath of [".npmrc", "hard.npmrc", "alias/.npmrc"]) {
        const workspace = descriptor(repo);
        await expect(
          native.execute({
            workspace,
            operation: { kind: "workspace.read", relativePath },
          }),
        ).resolves.toEqual(refused);
        await expect(
          native.mutate({
            workspace: mutable(workspace),
            operation: {
              kind: "workspace.write",
              relativePath,
              content: "blocked",
              expectedSha256: null,
            },
          }),
        ).resolves.toEqual(refused);
        await expect(
          native.mutate({
            workspace: mutable(workspace),
            operation: {
              kind: "workspace.edit",
              relativePath,
              edits: [{ oldText: "marker", newText: "blocked" }],
              expectedSha256: digest("synthetic-home-marker\n"),
            },
          }),
        ).resolves.toEqual(refused);
      }
      const workspace = descriptor(repo);
      await fs.rename(repo, path.join(base, "retained-repo"));
      await fs.mkdir(repo, { mode: 0o700 });
      await fs.writeFile(path.join(repo, ".npmrc"), "replacement", {
        mode: 0o600,
      });
      await expect(
        native.execute({
          workspace,
          operation: { kind: "workspace.read", relativePath: ".npmrc" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_ROOT_CHANGED" },
      });
    });
  });
});
