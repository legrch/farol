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

function headRequest(): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      deniedPaths: ["private"],
    },
    operation: {
      kind: "verification.run",
      command: "git.head",
      relativePath: ".",
    },
  } as unknown as ReadonlyWorkspaceRequest;
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

  it("reports the exact repository HEAD through a second fixed no-network profile", async () => {
    const expected = (
      await executeFile(git, ["-C", root, "rev-parse", "--verify", "HEAD"])
    ).stdout;

    await expect(workspace().execute(headRequest())).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.command",
        command: "git.head",
        relativePath: ".",
        exitCode: 0,
        stdout: expected,
        stderr: "",
        outputBytes: Buffer.byteLength(expected),
        network: "none",
      },
    });
  });

  it("rejects a malformed repository identity from the fixed HEAD profile", async () => {
    const malformedHead = await compileCommandFixture(
      "malformed-head",
      `#include <stddef.h>
#include <unistd.h>

int main(void) {
  const char output[] = "not-a-commit\\n";
  const ssize_t written = write(STDOUT_FILENO, output, sizeof(output) - 1);
  return written == (ssize_t)(sizeof(output) - 1) ? 0 : 1;
}
`,
    );

    await expect(
      workspace(async () => malformedHead).execute(headRequest()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("supports one exact linked worktree without authorizing its metadata parent", async () => {
    const mainRoot = root;
    const worktreeParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-worktree-parent-"),
    );
    const linkedRoot = path.join(worktreeParent, "checkout");
    const parentCanary = path.join(worktreeParent, "parent-canary");
    try {
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linkedRoot,
      ]);
      root = await fs.realpath(linkedRoot);
      await fs.writeFile(parentCanary, "parent private\n", { mode: 0o600 });
      await fs.writeFile(path.join(root, "README.md"), "linked change\n", {
        mode: 0o600,
      });

      await expect(workspace().execute(request())).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          command: "git.status",
          relativePath: ".",
          stdout: expect.stringContaining("README.md"),
          network: "none",
        },
      });

      const parentReader = await compileCommandFixture(
        "parent-reader",
        `#include <fcntl.h>
#include <stddef.h>
#include <unistd.h>

int main(void) {
  const int descriptor = open(${JSON.stringify(parentCanary)}, O_RDONLY);
  const char denied[] = "parent denied\\n";
  const char readable[] = "parent readable\\n";
  const char *output = descriptor < 0 ? denied : readable;
  const size_t length = descriptor < 0 ? sizeof(denied) - 1 : sizeof(readable) - 1;
  if (descriptor >= 0) {
    close(descriptor);
  }
  const ssize_t written = write(STDOUT_FILENO, output, length);
  return written == (ssize_t)length ? 0 : 1;
}
`,
      );
      await expect(
        workspace(async () => parentReader).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "parent denied\n",
          network: "none",
        },
      });
    } finally {
      root = mainRoot;
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "remove",
        "--force",
        linkedRoot,
      ]).catch(() => undefined);
      await fs.rm(worktreeParent, { recursive: true, force: true });
    }
  });

  it("rejects a linked worktree that redirects its Git file to arbitrary metadata", async () => {
    const mainRoot = root;
    const worktreeParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-worktree-metadata-"),
    );
    const linkedRoot = path.join(worktreeParent, "checkout");
    let originalGitFile = "";
    try {
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linkedRoot,
      ]);
      root = await fs.realpath(linkedRoot);
      const gitFile = path.join(root, ".git");
      originalGitFile = await fs.readFile(gitFile, "utf8");
      await fs.writeFile(gitFile, `gitdir: ${path.join(mainRoot, ".git")}\n`, {
        mode: 0o600,
      });

      await expect(workspace().execute(request())).resolves.toMatchObject({
        ok: false,
        error: {
          code: "WORKSPACE_COMMAND_UNSUPPORTED",
          retry: "never",
        },
      });
    } finally {
      if (originalGitFile !== "") {
        await fs
          .writeFile(path.join(linkedRoot, ".git"), originalGitFile, {
            mode: 0o600,
          })
          .catch(() => undefined);
      }
      root = mainRoot;
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "remove",
        "--force",
        linkedRoot,
      ]).catch(() => undefined);
      await fs.rm(worktreeParent, { recursive: true, force: true });
    }
  });

  it("rejects writable linked-worktree metadata", async () => {
    const mainRoot = root;
    const worktreeParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-worktree-writable-"),
    );
    const linkedRoot = path.join(worktreeParent, "checkout");
    let gitDirectory = "";
    let originalMode = 0;
    try {
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        linkedRoot,
      ]);
      root = await fs.realpath(linkedRoot);
      const gitFile = await fs.readFile(path.join(root, ".git"), "utf8");
      const gitDirectoryLine = /^gitdir: ([^\r\n]+)\n?$/u.exec(gitFile)?.[1];
      expect(gitDirectoryLine).toBeDefined();
      gitDirectory = path.resolve(root, gitDirectoryLine ?? "");
      originalMode = (await fs.stat(gitDirectory)).mode & 0o777;
      await fs.chmod(gitDirectory, originalMode | 0o022);

      await expect(workspace().execute(request())).resolves.toMatchObject({
        ok: false,
        error: {
          code: "WORKSPACE_COMMAND_UNSUPPORTED",
          retry: "never",
        },
      });
    } finally {
      if (gitDirectory !== "" && originalMode !== 0) {
        await fs.chmod(gitDirectory, originalMode).catch(() => undefined);
      }
      root = mainRoot;
      await executeFile(git, [
        "-C",
        mainRoot,
        "worktree",
        "remove",
        "--force",
        linkedRoot,
      ]).catch(() => undefined);
      await fs.rm(worktreeParent, { recursive: true, force: true });
    }
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

  it("keeps default credential paths denied for verification commands", async () => {
    const credential = path.join(root, ".env");
    await fs.writeFile(credential, "PRIVATE_VALUE=never-read\n", {
      mode: 0o600,
    });
    const credentialReader = await compileCommandFixture(
      "credential-reader",
      `#include <fcntl.h>
#include <stddef.h>
#include <unistd.h>

int main(void) {
  const int descriptor = open(${JSON.stringify(credential)}, O_RDONLY);
  const char denied[] = "credential denied\\n";
  const char readable[] = "credential readable\\n";
  const char *output = descriptor < 0 ? denied : readable;
  const size_t length = descriptor < 0 ? sizeof(denied) - 1 : sizeof(readable) - 1;
  if (descriptor >= 0) {
    close(descriptor);
  }
  const ssize_t written = write(STDOUT_FILENO, output, length);
  return written == (ssize_t)length ? 0 : 1;
}
`,
    );

    await expect(
      workspace(async () => credentialReader).execute(request()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.command",
        stdout: "credential denied\n",
        network: "none",
      },
    });
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

    // C05-07: a root without any .git entry is reported as not a repository
    // rather than as an unsupported command.
    await expect(workspace().execute(request())).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_NOT_GIT_REPOSITORY", retry: "never" },
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

  describe("C05-07 truthful fixed Git coverage", () => {
    it("discloses that status covers tracked files only", async () => {
      await fs.writeFile(path.join(root, "untracked-canary.txt"), "new\n", {
        mode: 0o600,
      });

      const result = await workspace().execute(request());

      expect(result).toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          command: "git.status",
          coverage: "tracked-files-only",
          layout: "primary",
        },
      });
      if (!result.ok || result.value.kind !== "workspace.command") return;
      expect(result.value.stdout).not.toContain("untracked-canary.txt");
    });

    it("names the HEAD profile's coverage and layout", async () => {
      await expect(workspace().execute(headRequest())).resolves.toMatchObject({
        ok: true,
        value: { coverage: "head-commit", layout: "primary" },
      });
    });

    it("distinguishes an unborn HEAD from a failed command", async () => {
      const unborn = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-command-unborn-")),
      );
      const mainRoot = root;
      try {
        await fs.chmod(unborn, 0o700);
        await executeFile(git, ["init", "--quiet", unborn]);
        root = unborn;

        await expect(workspace().execute(headRequest())).resolves.toEqual({
          ok: false,
          error: { code: "WORKSPACE_GIT_HEAD_UNBORN", retry: "never" },
        });
        const status = await workspace().execute(request());
        expect(status).toMatchObject({
          ok: true,
          value: { coverage: "tracked-files-only" },
        });
        if (!status.ok || status.value.kind !== "workspace.command") return;
        expect(status.value.stdout).toContain("No commits yet");
      } finally {
        root = mainRoot;
        await fs.rm(unborn, { recursive: true, force: true });
      }
    });

    it("distinguishes a directory that is not a Git repository", async () => {
      await fs.rm(path.join(root, ".git"), { recursive: true, force: true });

      for (const operation of [request(), headRequest()]) {
        await expect(workspace().execute(operation)).resolves.toEqual({
          ok: false,
          error: { code: "WORKSPACE_NOT_GIT_REPOSITORY", retry: "never" },
        });
      }
    });

    it("reports a linked worktree layout", async () => {
      const mainRoot = root;
      const worktreeParent = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-next-command-layout-"),
      );
      const linkedRoot = path.join(worktreeParent, "checkout");
      try {
        await executeFile(git, [
          "-C",
          mainRoot,
          "worktree",
          "add",
          "--quiet",
          "--detach",
          linkedRoot,
        ]);
        root = await fs.realpath(linkedRoot);

        await expect(workspace().execute(request())).resolves.toMatchObject({
          ok: true,
          value: { layout: "linked-worktree", coverage: "tracked-files-only" },
        });
      } finally {
        root = mainRoot;
        await executeFile(git, [
          "-C",
          mainRoot,
          "worktree",
          "remove",
          "--force",
          linkedRoot,
        ]).catch(() => undefined);
        await fs.rm(worktreeParent, { recursive: true, force: true });
      }
    });
  });
});
