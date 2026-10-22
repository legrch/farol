import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  WorkspaceMutationOperation,
  WorkspaceMutationRequest,
} from "../../src/modules/computer/app/port/mutable-workspace";
import {
  NativeReadonlyWorkspace,
  SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { approvedRootOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// latin1 maps every byte to exactly one character, so this comparison is
// byte-exact while CR, LF and BOM bytes stay readable in a failure diff.
function visible(value: Buffer): string {
  return JSON.stringify(value.toString("latin1"));
}

async function editFileBytes(
  relativePath: string,
  before: Buffer,
  edits: Array<{ oldText: string; newText: string }>,
  expectedSha256 = digest(before),
) {
  await fs.writeFile(path.join(root, relativePath), before, { mode: 0o600 });
  const result = await workspace().mutate(
    request({ kind: "workspace.edit", relativePath, expectedSha256, edits }),
  );
  return { result, after: await fs.readFile(path.join(root, relativePath)) };
}

function request(
  operation: WorkspaceMutationOperation,
): WorkspaceMutationRequest {
  return {
    workspace: {
      workspaceId: "workspace-write-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: [".env"],
      writeDeniedPaths: [".git"],
    },
    operation,
  };
}

function workspace(): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-mutation-")),
  );
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, ".git"), { mode: 0o700 });
  await fs.writeFile(path.join(root, ".git", "config"), "safe\n", {
    mode: 0o600,
  });
  await fs.writeFile(path.join(root, "README.md"), "before\n", {
    mode: 0o600,
  });
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// Where the helper keeps its staged candidate, or the object an exchange
// displaced: a private staging directory beside the target, or (before R5) a
// private name among the workspace's own entries.
async function stagedPath(): Promise<string> {
  const entries = await fs.readdir(root);
  const stages = entries.filter((entry) => entry.startsWith(".farol-stage-"));
  if (stages.length === 1) return path.join(root, stages[0]!, "staged");
  const names = entries.filter((entry) => entry.startsWith(".farol-tmp-"));
  if (names.length === 1) return path.join(root, names[0]!);
  throw new Error("staged name missing");
}

// The bytes of every object the helper left under its own names.
async function retained(): Promise<string[]> {
  const contents: string[] = [];
  for (const entry of await fs.readdir(root)) {
    const full = path.join(root, entry);
    if (entry.startsWith(".farol-tmp-")) {
      contents.push(await fs.readFile(full, "utf8"));
    } else if (entry.startsWith(".farol-stage-")) {
      for (const inner of await fs.readdir(full)) {
        contents.push(await fs.readFile(path.join(full, inner), "utf8"));
      }
    }
  }
  return contents.sort();
}

async function leftovers(): Promise<string[]> {
  return (await fs.readdir(root)).filter((entry) =>
    entry.startsWith(".farol-"),
  );
}

// Replace a file the way an editor's atomic save does: a new inode renamed
// over the old name.
let saves = 0;
async function atomicSave(file: string, content: string): Promise<void> {
  const next = `${file}.next-${(saves += 1)}`;
  await fs.writeFile(next, content, { mode: 0o600 });
  await fs.rename(next, file);
}

