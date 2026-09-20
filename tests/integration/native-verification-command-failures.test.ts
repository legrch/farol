import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ReadonlyWorkspaceRequest,
  WorkspaceVerificationCommand,
} from "../../src/modules/computer/app/port/readonly-workspace";

const processMock = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: processMock.spawn,
}));

import {
  executeNativeVerificationCommand,
  type SnapshotFactory,
} from "../../src/modules/computer/infra/native/native-verification-command";
import type { WorkspaceSnapshotErrorCode } from "../../src/modules/computer/infra/native/workspace-snapshot";
import { approvedRootOf } from "../fixtures/root-identity";

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  constructor(readonly pid: number | undefined = undefined) {
    super();
  }

  readonly kill = vi.fn(() => {
    this.emit("close", null, "SIGKILL");
    return true;
  });
}

// A child whose stdio pipes never came up.
class HeadlessChild extends EventEmitter {
  readonly stdout = null;
  readonly stderr = null;
  readonly pid = undefined;
  readonly kill = vi.fn(() => true);
}

let root = "";

function request(
  command: WorkspaceVerificationCommand = "git.status",
): ReadonlyWorkspaceRequest {
  return {
    workspace: {
      workspaceId: "workspace-a",
      root,
      approvedRoot: approvedRootOf(root),
      deniedPaths: [],
    },
    operation: {
      kind: "verification.run",
      command,
      relativePath: ".",
    },
  };
}

// N02: the snapshot mechanism itself is proven separately
// (workspace-snapshot.test.ts) and by the real end-to-end tests in
// native-verification-command.test.ts. These tests are about the command
// spawned *over* a snapshot, so the snapshot here is a fixed fake -- its
// destination is `root` itself, which already has a `.git` from beforeEach --
// and never goes through a real child process of its own.
function fakeSnapshotFactory(): SnapshotFactory {
  return async () => ({
    ok: true,
    path: root,
    entries: 0,
    bytes: 0,
    clonedBytes: 0,
    skipped: 0,
    indexSha256: null,
    remove: async () => undefined,
  });
}

