import { productName } from "../../tooling/harness-identity.ts";
import { desktopIdentity as harnessDesktopIdentity } from "../../tooling/harness-identity.ts";
import {
  ownedFixtureTransport,
  requireOwnedFixtureExit,
  closeOwnedFixture,
  preserveFixtureFailure,
} from "./owned-mcp-fixture-lifecycle.mjs";
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
const options = process.argv.slice(2);
assert(
  options.every((value) =>
    ["--packaged", "--reconnect-failure"].includes(value),
  ) && new Set(options).size === options.length,
);
const packaged = options.includes("--packaged");
const reconnectFault = options.includes("--reconnect-failure");
const reconnectFailure = new assert.AssertionError({
  message: "CLAUDE_FIXTURE_RECONNECT_FAILURE",
});
const transports = [];
let connections = 0;
const app = path.resolve(
  `_output/package/${harnessDesktopIdentity("preview", "/").applicationName}.app`,
);
const entry = packaged
  ? path.join(app, "Contents/Resources/app/computer-mcp.cjs")
  : path.resolve("_output/build/app/computer-mcp.cjs");
const command = packaged
  ? path.join(
      app,
      "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : process.execPath;
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-claude-mcp-")),
);
await fs.chmod(root, 0o700);
const project = path.join(root, "project");
const writer = path.join(root, "writer");
const launchRoot = path.join(root, "launch");
const home = path.join(root, "synthetic-home");
const run = promisify(execFile);
const key = "019b0000-0000-4000-8000-000000000020";
const denyKey = "019b0000-0000-4000-8000-000000000021";
const env = {
  HOME: home,
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (...args) =>
  run("/usr/bin/git", args, { env, timeout: 10000, maxBuffer: 16384 });
const identity = async (dir) => {
  const stat = await fs.lstat(dir, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
};
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
let client;
let transport;
let allPassed = false;
async function connect() {
  client = new Client({ name: "claude-fixture", version: "1" });
  const attempt = ++connections;
  transport = ownedFixtureTransport(
    StdioClientTransport,
    {
      command,
      args: [
        entry,
        "--launch-contract",
        path.join(launchRoot, "computer-launch.json"),
      ],
      env: {
        PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: home,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stderr: "pipe",
    },
    () => {
      if (reconnectFault && attempt === 2) throw reconnectFailure;
    },
  );
  transports.push(transport);
  await client.connect(transport);
}
async function close() {
  if (!client) return;
  await closeOwnedFixture(client, transport);
  client = undefined;
}
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return result;
}
async function terminal(dispatchId) {
  for (let i = 0; i < 100; i++) {
    const value = (await call("claude_task_status", { dispatchId }))
      .structuredContent;
    if (value?.status === "known" && value.lifecycle !== "running")
      return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw Error("CLAUDE_FIXTURE_TERMINAL_NOT_OBSERVED");
}
const rootIdentity = await fs.lstat(root);
try {
  await preserveFixtureFailure(
    async () => {
      await fs.mkdir(home, { mode: 0o700 });
      await fs.mkdir(launchRoot, { mode: 0o700 });
      await git("init", project);
      await git("-C", project, "commit", "--allow-empty", "-m", "fixture");
      await git("-C", project, "worktree", "add", "--detach", writer, "HEAD");
      const script = `#!/bin/sh
session=''
model=''
mode=''
prompts=''
while [ "$#" -gt 0 ]; do
 case "$1" in
 --print|--verbose) shift ;;
 --output-format) [ "$2" = stream-json ] || exit 64; shift 2 ;;
 --session-id) session="$2"; shift 2 ;;
 --model) model="$2"; shift 2 ;;
 --effort) [ "$2" = medium ] || exit 64; shift 2 ;;
 --permission-mode) mode="$2"; shift 2 ;;
 --permission-prompts) prompts="$2"; shift 2 ;;
 *) exit 64 ;;
 esac
 done
 [ "$model" = fixture-model ] && [ "$mode" = default ] && [ "$prompts" = none ] || exit 64
 printf '{"type":"system","subtype":"init","session_id":"%s","cwd":"%s","model":"%s","permissionMode":"default"}\n' "$session" "$PWD" "$model"
 IFS= read -r message
 if [ "$message" = deny ]; then
 printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"Blocked fixture","permission_denials":[{"tool_name":"Bash"}]}\n' "$session"
 else
 printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"Exact owned fixture PID %s","permission_denials":[]}\n' "$session" "$$"
 fi
 exit 0
`;
      const binary = path.join(writer, "fixture-claude-host");
      await fs.writeFile(binary, script, { mode: 0o700 });
      const expiresAt = Date.now() + 120000;
      const writerIdentity = await identity(writer);
      const projectIdentity = await identity(project);
      const commonDirectory = path.join(project, ".git");
      const gitDirectory = (
        await git("-C", writer, "rev-parse", "--absolute-git-dir")
      ).stdout.trim();
      const tasks = {
        defaultHarness: "claude-code",
        harnesses: {
          "claude-code": {
            defaultModel: "small",
            models: {
              small: { model: "fixture-model", defaultEffort: "medium" },
            },
          },
        },
      };
      const configSha256 = createHash("sha256")
        .update(
          JSON.stringify([
            "farol-task-policy/1",
            "claude-code",
            [["claude-code", "small", [["small", "fixture-model", "medium"]]]],
          ]),
        )
        .digest("hex");
      const launch = {
        schema: 1,
        gitSettingsHome: home,
        approval: {
          ownerId: "fixture-owner",
          computerId: "fixture-computer",
          generation: 1,
          workspaces: [
            {
              workspaceId: "selected",
              root: writer,
              rootIdentity: writerIdentity,
              access: "read",
              shellVerified: true,
              gitHistoryApproved: true,
              gitMetadata: { gitDirectory, commonDirectory },
            },
          ],
          capabilities: ["workspace.list", "workspace.read", "workspace.shell"],
          network: "none",
          commands: "workspace",
          expiresAt,
        },
        admission: {
          authorityId: "fixture-authority",
          ownerId: "fixture-owner",
          computerId: "fixture-computer",
          computerGeneration: 1,
          sessionId: "fixture-session",
          taskId: "fixture-task",
          taskEpoch: 1,
          workspaces: [
            {
              workspaceId: "selected",
              root: writer,
              mode: "subtree",
              access: "read",
            },
          ],
          capabilities: ["workspace.list", "workspace.read", "workspace.shell"],
          network: "none",
          commands: "workspace",
          expiresAt,
        },
        delegationChain: [
          {
            participantId: "fixture-main",
            role: "main",
            mutationOwnership: "none",
          },
        ],
        binding: {
          participantId: "fixture-main",
          turnId: "fixture-turn",
          generation: 1,
        },
        claudeTasks: {
          transport: "claude-sandboxed-print/v1",
          host: {
            qualification: "fixture-only",
            executablePath: binary,
            executableSha256: createHash("sha256").update(script).digest("hex"),
            models: [{ model: "fixture-model", efforts: ["medium"] }],
          },
          grant: {
            workspaceId: "selected",
            writerRoot: writer,
            writerIdentity,
            projectId: "fixture-saved",
            projectRoot: project,
            projectIdentity,
            gitCommonDirectory: commonDirectory,
            execution: { sandbox: "read-only", approvalPolicy: "on-request" },
            harness: "claude-code",
            tasks,
            configSha256,
            expiresAt,
          },
        },
      };
      const launchFile = path.join(launchRoot, "computer-launch.json");
      await fs.writeFile(launchFile, canonical(launch) + "\n", { mode: 0o600 });
      await prepareMcpLifecycle(launchFile);
      await connect();
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert(
        names.includes("claude_task_create") &&
          names.includes("claude_task_status"),
      );
      assert(!names.includes("codex_task_create"));
      const request = {
        key,
        workspaceId: "selected",
        projectId: "fixture-saved",
        message: "fixture",
      };
      for (const change of [
        { workspaceId: "foreign" },
        { projectId: "foreign" },
        { model: "missing" },
        { harness: "codex" },
      ])
        assert.equal(
          (await call("claude_task_create", { ...request, ...change })).isError,
          true,
        );
      assert.equal(
        (await call("claude_task_create", request)).structuredContent?.status,
        "dispatched",
      );
      assert.equal(
        (await call("claude_task_create", request)).structuredContent?.status,
        "outcome_unknown",
      );
      const complete = await terminal(key);
      assert.equal(complete.lifecycle, "completed");
      assert.equal(complete.actualModel, "fixture-model");
      assert.equal(complete.proof, "recorded-terminal");
      assert.equal(complete.nativeVisibility, "not-qualified");
      assert.match(complete.text, /^Exact owned fixture PID [0-9]+$/u);
      assert.equal(complete.exitCode, 0);
      assert.equal(
        (
          await call("claude_task_create", {
            ...request,
            key: denyKey,
            message: "deny",
          })
        ).structuredContent?.status,
        "dispatched",
      );
      assert.equal((await terminal(denyKey)).lifecycle, "needs_input");
      await close();
      await connect();
      assert.deepEqual(
        (await call("claude_task_status", { dispatchId: key }))
          .structuredContent,
        complete,
      );
      assert.equal(
        (await call("claude_task_create", request)).structuredContent?.status,
        "outcome_unknown",
      );
      assert.equal(
        (
          await call("claude_task_status", {
            dispatchId: "019b0000-0000-4000-8000-000000000022",
          })
        ).structuredContent?.status,
        "unknown",
      );
      await close();
    },
    async () => {
      try {
        await close();
      } catch (error) {
        console.error("FIXTURE_ROOT_RETAINED_FOR_UNVERIFIED_SHUTDOWN", root);
        throw error;
      }
      for (const owned of transports) await requireOwnedFixtureExit(owned);
      const current = await fs.lstat(root);
      assert(
        current.isDirectory() &&
          !current.isSymbolicLink() &&
          current.dev === rootIdentity.dev &&
          current.ino === rootIdentity.ino,
        "FIXTURE_ROOT_IDENTITY_CHANGED",
      );
      await fs.rm(root, { recursive: true, force: true });
    },
    (error) =>
      console.error("FIXTURE_SECONDARY_CLEANUP_FAILURE", String(error)),
  );
  allPassed = true;
  console.log(
    JSON.stringify({
      status: "PASS",
      route: `new-${productName}-packaged-or-built-MCP`,
      packaged,
      qualification: "owned-process-fixture-only",
      terminal: "completed-and-needs-input",
      restart: "recorded-terminal-same-session-no-relaunch",
      sandbox: "existing-Seatbelt-read-only-network-none",
      nativeClaude: "NOT_QUALIFIED",
      nativeDetachedCleanup: "NOT_QUALIFIED",
      modelInferenceCalls: 0,
    }),
  );
} catch (error) {
  if (
    reconnectFault &&
    error === reconnectFailure &&
    connections === 2 &&
    transports[0].ownedPid !== transports[1].ownedPid
  ) {
    try {
      for (const owned of transports) await requireOwnedFixtureExit(owned);
      await assert.rejects(fs.stat(root), (value) => value.code === "ENOENT");
      console.error(
        "CLAUDE_RECONNECT_FIRST_ERROR_CURRENT_CHILD_EXIT_ROOT_REMOVED",
      );
    } catch (proofError) {
      console.error("FAULT_CLEANUP_PROOF_UNVERIFIED", String(proofError));
    }
  }
  throw error;
} finally {
  if (!allPassed) console.error("CLAUDE_MCP_FIXTURE_NOT_QUALIFIED");
}
