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

import type { ChildProcess } from "node:child_process";
import {
  executeNativeVerificationCommand,
  type ApprovedRootLauncher,
} from "../../src/modules/computer/infra/native/native-verification-command";
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
    // The reviewed helper's launch, replaced by the process mock so each test
    // controls what the bound command does.
    launchInApprovedRoot: async (launch) => {
      launches.push(launch);
      return processMock.spawn(
        "/usr/bin/python3",
        launch.arguments,
        {},
      ) as unknown as ChildProcess;
    },
  });
}

// What the helper writes right before it becomes the command.
const EXEC_MAGIC = Buffer.from("FAROLX1\0", "ascii");
type Launch = Parameters<ApprovedRootLauncher>[0];
const launches: Launch[] = [];

beforeEach(async () => {
  processMock.spawn.mockReset();
  launches.length = 0;
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
        child.stdout.emit("data", EXEC_MAGIC);
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

  it("pins the exact HEAD command, workspace and Git metadata environment", async () => {
    processMock.spawn.mockImplementationOnce(() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.emit(
          "data",
          Buffer.concat([EXEC_MAGIC, Buffer.from(`${"a".repeat(40)}\n`)]),
        );
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
    const launch = launches[0];
    expect(launch?.arguments.slice(-4)).toEqual([
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD",
    ]);
    // Git gets no pathname for the workspace: the helper binds the working
    // directory to the approved root object and Git's paths are relative.
    expect(launch?.arguments).not.toContain("-C");
    expect(launch?.root).toBe(root);
    expect(launch?.approvedRoot).toEqual(approvedRootOf(root));
    expect(launch?.environment).toMatchObject({
      GIT_DIR: ".git",
      GIT_COMMON_DIR: ".git",
      GIT_WORK_TREE: ".",
      GIT_TERMINAL_PROMPT: "0",
    });
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