async function execute(
  attestGit?: () => Promise<string>,
  command: WorkspaceVerificationCommand = "git.status",
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof executeNativeVerificationCommand>>> {
  const input = request(command);
  if (input.operation.kind !== "verification.run") {
    throw new Error("verification operation expected");
  }
  return executeNativeVerificationCommand(input, input.operation, {
    ...(attestGit ? { attestGit } : {}),
    ...(signal ? { signal } : {}),
    createSnapshot: fakeSnapshotFactory(),
  });
}

beforeEach(async () => {
  processMock.spawn.mockReset();
  root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-command-failure-"),
  );
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, ".git"), { mode: 0o700 });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("native verification command process failures", () => {
  it("fails closed when the reviewed attestation executable cannot start", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("spawn refused")));
      return child;
    });

    await expect(execute()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
        retry: "never",
      },
    });
  });

  it("fails closed when reviewed attestation output exceeds its bound", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.alloc(16 * 1_024 + 1, "x"));
      });
      return child;
    });

    await expect(execute()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
        retry: "never",
      },
    });
  });

  it("fails closed when a reviewed attestation command exits non-zero", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("close", 1, null));
      return child;
    });

    await expect(execute()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED",
        retry: "never",
      },
    });
  });

  it("reports a missing sandbox process and ignores its later close", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.emit("error", new Error("sandbox unavailable"));
        child.emit("close", 1, null);
      });
      return child;
    });

    await expect(execute(async () => "/usr/bin/git")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE",
        retry: "never",
      },
    });
  });

  it("classifies sandbox policy application failures precisely", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stderr.emit(
          "data",
          Buffer.from("sandbox-exec: sandbox_apply: operation not permitted"),
        );
        child.emit("close", 1, null);
      });
      return child;
    });

    await expect(execute(async () => "/usr/bin/git")).resolves.toMatchObject({
      ok: false,
      error: {
        code: "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE",
        retry: "never",
      },
    });
  });

  it("pins the exact HEAD command, snapshot working directory and environment", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${"a".repeat(40)}\n`));
        child.emit("close", 0, null);
      });
      return child;
    });

    await expect(
      execute(async () => "/usr/bin/git", "git.head"),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "workspace.command",
        command: "git.head",
        network: "none",
      },
    });
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    const [executable, launchArguments, spawnOptions] = processMock.spawn.mock
      .calls[0] as [string, string[], Record<string, unknown>];
    expect(executable).toBe("/usr/bin/sandbox-exec");
    expect(launchArguments.slice(-4)).toEqual([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    // Git gets no `-C`: it runs bound to the private snapshot's own working
    // directory (here the fake snapshot's path, which this test doubles as
    // `root` for convenience) rather than being told a path on the command
    // line.
    expect(launchArguments).not.toContain("-C");
    expect(spawnOptions.cwd).toBe(root); // the fake snapshot's own path
    expect(spawnOptions.env).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      HOME: root,
    });
  });

  it("grants the sandboxed Git writes to exactly the snapshot's index and index lock", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(`${"b".repeat(40)}\n`));
        child.emit("close", 0, null);
      });
      return child;
    });

    await execute(async () => "/usr/bin/git", "git.head");
    const [, launchArguments] = processMock.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    const profile = launchArguments[launchArguments.indexOf("-p") + 1] ?? "";
    // The write grant names four literal files and no subtree at all.
    expect(profile).toContain('(literal (param "FAROL_GIT_INDEX"))');
    expect(profile).toContain('(literal (param "FAROL_GIT_INDEX_LOCK"))');
    expect(profile).toContain('(literal (param "FAROL_GIT_META_INDEX"))');
    expect(profile).toContain('(literal (param "FAROL_GIT_META_INDEX_LOCK"))');
    expect(profile).not.toContain('(subpath (param "FAROL_GIT_DIR"))');
    expect(profile).not.toContain('(subpath (param "FAROL_GIT_META_DIR"))');
    expect(
      profile.match(/\(allow file-write\*[\s\S]*?\)\)/u)?.[0],
    ).not.toContain("subpath");
    for (const [parameter, relative] of [
      ["FAROL_GIT_INDEX", ".git/index"],
      ["FAROL_GIT_INDEX_LOCK", ".git/index.lock"],
      ["FAROL_GIT_META_INDEX", ".gitmeta/worktree/index"],
      ["FAROL_GIT_META_INDEX_LOCK", ".gitmeta/worktree/index.lock"],
    ] as const) {
      expect(launchArguments).toContain(
        `${parameter}=${path.join(root, ...relative.split("/"))}`,
      );
    }
    expect(
      launchArguments.some((argument) => argument.startsWith("FAROL_GIT_DIR=")),
    ).toBe(false);
  });

  it("pins the exact tracked-list and status argument vectors, with one literal exclude pathspec per denied prefix", async () => {
    processMock.spawn
      .mockImplementationOnce(() => {
        // The tracked-path listing: nothing tracked.
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      })
      .mockImplementationOnce(() => {
        // The status over the metadata-only snapshot: a header record only.
        const child = new FakeChild();
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("## main\0"));
          child.emit("close", 0, null);
        });
        return child;
      });

    const input = request("git.status");
    const denied = {
      ...input,
      workspace: {
        ...input.workspace,
        deniedPaths: ["private", "secrets/keys"],
      },
    };
    if (denied.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }
    await expect(
      executeNativeVerificationCommand(denied, denied.operation, {
        attestGit: async () => "/usr/bin/git",
        createSnapshot: fakeSnapshotFactory(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: "workspace.command", stdout: "## main\n", outputBytes: 8 },
    });
    expect(processMock.spawn).toHaveBeenCalledTimes(2);
    const [, listArguments] = processMock.spawn.mock.calls[0] as [
      string,
      string[],
    ];
    expect(listArguments.slice(-3)).toEqual(["ls-files", "-z", "--stage"]);
    const [, statusArguments] = processMock.spawn.mock.calls[1] as [
      string,
      string[],
    ];
    expect(statusArguments.slice(-9)).toEqual([
      "status",
      "--porcelain",
      "--branch",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=all",
      "--",
      ":(exclude,top,literal)private",
      ":(exclude,top,literal)secrets/keys",
    ]);
  });

  it("renders porcelain records itself and drops one naming a denied path on either side of a rename", async () => {
    processMock.spawn
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => {
          child.stdout.emit(
            "data",
            Buffer.from(
              [
                "## main...origin/main [ahead 1]",
                " M has space.txt",
                "R  moved.txt",
                "orig -> old.txt",
                "R  Private/in.txt",
                "public/from.txt",
                "R  public/to.txt",
                "private/from.txt",
                "A  отчёт.md",
                "",
              ].join("\0"),
            ),
          );
          child.emit("close", 0, null);
        });
        return child;
      });

    const input = request("git.status");
    const denied = {
      ...input,
      workspace: { ...input.workspace, deniedPaths: ["private"] },
    };
    if (denied.operation.kind !== "verification.run") {
      throw new Error("verification operation expected");
    }
    await expect(
      executeNativeVerificationCommand(denied, denied.operation, {
        attestGit: async () => "/usr/bin/git",
        createSnapshot: fakeSnapshotFactory(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        stdout:
          "## main...origin/main [ahead 1]\n" +
          " M has space.txt\n" +
          "R  orig -> old.txt -> moved.txt\n" +
          "A  отчёт.md\n",
      },
    });
  });

  it("refuses a listing or a status record whose path it will not carry, and a malformed listing outright", async () => {
    const listingThen = (
      listing: string,
    ): ((command: WorkspaceVerificationCommand) => Promise<unknown>) => {
      processMock.spawn.mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => {
          if (listing !== "") child.stdout.emit("data", Buffer.from(listing));
          child.emit("close", 0, null);
        });
        return child;
      });
      return (command) => execute(async () => "/usr/bin/git", command);
    };
    const blob = "a".repeat(40);

    await expect(
      listingThen(`100644 ${blob} 0\tback\\slash.txt\0`)("git.status"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_TRACKED_PATH_UNSUPPORTED" },
    });
    await expect(
      listingThen("README.md\0")("git.status"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED" },
    });
    await expect(
      listingThen(`100644 ${blob} 0\tREADME.md`)("git.status"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED" },
    });

    processMock.spawn
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from("D  gone\\here.txt\0"));
          child.emit("close", 0, null);
        });
        return child;
      });
    await expect(execute(async () => "/usr/bin/git")).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_TRACKED_PATH_UNSUPPORTED" },
    });
  });

  it("maps every snapshot-layer refusal onto its own closed code, without spawning anything", async () => {
    const expectations: ReadonlyArray<
      readonly [WorkspaceSnapshotErrorCode, string]
    > = [
      ["SNAPSHOT_ROOT_CHANGED", "WORKSPACE_ROOT_CHANGED"],
      ["SNAPSHOT_METADATA_UNAPPROVED", "WORKSPACE_GIT_METADATA_NOT_APPROVED"],
      [
        "SNAPSHOT_ALTERNATES_UNSUPPORTED",
        "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED",
      ],
      ["SNAPSHOT_HELPER_UNTRUSTED", "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED"],
      ["SNAPSHOT_NOT_FOUND", "WORKSPACE_NOT_FOUND"],
      ["SNAPSHOT_PATH_REFUSED", "WORKSPACE_PATH_REFUSED"],
      ["SNAPSHOT_RACE_DETECTED", "WORKSPACE_RACE_DETECTED"],
      ["SNAPSHOT_TOO_LARGE", "WORKSPACE_SNAPSHOT_TOO_LARGE"],
      ["SNAPSHOT_CROSS_VOLUME", "WORKSPACE_SNAPSHOT_CROSS_VOLUME"],
      ["SNAPSHOT_CLONE_UNSUPPORTED", "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED"],
      ["SNAPSHOT_INDEX_CHANGED", "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT"],
      ["SNAPSHOT_INVALID_REQUEST", "WORKSPACE_HELPER_FAILED"],
      ["SNAPSHOT_DESTINATION_INVALID", "WORKSPACE_HELPER_FAILED"],
      ["SNAPSHOT_HELPER_FAILED", "WORKSPACE_HELPER_FAILED"],
    ];
    for (const [snapshotCode, code] of expectations) {
      const input = request("git.head");
      if (input.operation.kind !== "verification.run") {
        throw new Error("verification operation expected");
      }
      await expect(
        executeNativeVerificationCommand(input, input.operation, {
          attestGit: async () => "/usr/bin/git",
          createSnapshot: async () => ({ ok: false, code: snapshotCode }),
        }),
        snapshotCode,
      ).resolves.toEqual({ ok: false, error: { code, retry: "never" } });
    }
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it("refuses a snapshot path it cannot grant -- relative, or deeper than the ancestor bound -- before spawning anything", async () => {
    for (const snapshotPath of ["relative/snapshot", "/a".repeat(130)]) {
      const input = request("git.head");
      if (input.operation.kind !== "verification.run") {
        throw new Error("verification operation expected");
      }
      await expect(
        executeNativeVerificationCommand(input, input.operation, {
          attestGit: async () => "/usr/bin/git",
          createSnapshot: async () => ({
            ok: true,
            path: snapshotPath,
            entries: 0,
            bytes: 0,
            clonedBytes: 0,
            skipped: 0,
            indexSha256: null,
            remove: async () => undefined,
          }),
        }),
        snapshotPath,
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_COMMAND_UNSUPPORTED", retry: "never" },
      });
    }
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it("classifies a sandbox process that came up without stdio as unavailable", async () => {
    processMock.spawn.mockImplementationOnce(() => new HeadlessChild());

    await expect(
      execute(async () => "/usr/bin/git", "git.head"),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE", retry: "never" },
    });
  });

  function listingThenStatus(status: Buffer, stderr = "", code = 0): void {
    processMock.spawn
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => child.emit("close", 0, null));
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new FakeChild();
        setImmediate(() => {
          if (status.length > 0) child.stdout.emit("data", status);
          if (stderr !== "") child.stderr.emit("data", Buffer.from(stderr));
          child.emit("close", code, null);
        });
        return child;
      });
  }

  it("refuses every malformed status shape instead of rendering it", async () => {
    const malformed: ReadonlyArray<readonly [string, Buffer]> = [
      ["header with a line break", Buffer.from("## ma\nin\0")],
      ["empty header", Buffer.from("## \0")],
      ["blank status code", Buffer.from("   x.txt\0")],
      ["short record", Buffer.from("M x\0")],
      ["unknown status letter", Buffer.from("Z  x.txt\0")],
      ["rename without its original", Buffer.from("R  new.txt\0")],
      ["record without a terminator", Buffer.from("## main")],
      ["invalid UTF-8", Buffer.from([0xff, 0x00])],
    ];
    for (const [label, status] of malformed) {
      listingThenStatus(status);
      await expect(
        execute(async () => "/usr/bin/git"),
        label,
      ).resolves.toEqual({
        ok: false,
        error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
      });
    }
    listingThenStatus(Buffer.from("## main\0"), "warning: something");
    await expect(execute(async () => "/usr/bin/git")).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
    listingThenStatus(Buffer.from("## main\0"), "", 128);
    await expect(execute(async () => "/usr/bin/git")).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("bounds the rendered status at the result size even when the NUL-separated form fit under it", async () => {
    // 9,000 rename records of 7 bytes each (63,000 bytes, under the 64 KiB
    // bound Git's output is read with) render at 10 bytes each: over it.
    listingThenStatus(Buffer.from("R  x\0y\0".repeat(9_000)));
    await expect(execute(async () => "/usr/bin/git")).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE", retry: "never" },
    });
  });

  it("bounds the tracked-path listing's stderr like any other invocation's", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stderr.emit("data", Buffer.alloc(5_000, "x"));
        child.emit("close", 0, null);
      });
      return child;
    });
    await expect(execute(async () => "/usr/bin/git")).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE", retry: "never" },
    });
  });

  it("classifies an unresolved HEAD as a failure when the repository's HEAD is not a branch pointer", async () => {
    // The fake repository has no HEAD file at all, so the unborn-branch
    // reading cannot be established and the unresolved HEAD is a failure.
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => child.emit("close", 1, null));
      return child;
    });
    await expect(
      execute(async () => "/usr/bin/git", "git.head"),
    ).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from([0xff, 0x0a]));
        child.emit("close", 0, null);
      });
      return child;
    });
    await expect(
      execute(async () => "/usr/bin/git", "git.head"),
    ).resolves.toEqual({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_FAILED", retry: "never" },
    });
  });

  it("falls back to the child's own kill when its process group cannot be signalled", async () => {
    const child = new FakeChild(43_211);
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    processMock.spawn.mockImplementationOnce(() => {
      markSpawned?.();
      return child;
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("no such process group");
    });
    const controller = new AbortController();

    const result = execute(
      async () => "/usr/bin/git",
      "git.status",
      controller.signal,
    );
    await spawned;
    controller.abort();

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_CANCELLED", retry: "never" },
    });
    expect(kill).toHaveBeenCalledWith(-43_211, "SIGKILL");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("terminates and classifies a command that exceeds the fixed deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    processMock.spawn.mockImplementationOnce(() => {
      markSpawned?.();
      return new FakeChild();
    });

    const result = execute(async () => "/usr/bin/git");
    await spawned;
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_TIMEOUT", retry: "never" },
    });
  });

  it("does not spawn a command when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execute(async () => "/usr/bin/git", "git.status", controller.signal),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_CANCELLED", retry: "never" },
    });
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it("kills the detached process group and classifies in-flight cancellation", async () => {
    const child = new FakeChild(43_210);
    let markSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    processMock.spawn.mockImplementationOnce(() => {
      markSpawned?.();
      return child;
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    const controller = new AbortController();

    const result = execute(
      async () => "/usr/bin/git",
      "git.status",
      controller.signal,
    );
    await spawned;
    controller.abort();

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_COMMAND_CANCELLED", retry: "never" },
    });
    expect(kill).toHaveBeenCalledWith(-43_210, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
