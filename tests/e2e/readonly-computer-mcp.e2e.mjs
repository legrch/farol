import { desktopIdentity as harnessDesktopIdentity } from "../../src/apps/desktop/desktop-environment.ts";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { prepareMcpLifecycle } from "./prepare-mcp-lifecycle.mjs";

const executeFile = promisify(execFile);

const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-computer-mcp-")),
);
const launchRoot = path.join(root, "launch");
const workspaceRoot = path.join(root, "workspace");
const launchFile = path.join(launchRoot, "computer-launch.json");
const verificationChallenge = "00000000-0000-4000-8000-000000000001";
const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  (arguments_.length === 1 && arguments_[0] !== "--packaged")
) {
  throw new Error("READONLY_COMPUTER_MCP_E2E_ARGUMENTS_INVALID");
}
const packaged = arguments_[0] === "--packaged";
const packageRoot = path.resolve(
  `_output/package/${harnessDesktopIdentity("preview", "/").applicationName}.app`,
);
const entry = packaged
  ? path.join(packageRoot, "Contents/Resources/app/computer-mcp.cjs")
  : path.resolve("_output/build/app/computer-mcp.cjs");
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
const templates = path.join(root, "empty-templates");
await fs.mkdir(templates, { mode: 0o700 });
const fixtureGit = (args) =>
  executeFile(
    git,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: root,
        LANG: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TEMPLATE_DIR: templates,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
await fixtureGit(["init", "--quiet", workspaceRoot]);
await fs.writeFile(
  path.join(workspaceRoot, "notes", "review.txt"),
  "delegated critic reached the native workspace\n",
  { mode: 0o600 },
);
await fs.writeFile(
  path.join(workspaceRoot, "notes", "AGENTS.md"),
  "# Notes instructions\nPreserve exact evidence.\n",
  { mode: 0o600 },
);
await fixtureGit([
  "-C",
  workspaceRoot,
  "add",
  "notes/review.txt",
  "notes/AGENTS.md",
]);
await fixtureGit([
  "-C",
  workspaceRoot,
  "-c",
  "user.name=Farol E2E",
  "-c",
  "user.email=farol-e2e@invalid.example",
  "commit",
  "--quiet",
  "-m",
  "fixture",
]);
const head = (await fixtureGit(["-C", workspaceRoot, "rev-parse", "HEAD"]))
  .stdout;

const now = Date.now();
// F1-1: an admitted workspace is bound to its folder's device/inode identity.
const workspaceRootIdentity = await (async () => {
  const stat = await fs.stat(workspaceRoot, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
})();
const launch = {
  schema: 1,
  approval: {
    ownerId: "owner-e2e",
    computerId: "computer-e2e",
    generation: 9,
    workspaces: [
      {
        workspaceId: "fixture",
        root: workspaceRoot,
        access: "read",
        rootIdentity: workspaceRootIdentity,
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
  connectorVerification: {
    challengeSha256: createHash("sha256")
      .update(verificationChallenge)
      .digest("hex"),
  },
};
await fs.writeFile(launchFile, `${canonical(launch)}\n`, {
  mode: 0o600,
  flag: "wx",
});
await prepareMcpLifecycle(launchFile);

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
const client = new Client({ name: "farol-e2e", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    [
      "computer_workspace_catalogue",
      "computer_workspace_bootstrap",
      "computer_guidance_search",
      "computer_guidance_fetch",
      "computer_workspace_list",
      "computer_workspace_read",
      "computer_workspace_search",
      "computer_workspace_git_status",
      "computer_workspace_git_head",
      "farol_connector_verify",
    ],
  );
  assert.equal(
    tools.tools
      .filter((tool) => tool.name !== "farol_connector_verify")
      .every(
        (tool) =>
          tool.annotations?.readOnlyHint === true &&
          tool.annotations.destructiveHint === false,
      ),
    true,
  );
  assert.deepEqual(
    tools.tools.find((tool) => tool.name === "farol_connector_verify")
      ?.annotations,
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  );

  const catalogue = await client.callTool({
    name: "computer_workspace_catalogue",
    arguments: {},
  });
  assert.equal(catalogue.isError, undefined);
  assert.equal(catalogue.structuredContent?.ok, true);
  assert.deepEqual(
    catalogue.structuredContent?.workspaces.map((item) => ({
      workspaceId: item.workspaceId,
      root: item.root,
    })),
    [{ workspaceId: "fixture", root: workspaceRoot }],
  );
  const discoveredWorkspaceId =
    catalogue.structuredContent.workspaces[0].workspaceId;
  const bootstrap = await client.callTool({
    name: "computer_workspace_bootstrap",
    arguments: {
      workspaceId: discoveredWorkspaceId,
      relativeDirectory: "notes",
    },
  });
  assert.equal(bootstrap.isError, undefined, JSON.stringify(bootstrap));
  assert.equal(bootstrap.structuredContent?.root, workspaceRoot);
  assert.deepEqual(bootstrap.structuredContent?.approvedRoot, {
    path: workspaceRoot,
    ...workspaceRootIdentity,
  });
  assert.equal(bootstrap.structuredContent?.complete, true);
  assert.deepEqual(bootstrap.structuredContent?.instructions, [
    { relativePath: "AGENTS.md", status: "not_found" },
    {
      relativePath: "notes/AGENTS.md",
      status: "read",
      text: "# Notes instructions\nPreserve exact evidence.\n",
      bytes: 46,
    },
  ]);
  const guidance = await client.callTool({
    name: "computer_guidance_search",
    arguments: { query: "instructions workspace", limit: 1 },
  });
  assert.equal(guidance.isError, undefined);
  assert.equal(guidance.structuredContent?.source, "sealed-package-manifest");
  assert.equal(guidance.structuredContent?.entries?.[0]?.id, "computer-start");
  const fetched = await client.callTool({
    name: "computer_guidance_fetch",
    arguments: { id: "computer-start" },
  });
  assert.equal(fetched.isError, undefined);
  assert.equal(fetched.structuredContent?.entry?.id, "computer-start");
  const invented = await client.callTool({
    name: "computer_guidance_fetch",
    arguments: { id: "../../AGENTS.md" },
  });
  assert.equal(invented.isError, true);
  assert.equal(
    invented.structuredContent?.error?.code,
    "GUIDANCE_NOT_PUBLISHED",
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
    sha256: createHash("sha256")
      .update("delegated critic reached the native workspace\n")
      .digest("hex"),
  });

  assert.deepEqual(
    JSON.parse(read.content[0].text),
    read.structuredContent.output,
  );
  const window = await client.callTool({
    name: "computer_workspace_read",
    arguments: {
      workspaceId: "fixture",
      relativePath: "notes/review.txt",
      offset: 0,
      length: 64,
    },
  });
  assert.equal(window.isError, undefined);
  assert.equal(Object.hasOwn(window.structuredContent.output, "sha256"), false);
  assert.deepEqual(window.structuredContent.output.page, {
    offset: 0,
    size: 46,
    nextOffset: null,
  });

  // N02: Git runs for real now, over a private point-in-time clone of the
  // approved folder's metadata and tracked files -- both fixed, no-network
  // verifications return their result. A real tracked change made through
  // the owner's own path first, so the rendered status carries exactly one
  // record besides the branch header, in the route's own `--short`-style
  // rendering.
  await fs.writeFile(
    path.join(workspaceRoot, "notes", "review.txt"),
    "delegated critic reached the native workspace\nand left a note\n",
    { mode: 0o600 },
  );
  const branch = (
    await fixtureGit(["-C", workspaceRoot, "symbolic-ref", "--short", "HEAD"])
  ).stdout.trim();
  const status = await client.callTool({
    name: "computer_workspace_git_status",
    arguments: { workspaceId: "fixture" },
  });
  assert.equal(status.isError, undefined, JSON.stringify(status));
  assert.equal(status.structuredContent?.output?.kind, "workspace.command");
  assert.equal(status.structuredContent?.output?.command, "git.status");
  assert.equal(status.structuredContent?.output?.exitCode, 0);
  assert.equal(status.structuredContent?.output?.network, "none");
  assert.equal(
    status.structuredContent?.output?.stdout,
    `## ${branch}\n M notes/review.txt\n`,
  );
  assert.equal(
    status.structuredContent?.output?.coverage,
    "tracked-files-only",
  );
  assert.equal(status.structuredContent?.output?.layout, "primary");

  const exactHead = await client.callTool({
    name: "computer_workspace_git_head",
    arguments: { workspaceId: "fixture" },
  });
  assert.equal(exactHead.isError, undefined, JSON.stringify(exactHead));
  assert.equal(exactHead.structuredContent?.output?.kind, "workspace.command");
  assert.equal(exactHead.structuredContent?.output?.command, "git.head");
  assert.equal(exactHead.structuredContent?.output?.stdout, head);
  assert.equal(exactHead.structuredContent?.output?.exitCode, 0);
  assert.equal(exactHead.structuredContent?.output?.network, "none");

  // A command with an injected argument is still refused: the tool exposes
  // exactly the two fixed, no-network verifications and nothing shaped like
  // an arbitrary command line.
  const injected = await client.callTool({
    name: "computer_workspace_git_status",
    arguments: { workspaceId: "fixture", command: "sh -c whoami" },
  });
  assert.equal(injected.isError, true);
  const verified = await client.callTool({
    name: "farol_connector_verify",
    arguments: {
      challenge: verificationChallenge,
      workspaceId: "fixture",
    },
  });
  assert.equal(verified.isError, undefined);
  assert.equal(verified.structuredContent?.operation, "workspace.list");
  assert.equal(verified.structuredContent?.workspaceId, "fixture");
  assert.equal(verified.structuredContent?.entryCount, 1);
  assert.equal(
    JSON.stringify(verified.structuredContent).includes("notes/review.txt"),
    false,
  );
  const connectorReceipt = JSON.parse(
    await fs.readFile(
      path.join(launchRoot, "connector-verification-receipt.json"),
      "utf8",
    ),
  );
  assert.equal(
    connectorReceipt.challengeSha256,
    launch.connectorVerification.challengeSha256,
  );
  assert.equal(connectorReceipt.participantId, "critic-e2e");
  assert.equal(connectorReceipt.operation, "workspace.list");
  assert.equal(connectorReceipt.entryCount, 1);
  assert.equal(JSON.stringify(connectorReceipt).includes("review.txt"), false);
  assert.equal(stderr, "");
  process.stdout.write(
    `${JSON.stringify({ tools: tools.tools.length, participant: "critic-e2e", connectorVerification: "content-free", transport: "stdio", runtime: packaged ? "sealed-package" : "development" })}\n`,
  );
} catch (error) {
  throw new Error(
    `READONLY_COMPUTER_MCP_E2E_FAILED:${error instanceof Error ? error.message : String(error)}:${stderr}`,
  );
} finally {
  await client.close().catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
}
