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
import {
  discoverLinkedGitMetadata,
  executeNativeVerificationCommand,
  type SnapshotFactory,
} from "../../src/modules/computer/infra/native/native-verification-command";
import { createWorkspaceSnapshot } from "../../src/modules/computer/infra/native/workspace-snapshot";
import { approvedRootOf } from "../fixtures/root-identity";

const executeFile = promisify(execFile);
const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
let root = "";
let git = "";
let runtimeDirectory = "";
// Compiled test doubles live here, never inside `root`: a confinement test
// proves the sandboxed process cannot read a secret sitting next to it in
// the owner's approved folder, so the double itself must sit somewhere else.
let fixturesDirectory = "";

function request(
  gitMetadata?: Readonly<{ gitDirectory: string; commonDirectory: string }>,
): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: ["private"],
      ...(gitMetadata ? { gitMetadata } : {}),
    },
    operation: {
      kind: "verification.run",
      command: "git.status",
      relativePath: ".",
    },
  };
}

function headRequest(
  gitMetadata?: Readonly<{ gitDirectory: string; commonDirectory: string }>,
): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: ["private"],
      ...(gitMetadata ? { gitMetadata } : {}),
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
    runtimeDirectory,
  });
}

// The same production wiring `NativeReadonlyWorkspace` builds internally
// (native-readonly-workspace.ts), exposed directly for the tests that call
// `executeNativeVerificationCommand` below the workspace layer.
function snapshotFactory(): SnapshotFactory {
  return (snapshotRequest) =>
    createWorkspaceSnapshot(snapshotRequest, {
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
      attestInterpreter: async () => "/usr/bin/python3",
      runtimeDirectory,
    });
}

async function compileCommandFixture(
  name: string,
  source: string,
): Promise<string> {
  const sourcePath = path.join(fixturesDirectory, `${name}.c`);
  const executablePath = path.join(fixturesDirectory, name);
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
  runtimeDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-command-runtime-")),
  );
  fixturesDirectory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-command-fixtures-")),
  );
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
  if (runtimeDirectory) {
    await fs.rm(runtimeDirectory, { recursive: true, force: true });
  }
  if (fixturesDirectory) {
    await fs.rm(fixturesDirectory, { recursive: true, force: true });
  }
});

