import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepareMcpLifecycle } from "./prepare-mcp-lifecycle.mjs";

// Built product MCP entry, native filesystem, disposable state. An expired
// sealed template stands in for elapsed wall time. No ChatGPT/live connector,
// desktop restart, system clock change, or owner approval mutation occurs.
assert.equal(process.argv.length, 2, "RENEWAL_E2E_ARGUMENTS_INVALID");
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-renewal-e2e-")),
);
const launchRoot = path.join(root, "launch");
const settingsRoot = path.join(root, "settings");
const workspaceRoot = path.join(root, "workspace");
const launchFile = path.join(launchRoot, "computer-launch.json");
const configFile = path.join(settingsRoot, "config.json");
const workspaceId = "00000000-0000-4000-8000-000000000002";
const entry = path.resolve("_output/build/app/computer-mcp.cjs");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
for (const directory of [launchRoot, settingsRoot, workspaceRoot])
  await fs.mkdir(directory, { mode: 0o700 });
const templates = path.join(root, "git-templates");
await fs.mkdir(templates, { mode: 0o700 });
execFileSync("/usr/bin/git", ["init", "--quiet", workspaceRoot], {
  env: {
    HOME: root,
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TEMPLATE_DIR: templates,
  },
});
const gitMetadata = {
  gitDirectory: path.join(workspaceRoot, ".git"),
  commonDirectory: path.join(workspaceRoot, ".git"),
};
const info = await fs.lstat(workspaceRoot, { bigint: true });
const identity = { device: String(info.dev), inode: String(info.ino) };
await fs.writeFile(path.join(workspaceRoot, "README.md"), "renewal fixture\n", {
  mode: 0o600,
});
const step = {
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown",
  verified: null,
  needsAction: "Pending.",
  unavailable: null,
  outcomeUnknown: false,
};
const settings = {
  schema: 1,
  revision: 1,
  general: {
    openAtLaunch: "browser",
    sidebarDefault: "full",
    activityDetail: "summary",
  },
  computer: {
    computerId: "00000000-0000-4000-8000-000000000001",
    generation: 7,
    name: "Disposable",
    commands: "none",
    workspaces: [
      {
        workspaceId,
        root: workspaceRoot,
        label: "Fixture",
        access: "read",
        excludedPaths: [],
        rootIdentity: identity,
        gitMetadata,
        gitHistoryApproved: true,
      },
    ],
  },
  setup: {
    chatgpt: step,
    computer: step,
    connect: step,
    hosts: step,
    verify: step,
  },
};
await fs.writeFile(configFile, JSON.stringify(settings), { mode: 0o600 });
const expiresAt = Date.now() - 12 * 60 * 60 * 1000;
const approval = {
  ownerId: "owner-desktop",
  computerId: settings.computer.computerId,
  generation: 7,
  workspaces: [
    {
      workspaceId,
      root: workspaceRoot,
      access: "read",
      rootIdentity: identity,
      gitMetadata,
      gitHistoryApproved: true,
      shellVerified: false,
    },
  ],
  excludedPaths: [],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt,
};
const ceiling = {
  schema: 2,
  approvalSource: {
    kind: "owner-settings/v1",
    root: settingsRoot,
    connectorGeneration: 1,
  },
  approval,
  admission: {
    authorityId: "renewal-e2e-authority",
    ownerId: "owner-desktop",
    sessionId: "renewal-e2e-session",
    taskId: "renewal-e2e-task",
    taskEpoch: 7,
    computerId: approval.computerId,
    computerGeneration: 7,
    workspaces: [
      { workspaceId, mode: "subtree", root: workspaceRoot, access: "read" },
    ],
    excludedPaths: [],
    capabilities: approval.capabilities,
    network: "none",
    commands: "none",
    expiresAt,
  },
  delegationChain: [
    {
      participantId: "renewal-e2e-main",
      role: "main",
      mutationOwnership: "none",
    },
  ],
  binding: {
    participantId: "renewal-e2e-main",
    turnId: "renewal-e2e-turn",
    generation: 7,
  },
};
await fs.writeFile(launchFile, `${canonical(ceiling)}\n`, { mode: 0o600 });
await prepareMcpLifecycle(launchFile);
const owned = [];
let clean = true;
class TrackedTransport extends StdioClientTransport {
  async start() {
    await super.start();
    assert.ok(
      this._process && this._process.pid === this.pid,
      "MCP_CHILD_UNVERIFIED",
    );
    const child = this._process;
    owned.push({
      transport: this,
      child,
      exit: new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      ),
    });
  }
}
async function connect() {
  const client = new Client({
    name: "renewal-built-fixture",
    version: "1.0.0",
  });
  const transport = new TrackedTransport({
    command: process.execPath,
    args: [entry, "--launch-contract", launchFile],
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  await client.connect(transport);
  return client;
}
async function disconnect(client) {
  await client.close();
  const record = owned.at(-1);
  let timer;
  const exit = await Promise.race([
    record.exit,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 3_000);
    }),
  ]);
  clearTimeout(timer);
  if (!exit || exit.code !== 0 || exit.signal !== null) clean = false;
  assert.deepEqual(
    exit,
    { code: 0, signal: null },
    "MCP_CLEAN_SHUTDOWN_UNVERIFIED",
  );
}
try {
  let client = await connect();
  const catalogue = await client.callTool({
    name: "computer_workspace_catalogue",
    arguments: {},
  });
  assert.notEqual(catalogue.isError, true, JSON.stringify(catalogue));
  for (let turn = 0; turn < 2; turn++) {
    const read = await client.callTool({
      name: "computer_workspace_read",
      arguments: { workspaceId, relativePath: "README.md" },
    });
    assert.notEqual(read.isError, true, JSON.stringify(read));
    assert.equal(read.structuredContent.output.text, "renewal fixture\n");
    assert.equal(read.structuredContent.taskId, ceiling.admission.taskId);
    assert.equal(
      read.structuredContent.output.sha256,
      createHash("sha256").update("renewal fixture\n").digest("hex"),
    );
  }
  await disconnect(client);
  client = await connect();
  const reconnected = await client.callTool({
    name: "computer_workspace_read",
    arguments: { workspaceId, relativePath: "README.md" },
  });
  assert.notEqual(reconnected.isError, true, JSON.stringify(reconnected));
  settings.computer.generation++;
  await fs.writeFile(configFile, JSON.stringify(settings), { mode: 0o600 });
  const revoked = await client.callTool({
    name: "computer_workspace_read",
    arguments: { workspaceId, relativePath: "README.md" },
  });
  assert.equal(revoked.isError, true);
  assert.equal(
    revoked.structuredContent.error.code,
    "AUTHORITY_COMPUTER_MISMATCH",
  );
  assert.equal(revoked.structuredContent.error.retry, "never");
  await disconnect(client);
  console.log(
    "Computer TaskGrant renewal: built MCP/native filesystem expiry, same connection, reconnect and generation revocation passed; no live ChatGPT claim.",
  );
} finally {
  for (const record of owned) {
    if (record.child.exitCode === null && record.child.signalCode === null) {
      await record.transport.close().catch(() => {
        clean = false;
      });
    }
    let timer;
    const exit = await Promise.race([
      record.exit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 3_000);
      }),
    ]);
    clearTimeout(timer);
    if (!exit || exit.code !== 0 || exit.signal !== null) clean = false;
  }
  if (clean) await fs.rm(root, { recursive: true, force: true });
  else
    console.error(
      `Preserved disposable state after unverified child shutdown: ${root}`,
    );
}
