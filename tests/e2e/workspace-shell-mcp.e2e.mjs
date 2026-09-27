import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packaged = process.argv[2] === "--packaged";
if (process.argv.length > (packaged ? 3 : 2)) {
  throw new Error("WORKSPACE_SHELL_MCP_E2E_ARGUMENTS_INVALID");
}
const packageRoot = path.resolve("_output/package/Farol Next Preview.app");
const entry = packaged
  ? path.join(packageRoot, "Contents/Resources/app/computer-mcp.cjs")
  : path.resolve("_output/build/app/computer-mcp.cjs");
const executable = packaged
  ? path.join(
      packageRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : process.execPath;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const ownedConnectorPids = new Set();
const unverifiedConnectorShutdowns = new Set();
const connectorExits = new Map();
const ownedShellPids = new Set();
const unverifiedShellHandles = new Set();
const unknownShellStarts = new Set();
let allCasesPassed = false;

class TrackedStdioClientTransport extends StdioClientTransport {
  constructor(parameters, onSpawn) {
    super(parameters);
    this.onSpawn = onSpawn;
  }

  async start() {
    await super.start();
    const pid = this.pid;
    assert.ok(
      Number.isSafeInteger(pid) && pid > 1,
      "MCP_PROCESS_ID_UNVERIFIED",
    );
    // The installed stdio transport owns this exact child. Observe its exit
    // event directly; PID disappearance alone cannot distinguish graceful
    // shutdown from the transport's TERM/KILL escalation.
    const child = this._process;
    assert.equal(child?.pid, pid, "MCP_OWNED_CHILD_HANDLE_UNVERIFIED");
    connectorExits.set(
      pid,
      new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
        }
      }),
    );
    this.onSpawn(pid);
  }
}