describe("native verification command", () => {
  it("N02 runs both Git verifications for real with no test-only flag anywhere in the path", async () => {
    // The plain production constructor: no experimental flag exists any
    // more, and no launcher override is supplied -- this is exactly what the
    // desktop and the Computer MCP server build.
    const product = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
      runtimeDirectory,
    });
    await expect(product.execute(request())).resolves.toMatchObject({
      ok: true,
      value: { kind: "workspace.command", command: "git.status", exitCode: 0 },
    });
    await expect(product.execute(headRequest())).resolves.toMatchObject({
      ok: true,
      value: { kind: "workspace.command", command: "git.head", exitCode: 0 },
    });
  });

  it("attests and caches the reviewed Apple Git chain before production execution", async () => {
    const productionWorkspace = new NativeReadonlyWorkspace({
      helperPath: sourceHelper,
      helper: NEXT_SAFE_OPEN_HELPER,
      runtimeDirectory,
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

  it("supports one exact linked worktree while never authorizing its metadata parent", async () => {
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
      const grant = await discoverLinkedGitMetadata(root);
      expect(grant).toEqual({
        gitDirectory: path.join(mainRoot, ".git", "worktrees", "checkout"),
        commonDirectory: path.join(mainRoot, ".git"),
      });

      // N02: a linked worktree is supported for real now -- both its own
      // gitdir and the repository's common gitdir are snapshotted into the
      // same private destination, so Git needs no path outside it.
      await expect(
        workspace().execute(request(grant ?? undefined)),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          command: "git.status",
          exitCode: 0,
          coverage: "tracked-files-only",
          layout: "linked-worktree",
          stdout: expect.stringContaining("README.md"),
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
      // The sandboxed process runs bound to the snapshot alone: the parent
      // directory the worktree's own gitdir lives under is never granted.
      // N02c runs this same substitute "git" twice (tracked-path discovery,
      // then the fixed command); its first invocation's output does not
      // parse as a tracked-path listing, which N02c treats as "nothing
      // tracked" rather than a hard failure, so the second invocation still
      // runs and its denial is still what is reported.
      await expect(
        workspace(async () => parentReader).execute(request(grant ?? undefined)),
      ).resolves.toMatchObject({
        ok: true,
        value: { stdout: "parent denied\n" },
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

  it("AUTH-09 refuses linked metadata the owner never approved before opening it", async () => {
    const mainRoot = root;
    const worktreeParent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-worktree-grant-"),
    );
    const linkedRoot = path.join(worktreeParent, "checkout");
    const gitDirectory = path.join(mainRoot, ".git", "worktrees", "checkout");
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
      const notApproved = {
        ok: false,
        error: { code: "WORKSPACE_GIT_METADATA_NOT_APPROVED", retry: "never" },
      };
      // An unreadable pointer file inside the external metadata tells a
      // refusal made before opening it apart from one made by reading it.
      await fs.chmod(path.join(gitDirectory, "commondir"), 0o000);

      await expect(workspace().execute(request())).resolves.toEqual(
        notApproved,
      );
      // A grant for another worktree's metadata is not this one's.
      await expect(
        workspace().execute(
          request({
            gitDirectory: path.join(mainRoot, ".git", "worktrees", "other"),
            commonDirectory: path.join(mainRoot, ".git"),
          }),
        ),
      ).resolves.toEqual(notApproved);
      await fs.chmod(path.join(gitDirectory, "commondir"), 0o600);
      await expect(
        workspace().execute(
          request({ gitDirectory, commonDirectory: gitDirectory }),
        ),
      ).resolves.toEqual(notApproved);
    } finally {
      await fs
        .chmod(path.join(gitDirectory, "commondir"), 0o600)
        .catch(() => undefined);
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

      await expect(
        workspace().execute(
          request({
            gitDirectory: path.join(mainRoot, ".git", "worktrees", "checkout"),
            commonDirectory: path.join(mainRoot, ".git"),
          }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "WORKSPACE_GIT_METADATA_NOT_APPROVED",
          retry: "never",
        },
      });
      // Even a grant naming the redirect target does not make it a worktree.
      await expect(
        workspace().execute(
          request({
            gitDirectory: path.join(mainRoot, ".git"),
            commonDirectory: path.join(mainRoot, ".git"),
          }),
        ),
      ).resolves.toMatchObject({
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

      await expect(
        workspace().execute(
          request({
            gitDirectory,
            commonDirectory: path.join(mainRoot, ".git"),
          }),
        ),
      ).resolves.toMatchObject({
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

  it("keeps the owner's workspace unreadable to the verifier: only the snapshot is granted", async () => {
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

  it("never lets the verifier read a sentinel outside the approved root", async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-command-sentinel-"),
    );
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "OUTSIDE-SENTINEL\n", { mode: 0o600 });
    try {
      const sentinelReader = await compileCommandFixture(
        "sentinel-reader",
        `#include <fcntl.h>
#include <stddef.h>
#include <unistd.h>

int main(void) {
  const int descriptor = open(${JSON.stringify(sentinel)}, O_RDONLY);
  const char denied[] = "sentinel denied\\n";
  const char readable[] = "sentinel readable\\n";
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
        workspace(async () => sentinelReader).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: { stdout: "sentinel denied\n" },
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
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
            approvedRoot: approvedRootOf("/"),
            deniedPaths: [],
          },
          operation,
        },
        operation,
        { attestGit: async () => git, createSnapshot: snapshotFactory() },
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
            approvedRoot: approvedRootOf(root),
            deniedPaths: ["../private"],
          },
          operation,
        },
        operation,
        { attestGit: async () => git, createSnapshot: snapshotFactory() },
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
            approvedRoot: approvedRootOf(root),
            deniedPaths: ["private\nscope"],
          },
          operation,
        },
        operation,
        { attestGit: async () => git, createSnapshot: snapshotFactory() },
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

    it("reports the linked-worktree layout and coverage for both commands", async () => {
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
        const grant = await discoverLinkedGitMetadata(root);
        expect(grant).toEqual({
          gitDirectory: path.join(mainRoot, ".git", "worktrees", "checkout"),
          commonDirectory: path.join(mainRoot, ".git"),
        });

        await expect(
          workspace().execute(request(grant ?? undefined)),
        ).resolves.toMatchObject({
          ok: true,
          value: { coverage: "tracked-files-only", layout: "linked-worktree" },
        });
        const expectedHead = (
          await executeFile(git, ["-C", root, "rev-parse", "--verify", "HEAD"])
        ).stdout;
        await expect(
          workspace().execute(headRequest(grant ?? undefined)),
        ).resolves.toMatchObject({
          ok: true,
          value: {
            coverage: "head-commit",
            layout: "linked-worktree",
            stdout: expectedHead,
          },
        });
        // A primary checkout keeps its metadata inside the root: no grant.
        await expect(discoverLinkedGitMetadata(mainRoot)).resolves.toBeNull();
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

  // S35-02 (3): the workspace's own exclusions (`deniedPaths`) must reach
  // the snapshot, not stop at syntax validation. A tracked file and an
  // untracked file inside an excluded subtree are proven absent both from
  // the snapshot's own linked paths and from the reported `git.status`
  // result -- not merely flagged as a deletion.
  it("N02c keeps a tracked and an untracked file inside an excluded subtree out of the snapshot and out of the status result", async () => {
    // request() already denies "private" (see the top of this file).
    await fs.mkdir(path.join(root, "private"), { mode: 0o700 });
    await fs.writeFile(path.join(root, "private", "tracked-secret.txt"), "s\n", {
      mode: 0o600,
    });
    await executeFile(git, ["-C", root, "add", "private/tracked-secret.txt"]);
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
        "tracked secret",
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    await fs.writeFile(path.join(root, "private", "untracked-secret.txt"), "u\n", {
      mode: 0o600,
    });
    // Also change the tracked one after the commit, so an unfiltered status
    // would otherwise show it as modified.
    await fs.writeFile(path.join(root, "private", "tracked-secret.txt"), "changed\n", {
      mode: 0o600,
    });

    const result = await workspace().execute(request());
    expect(result).toMatchObject({ ok: true, value: { kind: "workspace.command" } });
    if (!result.ok || result.value.kind !== "workspace.command") return;
    expect(result.value.stdout).not.toContain("private");
    expect(result.value.stdout).not.toContain("tracked-secret.txt");
    expect(result.value.stdout).not.toContain("untracked-secret.txt");
  });

  it("F1-8 never runs Git in a folder that took the approved root's place after the last check, and cleans up its snapshot either way", async () => {
    await fs.writeFile(path.join(root, "APPROVED.txt"), "approved\n", {
      mode: 0o600,
    });
    const input = request();
    if (input.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }
    const moved = `${root}.approved-moved`;
    let replaced = false;
    const factory = snapshotFactory();
    const snapshotPaths: string[] = [];
    const result = await executeNativeVerificationCommand(input, input.operation, {
      attestGit: async () => git,
      createSnapshot: async (snapshotRequest) => {
        const outcome = await factory(snapshotRequest);
        if (outcome.ok) snapshotPaths.push(outcome.path);
        return outcome;
      },
      // After every pathname check has passed: move the approved folder away
      // and put another repository at its path. The snapshot's own
      // descriptor-bound identity check (workspace-snapshot.ts / safe_open.py)
      // is what must catch this, not just the outer cheap check that already
      // ran before this hook.
      beforeSnapshot: async () => {
        await fs.rename(root, moved);
        await fs.mkdir(root, { mode: 0o700 });
        await executeFile(git, ["init", "--quiet", root]);
        await fs.writeFile(path.join(root, "REPLACEMENT.txt"), "x\n", {
          mode: 0o600,
        });
        replaced = true;
      },
    });
    expect(replaced).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_ROOT_CHANGED", retry: "never" },
    });
    expect(JSON.stringify(result)).not.toContain("REPLACEMENT");
    // No snapshot was left behind by the refused attempt.
    for (const snapshotPath of snapshotPaths) {
      await expect(fs.stat(snapshotPath)).rejects.toThrow();
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rename(moved, root);
  });

  it("N02 removes the snapshot after a successful command and after a failed one", async () => {
    const factory = snapshotFactory();
    const snapshotPaths: string[] = [];
    const observedFactory: SnapshotFactory = async (snapshotRequest) => {
      const outcome = await factory(snapshotRequest);
      if (outcome.ok) snapshotPaths.push(outcome.path);
      return outcome;
    };
    const input = request();
    if (input.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }

    await executeNativeVerificationCommand(input, input.operation, {
      attestGit: async () => git,
      createSnapshot: observedFactory,
    });
    await executeNativeVerificationCommand(input, input.operation, {
      attestGit: async () => "/usr/bin/false",
      createSnapshot: observedFactory,
    });

    // N02c: a `git.status` run over a real, tracked repository builds two
    // snapshots (metadata-only, then the bounded one carrying the tracked
    // paths `git ls-files` found) -- the first execute() call above
    // accounts for two. The second call's fake "git" fails `ls-files`
    // itself, so it never reaches the second snapshot -- one more. Every
    // snapshot actually created must still be removed, whichever count that
    // turns out to be.
    expect(snapshotPaths.length).toBe(3);
    for (const snapshotPath of snapshotPaths) {
      await expect(fs.stat(snapshotPath)).rejects.toThrow();
    }
  });

  // N02d: the Seatbelt write grant used to cover the whole snapshot, which a
  // linked working-tree file inside it makes dangerous -- that file is a hard
  // link to the owner's own inode (workspace-snapshot.ts / safe_open.py), so
  // a wide write grant lets the fixed Git command rewrite the owner's real
  // file. These tests substitute a stand-in for the Git binary (the same
  // pattern `native-verification-command-failures.test.ts`'s mocked spawn and
  // this file's other `compileCommandFixture` fixtures already use) that
  // attempts a write itself, so the sandbox's own refusal or grant is what
  // decides the outcome, not application logic.
  describe("N02d write grant", () => {
    it("denies a write into a linked working-tree file inside the snapshot, leaving the owner's file untouched", async () => {
      const worktreeWriteAttempt = await compileCommandFixture(
        "worktree-write-attempt",
        `#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "ls-files") == 0) {
      const char entry[] = "README.md";
      const ssize_t entry_written = write(STDOUT_FILENO, entry, sizeof(entry) - 1);
      const ssize_t nul_written = write(STDOUT_FILENO, "", 1);
      return entry_written == (ssize_t)(sizeof(entry) - 1) && nul_written == 1 ? 0 : 1;
    }
  }
  const int descriptor = open("README.md", O_WRONLY);
  const char payload[] = "TAMPERED\\n";
  ssize_t written = -1;
  if (descriptor >= 0) {
    written = write(descriptor, payload, sizeof(payload) - 1);
    close(descriptor);
  }
  const int allowed = descriptor >= 0 && written == (ssize_t)(sizeof(payload) - 1);
  const char allowed_message[] = "workdir-write:allowed\\n";
  const char denied_message[] = "workdir-write:denied\\n";
  const char *output = allowed ? allowed_message : denied_message;
  const size_t length = allowed ? sizeof(allowed_message) - 1 : sizeof(denied_message) - 1;
  const ssize_t out_written = write(STDOUT_FILENO, output, length);
  return out_written == (ssize_t)length ? 0 : 1;
}
`,
      );

      const result = await workspace(async () => worktreeWriteAttempt).execute(
        request(),
      );
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", stdout: "workdir-write:denied\n" },
      });
      // The owner's real file -- not a snapshot copy, which is already
      // removed by the time this runs -- is byte-identical afterwards.
      await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe(
        "before\n",
      );
    });

    it("allows a write into `.git` metadata inside the snapshot", async () => {
      const gitdirWriteAttempt = await compileCommandFixture(
        "gitdir-write-attempt",
        `#include <fcntl.h>
#include <stddef.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "ls-files") == 0) {
      return 0;
    }
  }
  const int descriptor = open(".git/farol-write-canary", O_WRONLY | O_CREAT, 0600);
  const char payload[] = "canary\\n";
  ssize_t written = -1;
  if (descriptor >= 0) {
    written = write(descriptor, payload, sizeof(payload) - 1);
    close(descriptor);
  }
  const int allowed = descriptor >= 0 && written == (ssize_t)(sizeof(payload) - 1);
  const char allowed_message[] = "gitdir-write:allowed\\n";
  const char denied_message[] = "gitdir-write:denied\\n";
  const char *output = allowed ? allowed_message : denied_message;
  const size_t length = allowed ? sizeof(allowed_message) - 1 : sizeof(denied_message) - 1;
  const ssize_t out_written = write(STDOUT_FILENO, output, length);
  return out_written == (ssize_t)length ? 0 : 1;
}
`,
      );

      const result = await workspace(async () => gitdirWriteAttempt).execute(
        request(),
      );
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", stdout: "gitdir-write:allowed\n" },
      });
    });

    async function indexRefreshHappened(
      input: ReadonlyWorkspaceRequest,
    ): Promise<boolean> {
      if (input.operation.kind !== "verification.run") {
        throw new Error("verification operation expected");
      }
      const factory = snapshotFactory();
      const indexChanges: boolean[] = [];
      const observedFactory: SnapshotFactory = async (snapshotRequest) => {
        const outcome = await factory(snapshotRequest);
        if (!outcome.ok) return outcome;
        // Only the bounded, tracked-paths snapshot ever carries the actual
        // working file this stale mtime lives on; the metadata-only snapshot
        // (paths: []) never sees it and its index is never rewritten. Both
        // are observed the same way so the assertion below reflects whatever
        // the real, unmodified command flow actually does.
        const gitMetadataDirectory =
          snapshotRequest.externalGitDir !== undefined
            ? path.join(outcome.path, ".gitmeta", "worktree")
            : path.join(outcome.path, ".git");
        const indexPath =
          (snapshotRequest.paths?.length ?? 0) > 0
            ? path.join(gitMetadataDirectory, "index")
            : null;
        const before =
          indexPath === null
            ? null
            : (await fs.stat(indexPath, { bigint: true })).mtimeNs;
        return {
          ...outcome,
          remove: async () => {
            if (indexPath !== null && before !== null) {
              const after = await fs
                .stat(indexPath, { bigint: true })
                .then((stat) => stat.mtimeNs)
                .catch(() => before);
              indexChanges.push(after !== before);
            }
            await outcome.remove();
          },
        };
      };

      const result = await executeNativeVerificationCommand(
        input,
        input.operation,
        { attestGit: async () => git, createSnapshot: observedFactory },
      );
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      return indexChanges.some(Boolean);
    }

    it("still writes a refreshed index under the narrowed grant, on a primary checkout", async () => {
      // A future mtime with unchanged content is exactly what makes Git's own
      // "racily clean" handling reread the file, find it unmodified, and
      // rewrite the index's cached stat data -- the one on-disk write a plain
      // `git status` actually performs.
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(path.join(root, "README.md"), future, future);

      expect(await indexRefreshHappened(request())).toBe(true);
    });

    it("still writes a refreshed index under the narrowed grant, on a linked worktree", async () => {
      const mainRoot = root;
      const worktreeParent = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-next-command-worktree-refresh-"),
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
        const grant = await discoverLinkedGitMetadata(root);
        const future = new Date(Date.now() + 60_000);
        await fs.utimes(path.join(root, "README.md"), future, future);

        expect(await indexRefreshHappened(request(grant ?? undefined))).toBe(
          true,
        );
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
