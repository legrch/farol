import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NativeReadonlyWorkspace,
  SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { approvedRootOf } from "../fixtures/root-identity";

// Real native helper IO belongs to integration, outside unit/fast selectors.
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
          helper: SAFE_OPEN_HELPER,
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
