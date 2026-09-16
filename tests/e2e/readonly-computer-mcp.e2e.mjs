import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-computer-mcp-")),
);
const launchRoot = path.join(root, "launch");
const workspaceRoot = path.join(root, "workspace");
const launchFile = path.join(launchRoot, "computer-launch.json");
const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--packaged")
) {
  throw new Error("READONLY_COMPUTER_MCP_E2E_ARGUMENTS_INVALID");
}
const packaged = arguments_[0] === "--packaged";
const packageRoot = path.resolve("dist/package/Farol Next Preview.app");
const entry = packaged
  ? path.join(packageRoot, "Contents/Resources/app/computer-mcp.cjs")
  : path.resolve("dist/app/computer-mcp.cjs");
const command = packaged
  ? path.join(
      packageRoot,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : process.execPath;

function packagedEnvironment() {
  const environment = { ELECTRON_RUN_AS_NODE: "1" };
  for (const name of ["HOME", "PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
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

await fs.chmod(root, 0o700);
await fs.mkdir(launchRoot, { mode: 0o700 });
await fs.mkdir(path.join(workspaceRoot, "notes"), {
  recursive: true,
  mode: 0o700,
});
const git = (
  await executeFile("/usr/bin/xcrun", ["--find", "git"])
).stdout.trim();
await executeFile(git, ["init", "--quiet", workspaceRoot]);
await fs.writeFile(
  path.join(workspaceRoot, "notes", "review.txt"),
  "delegated critic reached the native workspace\n",
  { mode: 0o600 },
);

const now = Date.now();
const launch = {
  schema: 1,
  approval: {
    ownerId: "owner-e2e",
    computerId: "computer-e2e",
    generation: 9,
    workspaces: [
      { workspaceId: "fixture", root: workspaceRoot, access: "read" },
    ],
    capabilities: [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
    ],
    network: "none",
    commands: "verification",
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
        access: "read",
      },
    ],
    capabilities: [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
    ],
    network: "none",
    commands: "verification",
    expiresAt: now + 30_000,
  },
  delegationChain: [
    {
      participantId: "main-e2e",
      role: "main",
      mutationOwnership: "none",
    },
    {
      participantId: "agent-e2e",
      role: "agent",
      mutationOwnership: "none",
    },
    {
      participantId: "critic-e2e",
      role: "critic",
      mutationOwnership: "none",
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

const transport = new StdioClientTransport({
  command,
  args: [entry, "--launch-contract", launchFile],
  cwd: process.cwd(),
  stderr: "pipe",
  ...(packaged ? { env: packagedEnvironment() } : {}),
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += String(chunk);
});
const client = new Client({ name: "farol-next-e2e", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "computer_workspace_list",
      "computer_workspace_read",
      "computer_workspace_search",
      "computer_workspace_git_status",
    ],
  );
  assert.equal(
    tools.tools.every(
      (tool) =>
        tool.annotations?.readOnlyHint === true &&
        tool.annotations.destructiveHint === false,
    ),
    true,
  );

  const searched = await client.callTool({
    name: "computer_workspace_search",
    arguments: {
      workspaceId: "fixture",
      relativePath: ".",
      pattern: "native workspace",
    },
  });
  assert.equal(searched.isError, undefined);
  assert.equal(searched.structuredContent?.participantId, "critic-e2e");
  assert.deepEqual(searched.structuredContent?.output, {
    kind: "workspace.matches",
    matches: [
      {
        path: "notes/review.txt",
        line: 1,
        text: "delegated critic reached the native workspace",
        truncated: false,
      },
    ],
    resultLimited: false,
    scanLimited: false,
  });

  const read = await client.callTool({
    name: "computer_workspace_read",
    arguments: {
      workspaceId: "fixture",
      relativePath: "notes/review.txt",
    },
  });
  assert.equal(read.isError, undefined);
  assert.equal(read.structuredContent?.taskId, "task-e2e");
  assert.deepEqual(read.structuredContent?.output, {
    kind: "workspace.text",
    text: "delegated critic reached the native workspace\n",
    bytes: 46,
  });

  const status = await client.callTool({
    name: "computer_workspace_git_status",
    arguments: { workspaceId: "fixture" },
  });
  assert.equal(status.isError, undefined);
  assert.equal(status.structuredContent?.participantId, "critic-e2e");
  assert.deepEqual(status.structuredContent?.operation, {
    kind: "verification.run",
    command: "git.status",
    relativePath: ".",
  });
  assert.equal(status.structuredContent?.output?.kind, "workspace.command");
  assert.equal(status.structuredContent?.output?.command, "git.status");
  assert.equal(status.structuredContent?.output?.exitCode, 0);
  assert.equal(status.structuredContent?.output?.network, "none");

  const injected = await client.callTool({
    name: "computer_workspace_git_status",
    arguments: { workspaceId: "fixture", command: "sh -c whoami" },
  });
  assert.equal(injected.isError, true);
  assert.equal(stderr, "");
  process.stdout.write(
    `${JSON.stringify({ tools: tools.tools.length, participant: "critic-e2e", transport: "stdio", runtime: packaged ? "sealed-package" : "development" })}\n`,
  );
} catch (error) {
  throw new Error(
    `READONLY_COMPUTER_MCP_E2E_FAILED:${error instanceof Error ? error.message : String(error)}:${stderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}
