import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import type { ReadonlyWorkspaceRequest } from "../../src/modules/computer/app/port/readonly-workspace";
import { approvedRootOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";

function request(
  operation: ReadonlyWorkspaceRequest["operation"],
): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: [".secrets", ".env"],
    },
    operation,
  };
}

function reader(helperPath = sourceHelper): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-workspace-"));
  // Admission stores the physical root once. The operation adapter never
  // resolves a caller path and then opens it; every component is walked from
  // the already-open root descriptor.
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, "README.md"),
    "Farol native workspace\nsecond line\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "src", "related.ts"),
    "export const iris = 'watch-rail';\n",
    { mode: 0o600 },
  );
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("native readonly Computer workspace", () => {
  it("F1-1 refuses a request that names no approved folder identity", async () => {
    const { approvedRoot: _identity, ...unbound } = request({
      kind: "workspace.list",
      relativePath: ".",
    }).workspace;
    await expect(
      reader().execute({
        workspace: unbound,
        operation: { kind: "workspace.list", relativePath: "." },
      } as unknown as ReadonlyWorkspaceRequest),
    ).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
    });
  });

  it("attests the signed Apple Python chain before native execution", async () => {
    const workspace = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
    });

    await expect(
      workspace.execute(
        request({ kind: "workspace.read", relativePath: "README.md" }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.text",
        text: "Farol native workspace\nsecond line\n",
      },
    });
  });

  it("reads, lists and searches a real approved temporary workspace", async () => {
    const workspace = reader();

    await expect(
      workspace.execute(
        request({ kind: "workspace.read", relativePath: "README.md" }),
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "workspace.text",
        text: "Farol native workspace\nsecond line\n",
        bytes: 35,
        sha256: createHash("sha256")
          .update("Farol native workspace\nsecond line\n")
          .digest("hex"),
      },
    });
    await expect(
      workspace.execute(request({ kind: "workspace.list", relativePath: "." })),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: ["README.md", "src/"],
        truncated: false,
      },
    });
    await expect(
      workspace.execute(
        request({
          kind: "workspace.search",
          relativePath: ".",
          pattern: "watch-rail",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.matches",
        matches: [
          {
            path: "src/related.ts",
            line: 1,
            text: "export const iris = 'watch-rail';",
          },
        ],
        resultLimited: false,
        scanLimited: false,
      },
    });
  });

  it("AUTH-03 binds exact-file requests to one regular file", async () => {
    const workspace = reader();
    const exact = (
      operation: ReadonlyWorkspaceRequest["operation"],
      exactFilePaths: readonly string[],
    ): ReadonlyWorkspaceRequest => ({
      workspace: {
        workspaceId: "workspace-a",
        root,
        approvedRoot: approvedRootOf(root),
        deniedPaths: [".secrets", ".env"],
        exactFilePaths,
      },
      operation,
    });

    await expect(
      workspace.execute(
        exact(
          {
            kind: "workspace.search",
            relativePath: "README.md",
            pattern: "Farol native workspace",
          },
          ["README.md"],
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.matches",
        matches: [{ path: "README.md", line: 1 }],
      },
    });
    await expect(
      workspace.execute(
        exact(
          {
            kind: "workspace.search",
            relativePath: "src/related.ts",
            pattern: "watch-rail",
          },
          ["README.md"],
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
    });
    await expect(
      workspace.execute(
        exact(
          {
            kind: "workspace.search",
            relativePath: "src",
            pattern: "watch-rail",
          },
          ["src"],
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_NOT_A_FILE", retry: "never" },
    });
  });

  it("refuses symlink leaves, symlink ancestors and denied credential paths", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-outside-"),
    );
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "outside\n", {
        mode: 0o600,
      });
      await fs.symlink(
        path.join(outside, "secret.txt"),
        path.join(root, "linked.txt"),
      );
      await fs.symlink(outside, path.join(root, "linked-dir"));
      await fs.writeFile(path.join(root, ".env"), "TOKEN=canary\n", {
        mode: 0o600,
      });
      const workspace = reader();

      for (const relativePath of [
        "linked.txt",
        "linked-dir/secret.txt",
        ".env",
      ]) {
        await expect(
          workspace.execute(request({ kind: "workspace.read", relativePath })),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
        });
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a direct-read hardlink without disclosing its bytes", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-hardlink-"),
    );
    try {
      const canary = "outside-hardlink-canary";
      const outsideFile = path.join(outside, "canary.txt");
      await fs.writeFile(outsideFile, canary, { mode: 0o600 });
      await fs.link(outsideFile, path.join(root, "hardlink.txt"));
      const workspace = reader();

      const read = await workspace.execute(
        request({ kind: "workspace.read", relativePath: "hardlink.txt" }),
      );
      expect(read).toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
      });
      expect(JSON.stringify(read)).not.toContain(canary);
      await expect(
        workspace.execute(
          request({
            kind: "workspace.search",
            relativePath: ".",
            pattern: canary,
          }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.matches", matches: [] },
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses when a direct-read file gains another link before post-stat", async () => {
    const alias = path.join(root, "README-alias.md");
    const result = await reader().execute(
      request({ kind: "workspace.read", relativePath: "README.md" }),
      {
        testHookRequest: { phase: "before-post-stat", index: null },
        testHook: async () => {
          await fs.link(path.join(root, "README.md"), alias);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_RACE_DETECTED", retry: "never" },
    });
  });

  it("hides Git internals from generic file tools", async () => {
    await fs.mkdir(path.join(root, ".git"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, ".git", "config"),
      "farol-git-internal-marker\n",
      { mode: 0o600 },
    );
    const workspace = reader();

    await expect(
      workspace.execute(request({ kind: "workspace.list", relativePath: "." })),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.entries",
        entries: ["README.md", "src/"],
      },
    });
    await expect(
      workspace.execute(
        request({ kind: "workspace.read", relativePath: ".git/config" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
    });
    await expect(
      workspace.execute(
        request({
          kind: "workspace.search",
          relativePath: ".",
          pattern: "farol-git-internal-marker",
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "workspace.matches", matches: [] },
    });
  });

  it("keeps reading the opened ancestor when its pathname is swapped", async () => {
    await fs.mkdir(path.join(root, "stable"), { mode: 0o700 });
    await fs.mkdir(path.join(root, "stable", "nested"), { mode: 0o700 });
    await fs.writeFile(
      path.join(root, "stable", "nested", "value.txt"),
      "descriptor-bound\n",
      { mode: 0o600 },
    );
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-swap-"),
    );
    try {
      await fs.mkdir(path.join(outside, "nested"), { mode: 0o700 });
      await fs.writeFile(
        path.join(outside, "nested", "value.txt"),
        "attacker-controlled\n",
        { mode: 0o600 },
      );

      const result = await reader().execute(
        request({
          kind: "workspace.read",
          relativePath: "stable/nested/value.txt",
        }),
        {
          testHookRequest: {
            phase: "after-relative-directory",
            index: 0,
          },
          testHook: async () => {
            await fs.rename(
              path.join(root, "stable"),
              path.join(root, "stable-opened"),
            );
            await fs.symlink(outside, path.join(root, "stable"));
          },
        },
      );

      expect(result).toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: "descriptor-bound\n",
          bytes: 17,
          sha256: createHash("sha256")
            .update("descriptor-bound\n")
            .digest("hex"),
        },
      });
      expect(JSON.stringify(result)).not.toContain("attacker-controlled");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses unsafe workspace and helper ownership modes", async () => {
    await fs.chmod(root, 0o777);
    await expect(
      reader().execute(
        request({ kind: "workspace.read", relativePath: "README.md" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_PATH_REFUSED" },
    });
    await fs.chmod(root, 0o700);

    const unsafeHelper = path.join(root, "unsafe-helper.py");
    await fs.copyFile(sourceHelper, unsafeHelper);
    await fs.chmod(unsafeHelper, 0o666);
    await expect(
      reader(unsafeHelper).execute(
        request({ kind: "workspace.read", relativePath: "README.md" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_HELPER_UNTRUSTED" },
    });
  });

  it("bounds source bytes, output and request grammar", async () => {
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(300_000), {
      mode: 0o600,
    });
    const workspace = reader();
    await expect(
      workspace.execute(
        request({ kind: "workspace.read", relativePath: "large.txt" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_FILE_TOO_LARGE" },
    });
    await expect(
      workspace.execute(
        request({ kind: "workspace.read", relativePath: "../README.md" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_INVALID_REQUEST" },
    });
  });

  describe("P03 bounded search output and match semantics", () => {
    const search = (relativePath: string, pattern: string) =>
      reader().execute(
        request({ kind: "workspace.search", relativePath, pattern }),
      );

    it("C05-03 returns a valid bounded partial when escaped output would overflow", async () => {
      const line = `needle ${"\u{1F600}".repeat(500)}`;
      await fs.writeFile(
        path.join(root, "emoji.txt"),
        `${Array.from({ length: 100 }, () => line).join("\n")}\n`,
        { mode: 0o600 },
      );

      const result = await search("emoji.txt", "needle");

      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.matches", resultLimited: true },
      });
      if (!result.ok || result.value.kind !== "workspace.matches") return;
      expect(result.value.matches.length).toBeGreaterThan(0);
      expect(result.value.matches.length).toBeLessThan(100);
      for (const match of result.value.matches) {
        expect([...match.text].length).toBeLessThanOrEqual(500);
        expect(match.truncated).toBe(true);
      }
    });

    it("C05-03 keeps the ASCII count limit unchanged", async () => {
      const line = `needle ${"a".repeat(600)}`;
      await fs.writeFile(
        path.join(root, "ascii.txt"),
        `${Array.from({ length: 120 }, () => line).join("\n")}\n`,
        { mode: 0o600 },
      );

      const result = await search("ascii.txt", "needle");

      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.matches", resultLimited: true },
      });
      if (!result.ok || result.value.kind !== "workspace.matches") return;
      expect(result.value.matches).toHaveLength(100);
    });

    it("C05-03 counts long Unicode paths in the output budget", async () => {
      // 80 escaped 500-code-point excerpts fit in the response by themselves;
      // with their escaped Unicode paths they do not.
      const segment = "\u{1F4C1}".repeat(40);
      const directory = path.join(root, segment, segment, segment);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      for (let index = 0; index < 80; index += 1) {
        await fs.writeFile(
          path.join(directory, `${"\u{1F4C4}".repeat(40)}-${index}.txt`),
          `needle ${"\u{1F600}".repeat(500)}\n`,
          { mode: 0o600 },
        );
      }

      const result = await search(".", "needle");

      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.matches", resultLimited: true },
      });
      if (!result.ok || result.value.kind !== "workspace.matches") return;
      expect(result.value.matches.length).toBeLessThan(80);
    });

    it("C05-04 refuses an explicitly named binary or non-UTF-8 file", async () => {
      await fs.writeFile(
        path.join(root, "blob.bin"),
        Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(root, "latin1.txt"),
        Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xe9, 0x0a]),
        { mode: 0o600 },
      );

      for (const file of ["blob.bin", "latin1.txt"]) {
        await expect(search(file, "needle")).resolves.toEqual({
          ok: false,
          error: { code: "WORKSPACE_NOT_TEXT", retry: "never" },
        });
      }
      // A directory search still skips files that are not text, like ripgrep.
      await expect(search(".", "needle")).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.matches", matches: [] },
      });
    });

    it("C05-04 shows a match that starts after code point 500", async () => {
      await fs.writeFile(
        path.join(root, "long.txt"),
        `${"a".repeat(700)}needle${"b".repeat(50)}\n`,
        { mode: 0o600 },
      );

      const result = await search("long.txt", "needle");

      expect(result).toMatchObject({ ok: true });
      if (!result.ok || result.value.kind !== "workspace.matches") return;
      expect(result.value.matches).toHaveLength(1);
      const match = result.value.matches[0];
      if (!match) throw new Error("expected one match");
      expect(match.text).toContain("needle");
      expect([...match.text].length).toBeLessThanOrEqual(500);
      expect(match.truncated).toBe(true);
      expect(match.line).toBe(1);
    });

    it("C05-04 numbers lines by LF only, like the editor and the read tool", async () => {
      await fs.writeFile(
        path.join(root, "separators.txt"),
        "first\u{2028}still first\u{b}still\r\nsecond needle\r\nthird\n",
        { mode: 0o600 },
      );

      const result = await search("separators.txt", "needle");

      expect(result).toMatchObject({ ok: true });
      if (!result.ok || result.value.kind !== "workspace.matches") return;
      expect(result.value.matches).toEqual([
        {
          path: "separators.txt",
          line: 2,
          text: "second needle",
          truncated: false,
        },
      ]);
    });
  });

  describe("AUTH-06 home credential stores survive root selection", () => {
    // The outer fixture root plays a folder that encloses the owner's home;
    // the synthetic home and its synthetic key live inside it.
    let home = "";

    beforeEach(async () => {
      home = path.join(root, "home");
      await fs.mkdir(path.join(home, ".ssh", "keys"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(
        path.join(home, ".ssh", "keys", "id_synthetic"),
        "SYNTHETIC-KEY-CANARY\n",
        { mode: 0o600 },
      );
      await fs.mkdir(path.join(home, "Library", "Keychains"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(home, "notes.md"), "ordinary notes\n", {
        mode: 0o600,
      });
    });

    function homeReader(): NativeReadonlyWorkspace {
      return new NativeReadonlyWorkspace({
        helperPath: sourceHelper,
        helper: NEXT_SAFE_OPEN_HELPER,
        attestInterpreter: async () => "/usr/bin/python3",
        homeDirectory: home,
      });
    }

    function at(
      workspaceRoot: string,
      operation: ReadonlyWorkspaceRequest["operation"],
    ): ReadonlyWorkspaceRequest {
      return {
        workspace: {
          workspaceId: "workspace-a",
          root: workspaceRoot,
          approvedRoot: approvedRootOf(workspaceRoot),
          deniedPaths: [],
        },
        operation,
      };
    }

    const refused = {
      ok: false,
      error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
    } as const;

    it("refuses a root that is a credential store or lies inside one", async () => {
      const workspace = homeReader();
      for (const candidate of [
        path.join(home, ".ssh"),
        path.join(home, ".ssh", "keys"),
        path.join(home, ".SSH", "keys"),
        path.join(home, "Library", "Keychains"),
      ]) {
        await expect(
          workspace.execute(
            at(candidate, { kind: "workspace.list", relativePath: "." }),
          ),
        ).resolves.toEqual(refused);
        await expect(
          workspace.execute(
            at(candidate, {
              kind: "verification.run",
              command: "git.status",
              relativePath: ".",
            }),
          ),
        ).resolves.toEqual(refused);
        await expect(
          workspace.mutate({
            workspace: {
              workspaceId: "workspace-a",
              root: candidate,
              approvedRoot: approvedRootOf(candidate),
              deniedPaths: [],
              writeDeniedPaths: [],
            },
            operation: {
              kind: "workspace.write",
              relativePath: "planted",
              content: "planted\n",
              expectedSha256: null,
            },
          }),
        ).resolves.toEqual(refused);
      }
      await expect(
        fs.readdir(path.join(home, ".ssh", "keys")),
      ).resolves.toEqual(["id_synthetic"]);
    });

    it("keeps the stores of an enclosed home out of a broader root", async () => {
      const workspace = homeReader();

      await expect(
        workspace.execute(
          at(root, {
            kind: "workspace.read",
            relativePath: "home/.ssh/keys/id_synthetic",
          }),
        ),
      ).resolves.toEqual(refused);
      await expect(
        workspace.execute(
          at(root, {
            kind: "workspace.search",
            relativePath: ".",
            pattern: "SYNTHETIC-KEY-CANARY",
          }),
        ),
      ).resolves.toMatchObject({ ok: true, value: { matches: [] } });
      await expect(
        workspace.execute(
          at(root, { kind: "workspace.read", relativePath: "home/notes.md" }),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { text: "ordinary notes\n" },
      });
    });

    it("keeps root conventions distinct and does not scan nested names", async () => {
      await fs.writeFile(path.join(root, ".env"), "TOKEN=canary\n", {
        mode: 0o600,
      });
      await fs.writeFile(path.join(root, "src", ".env.example"), "TOKEN=\n", {
        mode: 0o600,
      });
      const workspace = homeReader();

      // The selected root's own credential conventions stay denied.
      await expect(
        workspace.execute(
          at(root, { kind: "workspace.read", relativePath: ".env" }),
        ),
      ).resolves.toEqual(refused);
      // Path policy is not a secret scanner: a nested example file stays an
      // ordinary task input.
      await expect(
        workspace.execute(
          at(root, {
            kind: "workspace.read",
            relativePath: "src/.env.example",
          }),
        ),
      ).resolves.toMatchObject({ ok: true, value: { text: "TOKEN=\n" } });
    });
  });

  describe("AUTH-10 an approved root is bound to the object that was approved", () => {
    let displaced = "";

    afterEach(async () => {
      if (displaced) await fs.rm(displaced, { recursive: true, force: true });
      displaced = "";
    });

    async function approvedRoot() {
      const measured = await fs.lstat(root, { bigint: true });
      return {
        path: root,
        device: String(measured.dev),
        inode: String(measured.ino),
      };
    }

    // The approved folder is moved away and another folder takes its path.
    async function replaceRoot() {
      displaced = `${root}-displaced`;
      await fs.rename(root, displaced);
      await fs.mkdir(path.join(root, "src"), { recursive: true, mode: 0o700 });
      await fs.chmod(root, 0o700);
      await fs.writeFile(path.join(root, "README.md"), "replacement\n", {
        mode: 0o600,
      });
    }

    const changed = {
      ok: false,
      error: { code: "WORKSPACE_ROOT_CHANGED", retry: "never" },
    } as const;

    it("serves the approved object and refuses a replacement at the same path", async () => {
      const approved = await approvedRoot();
      const workspace = reader();
      const at = (
        workspaceRoot: string,
        operation: ReadonlyWorkspaceRequest["operation"],
      ): ReadonlyWorkspaceRequest => ({
        workspace: {
          workspaceId: "workspace-a",
          root: workspaceRoot,
          deniedPaths: [],
          approvedRoot: approved,
        },
        operation,
      });

      await expect(
        workspace.execute(
          at(root, { kind: "workspace.read", relativePath: "README.md" }),
        ),
      ).resolves.toMatchObject({ ok: true });
      // A narrowed subtree is checked against the approved ancestor.
      await expect(
        workspace.execute(
          at(path.join(root, "src"), {
            kind: "workspace.list",
            relativePath: ".",
          }),
        ),
      ).resolves.toMatchObject({ ok: true });

      await replaceRoot();

      await expect(
        workspace.execute(
          at(root, { kind: "workspace.read", relativePath: "README.md" }),
        ),
      ).resolves.toEqual(changed);
      await expect(
        workspace.execute(
          at(path.join(root, "src"), {
            kind: "workspace.list",
            relativePath: ".",
          }),
        ),
      ).resolves.toEqual(changed);
      await expect(
        workspace.execute(
          at(root, {
            kind: "verification.run",
            command: "git.status",
            relativePath: ".",
          }),
        ),
        // N02: Git verification now runs for real, over a private snapshot,
        // and is bound to the same approved-root identity check every other
        // operation here already goes through.
      ).resolves.toEqual(changed);
      await expect(
        workspace.mutate({
          workspace: {
            workspaceId: "workspace-a",
            root,
            deniedPaths: [],
            writeDeniedPaths: [],
            approvedRoot: approved,
          },
          operation: {
            kind: "workspace.write",
            relativePath: "planted.md",
            content: "planted\n",
            expectedSha256: null,
          },
        }),
      ).resolves.toEqual(changed);
      await expect(fs.readdir(root)).resolves.toEqual(["README.md", "src"]);
    });

    it("refuses an approved root that does not enclose the requested root", async () => {
      const approved = await approvedRoot();

      await expect(
        reader().execute({
          workspace: {
            workspaceId: "workspace-a",
            root: path.dirname(root),
            deniedPaths: [],
            approvedRoot: approved,
          },
          operation: { kind: "workspace.list", relativePath: "." },
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
      });
    });
  });

  describe("C05-10 bounded exclusion policy", () => {
    function withDenied(count: number): ReadonlyWorkspaceRequest {
      return {
        workspace: {
          workspaceId: "workspace-a",
          root,
          approvedRoot: approvedRootOf(root),
          deniedPaths: Array.from(
            { length: count },
            (_, index) => `excluded-${index}`,
          ),
        },
        operation: { kind: "workspace.read", relativePath: "README.md" },
      };
    }

    it("accepts the largest exclusion union the helper enforces", async () => {
      // 14 mandatory credential exclusions + 50 owner exclusions = 64.
      await expect(reader().execute(withDenied(50))).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.text" },
      });
    });

    it("refuses one exclusion more with a specific policy error", async () => {
      for (const count of [51, 200]) {
        await expect(reader().execute(withDenied(count))).resolves.toEqual({
          ok: false,
          error: { code: "WORKSPACE_POLICY_TOO_LARGE", retry: "never" },
        });
      }
    });
  });

  describe("C05-06 a ranged read continues past the whole-file ceiling", () => {
    function ranged(
      relativePath: string,
      offset: number,
      length: number,
    ): ReadonlyWorkspaceRequest {
      return request({
        kind: "workspace.read",
        relativePath,
        range: { offset, length },
      });
    }

    it("pages a file too large to read whole until nextOffset is null", async () => {
      const line = (index: number) => `строка ${index} — λ ✓ 😀 status\n`;
      const content = Array.from({ length: 9_000 }, (_, index) =>
        line(index),
      ).join("");
      const size = Buffer.byteLength(content);
      expect(size).toBeGreaterThan(256 * 1024);
      await fs.writeFile(path.join(root, "large.txt"), content, {
        mode: 0o600,
      });
      const workspace = reader();
      await expect(
        workspace.execute(
          request({ kind: "workspace.read", relativePath: "large.txt" }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_FILE_TOO_LARGE" },
      });

      const pages: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result = await workspace.execute(
          ranged("large.txt", offset, 65_536),
        );
        if (!result.ok || result.value.kind !== "workspace.text") {
          throw new Error(`window at ${offset} failed`);
        }
        const page = result.value.page;
        expect(page).toMatchObject({ offset, size });
        expect(result.value.bytes).toBeLessThanOrEqual(65_536);
        expect(Buffer.byteLength(result.value.text)).toBe(result.value.bytes);
        pages.push(result.value.text);
        offset = page?.nextOffset ?? null;
      }
      expect(pages.length).toBeGreaterThanOrEqual(5);
      expect(pages.join("")).toBe(content);
    });

    it("returns whole characters when a window starts or ends inside one", async () => {
      // a (1 byte), é (2), ✓ (3), 😀 (4), z (1): 11 bytes.
      await fs.writeFile(path.join(root, "chars.txt"), "aé✓😀z", {
        mode: 0o600,
      });
      const workspace = reader();

      await expect(
        workspace.execute(ranged("chars.txt", 0, 4)),
      ).resolves.toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: "aé",
          bytes: 3,
          page: { offset: 0, size: 11, nextOffset: 3 },
        },
      });
      // Byte 2 is the second half of é: the window begins at the next whole
      // character and says so.
      await expect(
        workspace.execute(ranged("chars.txt", 2, 4)),
      ).resolves.toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: "✓",
          bytes: 3,
          page: { offset: 3, size: 11, nextOffset: 6 },
        },
      });
      await expect(
        workspace.execute(ranged("chars.txt", 6, 5)),
      ).resolves.toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: "😀z",
          bytes: 5,
          page: { offset: 6, size: 11, nextOffset: null },
        },
      });
      await expect(
        workspace.execute(ranged("chars.txt", 11, 4)),
      ).resolves.toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: "",
          bytes: 0,
          page: { offset: 11, size: 11, nextOffset: null },
        },
      });
    });

    it("continues past 64 MiB, so every reported nextOffset is a valid request", async () => {
      // A sparse file keeps this cheap: only its tail holds text.
      const tailOffset = 64 * 1024 * 1024 + 100;
      const tail = "a line far past sixty-four mebibytes\n".repeat(20);
      const size = tailOffset + Buffer.byteLength(tail);
      const handle = await fs.open(path.join(root, "huge.log"), "w", 0o600);
      try {
        await handle.write(tail, tailOffset, "utf8");
      } finally {
        await handle.close();
      }
      const workspace = reader();

      const first = await workspace.execute(ranged("huge.log", tailOffset, 16));
      expect(first).toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: tail.slice(0, 16),
          bytes: 16,
          page: { offset: tailOffset, size, nextOffset: tailOffset + 16 },
        },
      });
      await expect(
        workspace.execute(ranged("huge.log", tailOffset + 16, 256 * 1024)),
      ).resolves.toEqual({
        ok: true,
        value: {
          kind: "workspace.text",
          text: tail.slice(16),
          bytes: Buffer.byteLength(tail) - 16,
          page: { offset: tailOffset + 16, size, nextOffset: null },
        },
      });
    });

    it("applies the same text check and path policy as a whole read", async () => {
      await fs.writeFile(
        path.join(root, "binary.bin"),
        Buffer.from([0x61, 0x00, 0x62]),
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(root, "broken.txt"),
        Buffer.from([0x61, 0x62, 0xc3]),
        { mode: 0o600 },
      );
      await fs.writeFile(path.join(root, ".env"), "TOKEN=value\n", {
        mode: 0o600,
      });
      const workspace = reader();

      await expect(
        workspace.execute(ranged("binary.bin", 0, 16)),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_NOT_TEXT" },
      });
      // A character cut by the end of the file is invalid text, not a window
      // boundary to continue from.
      await expect(
        workspace.execute(ranged("broken.txt", 0, 16)),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_NOT_TEXT" },
      });
      await expect(
        workspace.execute(ranged(".env", 0, 16)),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_PATH_REFUSED" },
      });
    });

    it("refuses a window it cannot read as asked", async () => {
      const workspace = reader();
      for (const range of [
        { offset: 0, length: 0 },
        // Shorter than one UTF-8 character could never make progress.
        { offset: 0, length: 3 },
        { offset: 0, length: 256 * 1024 + 1 },
        { offset: -1, length: 16 },
        { offset: 1.5, length: 16 },
        { offset: Number.MAX_SAFE_INTEGER + 1, length: 16 },
        { offset: 0, length: 16, extra: true },
      ]) {
        await expect(
          workspace.execute(
            request({
              kind: "workspace.read",
              relativePath: "README.md",
              range,
            } as unknown as ReadonlyWorkspaceRequest["operation"]),
          ),
        ).resolves.toEqual({
          ok: false,
          error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
        });
      }
    });
  });
});
