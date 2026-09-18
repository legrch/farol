import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import type { ReadonlyWorkspaceRequest } from "../../src/modules/computer/app/port/readonly-workspace";

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

  describe("C05-10 bounded exclusion policy", () => {
    function withDenied(count: number): ReadonlyWorkspaceRequest {
      return {
        workspace: {
          workspaceId: "workspace-a",
          root,
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
});
