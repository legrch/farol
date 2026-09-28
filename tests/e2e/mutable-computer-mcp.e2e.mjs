import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareMcpLifecycle } from "./prepare-mcp-lifecycle.mjs";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--packaged")
) {
  throw new Error("MUTABLE_COMPUTER_MCP_E2E_ARGUMENTS_INVALID");
}
const packaged = arguments_[0] === "--packaged";
const packageRoot = path.resolve("_output/package/Farol Next Preview.app");
const entry = packaged
  ? path.join(packageRoot, "Contents/Resources/app/computer-mcp.cjs")
  : path.resolve("_output/build/app/computer-mcp.cjs");
const command = packaged
  ? path.join(
      packageRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : process.execPath;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function packagedEnvironment() {
  const environment = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["HOME", "PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function connect(entryFile, launchFile) {
  await prepareMcpLifecycle(launchFile);
  const transport = new StdioClientTransport({
    command,
    args: [entryFile, "--launch-contract", launchFile],
    cwd: process.cwd(),
    stderr: "pipe",
    ...(packaged ? { env: packagedEnvironment() } : {}),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({
    name: "farol-next-mutable-e2e",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mutable-mcp-")),
);
const launchRoot = path.join(root, "launch");
const workspaceRoot = path.join(root, "workspace");
let workspaceRootIdentity = null;
const launchFile = path.join(launchRoot, "computer-launch.json");

try {
  await fs.chmod(root, 0o700);
  await fs.mkdir(launchRoot, { mode: 0o700 });
  await fs.mkdir(workspaceRoot, { mode: 0o700 });
  // F1-1: an admitted workspace is bound to its folder's device/inode identity.
  const workspaceStat = await fs.stat(workspaceRoot, { bigint: true });
  workspaceRootIdentity = {
    device: String(workspaceStat.dev),
    inode: String(workspaceStat.ino),
  };
  await fs.writeFile(path.join(workspaceRoot, "status.txt"), "before\n", {
    mode: 0o600,
  });

  const now = Date.now();
  const launch = {
    schema: 2,
    approval: {
      ownerId: "owner-e2e",
      computerId: "computer-e2e",
      generation: 9,
      workspaces: [
        {
          workspaceId: "fixture",
          root: workspaceRoot,
          access: "write",
          rootIdentity: workspaceRootIdentity,
        },
      ],
      capabilities: ["workspace.read", "workspace.write"],
      network: "none",
      commands: "none",
      expiresAt: now + 60_000,
    },
    admission: {
      authorityId: "authority-e2e",
      ownerId: "owner-e2e",
      sessionId: "session-e2e",
      taskId: "task-e2e",
      taskEpoch: 4,
      computerId: "computer-e2e",
      computerGeneration: 9,
      workspaces: [
        {
          workspaceId: "fixture",
          mode: "subtree",
          root: workspaceRoot,
          access: "write",
        },
      ],
      capabilities: ["workspace.read", "workspace.write"],
      network: "none",
      commands: "none",
      expiresAt: now + 30_000,
    },
    delegationChain: [
      {
        participantId: "main-e2e",
        role: "main",
        mutationOwnership: "task",
      },
      {
        participantId: "agent-e2e",
        role: "agent",
        mutationOwnership: "task",
      },
      {
        participantId: "critic-e2e",
        role: "critic",
        mutationOwnership: "task",
      },
    ],
    binding: {
      participantId: "critic-e2e",
      turnId: "turn-e2e",
      generation: 5,
    },
  };
  await fs.writeFile(launchFile, `${canonical(launch)}\n`, {
    mode: 0o600,
    flag: "wx",
  });

  const writeArguments = {
    operationId: "write-e2e-a",
    workspaceId: "fixture",
    relativePath: "status.txt",
    expectedSha256: digest("before\n"),
    content: "after\n",
  };
  const first = await connect(entry, launchFile);
  try {
    const tools = await first.client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "computer_workspace_bootstrap",
        "computer_guidance_search",
        "computer_guidance_fetch",
        "computer_workspace_list",
        "computer_workspace_read",
        "computer_workspace_search",
        "computer_workspace_git_status",
        "computer_workspace_git_head",
        "computer_workspace_write",
        "computer_workspace_edit",
      ],
    );
    const written = await first.client.callTool({
      name: "computer_workspace_write",
      arguments: writeArguments,
    });
    assert.equal(written.isError, undefined);
    assert.equal(written.structuredContent?.redelivered, false);
    assert.equal(
      written.structuredContent?.receipt?.afterSha256,
      digest("after\n"),
    );
  } finally {
    await first.client.close();
    assert.equal(first.stderr(), "");
  }

  const restarted = await connect(entry, launchFile);
  try {
    const redelivered = await restarted.client.callTool({
      name: "computer_workspace_write",
      arguments: writeArguments,
    });
    assert.equal(redelivered.isError, undefined);
    assert.equal(redelivered.structuredContent?.redelivered, true);

    const edited = await restarted.client.callTool({
      name: "computer_workspace_edit",
      arguments: {
        operationId: "edit-e2e-a",
        workspaceId: "fixture",
        relativePath: "status.txt",
        expectedSha256: digest("after\n"),
        edits: [{ oldText: "after", newText: "finished" }],
      },
    });
    assert.equal(edited.isError, undefined);
    assert.equal(edited.structuredContent?.receipt?.operation, "edit");
    assert.equal(edited.structuredContent?.receipt?.replacements, 1);
  } finally {
    await restarted.client.close();
    assert.equal(restarted.stderr(), "");
  }

  assert.equal(
    await fs.readFile(path.join(workspaceRoot, "status.txt"), "utf8"),
    "finished\n",
  );
  const receipts = await fs.readdir(path.join(launchRoot, "mutations"));
  assert.equal(receipts.length, 2);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
