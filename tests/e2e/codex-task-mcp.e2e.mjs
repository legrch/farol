import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  fixtureSocketFrames,
  fixtureFailureBoundary,
} from "./fixture-socket-failures.mjs";
import { prepareMcpLifecycle } from "./prepare-mcp-lifecycle.mjs";

const executeFile = promisify(execFile);
const binary = process.env.FAROL_CODEX_PROXY_BINARY;
if (!binary || !path.isAbsolute(binary)) {
  throw new Error("CODEX_PROXY_BINARY_REQUIRED");
}
const options = process.argv.slice(2);
assert(
  options.every((option) =>
    ["--packaged", "--callback-failure"].includes(option),
  ),
);
const packaged = options.includes("--packaged");
const callbackFailure = options.includes("--callback-failure");
const callbackAssertion = new assert.AssertionError({
  message: "FIXTURE_TASK_DISCOVERY_CALLBACK_FAILURE",
});
let injectedFailureObserved = false;
const entry = packaged
  ? path.resolve(
      "_output/package/Farol Next Preview.app/Contents/Resources/app/computer-mcp.cjs",
    )
  : path.resolve("_output/build/app/computer-mcp.cjs");
const command = packaged
  ? path.resolve(
      "_output/package/Farol Next Preview.app/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
    )
  : process.execPath;
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-task-mcp-e2e-")),
);
const projectRoot = path.join(root, "project");
const writerRoot = path.join(root, "writer");
const launchRoot = path.join(root, "launch");
const socketPath = path.join(root, "control.sock");
const savedChatSocketPath = path.join(root, "saved-chat.sock");
const savedChatToken = "a".repeat(64);
const key = "41949674-c1e4-4a73-9098-4d31da6e7aaa";
const projectId = "saved-fixture-project";
const threadId = "issued-fixture-thread";
const ownerThreadId = "0e4b2463-5506-47d5-a1a0-b4b84e941301";
const ownerTurnId = "d7b554c6-6603-4404-b376-7c77b618a242";
const turnId = "issued-fixture-turn";
const calls = [];
let turnStatus = "inProgress";
let runtimeStatus = { type: "active", activeFlags: ["waitingOnApproval"] };
const runtimeSnapshot = {
  scope: "thread",
  source: "thread/read",
  snapshot: "non-atomic",
};
let canonicalMetadataCwdFault = false;
const sockets = new Set();
const savedChatCalls = [];
const savedChatNegative = new Map();
const savedChatClosed = new Set();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((field) => `${JSON.stringify(field)}:${canonical(value[field])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function git(...arguments_) {
  return executeFile("/usr/bin/git", arguments_, {
    env: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
}

async function identity(directory) {
  const info = await fs.lstat(directory, { bigint: true });
  return { device: String(info.dev), inode: String(info.ino) };
}

function hostResult(method, params) {
  calls.push(method);
  if (method === "initialize") {
    return {
      codexHome: "/fixture/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "disposable-fixture",
    };
  }
  if (method === "project/list") {
    return {
      data: [{ id: projectId, roots: [{ path: projectRoot }] }],
      nextCursor: null,
    };
  }
  if (method === "thread/list") {
    if (callbackFailure) throw callbackAssertion;
    assert.equal(params.projectId, projectId);
    const wide = Array.isArray(params.cwd);
    if (wide) assert.deepEqual(params.cwd, [writerRoot, projectRoot]);
    else assert.equal(params.cwd, writerRoot);
    assert.equal(params.useStateDbOnly, true);
    assert.equal(params.limit, 50);
    assert.equal(params.archived, false);
    assert.equal(params.sortKey, "updated_at");
    return {
      data: [
        {
          id: ownerThreadId,
          projectId,
          cwd: wide
            ? canonicalMetadataCwdFault
              ? path.join(root, "third-writer")
              : projectRoot
            : writerRoot,
          name: "Farol · Native observer canary",
          model: "gpt-6-luna",
          status: { type: "active", activeFlags: ["waitingOnUserInput"] },
          updatedAt: 123,
          preview: "PRIVATE FIXTURE PREVIEW",
        },
      ],
      nextCursor: null,
    };
  }
  if (method === "thread/start") {
    assert.equal(params.projectId, projectId);
    assert.equal(params.cwd, writerRoot);
    assert.equal(params.allowProviderModelFallback, false);
    return {
      cwd: writerRoot,
      model: "gpt-6-luna",
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly" },
      thread: { id: threadId, projectId },
    };
  }
  if (method === "turn/start") {
    assert.equal(params.threadId, threadId);
    assert.equal(params.cwd, writerRoot);
    assert.deepEqual(params.input, [{ type: "text", text: "Read README H1" }]);
    assert.deepEqual(params.sandboxPolicy, {
      type: "readOnly",
      networkAccess: false,
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }
  if (method === "turn/steer") {
    assert.equal(params.threadId, threadId);
    assert.equal(params.expectedTurnId, turnId);
    assert.deepEqual(params.input, [{ type: "text", text: "One steer" }]);
    return { turnId };
  }
  if (method === "thread/read") {
    if (params.threadId === ownerThreadId)
      return {
        thread: {
          id: ownerThreadId,
          projectId,
          cwd: writerRoot,
          name: "Farol · Native observer canary",
          model: "gpt-6-luna",
          status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        },
      };
    return {
      thread: {
        id: threadId,
        projectId,
        cwd: writerRoot,
        model: "gpt-6-luna",
        status: runtimeStatus,
      },
    };
  }
  if (method === "thread/turns/list") {
    if (params.threadId === ownerThreadId)
      return {
        data: [{ id: ownerTurnId, status: "completed" }],
        nextCursor: null,
      };
    return { data: [{ id: turnId, status: turnStatus }], nextCursor: null };
  }
  if (method === "thread/items/list") {
    if (params.threadId === ownerThreadId) {
      assert.equal(params.turnId, ownerTurnId);
      return {
        data: [
          {
            turnId: ownerTurnId,
            item: {
              id: "owner-answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "Exact owner-created fixture answer",
            },
          },
        ],
        nextCursor: null,
      };
    }
    assert.equal(params.turnId, turnId);
    return {
      data: [
        {
          turnId,
          item: {
            id: "answer",
            type: "agentMessage",
            phase: "final_answer",
            text: "Exact built-byte fixture answer",
          },
        },
      ],
      nextCursor: null,
    };
  }
  throw new Error(`UNEXPECTED_HOST_METHOD:${method}`);
}

const fixtureFailure = fixtureFailureBoundary();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  socket.on(
    "data",
    fixtureSocketFrames(
      socket,
      (request) => {
        if (request.id === undefined) return;
        socket.write(
          `${JSON.stringify({ id: request.id, result: hostResult(request.method, request.params) })}\n`,
        );
      },
      fixtureFailure.capture,
    ),
  );
});

// A local fake Browser endpoint proves built MCP routing only. It never
// opens ChatGPT or claims a saved conversation was verified.
const savedChatServer = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  let handled = false;
  socket.on(
    "data",
    fixtureSocketFrames(
      socket,
      (request) => {
        if (handled) return;
        handled = true;
        if (request.token !== savedChatToken) {
          socket.end(`${JSON.stringify({ status: "unknown" })}\n`);
          return;
        }
        savedChatCalls.push(request.operation);
        const dispatchId =
          request.operation === "create"
            ? request.request.key
            : request.dispatchId;
        const mode = savedChatNegative.get(dispatchId);
        if (mode) {
          socket.once("close", () => savedChatClosed.add(dispatchId));
          const foreignId = "22345678-1234-4123-8123-123456789abc";
          const verified = {
            status: "verified",
            dispatchId,
            conversationUrl:
              "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc",
            titleVerified: false,
          };
          if (mode === "abrupt-close") {
            socket.destroy();
            return;
          }
          const reply =
            mode === "foreign-verified"
              ? { ...verified, dispatchId: foreignId }
              : mode === "foreign-refused"
                ? {
                    status: "refused",
                    dispatchId: foreignId,
                    code: "SAVED_CHAT_BROWSER_UNAVAILABLE",
                  }
                : mode === "foreign-unknown"
                  ? { status: "outcome_unknown", dispatchId: foreignId }
                  : mode === "mixed-frame"
                    ? { ...verified, error: { message: "mixed fixture" } }
                    : {
                        status: "refused",
                        dispatchId,
                        code: "SAVED_CHAT_BROWSER_UNAVAILABLE",
                      };
          // Deliberately keep the peer open after a complete frame. The
          // packaged client must settle and close its own connection.
          socket.write(JSON.stringify(reply) + "\n");
          return;
        }
        socket.end(
          `${JSON.stringify(request.operation === "create" ? { status: "refused", code: "SAVED_CHAT_BROWSER_UNAVAILABLE", dispatchId: request.request.key } : { status: "unknown" })}\n`,
        );
      },
      fixtureFailure.capture,
    ),
  );
});

let client;
let transport;
async function callFixtureTool(request) {
  return fixtureFailure.wait(client.callTool(request));
}
try {
  await fs.chmod(root, 0o700);
  await git("init", projectRoot);
  await git("-C", projectRoot, "commit", "--allow-empty", "-m", "fixture");
  await git(
    "-C",
    projectRoot,
    "worktree",
    "add",
    "--detach",
    writerRoot,
    "HEAD",
  );
  await fs.mkdir(launchRoot, { mode: 0o700 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await new Promise((resolve, reject) => {
    savedChatServer.once("error", reject);
    savedChatServer.listen(savedChatSocketPath, resolve);
  });
  const now = Date.now();
  const writerIdentity = await identity(writerRoot);
  const projectIdentity = await identity(projectRoot);
  const gitDirectory = (
    await git("-C", writerRoot, "rev-parse", "--absolute-git-dir")
  ).stdout.trim();
  const commonDirectory = path.join(projectRoot, ".git");
  const launch = {
    schema: 1,
    approval: {
      ownerId: "fixture-owner",
      computerId: "fixture-computer",
      generation: 1,
      workspaces: [
        {
          workspaceId: "approved-writer",
          root: writerRoot,
          access: "read",
          rootIdentity: writerIdentity,
          gitMetadata: { gitDirectory, commonDirectory },
        },
      ],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
      expiresAt: now + 120_000,
    },
    admission: {
      authorityId: "fixture-authority",
      ownerId: "fixture-owner",
      sessionId: "fixture-session",
      taskId: "fixture-task",
      taskEpoch: 1,
      computerId: "fixture-computer",
      computerGeneration: 1,
      workspaces: [
        {
          workspaceId: "approved-writer",
          mode: "subtree",
          root: writerRoot,
          access: "read",
        },
      ],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
      expiresAt: now + 120_000,
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
    savedChat: {
      protocol: "farol-next-saved-chat/v1",
      socketPath: savedChatSocketPath,
      token: savedChatToken,
    },
    codexTasks: {
      transport: "codex-shared-proxy/v1",
      host: {
        executablePath: binary,
        executableSha256: createHash("sha256")
          .update(await fs.readFile(binary))
          .digest("hex"),
        socketPath,
        expectedCodexHome: "/fixture/codex-home",
      },
      grant: {
        workspaceId: "approved-writer",
        writerRoot,
        writerIdentity,
        projectId,
        observeThreadId: ownerThreadId,
        discoverProjectTasks: true,
        discoverCanonicalProjectTasks: true,
        projectRoot,
        projectIdentity,
        gitCommonDirectory: commonDirectory,
        execution: { sandbox: "read-only", approvalPolicy: "on-request" },
        harness: "codex",
        tasks: {
          defaultHarness: "codex",
          harnesses: {
            codex: {
              defaultModel: "luna",
              models: {
                luna: { model: "gpt-6-luna", defaultEffort: "medium" },
              },
            },
          },
        },
        configSha256: createHash("sha256")
          .update(
            JSON.stringify([
              "farol-task-policy/1",
              "codex",
              [["codex", "luna", [["luna", "gpt-6-luna", "medium"]]]],
            ]),
          )
          .digest("hex"),
        expiresAt: now + 120_000,
      },
    },
  };
  const launchFile = path.join(launchRoot, "computer-launch.json");
  await fs.writeFile(launchFile, `${canonical(launch)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await prepareMcpLifecycle(launchFile);
  transport = new StdioClientTransport({
    command,
    args: [entry, "--launch-contract", launchFile],
    cwd: process.cwd(),
    stderr: "pipe",
    ...(packaged
      ? {
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? root,
            TMPDIR: process.env.TMPDIR ?? "/private/tmp",
          },
        }
      : {}),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  client = new Client({ name: "built-task-fixture", version: "1" });
  await fixtureFailure.wait(client.connect(transport));
  const tools = (await fixtureFailure.wait(client.listTools())).tools.map(
    (tool) => tool.name,
  );
  assert(tools.includes("codex_task_create"), stderr);
  assert(tools.includes("codex_task_status"), stderr);
  assert(tools.includes("codex_task_result"), stderr);
  assert(tools.includes("codex_task_observe"), stderr);
  assert(tools.includes("codex_task_adopt"), stderr);
  assert(tools.includes("codex_project_resolve"), stderr);
  assert(tools.includes("codex_project_tasks"), stderr);
  assert(tools.includes("codex_project_preference"), stderr);
  assert(tools.includes("codex_project_preferred"), stderr);
  assert(tools.includes("codex_task_history"), stderr);
  assert(tools.includes("chatgpt_chat_create"), stderr);
  assert(tools.includes("chatgpt_chat_status"), stderr);
  assert(!tools.includes("codex_task_message"), stderr);
  assert(!tools.includes("codex_task_title"), stderr);
  const preferenceInput = {
    key,
    workspaceId: "approved-writer",
    projectId,
    operation: "remember",
  };
  const beforePreference = calls.length;
  const preference = await callFixtureTool({
    name: "codex_project_preference",
    arguments: preferenceInput,
  });
  assert.deepEqual(preference.structuredContent, {
    status: "remembered",
    key,
    workspaceId: "approved-writer",
    projectId,
    persistence: "immutable-local-receipt",
    catalogue: "current-non-atomic",
    controlGranted: false,
  });
  assert.deepEqual(calls.slice(beforePreference), ["project/list"]);
  const preferenceRead = await callFixtureTool({
    name: "codex_project_preference",
    arguments: { ...preferenceInput, operation: "read" },
  });
  assert.equal(preferenceRead.structuredContent.status, "resolved");
  const beforePreferred = calls.length;
  const preferred = await callFixtureTool({
    name: "codex_project_preferred",
    arguments: { workspaceId: "approved-writer", projectId },
  });
  assert.deepEqual(preferred.structuredContent, {
    status: "resolved",
    workspaceId: "approved-writer",
    projectId,
    key,
    persistence: "immutable-local-receipt",
    selection: "latest-local-publication",
    snapshot: "non-atomic",
    controlGranted: false,
  });
  assert.deepEqual(calls.slice(beforePreferred), ["project/list"]);
  assert.equal(
    (
      await callFixtureTool({
        name: "codex_project_preferred",
        arguments: { workspaceId: "approved-writer", projectId: "foreign" },
      })
    ).isError,
    true,
  );
  assert.deepEqual(calls.slice(beforePreferred), ["project/list"]);
  const beforeForeignPreference = calls.length;
  assert.equal(
    (
      await callFixtureTool({
        name: "codex_project_preference",
        arguments: { ...preferenceInput, projectId: "foreign" },
      })
    ).isError,
    true,
  );
  assert.equal(calls.length, beforeForeignPreference);
  const beforeDiscovery = calls.length;
  const taskMetadata = await callFixtureTool({
    name: "codex_project_tasks",
    arguments: { workspaceId: "approved-writer", projectId },
  });
  assert.equal(taskMetadata.isError, undefined);
  assert.deepEqual(taskMetadata.structuredContent, {
    status: "tasks",
    workspaceId: "approved-writer",
    projectId,
    source: "stored",
    snapshot: "non-atomic",
    scope: "selected-writer",
    coverage: "single-page-metadata",
    controlGranted: false,
    tasks: [
      {
        id: ownerThreadId,
        title: "Farol · Native observer canary",
        configuredModel: "gpt-6-luna",
        updatedAt: 123,
      },
    ],
    nextCursor: null,
    complete: true,
  });
  assert(!JSON.stringify(taskMetadata).includes("PRIVATE FIXTURE PREVIEW"));
  assert.deepEqual(calls.slice(beforeDiscovery), [
    "project/list",
    "thread/list",
  ]);
  const beforeCanonicalMetadata = calls.length;
  const canonicalMetadata = await callFixtureTool({
    name: "codex_project_tasks",
    arguments: {
      workspaceId: "approved-writer",
      projectId,
      scope: "canonical-and-selected-writer",
    },
  });
  assert.equal(canonicalMetadata.isError, undefined);
  assert.equal(
    canonicalMetadata.structuredContent.scope,
    "canonical-and-selected-writer",
  );
  assert.equal(canonicalMetadata.structuredContent.controlGranted, false);
  assert.equal(canonicalMetadata.structuredContent.tasks[0].id, ownerThreadId);
  assert(
    !JSON.stringify(canonicalMetadata).includes("PRIVATE FIXTURE PREVIEW"),
  );
  assert.deepEqual(calls.slice(beforeCanonicalMetadata), [
    "project/list",
    "thread/list",
  ]);
  canonicalMetadataCwdFault = true;
  try {
    const foreignCwd = await callFixtureTool({
      name: "codex_project_tasks",
      arguments: {
        workspaceId: "approved-writer",
        projectId,
        scope: "canonical-and-selected-writer",
      },
    });
    assert.equal(foreignCwd.isError, true);
    assert.equal(foreignCwd.structuredContent.status, "unavailable");
    assert(!JSON.stringify(foreignCwd).includes("Native observer canary"));
  } finally {
    canonicalMetadataCwdFault = false;
  }
  const beforeForeignDiscovery = calls.length;
  assert.equal(
    (
      await callFixtureTool({
        name: "codex_project_tasks",
        arguments: { workspaceId: "approved-writer", projectId: "foreign" },
      })
    ).isError,
    true,
  );
  assert.equal(calls.length, beforeForeignDiscovery);
  const callsBeforeResolution = calls.length;
  const resolvedProject = await callFixtureTool({
    name: "codex_project_resolve",
    arguments: { workspaceId: "approved-writer" },
  });
  assert.equal(
    resolvedProject.isError,
    undefined,
    JSON.stringify(resolvedProject),
  );
  assert.deepEqual(resolvedProject.structuredContent, {
    status: "resolved",
    complete: true,
    pages: 1,
    matches: [{ projectId, name: null }],
    selectedProjectId: projectId,
    selection: "requested-id",
    workspaceId: "approved-writer",
    writerRoot,
    projectRoot,
  });
  assert.deepEqual(calls.slice(callsBeforeResolution), ["project/list"]);
  const savedChatCreate = await callFixtureTool({
    name: "chatgpt_chat_create",
    arguments: {
      key,
      title: "Harmless fixture title",
      firstMessage: "No live account message",
    },
  });
  assert.deepEqual(savedChatCreate.structuredContent, {
    status: "refused",
    code: "SAVED_CHAT_BROWSER_UNAVAILABLE",
    dispatchId: key,
  });
  const savedChatStatus = await callFixtureTool({
    name: "chatgpt_chat_status",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(savedChatStatus.structuredContent, { status: "unknown" });
  assert.deepEqual(savedChatCalls, ["create", "status"]);
  const negativeModes = [
    "foreign-verified",
    "foreign-refused",
    "foreign-unknown",
    "mixed-frame",
    "complete-frame-peer-open",
    "abrupt-close",
  ];
  for (const [index, mode] of negativeModes.entries()) {
    const dispatchId =
      "12345678-1234-4123-8123-" + String(index + 1).padStart(12, "0");
    savedChatNegative.set(dispatchId, mode);
    const count = savedChatCalls.length;
    const statusOnly = mode === "foreign-unknown";
    const result = await callFixtureTool({
      name: statusOnly ? "chatgpt_chat_status" : "chatgpt_chat_create",
      arguments: statusOnly
        ? { dispatchId }
        : {
            key: dispatchId,
            title: "Synthetic transport negative",
            firstMessage: "No account or Send",
          },
    });
    assert.deepEqual(
      result.structuredContent,
      mode === "complete-frame-peer-open"
        ? {
            status: "refused",
            code: "SAVED_CHAT_BROWSER_UNAVAILABLE",
            dispatchId,
          }
        : { status: "outcome_unknown", dispatchId },
    );
    assert.equal(savedChatCalls.length, count + 1, mode + ": no retry");
    // Bounded current-connection cleanup proof; not descendant process proof.
    const deadline = Date.now() + 2_000;
    while (!savedChatClosed.has(dispatchId) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(savedChatClosed.has(dispatchId), mode + ": owned connection closed");
  }

  const observed = await callFixtureTool({
    name: "codex_task_observe",
    arguments: {
      threadId: ownerThreadId,
      workspaceId: "approved-writer",
      projectId,
    },
  });
  assert.deepEqual(observed.structuredContent, {
    status: "observed",
    threadId: ownerThreadId,
    title: "Farol · Native observer canary",
    model: "gpt-6-luna",
    turns: [{ id: ownerTurnId, status: "completed" }],
    hasMoreTurns: false,
    threadRuntime: {
      ...runtimeSnapshot,
      state: "active",
      activeFlags: ["waitingOnUserInput"],
    },
  });
  const historyBefore = calls.length;
  const history = await callFixtureTool({
    name: "codex_task_history",
    arguments: {
      threadId: ownerThreadId,
      turnId: ownerTurnId,
      workspaceId: "approved-writer",
      projectId,
      tail: true,
    },
  });
  assert.deepEqual(history.structuredContent, {
    status: "history",
    source: "stored",
    snapshot: "non-atomic",
    coverage: "single-page-text-only",
    threadId: ownerThreadId,
    turnId: ownerTurnId,
    turnStatus: "completed",
    sortDirection: "desc",
    items: [
      {
        id: "owner-answer",
        kind: "agent_message",
        phase: "final_answer",
        text: "Exact owner-created fixture answer",
      },
    ],
    nextCursor: null,
    complete: true,
  });
  assert.deepEqual(calls.slice(historyBefore), [
    "project/list",
    "thread/read",
    "thread/turns/list",
    "thread/items/list",
    "thread/read",
  ]);
  const foreignHistoryBefore = calls.length;
  const foreignHistory = await callFixtureTool({
    name: "codex_task_history",
    arguments: {
      threadId: "323c8bfa-806c-4bb0-b07e-9e90b3a6471a",
      turnId: ownerTurnId,
      workspaceId: "approved-writer",
      projectId,
    },
  });
  assert.equal(foreignHistory.structuredContent.status, "refused");
  assert.equal(calls.length, foreignHistoryBefore);
  const adopted = await callFixtureTool({
    name: "codex_task_adopt",
    arguments: {
      threadId: ownerThreadId,
      turnId: ownerTurnId,
      workspaceId: "approved-writer",
      projectId,
    },
  });
  assert.deepEqual(adopted.structuredContent, {
    status: "adopted",
    dispatchId: ownerTurnId,
  });
  const repeatedAdoption = await callFixtureTool({
    name: "codex_task_adopt",
    arguments: {
      threadId: ownerThreadId,
      turnId: ownerTurnId,
      workspaceId: "approved-writer",
      projectId,
    },
  });
  assert.deepEqual(
    repeatedAdoption.structuredContent,
    adopted.structuredContent,
  );
  const adoptedStatus = await callFixtureTool({
    name: "codex_task_status",
    arguments: { dispatchId: ownerTurnId },
  });
  assert.deepEqual(adoptedStatus.structuredContent, {
    status: "known",
    dispatchId: ownerTurnId,
    turnStatus: "completed",
    threadRuntime: {
      ...runtimeSnapshot,
      state: "active",
      activeFlags: ["waitingOnUserInput"],
    },
  });
  const adoptedResult = await callFixtureTool({
    name: "codex_task_result",
    arguments: { dispatchId: ownerTurnId },
  });
  assert.deepEqual(adoptedResult.structuredContent, {
    status: "completed",
    dispatchId: ownerTurnId,
    text: "Exact owner-created fixture answer",
  });
  assert.equal(calls.filter((method) => method === "thread/start").length, 0);
  assert.equal(calls.filter((method) => method === "turn/start").length, 0);
  const readsBeforeWrongThread = calls.filter(
    (method) => method === "thread/read",
  ).length;
  const wrongThread = await callFixtureTool({
    name: "codex_task_observe",
    arguments: {
      threadId: "323c8bfa-806c-4bb0-b07e-9e90b3a6471a",
      workspaceId: "approved-writer",
      projectId,
    },
  });
  assert.deepEqual(wrongThread.structuredContent, {
    status: "refused",
    code: "HANDOFF_TASK_ADMISSION_DENIED",
  });
  assert.equal(
    calls.filter((method) => method === "thread/read").length,
    readsBeforeWrongThread,
  );
  const wrongProject = await callFixtureTool({
    name: "codex_task_observe",
    arguments: {
      threadId: ownerThreadId,
      workspaceId: "approved-writer",
      projectId: "wrong-project",
    },
  });
  assert.deepEqual(wrongProject.structuredContent, {
    status: "refused",
    code: "HANDOFF_TASK_ADMISSION_DENIED",
  });
  assert.equal(calls.filter((method) => method === "thread/start").length, 0);
  assert.equal(calls.filter((method) => method === "turn/start").length, 0);
  const created = await callFixtureTool({
    name: "codex_task_create",
    arguments: {
      key,
      workspaceId: "approved-writer",
      projectId,
      message: "Read README H1",
    },
  });
  assert.deepEqual(created.structuredContent, {
    status: "dispatched",
    dispatchId: key,
  });
  assert.equal(calls.filter((method) => method === "turn/steer").length, 0);
  const beforeRuntime = calls.length;
  const waiting = await callFixtureTool({
    name: "codex_task_result",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(waiting.structuredContent, {
    status: "running",
    dispatchId: key,
    threadRuntime: {
      ...runtimeSnapshot,
      state: "active",
      activeFlags: ["waitingOnApproval"],
    },
  });
  runtimeStatus = { type: "active", activeFlags: ["unknown-future-flag"] };
  const malformedRuntime = await callFixtureTool({
    name: "codex_task_status",
    arguments: { dispatchId: key },
  });
  assert.equal(malformedRuntime.isError, true);
  assert.deepEqual(malformedRuntime.structuredContent, {
    status: "outcome_unknown",
    dispatchId: key,
  });
  runtimeStatus = { type: "active", activeFlags: [] };
  const clearedRuntime = await callFixtureTool({
    name: "codex_task_result",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(clearedRuntime.structuredContent, {
    status: "running",
    dispatchId: key,
    threadRuntime: { ...runtimeSnapshot, state: "active", activeFlags: [] },
  });
  assert.deepEqual(calls.slice(beforeRuntime), [
    "thread/read",
    "thread/turns/list",
    "thread/read",
    "thread/read",
    "thread/turns/list",
  ]);
  turnStatus = "completed";
  const status = await callFixtureTool({
    name: "codex_task_status",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(status.structuredContent, {
    status: "known",
    dispatchId: key,
    turnStatus: "completed",
    threadRuntime: { ...runtimeSnapshot, state: "active", activeFlags: [] },
  });
  const result = await callFixtureTool({
    name: "codex_task_result",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(result.structuredContent, {
    status: "completed",
    dispatchId: key,
    text: "Exact built-byte fixture answer",
  });
  assert.equal(calls.filter((method) => method === "thread/start").length, 1);
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);
  await client.close();
  await transport.close();
  client = undefined;
  transport = undefined;

  // Reopen the same sealed launch: durable project choice and task identity
  // survive MCP process disconnect; observation must not create another turn.
  await prepareMcpLifecycle(launchFile);
  transport = new StdioClientTransport({
    command,
    args: [entry, "--launch-contract", launchFile],
    cwd: process.cwd(),
    stderr: "pipe",
    ...(packaged
      ? {
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? root,
            TMPDIR: process.env.TMPDIR ?? "/private/tmp",
          },
        }
      : {}),
  });
  client = new Client({ name: "reconnected-task-fixture", version: "1" });
  await fixtureFailure.wait(client.connect(transport));
  const beforeReconnect = calls.length;
  const restoredPreference = await callFixtureTool({
    name: "codex_project_preference",
    arguments: { ...preferenceInput, operation: "read" },
  });
  assert.equal(restoredPreference.structuredContent.status, "resolved");
  const restoredStatus = await callFixtureTool({
    name: "codex_task_status",
    arguments: { dispatchId: key },
  });
  assert.deepEqual(restoredStatus.structuredContent, {
    status: "known",
    dispatchId: key,
    turnStatus: "completed",
    threadRuntime: { ...runtimeSnapshot, state: "active", activeFlags: [] },
  });
  assert.deepEqual(calls.slice(beforeReconnect), [
    "project/list",
    "thread/read",
    "thread/turns/list",
  ]);
  assert.equal(calls.filter((method) => method === "thread/start").length, 1);
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);
  await client.close();
  await transport.close();
  client = undefined;
  transport = undefined;

  const unavailableLaunch = structuredClone(launch);
  unavailableLaunch.codexTasks.host.socketPath = path.join(
    root,
    "missing.sock",
  );
  const unavailableLaunchRoot = path.join(root, "launch-without-task-host");
  await fs.mkdir(unavailableLaunchRoot, { mode: 0o700 });
  const unavailableLaunchFile = path.join(
    unavailableLaunchRoot,
    "computer-launch.json",
  );
  await fs.writeFile(
    unavailableLaunchFile,
    `${canonical(unavailableLaunch)}\n`,
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  await prepareMcpLifecycle(unavailableLaunchFile);
  transport = new StdioClientTransport({
    command,
    args: [entry, "--launch-contract", unavailableLaunchFile],
    cwd: process.cwd(),
    stderr: "pipe",
    ...(packaged
      ? {
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? root,
            TMPDIR: process.env.TMPDIR ?? "/private/tmp",
          },
        }
      : {}),
  });
  client = new Client({ name: "built-task-host-down", version: "1" });
  await fixtureFailure.wait(client.connect(transport));
  const remainingTools = (
    await fixtureFailure.wait(client.listTools())
  ).tools.map((tool) => tool.name);
  assert(remainingTools.includes("computer_workspace_list"));
  assert(!remainingTools.some((tool) => tool.startsWith("codex_task_")));
  assert(remainingTools.includes("chatgpt_chat_status"));
  const listed = await callFixtureTool({
    name: "computer_workspace_list",
    arguments: { workspaceId: "approved-writer", relativePath: "." },
  });
  assert.notEqual(listed.isError, true);
  process.stdout.write(
    `PASS: ${packaged ? "packaged" : "built"} Computer MCP project resolution/task route and fake saved-chat Browser endpoint including six frame/close negatives used disposable sockets; unavailable task host left Computer working; no model or live ChatGPT turn.\n`,
  );
} catch (error) {
  injectedFailureObserved = error === callbackAssertion;
  throw error;
} finally {
  await client?.close().catch(() => undefined);
  await transport?.close().catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  if (server.listening) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (savedChatServer.listening) {
    await new Promise((resolve) => savedChatServer.close(() => resolve()));
  }
  await fs.rm(root, { recursive: true, force: true });
  if (callbackFailure && injectedFailureObserved) {
    assert.equal(server.listening, false);
    assert.equal(savedChatServer.listening, false);
    assert.equal(sockets.size, 0);
    await assert.rejects(fs.stat(root), { code: "ENOENT" });
    process.stdout.write(
      "PASS: injected callback failure unwound awaited teardown; disposable servers/sockets/root removed. Native descendants are not qualified.\n",
    );
  }
}
