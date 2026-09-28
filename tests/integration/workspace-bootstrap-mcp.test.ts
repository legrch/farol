import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
} from "../../src/modules/computer/domain/execution-authority";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { rootIdentityOf } from "../fixtures/root-identity";

let root = "";
const close: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-instructions-")),
  );
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true });
  await fs.writeFile(
    path.join(root, "AGENTS.md"),
    "# Root rules\nUse ordinary Git.\n",
  );
  await fs.writeFile(
    path.join(root, "src", "AGENTS.md"),
    "# Source rules\nKeep strict checks.\n",
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of close.splice(0)) await dispose();
  await fs.rm(root, { recursive: true, force: true });
});

async function connect(
  options: {
    excluded?: string[];
    readScope?: string;
    revokeAfterRead?: boolean;
    workspaceRoot?: string;
    changeAfterRead?: boolean;
    exactOnly?: boolean;
  } = {},
) {
  const workspaceRoot = options.workspaceRoot ?? root;
  const selectedRoot = options.readScope
    ? path.join(workspaceRoot, options.readScope)
    : workspaceRoot;
  const approved: ComputerApproval = {
    ownerId: "owner",
    computerId: "computer",
    generation: 1,
    workspaces: [
      {
        workspaceId: "selected",
        root: workspaceRoot,
        access: "read",
        rootIdentity: rootIdentityOf(workspaceRoot),
      },
    ],
    capabilities: ["workspace.list", "workspace.read"],
    network: "none",
    commands: "none",
    expiresAt: 10000,
    excludedPaths:
      options.excluded?.map((relative) => ({
        workspaceId: "selected",
        path: path.join(workspaceRoot, relative),
      })) ?? [],
  };
  const grant = deriveTaskGrant(
    approved,
    {
      authorityId: "admission",
      ownerId: "owner",
      sessionId: "session",
      taskId: "task",
      taskEpoch: 1,
      computerId: "computer",
      computerGeneration: 1,
      workspaces: [
        {
          workspaceId: "selected",
          root: selectedRoot,
          ...(options.exactOnly
            ? {
                mode: "exact" as const,
                paths: [path.join(selectedRoot, "AGENTS.md")],
              }
            : { mode: "subtree" as const }),
          access: "read",
        },
      ],
      capabilities: approved.capabilities,
      network: "none",
      commands: "none",
      expiresAt: 9000,
    },
    1000,
  );
  if (!grant.ok) throw new Error(grant.error.code);
  const authority = createParticipantAuthority(grant.value, {
    participantId: "main",
    role: "main",
    mutationOwnership: "none",
  });
  if (!authority.ok) throw new Error(authority.error.code);
  let revoked = false;
  const native = new NativeReadonlyWorkspace({
    helperPath: path.resolve("resources/native/safe_open.py"),
    helper: NEXT_SAFE_OPEN_HELPER,
    attestInterpreter: async () => "/usr/bin/python3",
  });
  const handler = new ReadonlyComputerContractHandler(
    new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([authority.value]),
      {
        async get() {
          return revoked ? null : approved;
        },
      },
      {
        async execute(request, context) {
          const result = await native.execute(request, context);
          if (
            options.revokeAfterRead &&
            request.operation.kind === "workspace.read"
          )
            revoked = true;
          if (
            options.changeAfterRead &&
            request.operation.kind === "workspace.read" &&
            request.operation.relativePath === "AGENTS.md"
          )
            await fs.writeFile(
              path.join(workspaceRoot, "AGENTS.md"),
              "# Concurrent change\n",
            );
          return result;
        },
      },
      { now: () => 1000 },
    ),
  );
  const server = createReadonlyComputerMcpServer(handler, {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task",
    taskEpoch: 1,
    participantId: "main",
    turnId: "turn",
    generation: 1,
  });
  const client = new Client({ name: "instructions-fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe("approved workspace instruction bootstrap through MCP", () => {
  it("returns applicable root and nested AGENTS, explicit absence and selected root identity", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src/nested" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      complete: true,
      root,
      approvedRoot: { path: root, ...rootIdentityOf(root) },
      instructions: [
        {
          relativePath: "AGENTS.md",
          status: "read",
          text: "# Root rules\nUse ordinary Git.\n",
        },
        {
          relativePath: "src/AGENTS.md",
          status: "read",
          text: "# Source rules\nKeep strict checks.\n",
        },
        { relativePath: "src/nested/AGENTS.md", status: "not_found" },
      ],
    });
  });
  it("never searches ancestors outside a narrowed approved task scope", async () => {
    const client = await connect({ readScope: "src" });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "nested" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      root: path.join(root, "src"),
      instructions: [
        {
          relativePath: "AGENTS.md",
          text: "# Source rules\nKeep strict checks.\n",
        },
        { relativePath: "nested/AGENTS.md", status: "not_found" },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
  it("reports an excluded instruction as unavailable rather than absent or fully read", async () => {
    const client = await connect({ excluded: ["src/AGENTS.md"] });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src/nested" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      complete: false,
      instructions: [
        { status: "read" },
        {
          relativePath: "src/AGENTS.md",
          status: "unavailable",
          code: "AUTHORITY_PATH_DENIED",
        },
        { status: "not_found" },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Source rules",
    );
  });
  it("does not return previously read instruction text after approval revocation", async () => {
    const client = await connect({ revokeAfterRead: true });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_APPROVAL_NOT_FOUND" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
  it("publishes guidance by listed IDs and refuses invented file references", async () => {
    const client = await connect();
    const found = await client.callTool({
      name: "computer_guidance_search",
      arguments: { query: "instructions workspace" },
    });
    expect(found.structuredContent).toMatchObject({
      ok: true,
      schema: 1,
      entries: expect.arrayContaining([
        expect.objectContaining({ id: "computer-start" }),
      ]),
    });
    const fetch = await client.callTool({
      name: "computer_guidance_fetch",
      arguments: { id: "computer-start" },
    });
    expect(fetch.structuredContent).toMatchObject({
      ok: true,
      entry: {
        id: "computer-start",
        references: ["computer-files", "computer-shell", "computer-outcomes"],
      },
    });
    const invented = await client.callTool({
      name: "computer_guidance_fetch",
      arguments: { id: "../../AGENTS.md" },
    });
    expect(invented.structuredContent).toMatchObject({
      ok: false,
      status: "unavailable",
      error: { code: "GUIDANCE_NOT_PUBLISHED" },
    });
  });
  it("binds bootstrap to an actual selected linked worktree, not the primary checkout", async () => {
    const run = promisify(execFile);
    const git = (await run("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();
    const templates = path.join(root, "empty-templates");
    const hooks = path.join(root, "hostile-hooks");
    const sentinel = path.join(root, "hook-was-run");
    await fs.mkdir(templates);
    await fs.mkdir(hooks);
    await fs.writeFile(
      path.join(hooks, "pre-commit"),
      `#!/bin/sh\nprintf 'unsafe' > '${sentinel}'\n`,
      { mode: 0o700 },
    );
    const hostileConfig = path.join(root, "ambient-config");
    await fs.writeFile(
      hostileConfig,
      `[core]\n hooksPath = ${JSON.stringify(hooks)}\n[commit]\n gpgSign = true\n`,
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", hostileConfig);
    const fixtureGit = (args: string[]) =>
      run(
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
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TEMPLATE_DIR: templates,
            GIT_TERMINAL_PROMPT: "0",
            LANG: "C",
          },
        },
      );
    await fixtureGit(["init", "--quiet", root]);
    await fixtureGit(["-C", root, "add", "AGENTS.md", "src/AGENTS.md"]);
    await fixtureGit([
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid.example",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const writer = path.join(root, "selected-writer");
    await fixtureGit([
      "-C",
      root,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      writer,
      "HEAD",
    ]);
    await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(writer, "AGENTS.md"), "# Writer rules\n");
    const client = await connect({ workspaceRoot: writer });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      root: writer,
      approvedRoot: { path: writer, ...rootIdentityOf(writer) },
      instructions: [
        { relativePath: "AGENTS.md", text: "# Writer rules\n" },
        { relativePath: "src/AGENTS.md", status: "read" },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
  it("refuses an excluded working directory before returning any instruction", async () => {
    const client = await connect({ excluded: ["src"] });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
  it("does not follow a symlink instruction to outside text", async () => {
    const secret = path.join(root, "outside-rules.txt");
    await fs.writeFile(secret, "Outside text must not be disclosed");
    await fs.symlink(secret, path.join(root, "src/nested/AGENTS.md"));
    const client = await connect();
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src/nested" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      complete: false,
      instructions: [
        { status: "read" },
        { status: "read" },
        { status: "unavailable", code: "WORKSPACE_PATH_REFUSED" },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Outside text",
    );
  });
  it("labels instruction response-budget exhaustion without returning partial text", async () => {
    await fs.writeFile(path.join(root, "src/AGENTS.md"), "x".repeat(64 * 1024));
    const client = await connect();
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      complete: false,
      instructions: [
        { status: "read" },
        { status: "unavailable", code: "COMPUTER_INSTRUCTION_BYTE_LIMIT" },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "x".repeat(100),
    );
  });
  it("does not merge old and concurrently edited instructions into a complete chain", async () => {
    const client = await connect({ changeAfterRead: true });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "src" },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_INSTRUCTIONS_CHANGED" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
  it("fails a depth overflow and canonical path escape without reading anything", async () => {
    const client = await connect();
    const deep = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: {
        workspaceId: "selected",
        relativeDirectory: Array(33).fill("a").join("/"),
      },
    });
    expect(deep.structuredContent).toMatchObject({
      ok: false,
      error: { code: "COMPUTER_INSTRUCTION_DEPTH_LIMIT" },
    });
    const escape = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "../other" },
    });
    expect(escape.isError).toBe(true);
  });
  it("does not bootstrap a directory from an exact-file-only grant", async () => {
    const client = await connect({ exactOnly: true });
    const result = await client.callTool({
      name: "computer_workspace_bootstrap",
      arguments: { workspaceId: "selected", relativeDirectory: "." },
    });
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "AUTHORITY_PATH_DENIED" },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      "Root rules",
    );
  });
});
