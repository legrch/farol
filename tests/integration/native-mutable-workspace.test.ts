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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
});