async function connectorExit(pid) {
  const observed = connectorExits.get(pid);
  if (!observed) return null;
  let timer;
  try {
    return await Promise.race([
      observed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitPidGone(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function connect(launchFile, onSpawn = () => {}) {
  let launchedPid = null;
  const transport = new TrackedStdioClientTransport(
    {
      command: executable,
      args: [entry, "--launch-contract", launchFile],
      cwd: process.cwd(),
      stderr: "pipe",
      ...(packaged
        ? {
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              HOME: process.env.HOME ?? os.homedir(),
              PATH: process.env.PATH ?? "/usr/bin:/bin",
              TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
            },
          }
        : {}),
    },
    (pid) => {
      launchedPid = pid;
      ownedConnectorPids.add(pid);
      unverifiedConnectorShutdowns.add(pid);
      onSpawn(pid);
    },
  );
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "farol-shell-e2e", version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    let closed = false;
    try {
      await client.close();
      closed = true;
    } catch {
      // Keep shutdown unverified when the transport close also fails.
    }
    if (launchedPid !== null && (await waitPidGone(launchedPid))) {
      ownedConnectorPids.delete(launchedPid);
      const exit = await connectorExit(launchedPid);
      if (closed && exit?.signal === null) {
        unverifiedConnectorShutdowns.delete(launchedPid);
      }
    }
    throw error;
  }
  if (launchedPid === null) {
    await client.close().catch(() => undefined);
    throw new Error("MCP_PROCESS_ID_UNVERIFIED");
  }
  return { client, pid: launchedPid, stderr: () => stderr };
}

async function disconnect(connection) {
  let closeError = null;
  try {
    await connection.client.close();
  } catch (error) {
    closeError = error;
  }
  assert.equal(
    await waitPidGone(connection.pid),
    true,
    `MCP_OWNED_PROCESS_SURVIVED_CLOSE:${connection.pid}`,
  );
  ownedConnectorPids.delete(connection.pid);
  if (closeError) throw closeError;
  assert.equal(connection.stderr(), "");
  assert.deepEqual(await connectorExit(connection.pid), {
    code: 0,
    signal: null,
  });
  unverifiedConnectorShutdowns.delete(connection.pid);
}

async function startShell(client, arguments_) {
  const operationId = arguments_.operationId;
  unknownShellStarts.add(operationId);
  const result = await client.callTool({
    name: "computer_shell_start",
    arguments: arguments_,
  });
  const handle = result.structuredContent?.value?.handle;
  if (typeof handle === "string" && handle.length > 0) {
    unknownShellStarts.delete(operationId);
    unverifiedShellHandles.add(handle);
  }
  return result;
}

async function complete(client, handle) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.callTool({
      name: "computer_shell_read",
      arguments: { handle, stdoutOffset: 0, stderrOffset: 0 },
    });
    if (result.structuredContent?.value?.state === "exited") {
      const outcome = result.structuredContent.value;
      if (outcome.groupCleanup === "confirmed") {
        unverifiedShellHandles.delete(handle);
      }
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("WORKSPACE_SHELL_MCP_E2E_TIMEOUT");
}

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-shell-mcp-e2e-")),
);
try {
  const launchRoot = path.join(root, "launch");
  const workspaceRoot = path.join(root, "workspace");
  await fs.chmod(root, 0o700);
  await fs.mkdir(launchRoot, { mode: 0o700 });
  await fs.mkdir(workspaceRoot, { mode: 0o700 });
  await fs.writeFile(path.join(workspaceRoot, "input.txt"), "source\n");
  await fs.writeFile(path.join(root, "outside.txt"), "OUTSIDE_SECRET_CANARY\n");
  execFileSync("git", ["init", "-q", workspaceRoot]);
  await fs.writeFile(
    path.join(workspaceRoot, "history.txt"),
    "HISTORY_SECRET_CANARY\n",
  );
  execFileSync("git", ["-C", workspaceRoot, "add", "history.txt"]);
  execFileSync("git", [
    "-C",
    workspaceRoot,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "history",
  ]);
  await fs.rm(path.join(workspaceRoot, "history.txt"));
  const stat = await fs.lstat(workspaceRoot, { bigint: true });
  const approval = {
    ownerId: "owner-e2e",
    computerId: "computer-e2e",
    generation: 9,
    workspaces: [
      {
        workspaceId: "fixture",
        root: workspaceRoot,
        access: "write",
        rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
        shellVerified: true,
      },
    ],
    capabilities: ["workspace.shell", "workspace.write"],
    network: "none",
    commands: "workspace",
    expiresAt: Date.now() + 60_000,
  };
  const launch = {
    schema: 2,
    approval,
    admission: {
      authorityId: "authority-e2e",
      ownerId: approval.ownerId,
      sessionId: "session-e2e",
      taskId: "task-e2e",
      taskEpoch: 4,
      computerId: approval.computerId,
      computerGeneration: approval.generation,
      workspaces: [
        {
          workspaceId: "fixture",
          mode: "subtree",
          root: workspaceRoot,
          access: "write",
        },
      ],
      capabilities: approval.capabilities,
      network: "none",
      commands: "workspace",
      expiresAt: Date.now() + 30_000,
    },
    delegationChain: [
      { participantId: "main-e2e", role: "main", mutationOwnership: "task" },
    ],
    binding: { participantId: "main-e2e", turnId: "turn-e2e", generation: 5 },
  };
  const launchFile = path.join(launchRoot, "computer-launch.json");
  await fs.writeFile(launchFile, `${canonical(launch)}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  const failedLaunchFile = path.join(launchRoot, "invalid-launch.json");
  await fs.writeFile(failedLaunchFile, "{invalid", { mode: 0o600, flag: "wx" });
  let failedLaunchPid = null;
  await assert.rejects(
    connect(failedLaunchFile, (pid) => {
      failedLaunchPid = pid;
    }),
  );
  assert.ok(Number.isSafeInteger(failedLaunchPid) && failedLaunchPid > 1);
  assert.equal(await waitPidGone(failedLaunchPid), true);
  assert.equal(ownedConnectorPids.size, 0);
  assert.equal(unverifiedConnectorShutdowns.size, 0);

  const first = await connect(launchFile);
  try {
    const tools = await first.client.listTools();
    assert.deepEqual(
      tools.tools
        .filter((tool) => tool.name.startsWith("computer_shell_"))
        .map((tool) => tool.name),
      ["computer_shell_start", "computer_shell_read", "computer_shell_cancel"],
    );
    const started = await startShell(first.client, {
      operationId: "packaged-shell-once",
      workspaceId: "fixture",
      relativeCwd: ".",
      command:
        "cat input.txt && mv input.txt moved.txt && printf created > created.txt && rm moved.txt",
      timeoutMs: 5_000,
      write: true,
    });
    assert.equal(started.isError, undefined);
    const result = await complete(
      first.client,
      started.structuredContent.value.handle,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.groupCleanup, "confirmed");
    assert.equal(result.detachedCleanup, "unverified");
    assert.equal(result.stdout, "source\n");
    assert.equal(
      await fs.readFile(path.join(workspaceRoot, "created.txt"), "utf8"),
      "created",
    );
    await assert.rejects(fs.stat(path.join(workspaceRoot, "moved.txt")), {
      code: "ENOENT",
    });

    const longStarted = await startShell(first.client, {
      operationId: "packaged-shell-long-result",
      workspaceId: "fixture",
      relativeCwd: ".",
      command:
        'printf "owned-long=%s early\\n" "$$"; sleep 2; printf "late\\n"',
      timeoutMs: 5_000,
      write: false,
    });
    assert.equal(longStarted.isError, undefined);
    const longHandle = longStarted.structuredContent.value.handle;
    let early = null;
    let longPid = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const read = await first.client.callTool({
        name: "computer_shell_read",
        arguments: { handle: longHandle, stdoutOffset: 0, stderrOffset: 0 },
      });
      const value = read.structuredContent?.value;
      const marker = /^owned-long=(\d+) early\n/u.exec(value?.stdout ?? "");
      if (marker) {
        longPid = Number(marker[1]);
        assert.ok(Number.isSafeInteger(longPid) && longPid > 1);
        ownedShellPids.add(longPid);
        early = value;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(early, "SHELL_EARLY_OUTPUT_MISSING");
    assert.equal(early.state, "running");
    const longResult = await complete(first.client, longHandle);
    assert.equal(longResult.exitCode, 0, longResult.stderr);
    assert.equal(longResult.exitSignal, null);
    assert.equal(longResult.groupCleanup, "confirmed");
    assert.equal(longResult.stdout, `owned-long=${longPid} early\nlate\n`);
    assert.equal(await waitPidGone(longPid), true);

    const cancellable = await startShell(first.client, {
      operationId: "packaged-shell-cancel-child",
      workspaceId: "fixture",
      relativeCwd: ".",
      command:
        'sleep 20 & child=$!; printf "owned-shell=%s owned-child=%s\\n" "$$" "$child"; wait',
      timeoutMs: 30_000,
      write: false,
    });
    assert.equal(cancellable.isError, undefined);
    const cancelHandle = cancellable.structuredContent.value.handle;
    let cancellationSent = false;
    try {
      let owned = null;
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const read = await first.client.callTool({
          name: "computer_shell_read",
          arguments: {
            handle: cancelHandle,
            stdoutOffset: 0,
            stderrOffset: 0,
          },
        });
        owned = /^owned-shell=(\d+) owned-child=(\d+)\n/u.exec(
          read.structuredContent?.value?.stdout ?? "",
        );
        if (owned) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(owned, "SHELL_OWNED_PIDS_MISSING");
      const shellPid = Number(owned[1]);
      const childPid = Number(owned[2]);
      assert.ok(shellPid > 1 && childPid > 1 && shellPid !== childPid);
      ownedShellPids.add(shellPid);
      ownedShellPids.add(childPid);
      assert.doesNotThrow(() => process.kill(shellPid, 0));
      assert.doesNotThrow(() => process.kill(childPid, 0));
      const cancelled = await first.client.callTool({
        name: "computer_shell_cancel",
        arguments: { handle: cancelHandle },
      });
      cancellationSent = true;
      assert.equal(cancelled.isError, undefined);
      const stopped = await complete(first.client, cancelHandle);
      assert.equal(stopped.cancelRequested, true);
      assert.equal(stopped.exitSignal, "SIGTERM");
      assert.equal(stopped.groupCleanup, "confirmed");
      assert.equal(stopped.detachedCleanup, "unverified");
      assert.equal(await waitPidGone(shellPid), true);
      assert.equal(await waitPidGone(childPid), true);
    } finally {
      if (!cancellationSent) {
        await first.client
          .callTool({
            name: "computer_shell_cancel",
            arguments: { handle: cancelHandle },
          })
          .catch(() => undefined);
      }
    }

    const denied = await startShell(first.client, {
      operationId: "packaged-shell-deny",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "cat ../outside.txt",
      timeoutMs: 5_000,
      write: false,
    });
    assert.equal(denied.isError, undefined);
    const denial = await complete(
      first.client,
      denied.structuredContent.value.handle,
    );
    assert.notEqual(denial.exitCode, 0);
    assert.equal(denial.stdout.includes("OUTSIDE_SECRET_CANARY"), false);

    const history = await startShell(first.client, {
      operationId: "packaged-history-deny",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "git show HEAD:history.txt",
      timeoutMs: 5_000,
      write: false,
    });
    assert.equal(history.isError, undefined);
    const historyDenied = await complete(
      first.client,
      history.structuredContent.value.handle,
    );
    assert.notEqual(historyDenied.exitCode, 0);
    assert.equal(historyDenied.stdout.includes("HISTORY_SECRET_CANARY"), false);
  } finally {
    await disconnect(first);
  }

  // A new connector generation creates new synthetic session/task IDs while
  // retaining the same private launch root. The old operation must not run.
  const restartedLaunch = {
    ...launch,
    admission: {
      ...launch.admission,
      sessionId: "session-e2e-restarted",
      taskId: "task-e2e-restarted",
    },
    binding: { ...launch.binding, turnId: "turn-e2e-restarted" },
  };
  await fs.writeFile(launchFile, `${canonical(restartedLaunch)}\n`, {
    mode: 0o600,
  });
  const restarted = await connect(launchFile);
  try {
    const repeated = await startShell(restarted.client, {
      operationId: "packaged-shell-once",
      workspaceId: "fixture",
      relativeCwd: ".",
      command:
        "cat input.txt && mv input.txt moved.txt && printf created > created.txt && rm moved.txt",
      timeoutMs: 5_000,
      write: true,
    });
    assert.equal(repeated.isError, true);
    assert.equal(
      repeated.structuredContent?.error?.code,
      "SHELL_OUTCOME_UNKNOWN",
    );
    unknownShellStarts.delete("packaged-shell-once");
  } finally {
    await disconnect(restarted);
  }

  const historyLaunchRoot = path.join(root, "history-launch");
  await fs.mkdir(historyLaunchRoot, { mode: 0o700 });
  const historyLaunchFile = path.join(
    historyLaunchRoot,
    "computer-launch.json",
  );
  const historyLaunch = {
    ...launch,
    approval: {
      ...launch.approval,
      workspaces: launch.approval.workspaces.map((workspace) => ({
        ...workspace,
        gitHistoryApproved: true,
      })),
    },
  };
  await fs.writeFile(historyLaunchFile, `${canonical(historyLaunch)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const approved = await connect(historyLaunchFile);
  try {
    const history = await startShell(approved.client, {
      operationId: "packaged-history-approved",
      workspaceId: "fixture",
      relativeCwd: ".",
      command: "git show HEAD:history.txt",
      timeoutMs: 5_000,
      write: false,
    });
    assert.equal(history.isError, undefined);
    const observed = await complete(
      approved.client,
      history.structuredContent.value.handle,
    );
    assert.equal(observed.exitCode, 0, observed.stderr);
    assert.equal(observed.stdout, "HISTORY_SECRET_CANARY\n");

    // The sealed Computer route must run ordinary Git against approved
    // metadata. A path-scoped commit may not consume another task's index.
    await fs.writeFile(path.join(workspaceRoot, "foreign.txt"), "foreign\n");
    await fs.writeFile(path.join(workspaceRoot, "own.txt"), "own\n");
    execFileSync("git", ["-C", workspaceRoot, "add", "--", "foreign.txt"]);
    const workflow = await startShell(approved.client, {
      operationId: "packaged-ordinary-git-workflow",
      workspaceId: "fixture",
      relativeCwd: ".",
      command:
        "git status --short && git add -- own.txt && git -c user.name=Test -c user.email=test@example.invalid commit -qm own -- own.txt && git status --short",
      timeoutMs: 10_000,
      write: true,
    });
    assert.equal(workflow.isError, undefined);
    const gitResult = await complete(
      approved.client,
      workflow.structuredContent.value.handle,
    );
    assert.equal(gitResult.exitCode, 0, gitResult.stderr);
    assert.equal(gitResult.groupCleanup, "confirmed");
    assert.equal(
      execFileSync("git", ["-C", workspaceRoot, "show", "HEAD:own.txt"], {
        encoding: "utf8",
      }),
      "own\n",
    );
    assert.equal(
      execFileSync(
        "git",
        ["-C", workspaceRoot, "diff", "--cached", "--name-only"],
        {
          encoding: "utf8",
        },
      ),
      "foreign.txt\n",
    );
    assert.equal(
      execFileSync(
        "git",
        ["-C", workspaceRoot, "status", "--porcelain", "--", "own.txt"],
        {
          encoding: "utf8",
        },
      ),
      "",
    );
  } finally {
    await disconnect(approved);
  }

  // A linked writer needs both its own Git directory and the common object
  // directory. The grant is explicit for this physical worktree identity.
  const linkedRoot = path.join(root, "linked-writer");
  execFileSync("git", [
    "-C",
    workspaceRoot,
    "worktree",
    "add",
    "-qb",
    "package-linked",
    linkedRoot,
  ]);
  const linkedInfo = await fs.lstat(linkedRoot, { bigint: true });
  const gitMetadata = {
    gitDirectory: execFileSync(
      "git",
      ["-C", linkedRoot, "rev-parse", "--path-format=absolute", "--git-dir"],
      { encoding: "utf8" },
    ).trim(),
    commonDirectory: execFileSync(
      "git",
      [
        "-C",
        linkedRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim(),
  };
  const linkedWorkspace = {
    workspaceId: "linked",
    root: linkedRoot,
    access: "write",
    rootIdentity: {
      device: String(linkedInfo.dev),
      inode: String(linkedInfo.ino),
    },
    shellVerified: true,
    gitHistoryApproved: true,
    gitMetadata,
  };
  const linkedLaunch = {
    ...launch,
    approval: {
      ...approval,
      computerId: "computer-linked-e2e",
      workspaces: [linkedWorkspace],
    },
    admission: {
      ...launch.admission,
      computerId: "computer-linked-e2e",
      workspaces: [
        {
          workspaceId: "linked",
          mode: "subtree",
          root: linkedRoot,
          access: "write",
        },
      ],
    },
  };
  const linkedLaunchRoot = path.join(root, "linked-launch");
  await fs.mkdir(linkedLaunchRoot, { mode: 0o700 });
  const linkedLaunchFile = path.join(linkedLaunchRoot, "computer-launch.json");
  await fs.writeFile(linkedLaunchFile, `${canonical(linkedLaunch)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const linked = await connect(linkedLaunchFile);
  try {
    const started = await startShell(linked.client, {
      operationId: "packaged-linked-git-workflow",
      workspaceId: "linked",
      relativeCwd: ".",
      command:
        "printf linked > linked.txt && git add -- linked.txt && git -c user.name=Test -c user.email=test@example.invalid commit -qm linked -- linked.txt && git rev-parse --short HEAD",
      timeoutMs: 10_000,
      write: true,
    });
    assert.equal(started.isError, undefined);
    const result = await complete(
      linked.client,
      started.structuredContent.value.handle,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.groupCleanup, "confirmed");
    assert.equal(
      execFileSync("git", ["-C", linkedRoot, "show", "HEAD:linked.txt"], {
        encoding: "utf8",
      }),
      "linked",
    );
    assert.equal(
      execFileSync(
        "git",
        ["-C", workspaceRoot, "diff", "--cached", "--name-only"],
        {
          encoding: "utf8",
        },
      ),
      "foreign.txt\n",
    );
  } finally {
    await disconnect(linked);
  }
  allCasesPassed = true;
} finally {
  const unverifiedPids = [];
  for (const pid of ownedShellPids) {
    let gone = false;
    try {
      gone = await waitPidGone(pid);
    } catch {
      // A failed process probe is not evidence of cleanup.
    }
    if (!gone) unverifiedPids.push(pid);
  }
  const cleanupUnverified =
    ownedConnectorPids.size > 0 ||
    unverifiedConnectorShutdowns.size > 0 ||
    unverifiedPids.length > 0 ||
    unverifiedShellHandles.size > 0 ||
    unknownShellStarts.size > 0;
  if (cleanupUnverified) {
    const details = {
      root,
      connectorPids: [...ownedConnectorPids],
      unverifiedConnectorShutdowns: [...unverifiedConnectorShutdowns],
      unverifiedPids,
      unverifiedHandles: [...unverifiedShellHandles],
      unknownStarts: [...unknownShellStarts],
    };
    process.stderr.write(
      `MCP_OWNED_CLEANUP_UNVERIFIED:${JSON.stringify(details)}\n`,
    );
    if (allCasesPassed) throw new Error("MCP_OWNED_CLEANUP_UNVERIFIED");
  } else {
    await fs.rm(root, { recursive: true, force: true });
  }
}
