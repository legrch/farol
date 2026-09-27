import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { SandboxedWorkspaceShell } from "../../src/modules/computer/infra/native/sandboxed-workspace-shell";
import { SHELL_WATCHDOG_SOURCE } from "../../src/modules/computer/infra/native/shell-watchdog-source";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";

const binding = {
  ownerId: "owner-test",
  sessionId: "session-test",
  taskId: "task-test",
  taskEpoch: 1,
};

const roots: string[] = [];
const shells: SandboxedWorkspaceShell[] = [];

afterEach(async () => {
  for (const shell of shells.splice(0)) shell.close();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(
  commands: "none" | "workspace" = "workspace",
  linked = false,
  folderName = "workspace",
  gitHistoryApproved = false,
  expiresAt = Date.now() + 60_000,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-shell-")),
  );
  roots.push(root);
  const workspace = path.join(root, folderName);
  let gitMetadata:
    { gitDirectory: string; commonDirectory: string } | undefined;
  if (linked) {
    const primary = path.join(root, "primary");
    await fs.mkdir(primary);
    execFileSync("git", ["init", "-q", primary]);
    await fs.writeFile(path.join(primary, "base.txt"), "base");
    execFileSync("git", ["-C", primary, "add", "base.txt"]);
    execFileSync("git", [
      "-C",
      primary,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "base",
    ]);
    execFileSync("git", [
      "-C",
      primary,
      "worktree",
      "add",
      "-qb",
      "topic",
      workspace,
    ]);
    gitMetadata = {
      gitDirectory: execFileSync(
        "git",
        ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-dir"],
        { encoding: "utf8" },
      ).trim(),
      commonDirectory: execFileSync(
        "git",
        [
          "-C",
          workspace,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { encoding: "utf8" },
      ).trim(),
    };
  } else {
    await fs.mkdir(workspace);
  }
  const identity = await fs.lstat(workspace, { bigint: true });
  const approval: ComputerApproval = {
    ownerId: binding.ownerId,
    computerId: "computer-test",
    generation: 1,
    workspaces: [
      {
        workspaceId: "fixture",
        root: workspace,
        access: "write",
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
        },
        gitHistoryApproved,
        shellVerified: true,
        ...(gitMetadata ? { gitMetadata } : {}),
      },
    ],
    capabilities: ["workspace.shell", "workspace.write"],
    network: "none",
    commands,
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: "authority-test",
    ...binding,
    computerId: approval.computerId,
    computerGeneration: approval.generation,
    workspaces: [
      {
        workspaceId: "fixture",
        mode: "subtree",
        root: workspace,
        access: "write",
      },
    ],
    capabilities: approval.capabilities,
    network: "none",
    commands,
    expiresAt: approval.expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, Date.now());
  if (!grant.ok) throw new Error(grant.error.code);
  const result = createParticipantAuthority(grant.value, {
    participantId: "main-test",
    role: "main",
    mutationOwnership: "task",
  });
  if (!result.ok) throw new Error(result.error.code);
  const participant: ParticipantAuthority = result.value;
  const shell = new SandboxedWorkspaceShell(
    approval,
    participant,
    binding,
    path.join(root, "private"),
  );
  shells.push(shell);
  return { root, workspace, shell, approval, participant };
}

async function complete(shell: SandboxedWorkspaceShell, handle: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = shell.read({ handle, stdoutOffset: 0, stderrOffset: 0 });
    if (!read.ok) throw new Error(read.error.code);
    if (read.value.state === "exited") return read.value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("SHELL_TEST_TIMEOUT");
}

describe("workspace shell authority", () => {
  it("rejects a cancelled call before reserving or starting an operation", async () => {
    const { shell, workspace } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const input = {
      operationId: "aborted-before-intent",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "printf forbidden > cancelled.txt",
      timeoutMs: 5_000,
      write: true,
    };
    expect(await shell.start(input, controller.signal)).toMatchObject({
      ok: false,
      error: { code: "SHELL_CALL_ABORTED" },
    });
    await expect(
      fs.stat(path.join(workspace, "cancelled.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks authority after asynchronous workspace verification", async () => {
    const { root, workspace, approval, participant } = await fixture();
    let checks = 0;
    const expiring = new SandboxedWorkspaceShell(
      approval,
      participant,
      binding,
      path.join(root, "expiring-private"),
      () => (++checks === 1 ? Date.now() : Date.now() + 61_000),
    );
    shells.push(expiring);
    expect(
      await expiring.start({
        operationId: "expiry-during-verification",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "printf forbidden > expired.txt",
        timeoutMs: 5_000,
        write: true,
      }),
    ).toMatchObject({ ok: false });
    expect(checks).toBeGreaterThanOrEqual(2);
    await expect(
      fs.stat(path.join(workspace, "expired.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors caller cancellation during asynchronous workspace verification", async () => {
    const { root, workspace, approval, participant } = await fixture();
    const controller = new AbortController();
    let checks = 0;
    const cancelling = new SandboxedWorkspaceShell(
      approval,
      participant,
      binding,
      path.join(root, "verification-abort-private"),
      () => {
        if (++checks === 1) controller.abort();
        return Date.now();
      },
    );
    shells.push(cancelling);
    expect(
      await cancelling.start(
        {
          operationId: "abort-during-verification",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "printf forbidden > verification-abort.txt",
          timeoutMs: 5_000,
          write: true,
        },
        controller.signal,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: "SHELL_CALL_ABORTED" },
    });
    await expect(
      fs.stat(path.join(workspace, "verification-abort.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses authority that expires after durable reservation but before dispatch", async () => {
    const { root, workspace, approval, participant } = await fixture();
    let checks = 0;
    const expiring = new SandboxedWorkspaceShell(
      approval,
      participant,
      binding,
      path.join(root, "dispatch-expiry-private"),
      () => (++checks < 3 ? Date.now() : Date.now() + 61_000),
    );
    shells.push(expiring);
    const input = {
      operationId: "expire-before-dispatch",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "printf forbidden > dispatch-expired.txt",
      timeoutMs: 5_000,
      write: true,
    };
    expect(await expiring.start(input)).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_EXPIRED" },
    });
    const resumed = new SandboxedWorkspaceShell(
      approval,
      participant,
      binding,
      path.join(root, "dispatch-expiry-private"),
    );
    shells.push(resumed);
    expect(await resumed.start(input)).toMatchObject({
      ok: false,
      error: { code: "SHELL_OUTCOME_UNKNOWN" },
    });
    await expect(
      fs.stat(path.join(workspace, "dispatch-expired.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never dispatches an operation cancelled after its durable reservation", async () => {
    const { root, workspace, approval, participant } = await fixture();
    const controller = new AbortController();
    let checks = 0;
    const cancelling = new SandboxedWorkspaceShell(
      approval,
      participant,
      binding,
      path.join(root, "aborting-private"),
      () => {
        if (++checks === 3) controller.abort();
        return Date.now();
      },
    );
    shells.push(cancelling);
    const input = {
      operationId: "abort-after-intent",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "printf forbidden > late.txt",
      timeoutMs: 5_000,
      write: true,
    };
    expect(await cancelling.start(input, controller.signal)).toMatchObject({
      ok: false,
      error: { code: "SHELL_OUTCOME_UNKNOWN" },
    });
    expect(await cancelling.start(input)).toMatchObject({
      ok: false,
      error: { code: "SHELL_OUTCOME_UNKNOWN" },
    });
    await expect(
      fs.stat(path.join(workspace, "late.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses commands when command authority is off", async () => {
    const { shell } = await fixture("none");
    const result = await shell.start({
      operationId: "off-command",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "pwd",
      timeoutMs: 1_000,
      write: false,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a stale folder verification even when command mode remains on", async () => {
    const { root, approval, participant } = await fixture();
    const stale = new SandboxedWorkspaceShell(
      {
        ...approval,
        workspaces: approval.workspaces.map((workspace) => ({
          ...workspace,
          shellVerified: false,
        })),
      },
      participant,
      binding,
      path.join(root, "stale-private"),
    );
    shells.push(stale);
    expect(
      await stale.start({
        operationId: "stale-verification",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "printf should-not-run",
        timeoutMs: 1_000,
        write: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "SHELL_WORKSPACE_VERIFICATION_REQUIRED" },
    });
  });
});

describe.skipIf(process.platform !== "darwin")(
  "native sandboxed workspace shell",
  () => {
    it("never spawns a command after the absolute authority deadline", async () => {
      const { workspace } = await fixture();
      const watchdog = spawn(process.execPath, ["-e", SHELL_WATCHDOG_SOURCE], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const events: string[] = [];
      watchdog.on("message", (message: unknown) => {
        events.push((message as { type: string }).type);
      });
      try {
        const exited = new Promise<void>((resolve) =>
          watchdog.once("exit", () => resolve()),
        );
        watchdog.send({
          type: "start",
          executable: "/bin/zsh",
          args: ["-c", "printf forbidden > missed-deadline.txt"],
          cwd: workspace,
          environment: { PATH: "/usr/bin:/bin" },
          authorityDeadlineAt: Date.now() - 1,
          commandDeadlineAt: Date.now() + 30_000,
          stdin: "",
        });
        await exited;
        expect(events).toContain("deadline");
        expect(events).toContain("close");
        expect(events).not.toContain("ready");
        await expect(
          fs.stat(path.join(workspace, "missed-deadline.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (watchdog.connected) watchdog.send({ type: "stop" });
      }
    });

    it("terminates its owned process group when the MCP control channel disappears", async () => {
      const watchdog = spawn(process.execPath, ["-e", SHELL_WATCHDOG_SOURCE], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      try {
        const ready = new Promise<number>((resolve, reject) => {
          watchdog.on("error", reject);
          watchdog.on("message", (message: unknown) => {
            const event = message as { type?: string; pid?: number };
            if (event.type === "ready" && event.pid) resolve(event.pid);
          });
        });
        watchdog.send({
          type: "start",
          executable: "/bin/zsh",
          args: ["-c", "sleep 20"],
          cwd: os.tmpdir(),
          environment: { PATH: "/usr/bin:/bin" },
          authorityDeadlineAt: Date.now() + 60_000,
          commandDeadlineAt: Date.now() + 30_000,
          stdin: "",
        });
        const ownedPid = await ready;
        expect(() => process.kill(ownedPid, 0)).not.toThrow();
        const exited = new Promise<void>((resolve) =>
          watchdog.once("exit", () => resolve()),
        );
        watchdog.disconnect();
        await exited;
        expect(() => process.kill(-watchdog.pid!, 0)).toThrow();
      } finally {
        if (watchdog.connected) watchdog.send({ type: "stop" });
      }
    });

    it("uses the watchdog group to stop a command after watchdog loss", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "watchdog-crash",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "sleep 20",
        timeoutMs: 30_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const records = Reflect.get(shell, "byHandle") as Map<
        string,
        {
          child: ReturnType<typeof spawn>;
          productPid: number | null;
        }
      >;
      const record = records.get(started.value.handle);
      if (!record) throw new Error("TEST_RECORD_MISSING");
      for (
        let attempt = 0;
        attempt < 100 && record.productPid === null;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pid = record.productPid;
      if (pid === null) throw new Error("TEST_PRODUCT_PID_MISSING");
      record.child.kill("SIGKILL");
      const outcome = await complete(shell, started.value.handle);
      expect(outcome.errorCode).toBe("SHELL_WATCHDOG_LOST");
      expect(() => process.kill(-record.child.pid!, 0)).toThrow();
    });

    it("runs a normal write and Git workflow, denies outside and retains one operation", async () => {
      const { root, workspace, shell } = await fixture(
        "workspace",
        false,
        "workspace",
        true,
      );
      await fs.writeFile(
        path.join(root, "outside.txt"),
        "OUTSIDE_SECRET_CANARY",
      );
      await fs.writeFile(path.join(workspace, ".env"), "DENIED_SECRET_CANARY");
      const input = {
        operationId: "git-workflow",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          "git init -q && printf hello > owned.txt && git add -- owned.txt && git -c user.name=Test -c user.email=test@example.invalid commit -qm test && git status --short && printf '\\n' && git rev-parse HEAD",
        timeoutMs: 10_000,
        write: true,
      };
      const started = await shell.start(input);
      if (!started.ok) throw new Error(started.error.code);
      const same = await shell.start(input);
      expect(same).toMatchObject({
        ok: true,
        value: { handle: started.value.handle },
      });
      const result = await complete(shell, started.value.handle);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/[a-f0-9]{40}/u);
      expect(await fs.readFile(path.join(workspace, "owned.txt"), "utf8")).toBe(
        "hello",
      );

      const denied = await shell.start({
        operationId: "deny-outside",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "cat ../outside.txt .env",
        timeoutMs: 5_000,
        write: false,
      });
      if (!denied.ok) throw new Error(denied.error.code);
      const deniedResult = await complete(shell, denied.value.handle);
      expect(deniedResult.exitCode).not.toBe(0);
      expect(deniedResult.stdout).not.toContain("OUTSIDE_SECRET_CANARY");
      expect(deniedResult.stdout).not.toContain("DENIED_SECRET_CANARY");
    });

    it("keeps a foreign staged file while committing only an owned path", async () => {
      const { workspace, shell } = await fixture(
        "workspace",
        false,
        "workspace",
        true,
      );
      execFileSync("git", ["init", "-q", workspace]);
      await fs.writeFile(path.join(workspace, "foreign.txt"), "foreign-base\n");
      await fs.writeFile(path.join(workspace, "owned.txt"), "owned-base\n");
      execFileSync("git", [
        "-C",
        workspace,
        "add",
        "--",
        "foreign.txt",
        "owned.txt",
      ]);
      execFileSync("git", [
        "-C",
        workspace,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "base",
      ]);
      await fs.writeFile(
        path.join(workspace, "foreign.txt"),
        "foreign-staged\n",
      );
      execFileSync("git", ["-C", workspace, "add", "--", "foreign.txt"]);
      await fs.writeFile(path.join(workspace, "owned.txt"), "owned-next\n");
      const stagedForeign = execFileSync(
        "git",
        ["-C", workspace, "diff", "--cached", "--binary", "--", "foreign.txt"],
        { encoding: "utf8" },
      );
      const started = await shell.start({
        operationId: "path-scoped-commit",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          'git diff -- owned.txt && git add -- owned.txt && git restore --staged -- owned.txt && test "$(cat owned.txt)" = owned-next && git add -- owned.txt && git -c user.name=Test -c user.email=test@example.invalid commit --only -qm own -- owned.txt && git status --short',
        timeoutMs: 10_000,
        write: true,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("M  foreign.txt");
      expect(
        execFileSync("git", ["-C", workspace, "show", "HEAD:owned.txt"], {
          encoding: "utf8",
        }),
      ).toBe("owned-next\n");
      expect(
        execFileSync("git", ["-C", workspace, "show", "HEAD:foreign.txt"], {
          encoding: "utf8",
        }),
      ).toBe("foreign-base\n");
      expect(
        execFileSync(
          "git",
          [
            "-C",
            workspace,
            "diff",
            "--cached",
            "--binary",
            "--",
            "foreign.txt",
          ],
          { encoding: "utf8" },
        ),
      ).toBe(stagedForeign);
      expect(
        await fs.readFile(path.join(workspace, "foreign.txt"), "utf8"),
      ).toBe("foreign-staged\n");
    });

    it("applies the delegated subtree and exclusion to the whole shell profile", async () => {
      const { root, workspace, approval, participant } = await fixture();
      const narrowedRoot = path.join(workspace, "allowed");
      const adjacentRoot = path.join(root, "adjacent");
      await fs.mkdir(narrowedRoot);
      await fs.mkdir(adjacentRoot);
      await fs.writeFile(
        path.join(workspace, "parent.txt"),
        "PARENT_SECRET_CANARY",
      );
      await fs.writeFile(
        path.join(adjacentRoot, "other.txt"),
        "OTHER_SECRET_CANARY",
      );
      await fs.writeFile(
        path.join(narrowedRoot, "excluded.txt"),
        "EXCLUDED_SECRET_CANARY",
      );
      await fs.mkdir(path.join(narrowedRoot, "nested"));
      await fs.writeFile(
        path.join(narrowedRoot, "nested", ".env"),
        "NESTED_SECRET_CANARY",
      );
      const adjacentIdentity = await fs.lstat(adjacentRoot, { bigint: true });
      const widerApproval: ComputerApproval = {
        ...approval,
        workspaces: [
          ...approval.workspaces,
          {
            workspaceId: "adjacent",
            root: adjacentRoot,
            access: "write",
            rootIdentity: {
              device: String(adjacentIdentity.dev),
              inode: String(adjacentIdentity.ino),
            },
          },
        ],
      };
      const delegated = delegateParticipantAuthority(participant, {
        participantId: "narrowed-test",
        role: "agent",
        mutationOwnership: "task",
        narrowing: {
          workspaces: [
            {
              workspaceId: "fixture",
              mode: "subtree",
              root: narrowedRoot,
              access: "write",
            },
          ],
          excludedPaths: [
            {
              workspaceId: "fixture",
              path: path.join(narrowedRoot, "excluded.txt"),
            },
          ],
          capabilities: ["workspace.shell", "workspace.write"],
          network: "none",
          commands: "workspace",
        },
      });
      if (!delegated.ok) throw new Error(delegated.error.code);
      const narrowed = new SandboxedWorkspaceShell(
        widerApproval,
        delegated.value,
        binding,
        path.join(root, "narrowed-private"),
      );
      shells.push(narrowed);
      const started = await narrowed.start({
        operationId: "narrowed-profile",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: `cat ../parent.txt '${path.join(adjacentRoot, "other.txt")}' excluded.txt nested/.env; printf allowed`,
        timeoutMs: 5_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(narrowed, started.value.handle);
      expect(result.stdout).toBe("allowed");
      expect(result.stderr).not.toContain("SECRET_CANARY");
    });

    it("keeps Git object history closed until a separate workspace approval", async () => {
      const { workspace, shell } = await fixture();
      execFileSync("git", ["init", "-q", workspace]);
      await fs.writeFile(
        path.join(workspace, "past.txt"),
        "HISTORY_SECRET_CANARY",
      );
      execFileSync("git", ["-C", workspace, "add", "past.txt"]);
      execFileSync("git", [
        "-C",
        workspace,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "history",
      ]);
      await fs.rm(path.join(workspace, "past.txt"));
      const denied = await shell.start({
        operationId: "history-not-approved",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "git show HEAD:past.txt; cat .git/HEAD",
        timeoutMs: 5_000,
        write: false,
      });
      if (!denied.ok) throw new Error(denied.error.code);
      const result = await complete(shell, denied.value.handle);
      expect(result.stdout).not.toContain("HISTORY_SECRET_CANARY");
      expect(result.exitCode).not.toBe(0);
    });

    it("keeps home credential files closed when their parent is the selected workspace", async () => {
      const { root, workspace, approval, participant } = await fixture(
        "workspace",
        false,
        ".docker",
      );
      await fs.writeFile(
        path.join(workspace, "config.json"),
        "DOCKER_SECRET_CANARY",
      );
      const guarded = new SandboxedWorkspaceShell(
        approval,
        participant,
        binding,
        path.join(root, "home-guard-private"),
        () => Date.now(),
        root,
      );
      shells.push(guarded);
      const started = await guarded.start({
        operationId: "home-docker-config",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "cat config.json",
        timeoutMs: 5_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(guarded, started.value.handle);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("DOCKER_SECRET_CANARY");
    });

    it("refuses a workspace root that is itself inside a home credential store", async () => {
      const { root, approval, participant } = await fixture(
        "workspace",
        false,
        ".ssh",
      );
      const guarded = new SandboxedWorkspaceShell(
        approval,
        participant,
        binding,
        path.join(root, "home-store-private"),
        () => Date.now(),
        root,
      );
      shells.push(guarded);
      expect(
        await guarded.start({
          operationId: "home-ssh-root",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "pwd",
          timeoutMs: 5_000,
          write: false,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "SHELL_CREDENTIAL_STORE_DENIED" },
      });
    });

    it("cancels only its own process group and returns the real signal", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "cancel-owned",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "sleep 20 & wait",
        timeoutMs: 30_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      expect(shell.cancel(started.value.handle)).toMatchObject({ ok: true });
      const result = await complete(shell, started.value.handle);
      expect(result.cancelRequested).toBe(true);
      expect(result.exitSignal).toBe("SIGTERM");
      expect(result.groupCleanup).toBe("confirmed");
      expect(result.detachedCleanup).toBe("unverified");
    });

    it("waits for its owned process group during graceful connector shutdown", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "graceful-shutdown",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "sleep 20 & wait",
        timeoutMs: 30_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      expect(await shell.closeAndWait()).toBe("confirmed");
      const outcome = shell.read({
        handle: started.value.handle,
        stdoutOffset: 0,
        stderrOffset: 0,
      });
      expect(outcome).toMatchObject({
        ok: true,
        value: {
          state: "exited",
          groupCleanup: "confirmed",
          detachedCleanup: "unverified",
        },
      });
    });

    it("stops its running command when the initiating call is aborted", async () => {
      const { shell } = await fixture();
      const controller = new AbortController();
      const started = await shell.start(
        {
          operationId: "abort-running",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "sleep 20",
          timeoutMs: 30_000,
          write: false,
        },
        controller.signal,
      );
      if (!started.ok) throw new Error(started.error.code);
      controller.abort();
      const outcome = await complete(shell, started.value.handle);
      expect(outcome.cancelRequested).toBe(true);
      expect(outcome.groupCleanup).toBe("confirmed");
      expect(outcome.exitCode).toBeNull();
    });

    it("does not report cleanup while a detached descendant still runs", async () => {
      const { workspace, shell } = await fixture();
      const source = path.join(workspace, "detach-helper.c");
      const binary = path.join(workspace, "detach-helper");
      await fs.writeFile(
        source,
        [
          "#include <unistd.h>",
          "#include <fcntl.h>",
          "#include <stdio.h>",
          "#include <sys/types.h>",
          "int main(void) {",
          "  int gate[2]; if (pipe(gate) != 0) return 2;",
          "  pid_t child = fork(); if (child < 0) return 3;",
          "  if (child > 0) {",
          "    close(gate[0]);",
          '    FILE *file = fopen("detached.pid", "w");',
          "    if (!file) return 4;",
          '    fprintf(file, "%d", child);',
          "    if (fclose(file) != 0) return 5;",
          '    if (write(gate[1], "1", 1) != 1) return 6;',
          "    close(gate[1]); sleep(20); return 0;",
          "  }",
          "  close(gate[1]); char ready = 0;",
          "  if (read(gate[0], &ready, 1) != 1 || ready != '1') _exit(7);",
          "  close(gate[0]); if (setsid() < 0) _exit(8);",
          '  int nullfd = open("/dev/null", O_RDWR);',
          "  if (nullfd < 0) _exit(9);",
          "  for (int fd = 0; fd < 3; fd++) dup2(nullfd, fd);",
          "  close(nullfd); sleep(20); _exit(0);",
          "}",
        ].join("\n"),
      );
      execFileSync("/usr/bin/clang", ["-O0", "-o", binary, source]);
      let escapedPid: number | null = null;
      try {
        const started = await shell.start({
          operationId: "detached-cleanup",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "./detach-helper",
          timeoutMs: 30_000,
          write: true,
        });
        if (!started.ok) throw new Error(started.error.code);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const value = await fs
            .readFile(path.join(workspace, "detached.pid"), "utf8")
            .catch(() => null);
          if (value && /^[0-9]+$/u.test(value)) {
            escapedPid = Number(value);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (escapedPid === null) {
          throw new Error(
            `DETACHED_CHILD_NOT_STARTED:${JSON.stringify(
              shell.read({
                handle: started.value.handle,
                stdoutOffset: 0,
                stderrOffset: 0,
              }),
            )}`,
          );
        }
        shell.cancel(started.value.handle);
        const pending = shell.read({
          handle: started.value.handle,
          stdoutOffset: 0,
          stderrOffset: 0,
        });
        expect(pending).toMatchObject({
          ok: true,
          value: { groupCleanup: "pending", detachedCleanup: "unverified" },
        });
        let outcome;
        try {
          outcome = await complete(shell, started.value.handle);
        } catch {
          let childAlive = false;
          try {
            process.kill(escapedPid, 0);
            childAlive = true;
          } catch {
            // Child has exited.
          }
          throw new Error(
            `DETACHED_CANCEL_UNCONFIRMED:${childAlive}:${JSON.stringify(
              shell.read({
                handle: started.value.handle,
                stdoutOffset: 0,
                stderrOffset: 0,
              }),
            )}`,
          );
        }
        expect(outcome.groupCleanup).toBe("confirmed");
        expect(outcome.detachedCleanup).toBe("unverified");
        expect(() => process.kill(escapedPid!, 0)).not.toThrow();
      } finally {
        if (escapedPid !== null) {
          try {
            process.kill(escapedPid, "SIGKILL");
          } catch {
            // The child has already exited.
          }
          let stopped = false;
          for (let attempt = 0; attempt < 250; attempt += 1) {
            try {
              process.kill(escapedPid, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") {
                stopped = true;
                break;
              }
              throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!stopped)
            throw new Error("DETACHED_TEST_CHILD_CLEANUP_UNCONFIRMED");
        }
      }
    });

    it("can inspect its own shell process with lsof", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "self-process-inspection",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "/usr/sbin/lsof -p $$ -Fn",
        timeoutMs: 5_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/^p[0-9]+/u);
    });

    it("limits concurrent starts while four commands are still active", async () => {
      const { shell } = await fixture();
      const handles: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const started = await shell.start({
          operationId: `concurrent-${index}`,
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "sleep 20",
          timeoutMs: 30_000,
          write: false,
        });
        if (!started.ok) throw new Error(started.error.code);
        handles.push(started.value.handle);
      }
      expect(
        await shell.start({
          operationId: "concurrent-fifth",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "printf fifth",
          timeoutMs: 5_000,
          write: false,
        }),
      ).toMatchObject({ ok: false, error: { code: "SHELL_BUSY" } });
      for (const handle of handles) shell.cancel(handle);
      for (const handle of handles) {
        const outcome = await complete(shell, handle);
        expect(outcome.cancelRequested).toBe(true);
        expect(outcome.groupCleanup).toBe("confirmed");
      }
    });

    it("enforces a command deadline and reports the actual signal", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "command-deadline",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "sleep 20",
        timeoutMs: 100,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const timed = await complete(shell, started.value.handle);
      expect(timed.timedOut).toBe(true);
      expect(timed.authorityExpired).toBe(false);
      expect(timed.exitSignal).toBe("SIGTERM");
      expect(timed.groupCleanup).toBe("confirmed");
    });

    it("classifies an authority deadline separately from a command timeout", async () => {
      const { root, approval, participant } = await fixture(
        "workspace",
        false,
        "workspace",
        false,
        Date.now() + 1_000,
      );
      const almostExpired = new SandboxedWorkspaceShell(
        approval,
        participant,
        binding,
        path.join(root, "authority-deadline-private"),
      );
      shells.push(almostExpired);
      const started = await almostExpired.start({
        operationId: "authority-deadline",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "sleep 20",
        timeoutMs: 30_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const outcome = await complete(almostExpired, started.value.handle);
      expect(outcome.authorityExpired).toBe(true);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.groupCleanup).toBe("confirmed");
    });

    it("bounds a fast producer before IPC output can grow without limit", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "bounded-output",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "yes A | head -c 6000000",
        timeoutMs: 10_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.stdoutBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(result.outputLimitReached).toBe(true);
    });

    it("applies one combined cap to stdout and stderr", async () => {
      const { shell } = await fixture();
      const started = await shell.start({
        operationId: "combined-output-cap",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "yes A | head -c 2400000; yes B | head -c 2400000 >&2",
        timeoutMs: 10_000,
        write: false,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.stdoutBytes + result.stderrBytes).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      expect(result.outputLimitReached).toBe(true);
    });

    it("denies writes in read mode and denies even loopback network", async () => {
      const { workspace, shell } = await fixture();
      const listener = net.createServer();
      let accepted = 0;
      listener.on("connection", (socket) => {
        accepted += 1;
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
      });
      await new Promise<void>((resolve) =>
        listener.listen(0, "127.0.0.1", resolve),
      );
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("TEST_LISTENER_INVALID");
      try {
        const started = await shell.start({
          operationId: "read-only-network",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: `printf forbidden > forbidden.txt; /usr/bin/curl --max-time 2 -sS http://127.0.0.1:${address.port}`,
          timeoutMs: 5_000,
          write: false,
        });
        if (!started.ok) throw new Error(started.error.code);
        const result = await complete(shell, started.value.handle);
        expect(result.exitCode).not.toBe(0);
        await expect(
          fs.stat(path.join(workspace, "forbidden.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(accepted).toBe(0);
      } finally {
        listener.close();
      }
    });

    it("returns outcome unknown after a lost process-local handle, never repeats the command", async () => {
      const { root, workspace, shell } = await fixture();
      const input = {
        operationId: "lost-handle",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "printf once >> count.txt",
        timeoutMs: 5_000,
        write: true,
      };
      const started = await shell.start(input);
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.exitCode).toBe(0);
      const identity = await fs.lstat(workspace, { bigint: true });
      const approval: ComputerApproval = {
        ownerId: binding.ownerId,
        computerId: "computer-test",
        generation: 1,
        workspaces: [
          {
            workspaceId: "fixture",
            root: workspace,
            access: "write",
            rootIdentity: {
              device: String(identity.dev),
              inode: String(identity.ino),
            },
            shellVerified: true,
          },
        ],
        capabilities: ["workspace.shell", "workspace.write"],
        network: "none",
        commands: "workspace",
        expiresAt: Date.now() + 60_000,
      };
      const grant = deriveTaskGrant(
        approval,
        {
          authorityId: "restart-test",
          ...binding,
          computerId: approval.computerId,
          computerGeneration: approval.generation,
          workspaces: [
            {
              workspaceId: "fixture",
              mode: "subtree",
              root: workspace,
              access: "write",
            },
          ],
          capabilities: approval.capabilities,
          network: "none",
          commands: "workspace",
          expiresAt: approval.expiresAt,
        },
        Date.now(),
      );
      if (!grant.ok) throw new Error(grant.error.code);
      const participant = createParticipantAuthority(grant.value, {
        participantId: "main-test",
        role: "main",
        mutationOwnership: "task",
      });
      if (!participant.ok) throw new Error(participant.error.code);
      const resumed = new SandboxedWorkspaceShell(
        approval,
        participant.value,
        binding,
        path.join(root, "private"),
      );
      shells.push(resumed);
      expect(await resumed.start(input)).toMatchObject({
        ok: false,
        error: { code: "SHELL_OUTCOME_UNKNOWN" },
      });
      expect(await fs.readFile(path.join(workspace, "count.txt"), "utf8")).toBe(
        "once",
      );

      const otherBinding = { ...binding, taskId: "other-task" };
      const otherGrant = deriveTaskGrant(
        approval,
        {
          authorityId: "other-task-test",
          ...otherBinding,
          computerId: approval.computerId,
          computerGeneration: approval.generation,
          workspaces: [
            {
              workspaceId: "fixture",
              mode: "subtree",
              root: workspace,
              access: "write",
            },
          ],
          capabilities: approval.capabilities,
          network: "none",
          commands: "workspace",
          expiresAt: approval.expiresAt,
        },
        Date.now(),
      );
      if (!otherGrant.ok) throw new Error(otherGrant.error.code);
      const otherParticipant = createParticipantAuthority(otherGrant.value, {
        participantId: "other-task-test",
        role: "main",
        mutationOwnership: "task",
      });
      if (!otherParticipant.ok) throw new Error(otherParticipant.error.code);
      const otherTask = new SandboxedWorkspaceShell(
        approval,
        otherParticipant.value,
        otherBinding,
        path.join(root, "private"),
      );
      shells.push(otherTask);
      expect(await otherTask.start(input)).toMatchObject({
        ok: false,
        error: { code: "SHELL_OUTCOME_UNKNOWN" },
      });
      expect(await fs.readFile(path.join(workspace, "count.txt"), "utf8")).toBe(
        "once",
      );
      const independent = await otherTask.start({
        ...input,
        operationId: "other-task-new-operation",
      });
      if (!independent.ok) throw new Error(independent.error.code);
      expect(
        (await complete(otherTask, independent.value.handle)).exitCode,
      ).toBe(0);
      expect(await fs.readFile(path.join(workspace, "count.txt"), "utf8")).toBe(
        "onceonce",
      );
    });

    it("runs ordinary Git in a registered linked worktree", async () => {
      const { workspace, shell } = await fixture(
        "workspace",
        true,
        "workspace",
        true,
      );
      const before = execFileSync(
        "git",
        ["-C", workspace, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      const started = await shell.start({
        operationId: "linked-commit",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          "printf linked > linked.txt && git add -- linked.txt && git -c user.name=Test -c user.email=test@example.invalid commit -qm linked && git status --short",
        timeoutMs: 10_000,
        write: true,
      });
      if (!started.ok) throw new Error(started.error.code);
      const result = await complete(shell, started.value.handle);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(
        execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).not.toBe(before);
      expect(
        await fs.readFile(path.join(workspace, "linked.txt"), "utf8"),
      ).toBe("linked");
    });

    it("refuses a linked worktree whose Git pointer changed after approval", async () => {
      const { workspace, shell } = await fixture(
        "workspace",
        true,
        "workspace",
        true,
      );
      await fs.writeFile(
        path.join(workspace, ".git"),
        "gitdir: /private/tmp/other-repository\n",
      );
      expect(
        await shell.start({
          operationId: "changed-git-pointer",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "git status --short",
          timeoutMs: 5_000,
          write: false,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: "SHELL_GIT_METADATA_CHANGED" },
      });
    });

    it("serves shell start and result through the Computer MCP adapter", async () => {
      const { shell } = await fixture();
      const server = createReadonlyComputerMcpServer(
        {
          async execute(): Promise<never> {
            throw new Error("unused");
          },
        },
        {
          ...binding,
          participantId: "main-test",
          turnId: "turn-test",
          generation: 1,
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        shell,
      );
      const client = new Client({ name: "shell-fixture", version: "1.0.0" });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      try {
        const catalogue = await client.listTools();
        expect(catalogue.tools.map((tool) => tool.name)).toContain(
          "computer_shell_start",
        );
        const started = await client.callTool({
          name: "computer_shell_start",
          arguments: {
            operationId: "mcp-command",
            workspaceId: "fixture",
            relativeCwd: ".",
            command: "printf mcp-route",
            timeoutMs: 5_000,
            write: false,
          },
        });
        expect(started.isError).not.toBe(true);
        const handle = (
          started.structuredContent as { value: { handle: string } }
        ).value.handle;
        await complete(shell, handle);
        const read = await client.callTool({
          name: "computer_shell_read",
          arguments: { handle, stdoutOffset: 0, stderrOffset: 0 },
        });
        expect(read.structuredContent).toMatchObject({
          ok: true,
          value: { state: "exited", exitCode: 0, stdout: "mcp-route" },
        });
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    });

    it("keeps owned shell cancellation available while the fence blocks reads and starts", async () => {
      const { shell } = await fixture();
      let phase: "open" | "fenced" | "unreadable" = "open";
      const server = createReadonlyComputerMcpServer(
        {
          async execute(): Promise<never> {
            throw new Error("unused");
          },
        },
        {
          ...binding,
          participantId: "main-test",
          turnId: "turn-test",
          generation: 1,
        },
        undefined,
        undefined,
        undefined,
        {
          admits: async () => {
            if (phase === "unreadable") throw new Error("unreadable fence");
            return phase === "fenced"
              ? {
                  admitted: false as const,
                  code: "COMPUTER_SUMMARY_PHASE_ACTIVE" as const,
                }
              : { admitted: true as const };
          },
        },
        undefined,
        undefined,
        shell,
      );
      const client = new Client({
        name: "shell-fence-fixture",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      try {
        const started = await client.callTool({
          name: "computer_shell_start",
          arguments: {
            operationId: "fence-running",
            workspaceId: "fixture",
            relativeCwd: ".",
            command: "printf secret-before-fence; sleep 20",
            timeoutMs: 30_000,
            write: false,
          },
        });
        const handle = (
          started.structuredContent as { value: { handle: string } }
        ).value.handle;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const output = shell.read({
            handle,
            stdoutOffset: 0,
            stderrOffset: 0,
          });
          if (output.ok && output.value.stdout.includes("secret-before-fence"))
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(
          shell.read({ handle, stdoutOffset: 0, stderrOffset: 0 }),
        ).toMatchObject({
          ok: true,
          value: { stdout: "secret-before-fence" },
        });
        phase = "fenced";
        const denied = await client.callTool({
          name: "computer_shell_start",
          arguments: {
            operationId: "fence-denied",
            workspaceId: "fixture",
            relativeCwd: ".",
            command: "printf forbidden",
            timeoutMs: 5_000,
            write: false,
          },
        });
        expect(denied.structuredContent).toMatchObject({
          ok: false,
          error: { code: "COMPUTER_SUMMARY_PHASE_ACTIVE" },
        });
        const cancelled = await client.callTool({
          name: "computer_shell_cancel",
          arguments: { handle },
        });
        expect(cancelled.structuredContent).toMatchObject({
          ok: true,
          value: { stdout: "", stderr: "", stdoutBase64: "", stderrBase64: "" },
        });
        expect(JSON.stringify(cancelled.structuredContent)).not.toContain(
          "secret-before-fence",
        );
        expect(JSON.stringify(cancelled.content)).not.toContain(
          "secret-before-fence",
        );
        await complete(shell, handle);
        phase = "unreadable";
        const read = await client.callTool({
          name: "computer_shell_read",
          arguments: { handle, stdoutOffset: 0, stderrOffset: 0 },
        });
        expect(read.structuredContent).toMatchObject({
          ok: false,
          error: { code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" },
        });
        phase = "open";
        const afterFence = await client.callTool({
          name: "computer_shell_read",
          arguments: { handle, stdoutOffset: 0, stderrOffset: 0 },
        });
        expect(afterFence.structuredContent).toMatchObject({
          ok: true,
          value: {
            state: "exited",
            cancelRequested: true,
            groupCleanup: "confirmed",
            stdout: "secret-before-fence",
          },
        });
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    });

    it("rechecks the execution fence after shell reservation and before dispatch", async () => {
      const { shell, workspace } = await fixture();
      let admissions = 0;
      const server = createReadonlyComputerMcpServer(
        {
          async execute(): Promise<never> {
            throw new Error("unused");
          },
        },
        {
          ...binding,
          participantId: "main-test",
          turnId: "turn-test",
          generation: 1,
        },
        undefined,
        undefined,
        undefined,
        {
          admits: async () =>
            ++admissions === 2
              ? {
                  admitted: false as const,
                  code: "COMPUTER_SUMMARY_PHASE_ACTIVE" as const,
                }
              : { admitted: true as const },
        },
        undefined,
        undefined,
        shell,
      );
      const client = new Client({
        name: "shell-dispatch-fence",
        version: "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const request = {
        name: "computer_shell_start",
        arguments: {
          operationId: "late-fence",
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "printf forbidden > late-fence.txt",
          timeoutMs: 5_000,
          write: true,
        },
      };
      try {
        const refused = await client.callTool(request);
        expect(admissions).toBe(2);
        expect(refused.structuredContent).toMatchObject({
          ok: false,
          error: { code: "SHELL_DISPATCH_FENCED" },
        });
        expect(
          (await client.callTool(request)).structuredContent,
        ).toMatchObject({
          ok: false,
          error: { code: "SHELL_OUTCOME_UNKNOWN" },
        });
        await expect(
          fs.stat(path.join(workspace, "late-fence.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await Promise.all([client.close(), server.close()]);
      }
    });

    it("uses an ordinary Brain-shaped workspace and preserves a failing Git hook", async () => {
      const { workspace, shell } = await fixture(
        "workspace",
        false,
        "brain",
        true,
      );
      execFileSync("git", ["init", "-q", workspace]);
      const hook = path.join(workspace, ".git", "hooks", "pre-commit");
      await fs.writeFile(hook, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
      const started = await shell.start({
        operationId: "brain-hook",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          "printf draft > draft.md && mv draft.md daily.md && git add -- daily.md && git -c user.name=Test -c user.email=test@example.invalid commit -qm 'ordinary note'",
        timeoutMs: 10_000,
        write: true,
      });
      if (!started.ok) throw new Error(started.error.code);
      const failed = await complete(shell, started.value.handle);
      expect(failed.exitCode).toBe(1);
      expect(await fs.readFile(path.join(workspace, "daily.md"), "utf8")).toBe(
        "draft",
      );
      expect(() =>
        execFileSync(
          "git",
          ["-C", workspace, "rev-parse", "--verify", "HEAD"],
          {
            stdio: "ignore",
          },
        ),
      ).toThrow();

      const removed = await shell.start({
        operationId: "brain-remove",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "rm -- daily.md",
        timeoutMs: 5_000,
        write: true,
      });
      if (!removed.ok) throw new Error(removed.error.code);
      expect((await complete(shell, removed.value.handle)).exitCode).toBe(0);
      await expect(
        fs.stat(path.join(workspace, "daily.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