describe("native mutable Computer workspace", () => {
  it.each([".codex", ".claude"])(
    "writes and edits the %s agent store without weakening collision, digest or exclusion checks",
    async (directory) => {
      // Native helper proof on synthetic files only, not a live settings edit.
      const store = path.join(root, directory);
      await fs.mkdir(store, { mode: 0o700 });
      const native = new NativeReadonlyWorkspace({
        helperPath: sourceHelper,
        helper: SAFE_OPEN_HELPER,
        attestInterpreter: async () => "/usr/bin/python3",
        homeDirectory: root,
      });
      for (const selected of [root, store]) {
        const relativePath =
          selected === root ? directory + "/parent.txt" : "direct.txt";
        const descriptor = {
          workspaceId: "agent-store",
          root: selected,
          approvedRoot: approvedRootOf(selected),
          deniedPaths: [],
          writeDeniedPaths: [".git"],
        };
        const create = {
          workspace: descriptor,
          operation: {
            kind: "workspace.write" as const,
            relativePath,
            content: "before\n",
            expectedSha256: null,
          },
        };
        await expect(native.mutate(create)).resolves.toMatchObject({
          ok: true,
          value: { afterSha256: digest("before\n") },
        });
        await expect(native.mutate(create)).resolves.toMatchObject({
          ok: false,
        });
        await expect(
          native.mutate({
            workspace: descriptor,
            operation: {
              kind: "workspace.edit",
              relativePath,
              expectedSha256: digest("before\n"),
              edits: [{ oldText: "before", newText: "after" }],
            },
          }),
        ).resolves.toMatchObject({
          ok: true,
          value: { afterSha256: digest("after\n"), replacements: 1 },
        });
        await expect(
          native.mutate({
            ...create,
            operation: {
              ...create.operation,
              expectedSha256: digest("before\n"),
              content: "stale overwrite",
            },
          }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          native.mutate({
            ...create,
            workspace: { ...descriptor, deniedPaths: [relativePath] },
            operation: {
              ...create.operation,
              expectedSha256: digest("after\n"),
            },
          }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: "WORKSPACE_PATH_REFUSED" },
        });
        expect(
          await fs.readFile(path.join(selected, relativePath), "utf8"),
        ).toBe("after\n");
      }
    },
  );

  it("F1-1 refuses a mutation that names no approved folder identity", async () => {
    const valid = request({
      kind: "workspace.write",
      relativePath: "created.txt",
      content: "created\n",
      expectedSha256: null,
    });
    const { approvedRoot: _identity, ...unbound } = valid.workspace;
    await expect(
      workspace().mutate({
        ...valid,
        workspace: unbound,
      } as unknown as WorkspaceMutationRequest),
    ).resolves.toMatchObject({ ok: false });
    await expect(fs.stat(path.join(root, "created.txt"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });

  it("creates once and replaces only the expected source digest", async () => {
    const native = workspace();
    await expect(
      native.mutate(
        request({
          kind: "workspace.write",
          relativePath: "created.txt",
          content: "created\n",
          expectedSha256: null,
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      value: {
        kind: "workspace.mutation",
        operation: "write",
        relativePath: "created.txt",
        bytes: 8,
        replacements: 0,
        beforeSha256: null,
        afterSha256: digest("created\n"),
      },
    });
    await expect(
      native.mutate(
        request({
          kind: "workspace.write",
          relativePath: "created.txt",
          content: "blind overwrite\n",
          expectedSha256: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
    });
    expect(await fs.readFile(path.join(root, "created.txt"), "utf8")).toBe(
      "created\n",
    );
    expect((await fs.stat(path.join(root, "created.txt"))).nlink).toBe(1);

    await expect(
      native.mutate(
        request({
          kind: "workspace.write",
          relativePath: "README.md",
          content: "after\n",
          expectedSha256: digest("before\n"),
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        beforeSha256: digest("before\n"),
        afterSha256: digest("after\n"),
      },
    });
  });

  it("AUTH-04 never clobbers a destination created at the publication boundary", async () => {
    const destination = path.join(root, "created-race.txt");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "created-race.txt",
        content: "farol-candidate\n",
        expectedSha256: null,
      }),
      {
        testHookRequest: { phase: "before-publish", index: null },
        testHook: async () => {
          await fs.writeFile(destination, "competing-writer\n", {
            mode: 0o600,
            flag: "wx",
          });
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
    });
    expect(await fs.readFile(destination, "utf8")).toBe("competing-writer\n");
    expect(await leftovers()).toEqual([]);
  });

  it("AUTH-04 never overwrites an external write made after the replacement check", async () => {
    const target = path.join(root, "README.md");
    for (const [label, externalWrite] of [
      [
        "in place",
        async () => {
          await fs.appendFile(target, "external line\n");
        },
      ],
      [
        "by replacement",
        async () => {
          await fs.writeFile(`${target}.next`, "external file\n", {
            mode: 0o600,
          });
          await fs.rename(`${target}.next`, target);
        },
      ],
    ] as const) {
      await fs.writeFile(target, "before\n", { mode: 0o600 });
      let external = "";
      const result = await workspace().mutate(
        request({
          kind: "workspace.write",
          relativePath: "README.md",
          content: "farol-candidate\n",
          expectedSha256: digest("before\n"),
        }),
        {
          testHookRequest: { phase: "before-publish", index: null },
          testHook: async () => {
            await externalWrite();
            external = await fs.readFile(target, "utf8");
          },
        },
      );

      expect({ label, result }).toMatchObject({
        label,
        result: {
          ok: false,
          error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
        },
      });
      expect(await fs.readFile(target, "utf8")).toBe(external);
      expect(await leftovers()).toEqual([]);
    }
  });

  it("AUTH-04 keeps both external versions when the staged name and the target are replaced right after the exchange", async () => {
    // Early interference with both names at once: right after the exchange
    // the staged name (holding the checked original) is overwritten by one
    // external save and the target by another. This is not the late rollback
    // case (RB-05 below covers that); it pins that the edit claims neither
    // outcome and that neither external version is lost.
    const target = path.join(root, "README.md");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "README.md",
        content: "farol-candidate\n",
        expectedSha256: digest("before\n"),
      }),
      {
        testHookRequest: { phase: "after-exchange", index: null },
        testHook: async () => {
          await atomicSave(await stagedPath(), "external save 1\n");
          await atomicSave(target, "external save 2\n");
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    // The target no longer holds the candidate, so nothing is exchanged back:
    // the newest save stays at the target, the other is kept in staging.
    expect(await fs.readFile(target, "utf8")).toBe("external save 2\n");
    expect(await retained()).toEqual(["external save 1\n"]);
  });

  it("AUTH-04 reports an unknown outcome, never success, when the target is replaced right after the exchange", async () => {
    const target = path.join(root, "README.md");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "README.md",
        content: "farol-candidate\n",
        expectedSha256: digest("before\n"),
      }),
      {
        testHookRequest: { phase: "after-exchange", index: null },
        testHook: async () => {
          // An external atomic save lands on the target right after the
          // exchange and leaves the private name (the checked original)
          // untouched: the target no longer holds this edit.
          await fs.writeFile(`${target}.external`, "external save\n", {
            mode: 0o600,
          });
          await fs.rename(`${target}.external`, target);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    // The external save is kept as the target; the checked original survives
    // under a private name instead of being deleted as if the edit had won.
    expect(await fs.readFile(target, "utf8")).toBe("external save\n");
    expect(await retained()).toEqual(["before\n"]);
  });

  it("RB-08 reports an unknown outcome, never success, when bytes are written into the published candidate", async () => {
    // The candidate keeps its inode when someone appends through the target,
    // so only its bytes can tell that the edit's result is no longer what the
    // receipt would describe.
    const target = path.join(root, "README.md");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "README.md",
        content: "farol-candidate\n",
        expectedSha256: digest("before\n"),
      }),
      {
        testHookRequest: { phase: "after-original-check", index: null },
        testHook: async () => {
          await fs.appendFile(target, "external\n");
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    expect(await fs.readFile(target, "utf8")).toBe(
      "farol-candidate\nexternal\n",
    );
  });

  it("RB-09 reports an unknown outcome when its staging directory is no longer its own to remove", async () => {
    const target = path.join(root, "README.md");
    let foreign = "";
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "README.md",
        content: "farol-candidate\n",
        expectedSha256: digest("before\n"),
      }),
      {
        testHookRequest: { phase: "before-stage-removal", index: null },
        testHook: async () => {
          const stage = path.dirname(await stagedPath());
          foreign = stage;
          await fs.rename(stage, `${stage}.moved`);
          await fs.mkdir(stage, { mode: 0o700 });
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    expect(await fs.readFile(target, "utf8")).toBe("farol-candidate\n");
    // The directory that took the stage's name is not the helper's to remove.
    await expect(fs.stat(foreign)).resolves.toBeTruthy();
  });

  it("AUTH-05 validates create-only content before creating parent directories", async () => {
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "invalid/nested/file.txt",
        content: "\ud800",
        expectedSha256: null,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_INVALID_REQUEST", retry: "never" },
    });
    await expect(fs.stat(path.join(root, "invalid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("AUTH-05 keeps successful nested create-only writes available", async () => {
    await expect(
      workspace().mutate(
        request({
          kind: "workspace.write",
          relativePath: "created/nested/file.txt",
          content: "nested-success\n",
          expectedSha256: null,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        relativePath: "created/nested/file.txt",
        beforeSha256: null,
        afterSha256: digest("nested-success\n"),
      },
    });
    expect(
      await fs.readFile(path.join(root, "created/nested/file.txt"), "utf8"),
    ).toBe("nested-success\n");
  });

  it("AUTH-05 reports created parents when a competing writer keeps them in use", async () => {
    const destination = path.join(root, "shared", "nested", "created.txt");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "shared/nested/created.txt",
        content: "farol-candidate\n",
        expectedSha256: null,
      }),
      {
        testHookRequest: { phase: "before-publish", index: null },
        testHook: async () => {
          await fs.writeFile(destination, "competing-writer\n", {
            mode: 0o600,
            flag: "wx",
          });
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    expect(await fs.readFile(destination, "utf8")).toBe("competing-writer\n");
  });

  it("edits one unique match and rejects stale or ambiguous input", async () => {
    const native = workspace();
    await expect(
      native.mutate(
        request({
          kind: "workspace.edit",
          relativePath: "README.md",
          expectedSha256: digest("before\n"),
          edits: [{ oldText: "before", newText: "after" }],
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { operation: "edit", replacements: 1 },
    });
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "after\n",
    );

    await fs.writeFile(path.join(root, "README.md"), "same same\n");
    await expect(
      native.mutate(
        request({
          kind: "workspace.edit",
          relativePath: "README.md",
          expectedSha256: digest("same same\n"),
          edits: [{ oldText: "same", newText: "changed" }],
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_EDIT_NOT_UNIQUE", retry: "never" },
    });
  });

  describe("C05-02 byte fidelity of untouched line endings", () => {
    const utf8 = (value: string) => Buffer.from(value, "utf8");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);

    it("keeps every untouched LF and CRLF of a mixed-EOL file", async () => {
      const before = utf8("first\r\nkeep\nchange this\nlast\n");
      const expected = utf8("first\r\nkeep\nchange that\nlast\n");
      const { result, after } = await editFileBytes("mixed.txt", before, [
        { oldText: "this", newText: "that" },
      ]);

      expect(visible(after)).toBe(visible(expected));
      expect(result).toEqual({
        ok: true,
        value: {
          kind: "workspace.mutation",
          operation: "edit",
          relativePath: "mixed.txt",
          bytes: expected.length,
          replacements: 1,
          beforeSha256: digest(before),
          afterSha256: digest(expected),
        },
      });
    });

    it("gives inserted line breaks the ending of the line the edit starts on", async () => {
      const before = utf8("one\r\ntwo\nthree\r\nfour\n");
      const expected = utf8("1\r\ntwo\ntwo-b\n3\r\n3-b\r\nfour\n");
      const { result, after } = await editFileBytes("mixed-many.txt", before, [
        { oldText: "three", newText: "3\n3-b" },
        { oldText: "one", newText: "1" },
        { oldText: "two", newText: "two\ntwo-b" },
      ]);

      expect(visible(after)).toBe(visible(expected));
      expect(result).toMatchObject({
        ok: true,
        value: { replacements: 3, afterSha256: digest(expected) },
      });
    });

    it("keeps uniform LF files LF, including multi-line insertions", async () => {
      const before = utf8("alpha\nbeta\ngamma\n");
      const expected = utf8("alpha\nbeta-1\nbeta-2\ngamma\n");
      const { after } = await editFileBytes("uniform-lf.txt", before, [
        { oldText: "beta", newText: "beta-1\r\nbeta-2" },
      ]);

      expect(visible(after)).toBe(visible(expected));
    });

    it("keeps uniform CRLF files CRLF and matches LF-spelled multi-line text", async () => {
      const before = utf8("alpha\r\nbeta\r\ngamma\r\n");
      const expected = utf8("alpha\r\nBETA\r\nGAMMA\r\nDELTA\r\n");
      const { after } = await editFileBytes("uniform-crlf.txt", before, [
        { oldText: "beta\ngamma", newText: "BETA\nGAMMA\nDELTA" },
      ]);

      expect(visible(after)).toBe(visible(expected));
    });

    it("preserves a BOM and mixed endings together", async () => {
      const before = Buffer.concat([bom, utf8("head\r\nbody\ntail")]);
      const expected = Buffer.concat([bom, utf8("head\r\nBODY\ntail")]);
      const { after } = await editFileBytes("bom-mixed.txt", before, [
        { oldText: "body", newText: "BODY" },
      ]);

      expect(visible(after)).toBe(visible(expected));
    });

    it("uses the preceding line ending on an unterminated last line", async () => {
      const before = utf8("alpha\nbeta\r\ngamma");
      const expected = utf8("alpha\nbeta\r\ngamma\r\ndelta");
      const { after } = await editFileBytes("no-final-newline.txt", before, [
        { oldText: "gamma", newText: "gamma\ndelta" },
      ]);

      expect(visible(after)).toBe(visible(expected));
    });

    it("uses LF when the file has no line ending at all", async () => {
      const before = utf8("single line");
      const expected = utf8("single\nline");
      const { after } = await editFileBytes("single-line.txt", before, [
        { oldText: "single line", newText: "single\nline" },
      ]);

      expect(visible(after)).toBe(visible(expected));
    });

    it("refuses ambiguous, overlapping and stale edits before any byte changes", async () => {
      const before = utf8("same\r\nsame\nother\n");
      for (const [edits, expectedSha256, code] of [
        [
          [{ oldText: "same", newText: "changed" }],
          digest(before),
          "WORKSPACE_EDIT_NOT_UNIQUE",
        ],
        [
          [
            { oldText: "same\nother", newText: "x" },
            { oldText: "other", newText: "y" },
          ],
          digest(before),
          "WORKSPACE_EDIT_OVERLAP",
        ],
        [
          [{ oldText: "other", newText: "changed" }],
          digest("stale snapshot\n"),
          "WORKSPACE_MUTATION_CONFLICT",
        ],
      ] as const) {
        const { result, after } = await editFileBytes(
          "refused.txt",
          before,
          [...edits],
          expectedSha256,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code, retry: "never" },
        });
        expect(visible(after)).toBe(visible(before));
      }
    });
  });

  it("enforces credential and write-only exclusions", async () => {
    await fs.writeFile(path.join(root, ".env"), "TOKEN=canary\n", {
      mode: 0o600,
    });
    const native = workspace();
    for (const [relativePath, expectedSha256] of [
      [".env", digest("TOKEN=canary\n")],
      [".git/config", digest("safe\n")],
    ] as const) {
      await expect(
        native.mutate(
          request({
            kind: "workspace.write",
            relativePath,
            content: "changed\n",
            expectedSha256,
          }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
      });
    }
  });

  it("reports a lost post-replace acknowledgement as unknown and never retries", async () => {
    const native = workspace();
    const operation = request({
      kind: "workspace.write",
      relativePath: "README.md",
      content: "possibly applied\n",
      expectedSha256: digest("before\n"),
    });
    await expect(
      native.mutate(operation, {
        testHookRequest: { phase: "after-replace", index: null },
        testHook: async () => {
          throw new Error("SYNTHETIC_ACK_LOSS");
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
        retry: "never",
      },
    });
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "possibly applied\n",
    );
    await expect(native.mutate(operation)).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
    });
  });

  it("C05-10 refuses an oversized write-exclusion union before any effect", async () => {
    const result = await workspace().mutate({
      workspace: {
        workspaceId: "workspace-write-a",
        root,
        approvedRoot: approvedRootOf(root),
        deniedPaths: [".env"],
        writeDeniedPaths: Array.from(
          { length: 64 },
          (_, index) => `write-excluded-${index}`,
        ),
      },
      operation: {
        kind: "workspace.write",
        relativePath: "README.md",
        content: "changed\n",
        expectedSha256: digest("before\n"),
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_POLICY_TOO_LARGE", retry: "never" },
    });
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "before\n",
    );
  });
});

describe("C05-05 cancellation of helper work", () => {
  // Counts real interpreter launches, so "zero spawn" is observed rather
  // than assumed.
  async function countingInterpreter(): Promise<{
    interpreter: string;
    launches: () => Promise<number>;
  }> {
    const counter = path.join(root, ".launches");
    const interpreter = path.join(root, ".counting-python");
    await fs.writeFile(
      interpreter,
      `#!/bin/sh\nprintf x >> ${JSON.stringify(counter)}\nexec /usr/bin/python3 "$@"\n`,
      { mode: 0o700 },
    );
    return {
      interpreter,
      launches: async () =>
        (await fs.readFile(counter, "utf8").catch(() => "")).length,
    };
  }

  function countedWorkspace(interpreter: string): NativeReadonlyWorkspace {
    return new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: SAFE_OPEN_HELPER,
      attestInterpreter: async () => interpreter,
    });
  }

  const readRequest = () => ({
    workspace: {
      workspaceId: "workspace-write-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: [".env"],
    },
    operation: { kind: "workspace.read" as const, relativePath: "README.md" },
  });

  it("starts no helper for an already cancelled read or edit", async () => {
    const { interpreter, launches } = await countingInterpreter();
    const native = countedWorkspace(interpreter);
    const controller = new AbortController();
    controller.abort();

    await expect(
      native.execute(readRequest(), { signal: controller.signal }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_REQUEST_CANCELLED", retry: "never" },
    });
    await expect(
      native.mutate(
        request({
          kind: "workspace.write",
          relativePath: "README.md",
          content: "after\n",
          expectedSha256: digest("before\n"),
        }),
        { signal: controller.signal },
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_CANCELLED", retry: "never" },
    });
    expect(await launches()).toBe(0);
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "before\n",
    );
  });

  it("stops a read in progress and waits for the helper to exit", async () => {
    const { interpreter, launches } = await countingInterpreter();
    const controller = new AbortController();

    const result = await countedWorkspace(interpreter).execute(readRequest(), {
      signal: controller.signal,
      testHookRequest: { phase: "before-post-stat", index: null },
      testHook: async () => {
        controller.abort();
        await new Promise(() => undefined);
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_REQUEST_CANCELLED", retry: "never" },
    });
    expect(await launches()).toBe(1);
  });

  it("never reports a cancelled edit as unapplied once publication happened", async () => {
    const controller = new AbortController();

    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "README.md",
        content: "published\n",
        expectedSha256: digest("before\n"),
      }),
      {
        signal: controller.signal,
        testHookRequest: { phase: "after-replace", index: null },
        testHook: async () => {
          controller.abort();
          await new Promise(() => undefined);
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
    });
    expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe(
      "published\n",
    );
  });
});

// R5 / HR-015: the guarded edit's publication point and cleanup ownership.
//
// A replace is published at one atomic exchange of names; it is valid only
// when the object the exchange displaced is the checked original. Success
// also needs the helper's final observation, made after its last filesystem
// operation, to find the published file at the target: a save after that is
// a later write and wins untouched. Cleanup deletes only objects whose inode
// the helper verified -- its own candidate or the checked original -- and
// keeps anything else it finds under its names. Each barrier below is a real
// two-process pause of the helper at a named point, never a sleep.
describe("R5 guarded-edit publication and cleanup contract", () => {
  const target = () => path.join(root, "README.md");
  const replace = () =>
    request({
      kind: "workspace.write",
      relativePath: "README.md",
      content: "farol-candidate\n",
      expectedSha256: digest("before\n"),
    });
  const unknown = {
    ok: false,
    error: { code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", retry: "never" },
  };
  const conflict = {
    ok: false,
    error: { code: "WORKSPACE_MUTATION_CONFLICT", retry: "never" },
  };

  it("RB-01 publishes an ordinary replace and leaves nothing of its own behind", async () => {
    await expect(workspace().mutate(replace())).resolves.toMatchObject({
      ok: true,
      value: { afterSha256: digest("farol-candidate\n") },
    });
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await leftovers()).toEqual([]);
  });

  it("RB-02 undoes an exchange that displaced a save made after the identity check, reaching the undo once", async () => {
    const reached: number[] = [];
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "before-undo", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        if (barrier === 0) await atomicSave(target(), "external save 1\n");
      },
    });

    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(conflict);
    expect(await fs.readFile(target(), "utf8")).toBe("external save 1\n");
    expect(await leftovers()).toEqual([]);
  });

  it("RB-05 keeps both external saves when a second one lands after the failed original check, before the undo", async () => {
    // E1 replaces the target after the identity check, so the exchange
    // displaces E1, not the checked original. E2 replaces the target (then
    // holding the candidate) after that failed check and before the undo, so
    // the undo moves E2 into the helper's own names. Both are someone else's.
    const reached: number[] = [];
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "before-undo", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        await atomicSave(
          target(),
          barrier === 0 ? "external save 1\n" : "external save 2\n",
        );
      },
    });

    // Each barrier once: the late seam was reached and nothing was retried.
    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("external save 1\n");
    expect(await retained()).toEqual(["external save 2\n"]);
  });

  it("R5-B keeps an object that replaced the staged candidate before a refused publication", async () => {
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "before-replace", index: null },
      testHook: async () => {
        const staged = await stagedPath();
        await fs.rename(staged, path.join(root, "moved-candidate"));
        await atomicSave(staged, "foreign object\n");
        await atomicSave(target(), "external save\n");
      },
    });

    expect(result).toEqual(conflict);
    expect(await fs.readFile(target(), "utf8")).toBe("external save\n");
    expect(await retained()).toEqual(["foreign object\n"]);
  });

  it("R5-B keeps an object that replaced the staged candidate when the destination appeared first", async () => {
    const destination = path.join(root, "created-race.txt");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "created-race.txt",
        content: "farol-candidate\n",
        expectedSha256: null,
      }),
      {
        testHookRequest: { phase: "before-publish", index: null },
        testHook: async () => {
          const staged = await stagedPath();
          await fs.rename(staged, path.join(root, "moved-candidate"));
          await atomicSave(staged, "foreign object\n");
          await fs.writeFile(destination, "competing-writer\n", {
            mode: 0o600,
            flag: "wx",
          });
        },
      },
    );

    expect(result).toEqual(conflict);
    expect(await fs.readFile(destination, "utf8")).toBe("competing-writer\n");
    expect(await retained()).toEqual(["foreign object\n"]);
  });

  it("R5-B keeps an object that replaced the checked original under the staged name before cleanup", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-original-check", index: null },
      testHook: async () => {
        reached += 1;
        const staged = await stagedPath();
        await fs.rename(staged, path.join(root, "moved-original"));
        await atomicSave(staged, "foreign object\n");
      },
    });

    expect(reached).toBe(1);
    // The exchange displaced the checked original and the target still holds
    // the candidate, but an object the helper did not create had to be kept:
    // that is never reported as a clean success.
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await fs.readFile(path.join(root, "moved-original"), "utf8")).toBe(
      "before\n",
    );
    expect(await retained()).toEqual(["foreign object\n"]);
  });

  it("R5-B keeps an object that replaced the staging link of a created file and reports the create as unknown", async () => {
    let reached = 0;
    const destination = path.join(root, "created.txt");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "created.txt",
        content: "farol-candidate\n",
        expectedSha256: null,
      }),
      {
        testHookRequest: { phase: "after-link", index: null },
        testHook: async () => {
          reached += 1;
          const staged = await stagedPath();
          await fs.rename(staged, path.join(root, "moved-link"));
          await atomicSave(staged, "foreign object\n");
        },
      },
    );

    expect(reached).toBe(1);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(destination, "utf8")).toBe("farol-candidate\n");
    expect(await retained()).toEqual(["foreign object\n"]);
  });

  it("R5-A lets a save after the final observation win untouched while the publication stands", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-final-check", index: null },
      testHook: async () => {
        reached += 1;
        await atomicSave(target(), "later save\n");
      },
    });

    expect(reached).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      value: { afterSha256: digest("farol-candidate\n") },
    });
    expect(await fs.readFile(target(), "utf8")).toBe("later save\n");
    expect(await leftovers()).toEqual([]);
  });

  it("R5 keeps the candidate a target writer changed in place before the undo", async () => {
    // The candidate is visible at the target from the exchange to its undo.
    // An in-place append made through the target path in that window lands
    // in the candidate, so the candidate that comes back is no longer only
    // ours and must be kept, not deleted as a returned candidate.
    const reached: number[] = [];
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "before-undo", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        await fs.appendFile(
          target(),
          barrier === 0 ? "external line 1\n" : "external line 2\n",
        );
      },
    });

    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe(
      "before\nexternal line 1\n",
    );
    expect(await retained()).toEqual(["farol-candidate\nexternal line 2\n"]);
  });

  it("RB-07 leaves a newer save at the target when it lands after the failed original check", async () => {
    const reached: number[] = [];
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "after-original-mismatch", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        await atomicSave(
          target(),
          barrier === 0 ? "external save 1\n" : "external save 2\n",
        );
      },
    });

    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(unknown);
    // Nothing is exchanged back over the newer save: it stays at the target,
    // and staging keeps the version the exchange displaced.
    expect(await fs.readFile(target(), "utf8")).toBe("external save 2\n");
    expect(await retained()).toEqual(["external save 1\n"]);
  });

  it("R5-B never publishes an object substituted for the candidate", async () => {
    const destination = path.join(root, "created-substitute.txt");
    const result = await workspace().mutate(
      request({
        kind: "workspace.write",
        relativePath: "created-substitute.txt",
        content: "farol-candidate\n",
        expectedSha256: null,
      }),
      {
        testHookRequest: { phase: "before-publish", index: null },
        testHook: async () => {
          const staged = await stagedPath();
          await fs.rename(staged, path.join(root, "moved-candidate"));
          await atomicSave(staged, "foreign object\n");
        },
      },
    );

    expect(result).toEqual(conflict);
    await expect(fs.stat(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await retained()).toEqual(["foreign object\n"]);
  });

  it("R5 refuses a staging directory it did not create privately", async () => {
    let planted = "";
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-stage-mkdir", index: null },
      testHook: async () => {
        const [stage] = (await fs.readdir(root)).filter((entry) =>
          entry.startsWith(".farol-stage-"),
        );
        if (!stage) throw new Error("stage missing");
        planted = path.join(root, stage);
        await fs.rmdir(planted);
        await fs.mkdir(planted);
        await fs.chmod(planted, 0o777);
      },
    });

    expect(result).toEqual(conflict);
    expect(await fs.readFile(target(), "utf8")).toBe("before\n");
    // The planted directory is not the helper's: it is neither used nor
    // removed.
    expect((await fs.stat(planted)).mode & 0o777).toBe(0o777);
    await fs.rmdir(planted);
  });

  it("R5-A reports unknown when the target is replaced after the exchange but before the final observation", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "before-discard", index: null },
      testHook: async () => {
        reached += 1;
        await atomicSave(target(), "external save\n");
      },
    });

    expect(reached).toBe(1);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("external save\n");
    expect(await leftovers()).toEqual([]);
  });

  // A8: the exceptional paths after the publication point. A refused undo
  // exchange and an internal error once the exchange happened are both
  // unknown, never retried, and lose nothing: whatever the exchange displaced
  // stays in staging and the candidate stays where it landed.
  it("A8 reports a refused undo exchange as unknown and keeps every version", async () => {
    const reached: number[] = [];
    const moved = path.join(root, "moved-candidate");
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "before-undo", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        // E1 lands after the identity check, so the exchange displaces it
        // and an undo is due. Then the target -- holding the candidate -- is
        // renamed away, so the undo exchange itself is refused.
        if (barrier === 0) await atomicSave(target(), "external save 1\n");
        else await fs.rename(target(), moved);
      },
    });

    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(unknown);
    await expect(fs.stat(target())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(moved, "utf8")).toBe("farol-candidate\n");
    expect(await retained()).toEqual(["external save 1\n"]);
  });

  it("A8 reports an internal error right after the exchange as unknown and keeps the displaced original", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-exchange", index: null },
      testHook: async () => {
        reached += 1;
        return "helper-fault";
      },
    });

    expect(reached).toBe(1);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await retained()).toEqual(["before\n"]);
  });

  it("A8 reports an internal error after the original check as unknown and keeps the checked original", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-original-check", index: null },
      testHook: async () => {
        reached += 1;
        return "helper-fault";
      },
    });

    expect(reached).toBe(1);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await retained()).toEqual(["before\n"]);
  });

  it("A8 reports an internal error before the undo as unknown and keeps the displaced save", async () => {
    const reached: number[] = [];
    const result = await workspace().mutate(replace(), {
      testHookRequest: [
        { phase: "before-publish", index: null },
        { phase: "before-undo", index: null },
      ],
      testHook: async (barrier: number) => {
        reached.push(barrier);
        if (barrier === 0) {
          await atomicSave(target(), "external save 1\n");
          return undefined;
        }
        return "helper-fault";
      },
    });

    expect(reached).toEqual([0, 1]);
    expect(result).toEqual(unknown);
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await retained()).toEqual(["external save 1\n"]);
  });

  it("A8 positive control: without a fault the same barriers end in a clean success", async () => {
    let reached = 0;
    const result = await workspace().mutate(replace(), {
      testHookRequest: { phase: "after-exchange", index: null },
      testHook: async () => {
        reached += 1;
      },
    });

    expect(reached).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      value: { afterSha256: digest("farol-candidate\n") },
    });
    expect(await fs.readFile(target(), "utf8")).toBe("farol-candidate\n");
    expect(await leftovers()).toEqual([]);
  });
});
