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

async function connect(launchFile) {
  const transport = new StdioClientTransport({
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
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "farol-shell-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

async function complete(client, handle) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const result = await client.callTool({
      name: "computer_shell_read",
      arguments: { handle, stdoutOffset: 0, stderrOffset: 0 },
    });
    if (result.structuredContent?.value?.state === "exited") {
      return result.structuredContent.value;
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

  const first = await connect(launchFile);
  try {
    const tools = await first.client.listTools();
    assert.deepEqual(
      tools.tools
        .filter((tool) => tool.name.startsWith("computer_shell_"))
        .map((tool) => tool.name),
      ["computer_shell_start", "computer_shell_read", "computer_shell_cancel"],
    );
    const started = await first.client.callTool({
      name: "computer_shell_start",
      arguments: {
        operationId: "packaged-shell-once",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          "cat input.txt && mv input.txt moved.txt && printf created > created.txt && rm moved.txt",
        timeoutMs: 5_000,
        write: true,
      },
    });
    assert.equal(started.isError, undefined);
    const result = await complete(
      first.client,
      started.structuredContent.value.handle,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "source\n");
    assert.equal(
      await fs.readFile(path.join(workspaceRoot, "created.txt"), "utf8"),
      "created",
    );
    await assert.rejects(fs.stat(path.join(workspaceRoot, "moved.txt")), {
      code: "ENOENT",
    });

    const denied = await first.client.callTool({
      name: "computer_shell_start",
      arguments: {
        operationId: "packaged-shell-deny",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "cat ../outside.txt",
        timeoutMs: 5_000,
        write: false,
      },
    });
    assert.equal(denied.isError, undefined);
    const denial = await complete(
      first.client,
      denied.structuredContent.value.handle,
    );
    assert.notEqual(denial.exitCode, 0);
    assert.equal(denial.stdout.includes("OUTSIDE_SECRET_CANARY"), false);

    const history = await first.client.callTool({
      name: "computer_shell_start",
      arguments: {
        operationId: "packaged-history-deny",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "git show HEAD:history.txt",
        timeoutMs: 5_000,
        write: false,
      },
    });
    assert.equal(history.isError, undefined);
    const historyDenied = await complete(
      first.client,
      history.structuredContent.value.handle,
    );
    assert.notEqual(historyDenied.exitCode, 0);
    assert.equal(historyDenied.stdout.includes("HISTORY_SECRET_CANARY"), false);
  } finally {
    await first.client.close();
    assert.equal(first.stderr(), "");
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
    const repeated = await restarted.client.callTool({
      name: "computer_shell_start",
      arguments: {
        operationId: "packaged-shell-once",
        workspaceId: "fixture",
        relativeCwd: ".",
        command:
          "cat input.txt && mv input.txt moved.txt && printf created > created.txt && rm moved.txt",
        timeoutMs: 5_000,
        write: true,
      },
    });
    assert.equal(repeated.isError, true);
    assert.equal(
      repeated.structuredContent?.error?.code,
      "SHELL_OUTCOME_UNKNOWN",
    );
  } finally {
    await restarted.client.close();
    assert.equal(restarted.stderr(), "");
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
    const history = await approved.client.callTool({
      name: "computer_shell_start",
      arguments: {
        operationId: "packaged-history-approved",
        workspaceId: "fixture",
        relativeCwd: ".",
        command: "git show HEAD:history.txt",
        timeoutMs: 5_000,
        write: false,
      },
    });
    assert.equal(history.isError, undefined);
    const observed = await complete(
      approved.client,
      history.structuredContent.value.handle,
    );
    assert.equal(observed.exitCode, 0, observed.stderr);
    assert.equal(observed.stdout, "HISTORY_SECRET_CANARY\n");
  } finally {
    await approved.client.close();
    assert.equal(approved.stderr(), "");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
