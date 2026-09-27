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
    expiresAt: Date.now() + 60_000,
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
          timeoutMs: 30_000,
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

    it("enforces the deadline from the watchdog and limits concurrent starts", async () => {
      const { shell } = await fixture();
      const handles: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        const started = await shell.start({
          operationId: `concurrent-${index}`,
          workspaceId: "fixture",
          relativeCwd: ".",
          command: "sleep 20",
          timeoutMs: index === 0 ? 100 : 30_000,
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
      const timed = await complete(shell, handles[0]!);
      expect(timed.timedOut).toBe(true);
      expect(timed.exitSignal).toBe("SIGTERM");
      for (const handle of handles.slice(1)) shell.cancel(handle);
      for (const handle of handles.slice(1)) {
        expect((await complete(shell, handle)).cancelRequested).toBe(true);
      }
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
