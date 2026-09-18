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
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";

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
      deniedPaths: [".env"],
      writeDeniedPaths: [".git"],
    },
    operation,
  };
}

function workspace(): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mutation-")),
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

describe("native mutable Computer workspace", () => {
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
    expect(
      (await fs.readdir(root)).some((entry) => entry.startsWith(".farol-tmp-")),
    ).toBe(false);
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
      helper: NEXT_SAFE_OPEN_HELPER,
      attestInterpreter: async () => interpreter,
    });
  }

  const readRequest = () => ({
    workspace: {
      workspaceId: "workspace-write-a",
      root,
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
