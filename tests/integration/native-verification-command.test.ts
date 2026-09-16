import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReadonlyWorkspaceRequest } from "../../src/modules/computer/app/port/readonly-workspace";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";

const executeFile = promisify(execFile);
const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";
let git = "";

function request(): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      deniedPaths: ["private"],
    },
    operation: {
      kind: "verification.run",
      command: "git.status",
      relativePath: ".",
    },
  };
}

function workspace(): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
    attestGit: async () => git,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-command-"));
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  git = (await executeFile("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();
  await executeFile(git, ["init", "--quiet", root]);
  await fs.writeFile(path.join(root, "README.md"), "before\n", {
    mode: 0o600,
  });
  await executeFile(git, ["-C", root, "add", "README.md"]);
  await executeFile(
    git,
    [
      "-C",
      root,
      "-c",
      "user.name=Farol Test",
      "-c",
      "user.email=farol-test@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("native verification command", () => {
  it("runs only the fixed no-network git status command in the approved workspace", async () => {
    await fs.writeFile(path.join(root, "README.md"), "after\n", {
      mode: 0o600,
    });

    const result = await workspace().execute(request());
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "workspace.command",
        command: "git.status",
        relativePath: ".",
        exitCode: 0,
        stdout: expect.stringContaining("README.md"),
        stderr: "",
        network: "none",
      },
    });
  });

  it("refuses a linked Git directory instead of following command metadata outside the grant", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-gitdir-"),
    );
    try {
      await fs.rename(path.join(root, ".git"), path.join(outside, ".git"));
      await fs.symlink(path.join(outside, ".git"), path.join(root, ".git"));

      await expect(workspace().execute(request())).resolves.toMatchObject({
        ok: false,
        error: {
          code: "WORKSPACE_COMMAND_UNSUPPORTED",
          retry: "never",
        },
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not execute a repository-provided file-system monitor", async () => {
    const canary = path.join(root, "fsmonitor-ran");
    const monitor = path.join(root, "monitor.sh");
    await fs.writeFile(
      monitor,
      `#!/bin/sh\ntouch ${JSON.stringify(canary)}\n`,
      {
        mode: 0o700,
      },
    );
    await executeFile(git, ["-C", root, "config", "core.fsmonitor", monitor]);

    await expect(workspace().execute(request())).resolves.toMatchObject({
      ok: true,
      value: { kind: "workspace.command", exitCode: 0 },
    });
    await expect(fs.stat(canary)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
