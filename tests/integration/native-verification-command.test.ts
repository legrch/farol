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
import { executeNativeVerificationCommand } from "../../src/modules/computer/infra/native/native-verification-command";

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

function workspace(
  attestGit: () => Promise<string> = async () => git,
): NativeReadonlyWorkspace {
  return new NativeReadonlyWorkspace({
    helperPath: sourceHelper,
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
    attestGit,
  });
}

async function compileCommandFixture(
  name: string,
  source: string,
): Promise<string> {
  const sourcePath = path.join(root, `${name}.c`);
  const executablePath = path.join(root, name);
  const clang = (
    await executeFile("/usr/bin/xcrun", ["--find", "clang"])
  ).stdout.trim();
  const sdk = (
    await executeFile("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"])
  ).stdout.trim();
  await fs.writeFile(sourcePath, source, { mode: 0o600 });
  await executeFile(clang, [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-isysroot",
    sdk,
    sourcePath,
    "-o",
    executablePath,
  ]);
  return executablePath;
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
  it("attests and caches the reviewed Apple Git chain before production execution", async () => {
    const productionWorkspace = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
    });

    await expect(productionWorkspace.execute(request())).resolves.toMatchObject(
      {
        ok: true,
        value: {
          kind: "workspace.command",
          command: "git.status",
          exitCode: 0,
        },
      },
    );
    await expect(productionWorkspace.execute(request())).resolves.toMatchObject(
      {
        ok: true,
        value: { kind: "workspace.command", exitCode: 0 },
      },
    );
  });

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

  it("fails closed when Git attestation is missing or malformed", async () => {
    await expect(
      workspace(async () => {
        throw new Error("attestation unavailable");
      }).execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
        retry: "never",
      },
    });
    await expect(
      workspace(async () => "relative/git").execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
        retry: "never",
      },
    });
  });

  it("classifies a non-zero reviewed command as a non-retryable failure", async () => {
    await expect(
      workspace(async () => "/usr/bin/false").execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("terminates a reviewed command before unbounded output escapes", async () => {
    await expect(
      workspace(async () => "/usr/bin/yes").execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
        retry: "never",
      },
    });
  });

  it("bounds stderr from the exact reviewed process", async () => {
    const fixture = await compileCommandFixture(
      "stderr-command",
      `#include <stddef.h>
#include <unistd.h>

int main(void) {
  char output[5000];
  for (size_t index = 0; index < sizeof(output); index += 1) {
    output[index] = 'x';
  }
  const ssize_t written = write(STDERR_FILENO, output, sizeof(output));
  return written < 0 ? 1 : 0;
}
`,
    );

    await expect(
      workspace(async () => fixture).execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
        retry: "never",
      },
    });
  });

  it("rejects any stderr from the exact reviewed process", async () => {
    const fixture = await compileCommandFixture(
      "stderr-failure-command",
      `#include <stddef.h>
#include <unistd.h>

int main(void) {
  const char output[] = "unexpected stderr";
  const ssize_t written = write(STDERR_FILENO, output, sizeof(output) - 1);
  return written == (ssize_t)(sizeof(output) - 1) ? 0 : 1;
}
`,
    );

    await expect(
      workspace(async () => fixture).execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("rejects NUL bytes from the exact reviewed process", async () => {
    const fixture = await compileCommandFixture(
      "nul-command",
      `#include <stddef.h>
#include <unistd.h>

int main(void) {
  const unsigned char output[] = {'o', 'k', 0, 'x'};
  const ssize_t written = write(STDOUT_FILENO, output, sizeof(output));
  return written == (ssize_t)sizeof(output) ? 0 : 1;
}
`,
    );

    await expect(
      workspace(async () => fixture).execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("rejects malformed UTF-8 from the exact reviewed process", async () => {
    const fixture = await compileCommandFixture(
      "invalid-utf8-command",
      `#include <stddef.h>
#include <unistd.h>

int main(void) {
  const unsigned char output[] = {0xff};
  const ssize_t written = write(STDOUT_FILENO, output, sizeof(output));
  return written == (ssize_t)sizeof(output) ? 0 : 1;
}
`,
    );

    await expect(
      workspace(async () => fixture).execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("fails closed when repository metadata disappears before execution", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true, force: true });

    await expect(workspace().execute(request())).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_UNSUPPORTED", retry: "never" },
    });
  });

  it("rejects invalid roots and denied paths at the native command boundary", async () => {
    const operation = {
      kind: "verification.run",
      command: "git.status",
      relativePath: ".",
    } as const;

    await expect(
      executeNativeVerificationCommand(
        {
          workspace: {
            workspaceId: "workspace-a",
            root: "/",
            deniedPaths: [],
          },
          operation,
        },
        operation,
        { attestGit: async () => git },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_UNSUPPORTED", retry: "never" },
    });

    await expect(
      executeNativeVerificationCommand(
        {
          workspace: {
            workspaceId: "workspace-a",
            root,
            deniedPaths: ["../private"],
          },
          operation,
        },
        operation,
        { attestGit: async () => git },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_UNSUPPORTED", retry: "never" },
    });

    await expect(
      executeNativeVerificationCommand(
        {
          workspace: {
            workspaceId: "workspace-a",
            root,
            deniedPaths: ["private\nscope"],
          },
          operation,
        },
        operation,
        { attestGit: async () => git },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_UNSUPPORTED", retry: "never" },
    });
  });
});
