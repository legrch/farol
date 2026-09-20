import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  isUnderAnyPrefix,
  statusArguments,
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

// One C string literal for `value`: every byte outside plain printable ASCII
// (and the quote and backslash) becomes a three-digit octal escape, so a tab,
// a non-ASCII path or an embedded NUL in a listing survives
// `-Wall -Wextra -Werror` verbatim.
function cString(value: string): string {
  const escaped = [...Buffer.from(value, "utf8")]
    .map((byte) =>
      byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\${byte.toString(8).padStart(3, "0")}`,
    )
    .join("");
  return `"${escaped}"`;
}

// A stand-in for Git (the same pattern this file's other fixtures and
// native-verification-command-failures.test.ts's mocked spawn use). It
// answers the tracked-path listing (`ls-files -z --stage`) with `listing`
// -- an empty string means "nothing tracked" -- and answers the fixed status
// command by running `probe` (C statements that set `allowed` to non-zero
// when the guarded operation succeeded) and printing one porcelain header
// record, `## <verdict>`, which the route's structural parser renders as
// `## <verdict>\n`. The sandbox's own refusal or grant decides the verdict,
// not application logic.
function verdictFixtureSource(
  options: Readonly<{
    listing: string;
    probe: string;
    allowed: string;
    denied: string;
  }>,
): string {
  return `#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int write_all(const char *bytes, size_t length) {
  return write(STDOUT_FILENO, bytes, length) == (ssize_t)length;
}

int main(int argc, char **argv) {
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], "ls-files") == 0) {
      static const char listing[] = ${cString(options.listing)};
      return sizeof(listing) == 1 || write_all(listing, sizeof(listing) - 1) ? 0 : 1;
    }
  }
  int allowed = 0;
  ${options.probe}
  static const char allowed_message[] = ${cString(`## ${options.allowed}`)};
  static const char denied_message[] = ${cString(`## ${options.denied}`)};
  const char *message = allowed ? allowed_message : denied_message;
  const size_t length = allowed ? sizeof(allowed_message) - 1 : sizeof(denied_message) - 1;
  return write_all(message, length) && write_all("", 1) ? 0 : 1;
}
`;
}

async function commit(cwd: string, message: string): Promise<void> {
  await executeFile(
    git,
    [
      "-C",
      cwd,
      "-c",
      "user.name=Farol Test",
      "-c",
      "user.email=farol-test@invalid.example",
      "commit",
      "--quiet",
      "-m",
      message,
    ],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
}

type TreeFingerprint = Readonly<{
  path: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  mtimeNs: string;
  size?: number;
  nlink?: number;
  sha256?: string;
  target?: string;
}>;

// Everything about a tree that a stray write would move: names, kinds,
// modes, mtimes, sizes, link counts, content digests and symlink targets.
async function fingerprintTree(
  directory: string,
  base = directory,
): Promise<TreeFingerprint[]> {
  const rows: TreeFingerprint[] = [];
  const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    const stat = await fs.lstat(full, { bigint: true });
    const relative = path.relative(base, full);
    const common = {
      path: relative,
      mode: Number(stat.mode),
      mtimeNs: String(stat.mtimeNs),
    };
    if (entry.isSymbolicLink()) {
      rows.push({
        ...common,
        kind: "symlink",
        target: await fs.readlink(full),
      });
    } else if (entry.isDirectory()) {
      rows.push({ ...common, kind: "directory" });
      rows.push(...(await fingerprintTree(full, base)));
    } else {
      rows.push({
        ...common,
        kind: "file",
        size: Number(stat.size),
        nlink: Number(stat.nlink),
        sha256: createHash("sha256")
          .update(await fs.readFile(full))
          .digest("hex"),
      });
    }
  }
  return rows;
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
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(${cString(parentCanary)}, O_RDONLY); if (descriptor >= 0) { close(descriptor); allowed = 1; } }`,
          allowed: "parent readable",
          denied: "parent denied",
        }),
      );
      // The sandboxed process runs bound to the snapshot alone: the parent
      // directory the worktree's own gitdir lives under is never granted.
      // N02c runs this same substitute "git" twice (tracked-path discovery,
      // then the fixed command); the fixture answers the first with an empty
      // listing ("nothing tracked"), so the second runs over the
      // metadata-only snapshot and its denial is what is reported.
      await expect(
        workspace(async () => parentReader).execute(
          request(grant ?? undefined),
        ),
      ).resolves.toMatchObject({
        ok: true,
        value: { stdout: "## parent denied\n" },
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
      verdictFixtureSource({
        listing: "",
        probe: `{ const int descriptor = open(${cString(credential)}, O_RDONLY); if (descriptor >= 0) { close(descriptor); allowed = 1; } }`,
        allowed: "credential readable",
        denied: "credential denied",
      }),
    );

    await expect(
      workspace(async () => credentialReader).execute(request()),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.command",
        stdout: "## credential denied\n",
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
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(${cString(sentinel)}, O_RDONLY); if (descriptor >= 0) { close(descriptor); allowed = 1; } }`,
          allowed: "sentinel readable",
          denied: "sentinel denied",
        }),
      );

      await expect(
        workspace(async () => sentinelReader).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: { stdout: "## sentinel denied\n" },
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

  it("terminates a reviewed command before unbounded output escapes, under the bound that invocation has", async () => {
    // The fixed HEAD command: the product's 64 KiB result bound.
    await expect(
      workspace(async () => "/usr/bin/yes").execute(headRequest()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE",
        retry: "never",
      },
    });
    // `git.status` first asks for the tracked-path listing, which has its
    // own, larger budget (32 MiB) and its own code: an unbounded listing is
    // still killed, and told apart from an oversized result.
    await expect(
      workspace(async () => "/usr/bin/yes").execute(request()),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_TRACKED_LIST_TOO_LARGE",
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
    await fs.writeFile(
      path.join(root, "private", "tracked-secret.txt"),
      "s\n",
      {
        mode: 0o600,
      },
    );
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
    await fs.writeFile(
      path.join(root, "private", "untracked-secret.txt"),
      "u\n",
      {
        mode: 0o600,
      },
    );
    // Also change the tracked one after the commit, so an unfiltered status
    // would otherwise show it as modified.
    await fs.writeFile(
      path.join(root, "private", "tracked-secret.txt"),
      "changed\n",
      {
        mode: 0o600,
      },
    );

    const result = await workspace().execute(request());
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "workspace.command" },
    });
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
    const result = await executeNativeVerificationCommand(
      input,
      input.operation,
      {
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
      },
    );
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

  // S35-H1-2: the tracked-path capture attaches one file at a time, so a
  // write landing between two clones could leave the snapshot holding one
  // file from before it and another from after it. The index pin cannot see
  // that -- a working-tree write does not touch `.git/index` -- so the route
  // must refuse rather than report a status of a tree that never existed.
  it("S35-H1-2 refuses the status with WORKSPACE_CHANGED_DURING_SNAPSHOT when a tracked file is written between two clones, and reports no mixed status", async () => {
    await fs.writeFile(path.join(root, "second.txt"), "second before\n", {
      mode: 0o600,
    });
    await executeFile(git, ["-C", root, "add", "second.txt"]);
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
        "second",
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );

    const input = request();
    if (input.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }
    const snapshotPaths: string[] = [];
    let raced = false;
    // Only the bounded snapshot carries `paths`; the metadata-only one that
    // precedes it is left exactly as production takes it.
    const racingFactory: SnapshotFactory = async (snapshotRequest) => {
      const outcome = await createWorkspaceSnapshot(
        snapshotRequest,
        {
          helperPath: sourceHelper,
          helper: NEXT_SAFE_OPEN_HELPER,
          attestInterpreter: async () => "/usr/bin/python3",
          runtimeDirectory,
        },
        snapshotRequest.paths === undefined ||
          snapshotRequest.paths.length === 0
          ? {}
          : {
              // `README.md` is cloned; `second.txt` is listed but not yet.
              testHookRequest: {
                phase: "snapshot-clone-path-entry",
                index: 1,
              },
              testHook: async () => {
                await fs.writeFile(
                  path.join(root, "README.md"),
                  "written between the two clones\n",
                  { mode: 0o600 },
                );
                raced = true;
              },
            },
      );
      if (outcome.ok) snapshotPaths.push(outcome.path);
      return outcome;
    };

    const result = await executeNativeVerificationCommand(
      input,
      input.operation,
      { attestGit: async () => git, createSnapshot: racingFactory },
    );

    expect(raced).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_CHANGED_DURING_SNAPSHOT", retry: "never" },
    });
    // Not a status at all: no mixed tree is reported anywhere in the result.
    expect(JSON.stringify(result)).not.toContain("README.md");
    for (const snapshotPath of snapshotPaths) {
      await expect(fs.stat(snapshotPath)).rejects.toThrow();
    }
  });

  it("S35-H1-2 control: the same two-file repository reports its ordinary status when nothing changes during the capture", async () => {
    await fs.writeFile(path.join(root, "second.txt"), "second before\n", {
      mode: 0o600,
    });
    await executeFile(git, ["-C", root, "add", "second.txt"]);
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
        "second",
      ],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
    await fs.writeFile(path.join(root, "README.md"), "modified\n", {
      mode: 0o600,
    });

    const input = request();
    if (input.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }
    const result = await executeNativeVerificationCommand(
      input,
      input.operation,
      { attestGit: async () => git, createSnapshot: snapshotFactory() },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain("README.md");
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

  // N02e: the semantics the product promises for the two fixed commands,
  // proven through the production route (`NativeReadonlyWorkspace` or
  // `executeNativeVerificationCommand` with the real snapshot factory), not
  // at the helper alone.
  describe("N02e point-in-time clone semantics through the production route", () => {
    it("keeps a denied prefix out of the status result whatever its paths carry: non-ASCII, spaces, an arrow, and renames across it", async () => {
      await fs.mkdir(path.join(root, "private"), { mode: 0o700 });
      await fs.mkdir(path.join(root, "public"), { mode: 0o700 });
      const tracked: Record<string, string> = {
        "private/отчёт.md": "report\n",
        "private/has space.txt": "space\n",
        "private/a -> b.txt": "arrow\n",
        "private/out.txt": "out\n",
        "public/in.txt": "in\n",
      };
      for (const [relative, content] of Object.entries(tracked)) {
        await fs.writeFile(path.join(root, relative), content, {
          mode: 0o600,
        });
      }
      await executeFile(git, [
        "-C",
        root,
        "add",
        "--",
        ...Object.keys(tracked),
      ]);
      await commit(root, "denied fixture");
      for (const relative of [
        "private/отчёт.md",
        "private/has space.txt",
        "private/a -> b.txt",
      ]) {
        await fs.appendFile(path.join(root, relative), "changed\n");
      }
      await fs.writeFile(path.join(root, "README.md"), "after\n", {
        mode: 0o600,
      });
      await executeFile(git, [
        "-C",
        root,
        "mv",
        "public/in.txt",
        "private/moved-in.txt",
      ]);
      await executeFile(git, [
        "-C",
        root,
        "mv",
        "private/out.txt",
        "public/moved-out.txt",
      ]);

      const result = await workspace().execute(request());
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      if (!result.ok || result.value.kind !== "workspace.command") return;
      const { stdout } = result.value;
      expect(stdout).toMatch(/^## [^\n]+\n/u);
      expect(stdout).toContain(" M README.md\n");
      // The visible halves of the two renames are still reported (as a
      // staged deletion and a staged addition, or as a rename between the
      // two visible paths); nothing under the denied prefix is.
      expect(stdout).toContain("public/in.txt");
      expect(stdout).toContain("public/moved-out.txt");
      for (const forbidden of [
        "private",
        "\\320",
        "отчёт",
        "has space",
        "a -> b",
        "moved-in",
        '"',
      ]) {
        expect(stdout).not.toContain(forbidden);
      }
      expect(result.value.outputBytes).toBe(Buffer.byteLength(stdout));
    });

    // S35-H1-4b. The exclusion holds in three independent places, and the
    // route test below only shows the three together. These two prove the
    // two that are pure functions, on their own, so a layer cannot quietly
    // stop working behind the others.
    it("S35-H1-4b statusArguments emits exactly one `:(exclude,top,literal)` pathspec per denied prefix, after a `--` separator", () => {
      expect(statusArguments([])).toEqual([
        "status",
        "--porcelain",
        "--branch",
        "-z",
        "--untracked-files=no",
        "--ignore-submodules=all",
      ]);

      const withPrefixes = statusArguments(["private", "vendor/secret"]);
      expect(withPrefixes).toEqual([
        "status",
        "--porcelain",
        "--branch",
        "-z",
        "--untracked-files=no",
        "--ignore-submodules=all",
        "--",
        ":(exclude,top,literal)private",
        ":(exclude,top,literal)vendor/secret",
      ]);
      // One pathspec per prefix, never a merged or globbed one: `literal`
      // is what keeps a prefix containing `*` or `?` from matching more,
      // and `top` is what anchors it at the snapshot root.
      expect(
        withPrefixes.filter((argument) =>
          argument.startsWith(":(exclude,top,literal)"),
        ),
      ).toHaveLength(2);
      expect(statusArguments(["a", "b", "c"])).toHaveLength(10);
    });

    it("S35-H1-4b the folded filter drops a path that is a case or NFC variant of a denied prefix, and keeps an unrelated neighbour", () => {
      const denied = ["private", "caf\u00e9"];

      // Exact, and the prefix itself.
      expect(isUnderAnyPrefix("private/x.txt", denied)).toBe(true);
      expect(isUnderAnyPrefix("private", denied)).toBe(true);
      // Case variants, including one the volume itself folds together.
      expect(isUnderAnyPrefix("Private/x.txt", denied)).toBe(true);
      expect(isUnderAnyPrefix("PRIVATE/x.txt", denied)).toBe(true);
      expect(isUnderAnyPrefix("PrIvAtE/deep/x.txt", denied)).toBe(true);
      // Decomposed (NFD) `café`: the same name on an APFS volume.
      expect(isUnderAnyPrefix("cafe\u0301/x.txt", denied)).toBe(true);
      expect(isUnderAnyPrefix("CAFE\u0301/x.txt", denied)).toBe(true);

      // A neighbour whose name merely starts with the prefix's characters
      // is a different directory and stays.
      expect(isUnderAnyPrefix("privateer/x.txt", denied)).toBe(false);
      expect(isUnderAnyPrefix("public/private.txt", denied)).toBe(false);
      expect(isUnderAnyPrefix("x/private/y.txt", denied)).toBe(false);
      expect(isUnderAnyPrefix("cafes/x.txt", denied)).toBe(false);
      expect(isUnderAnyPrefix("anything.txt", [])).toBe(false);
    });

    it("excludes a case variant of a denied prefix on this side, so the helper is never asked for it", async () => {
      // On the default case-insensitive volume `Private` and `private` are
      // one directory; on a case-sensitive one they are siblings. Either
      // way the index records the path as typed, and request() denies
      // `private`.
      await fs.mkdir(path.join(root, "Private"), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(path.join(root, "Private", "upper.txt"), "u\n", {
        mode: 0o600,
      });
      await executeFile(git, ["-C", root, "add", "--", "Private/upper.txt"]);
      await commit(root, "case variant");
      await fs.appendFile(path.join(root, "Private", "upper.txt"), "changed\n");
      expect(
        (await executeFile(git, ["-C", root, "ls-files"])).stdout,
      ).toContain("Private/upper.txt");

      const result = await workspace().execute(request());
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      if (!result.ok || result.value.kind !== "workspace.command") return;
      expect(result.value.stdout).not.toContain("upper.txt");
      expect(result.value.stdout).not.toMatch(/private/iu);
    });

    it("reports a tracked file deleted from the working tree and one replaced by a directory, and never carries a gitlink", async () => {
      await fs.writeFile(path.join(root, "gone.txt"), "g\n", { mode: 0o600 });
      await fs.writeFile(path.join(root, "dir-now.txt"), "d\n", {
        mode: 0o600,
      });
      await executeFile(git, [
        "-C",
        root,
        "add",
        "--",
        "gone.txt",
        "dir-now.txt",
      ]);
      await commit(root, "deleted fixture");
      await fs.rm(path.join(root, "gone.txt"));
      await fs.rm(path.join(root, "dir-now.txt"));
      await fs.mkdir(path.join(root, "dir-now.txt"), { mode: 0o700 });
      await fs.writeFile(path.join(root, "dir-now.txt", "inner.txt"), "i\n", {
        mode: 0o600,
      });
      const head = (
        await executeFile(git, ["-C", root, "rev-parse", "HEAD"])
      ).stdout.trim();
      await executeFile(git, [
        "-C",
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},sub`,
      ]);

      const result = await workspace().execute(request());
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      if (!result.ok || result.value.kind !== "workspace.command") return;
      expect(result.value.stdout).toContain(" D gone.txt\n");
      expect(result.value.stdout).toContain(" D dir-now.txt\n");
      expect(result.value.stdout).not.toContain("sub");
      expect(result.value.stdout).not.toContain("inner");
    });

    it("lists and clones three thousand tracked files without touching the result bound", async () => {
      await fs.mkdir(path.join(root, "many"), { mode: 0o700 });
      const names = Array.from(
        { length: 3_000 },
        (_, index) =>
          `many/file-${String(index).padStart(4, "0")}-of-three-thousand.txt`,
      );
      for (let start = 0; start < names.length; start += 250) {
        await Promise.all(
          names
            .slice(start, start + 250)
            .map((name) =>
              fs.writeFile(path.join(root, name), `${name}\n`, { mode: 0o600 }),
            ),
        );
      }
      await executeFile(git, ["-C", root, "add", "--", "many"]);
      await commit(root, "three thousand");
      const last = names[names.length - 1] ?? "";
      await fs.appendFile(path.join(root, last), "changed\n");

      const result = await workspace().execute(request());
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      if (!result.ok || result.value.kind !== "workspace.command") return;
      expect(result.value.stdout).toMatch(
        /^## [^\n]+\n M many\/file-2999-of-three-thousand\.txt\n$/u,
      );
    }, 60_000);

    it("refuses instead of answering when the index changes between the metadata snapshot and the tracked-path snapshot", async () => {
      const input = request();
      if (input.operation.kind !== "verification.run") {
        throw new Error("verification operation expected");
      }
      const factory = snapshotFactory();
      const phases: number[] = [];
      const result = await executeNativeVerificationCommand(
        input,
        input.operation,
        {
          attestGit: async () => git,
          createSnapshot: async (snapshotRequest) => {
            const outcome = await factory(snapshotRequest);
            phases.push(snapshotRequest.paths?.length ?? -1);
            if (snapshotRequest.paths?.length === 0) {
              // After the metadata-only snapshot copied the index and before
              // the tracked-path snapshot is built: the owner stages a file.
              await fs.writeFile(path.join(root, "newfile.txt"), "n\n", {
                mode: 0o600,
              });
              await executeFile(git, ["-C", root, "add", "--", "newfile.txt"]);
            }
            return outcome;
          },
        },
      );
      expect(phases).toEqual([0, 1]);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT",
          retry: "never",
        },
      });
    });

    it("refuses the whole command for a tracked path it will not carry, instead of proceeding with an empty list", async () => {
      const blob = (
        await executeFile(git, ["-C", root, "hash-object", "-w", "README.md"])
      ).stdout.trim();
      await executeFile(git, [
        "-C",
        root,
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blob},back\\slash.txt`,
      ]);

      await expect(workspace().execute(request())).resolves.toEqual({
        ok: false,
        error: { code: "WORKSPACE_TRACKED_PATH_UNSUPPORTED", retry: "never" },
      });
    });

    it("keeps the owner's files readable and searchable while a snapshot of them is held open", async () => {
      const input = request();
      if (input.operation.kind !== "verification.run") {
        throw new Error("verification operation expected");
      }
      const factory = snapshotFactory();
      const reader = workspace();
      let observedWhileOpen = false;
      const result = await executeNativeVerificationCommand(
        input,
        input.operation,
        {
          attestGit: async () => git,
          createSnapshot: async (snapshotRequest) => {
            const outcome = await factory(snapshotRequest);
            if (!outcome.ok || (snapshotRequest.paths?.length ?? 0) === 0) {
              return outcome;
            }
            // The tracked-path snapshot exists now and carries README.md; the
            // owner's own file is still a single-link regular file, so the
            // descriptor helper's reads of it are unaffected.
            expect((await fs.stat(path.join(root, "README.md"))).nlink).toBe(1);
            await expect(
              reader.execute({
                workspace: input.workspace,
                operation: {
                  kind: "workspace.read",
                  relativePath: "README.md",
                },
              }),
            ).resolves.toMatchObject({
              ok: true,
              value: { kind: "workspace.text", text: "before\n" },
            });
            await expect(
              reader.execute({
                workspace: input.workspace,
                operation: {
                  kind: "workspace.search",
                  relativePath: ".",
                  pattern: "before",
                },
              }),
            ).resolves.toMatchObject({
              ok: true,
              value: {
                kind: "workspace.matches",
                matches: [expect.objectContaining({ path: "README.md" })],
              },
            });
            observedWhileOpen = true;
            return outcome;
          },
        },
      );
      expect(observedWhileOpen).toBe(true);
      expect(result).toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
    });

    it("leaves the owner's real .git byte-for-byte untouched around a status and a HEAD run, even when the index would be refreshed", async () => {
      // A future mtime with unchanged content forces Git to reread the file
      // and rewrite the index's cached stat data -- in the snapshot's copy.
      const future = new Date(Date.now() + 60_000);
      await fs.utimes(path.join(root, "README.md"), future, future);
      const before = await fingerprintTree(path.join(root, ".git"));
      expect(before.some((row) => row.path === "index")).toBe(true);

      await expect(workspace().execute(request())).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.status" },
      });
      await expect(workspace().execute(headRequest())).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.command", command: "git.head" },
      });

      expect(await fingerprintTree(path.join(root, ".git"))).toEqual(before);
    });

    describe("repository format extensions", () => {
      async function freshRepository(
        ...initArguments: string[]
      ): Promise<string> {
        const directory = await fs.realpath(
          await fs.mkdtemp(
            path.join(os.tmpdir(), "farol-next-command-format-"),
          ),
        );
        await fs.chmod(directory, 0o700);
        await executeFile(git, [
          "init",
          "--quiet",
          ...initArguments,
          directory,
        ]);
        await fs.writeFile(path.join(directory, "README.md"), "before\n", {
          mode: 0o600,
        });
        await executeFile(git, ["-C", directory, "add", "README.md"]);
        await commit(directory, "fixture");
        return directory;
      }

      async function expectBothCommandsOver(
        directory: string,
        headPattern: RegExp,
      ): Promise<void> {
        const mainRoot = root;
        root = directory;
        try {
          const expected = (
            await executeFile(git, [
              "-C",
              root,
              "rev-parse",
              "--verify",
              "HEAD",
            ])
          ).stdout;
          expect(expected).toMatch(headPattern);
          await expect(
            workspace().execute(headRequest()),
          ).resolves.toMatchObject({
            ok: true,
            value: { command: "git.head", stdout: expected },
          });
          await fs.writeFile(path.join(root, "README.md"), "after\n", {
            mode: 0o600,
          });
          await expect(workspace().execute(request())).resolves.toMatchObject({
            ok: true,
            value: {
              command: "git.status",
              stdout: expect.stringContaining(" M README.md\n"),
            },
          });
        } finally {
          root = mainRoot;
          await fs.rm(directory, { recursive: true, force: true });
        }
      }

      it("runs both commands over a sha256 repository", async () => {
        await expectBothCommandsOver(
          await freshRepository("--object-format=sha256"),
          /^[0-9a-f]{64}\n$/u,
        );
      });

      it("runs both commands over a reftable repository when the installed Git supports it", async () => {
        let directory: string;
        try {
          directory = await freshRepository("--ref-format=reftable");
        } catch (error) {
          console.warn(
            `reftable case skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        await expectBothCommandsOver(directory, /^[0-9a-f]{40}\n$/u);
      });

      it("carries extensions.worktreeConfig and reduces config.worktree, so nothing named there can run", async () => {
        const canary = path.join(root, "worktree-fsmonitor-ran");
        const monitor = path.join(root, "worktree-monitor.sh");
        await fs.writeFile(
          monitor,
          `#!/bin/sh\ntouch ${JSON.stringify(canary)}\n`,
          { mode: 0o700 },
        );
        for (const setting of [
          ["core.repositoryformatversion", "1"],
          ["extensions.worktreeConfig", "true"],
          ["--worktree", "core.fsmonitor", monitor],
          ["--worktree", "core.ignorecase", "true"],
        ]) {
          await executeFile(git, ["-C", root, "config", ...setting]);
        }
        const future = new Date(Date.now() + 60_000);
        await fs.utimes(path.join(root, "README.md"), future, future);
        const input = request();
        if (input.operation.kind !== "verification.run") {
          throw new Error("verification operation expected");
        }
        const factory = snapshotFactory();
        const worktreeConfigs: string[] = [];
        const configs: string[] = [];

        const result = await executeNativeVerificationCommand(
          input,
          input.operation,
          {
            attestGit: async () => git,
            createSnapshot: async (snapshotRequest) => {
              const outcome = await factory(snapshotRequest);
              if (outcome.ok) {
                worktreeConfigs.push(
                  await fs.readFile(
                    path.join(outcome.path, ".git", "config.worktree"),
                    "utf8",
                  ),
                );
                configs.push(
                  await fs.readFile(
                    path.join(outcome.path, ".git", "config"),
                    "utf8",
                  ),
                );
              }
              return outcome;
            },
          },
        );
        expect(result).toMatchObject({
          ok: true,
          value: { kind: "workspace.command", command: "git.status" },
        });
        await expect(fs.stat(canary)).rejects.toMatchObject({ code: "ENOENT" });
        expect(worktreeConfigs.length).toBe(2);
        for (const text of worktreeConfigs) {
          expect(text).toBe("[core]\n\tignorecase = true\n");
        }
        for (const text of configs) {
          expect(text).toContain("[extensions]\n\tworktreeconfig = true\n");
          expect(text).not.toContain("fsmonitor");
        }
      });

      it("refuses a repository whose object store borrows through objects/info/alternates", async () => {
        await fs.writeFile(
          path.join(root, ".git", "objects", "info", "alternates"),
          "/nonexistent/OUTSIDE-SENTINEL/objects\n",
          { mode: 0o600 },
        );

        for (const operation of [request(), headRequest()]) {
          await expect(workspace().execute(operation)).resolves.toEqual({
            ok: false,
            error: {
              code: "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
              retry: "never",
            },
          });
        }
      });
    });
  });

  // N02d: the Seatbelt write grant names exactly the snapshot's index and
  // index lock. Every working-tree file inside the snapshot is a clone on an
  // inode of its own (workspace-snapshot.ts / safe_open.py), so no write
  // through the snapshot could reach the owner's bytes in any case; the
  // literal grant additionally keeps the fixed command from altering its own
  // evidence. These tests substitute a stand-in for the Git binary
  // (`verdictFixtureSource`) that attempts a write itself, so the sandbox's
  // own refusal or grant is what decides the outcome, not application logic.
  describe("N02d write grant", () => {
    it("denies a write into a working-tree file inside the snapshot, leaving the owner's file untouched", async () => {
      const worktreeWriteAttempt = await compileCommandFixture(
        "worktree-write-attempt",
        verdictFixtureSource({
          listing: `100644 ${"0".repeat(40)} 0\tREADME.md\0`,
          probe: `{ const int descriptor = open("README.md", O_WRONLY); if (descriptor >= 0) { allowed = write(descriptor, "TAMPERED\\n", 9) == 9; close(descriptor); } }`,
          allowed: "workdir-write:allowed",
          denied: "workdir-write:denied",
        }),
      );

      const result = await workspace(async () => worktreeWriteAttempt).execute(
        request(),
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "## workdir-write:denied\n",
        },
      });
      // The owner's real file -- not a snapshot clone, which is already
      // removed by the time this runs -- is byte-identical afterwards.
      await expect(
        fs.readFile(path.join(root, "README.md"), "utf8"),
      ).resolves.toBe("before\n");
    });

    it("denies a write into `.git/HEAD` inside the snapshot: the metadata directory is no writable subtree", async () => {
      const headWriteAttempt = await compileCommandFixture(
        "head-write-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/HEAD", O_WRONLY); if (descriptor >= 0) { allowed = 1; close(descriptor); } }`,
          allowed: "head-write:allowed",
          denied: "head-write:denied",
        }),
      );

      await expect(
        workspace(async () => headWriteAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.command", stdout: "## head-write:denied\n" },
      });
    });

    it("allows creating and removing `.git/index.lock` inside the snapshot: exactly what an index refresh needs", async () => {
      const indexLockAttempt = await compileCommandFixture(
        "index-lock-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/index.lock", O_WRONLY | O_CREAT | O_EXCL, 0600); if (descriptor >= 0) { allowed = write(descriptor, "lock\\n", 5) == 5; close(descriptor); allowed = allowed && unlink(".git/index.lock") == 0; } }`,
          allowed: "index-lock-write:allowed",
          denied: "index-lock-write:denied",
        }),
      );

      await expect(
        workspace(async () => indexLockAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "## index-lock-write:allowed\n",
        },
      });
    });

    // S35-H1-4a. The write grant inside the snapshot is meant to be exactly
    // one thing -- what an index refresh needs -- and nothing else under
    // `.git`. Each of these is a real compiled binary run as the command,
    // under the real Seatbelt profile, inside a real snapshot.
    it("S35-H1-4a denies a write into `.git/refs/heads/main` inside the snapshot", async () => {
      const refWriteAttempt = await compileCommandFixture(
        "ref-write-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/refs/heads/main", O_WRONLY | O_CREAT, 0600); if (descriptor >= 0) { allowed = 1; close(descriptor); } }`,
          allowed: "ref-write:allowed",
          denied: "ref-write:denied",
        }),
      );

      await expect(
        workspace(async () => refWriteAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: { kind: "workspace.command", stdout: "## ref-write:denied\n" },
      });
    });

    it("S35-H1-4a denies a write into `.git/config` inside the snapshot", async () => {
      const configWriteAttempt = await compileCommandFixture(
        "config-write-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/config", O_WRONLY | O_CREAT, 0600); if (descriptor >= 0) { allowed = 1; close(descriptor); } }`,
          allowed: "config-write:allowed",
          denied: "config-write:denied",
        }),
      );

      await expect(
        workspace(async () => configWriteAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "## config-write:denied\n",
        },
      });
    });

    it("S35-H1-4a denies a write into `.git/packed-refs` inside the snapshot", async () => {
      const packedRefsWriteAttempt = await compileCommandFixture(
        "packed-refs-write-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/packed-refs", O_WRONLY | O_CREAT, 0600); if (descriptor >= 0) { allowed = 1; close(descriptor); } }`,
          allowed: "packed-refs-write:allowed",
          denied: "packed-refs-write:denied",
        }),
      );

      await expect(
        workspace(async () => packedRefsWriteAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "## packed-refs-write:denied\n",
        },
      });
    });

    it("S35-H1-4a still allows the whole index-refresh sequence: create `.git/index.lock`, write it, rename it over `.git/index`", async () => {
      const indexRefreshAttempt = await compileCommandFixture(
        "index-refresh-attempt",
        verdictFixtureSource({
          listing: "",
          probe: `{ const int descriptor = open(".git/index.lock", O_WRONLY | O_CREAT | O_EXCL, 0600); if (descriptor >= 0) { allowed = write(descriptor, "lock\\n", 5) == 5; close(descriptor); allowed = allowed && rename(".git/index.lock", ".git/index") == 0; } }`,
          allowed: "index-refresh:allowed",
          denied: "index-refresh:denied",
        }),
      );

      await expect(
        workspace(async () => indexRefreshAttempt).execute(request()),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          kind: "workspace.command",
          stdout: "## index-refresh:allowed\n",
        },
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
