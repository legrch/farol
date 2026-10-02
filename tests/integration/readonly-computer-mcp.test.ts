import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  ReadonlyComputerCallRequestSchema,
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerContract,
} from "../../src/modules/computer/contract/readonly-computer-contract";
import {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { rootIdentityOf } from "../fixtures/root-identity";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const sourceHelper = path.join(nextRoot, "resources/native/safe_open.py");
const executeFile = promisify(execFile);
let root = "";
let git = "";
let head = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-mcp-"));
  root = await fs.realpath(root);
  await fs.chmod(root, 0o700);
  git = (await executeFile("/usr/bin/xcrun", ["--find", "git"])).stdout.trim();
  await executeFile(git, ["init", "--quiet", root]);
  await fs.mkdir(path.join(root, "src"), { mode: 0o700 });
  await fs.writeFile(
    path.join(root, "src", "discovered.ts"),
    "export const protocol = 'mcp-boundary';\n",
    { mode: 0o600 },
  );
  await executeFile(git, ["-C", root, "add", "src/discovered.ts"]);
  await executeFile(git, [
    "-C",
    root,
    "-c",
    "user.name=Farol Test",
    "-c",
    "user.email=farol-test@invalid.example",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  head = (await executeFile(git, ["-C", root, "rev-parse", "HEAD"])).stdout;
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("read-only Computer MCP adapter", () => {
  it("lists only bounded read-only tools and carries delegated authority through real MCP calls", async () => {
    const approval: ComputerApproval = {
      ownerId: "owner-preview",
      computerId: "computer-preview",
      generation: 7,
      workspaces: [
        {
          workspaceId: "farol",
          root,
          access: "read",
          rootIdentity: rootIdentityOf(root),
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
      expiresAt: 20_000,
    };
    const admission: TaskAdmission = {
      authorityId: "authority-task-a",
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      computerId: "computer-preview",
      computerGeneration: 7,
      workspaces: [
        {
          workspaceId: "farol",
          mode: "subtree",
          root,
          access: "read",
        },
      ],
      capabilities: approval.capabilities,
      network: "none",
      commands: "verification",
      expiresAt: 10_000,
    };
    const grant = deriveTaskGrant(approval, admission, 1_000);
    if (!grant.ok) throw new Error(grant.error.code);
    const main = createParticipantAuthority(grant.value, {
      participantId: "main-a",
      role: "main",
      mutationOwnership: "none",
    });
    if (!main.ok) throw new Error(main.error.code);
    const agent = delegateParticipantAuthority(main.value, {
      participantId: "agent-a",
      role: "agent",
      mutationOwnership: "none",
    });
    if (!agent.ok) throw new Error(agent.error.code);
    const critic = delegateParticipantAuthority(agent.value, {
      participantId: "critic-a",
      role: "critic",
      mutationOwnership: "none",
    });
    if (!critic.ok) throw new Error(critic.error.code);

    const handler = new ReadonlyComputerContractHandler(
      new RunReadonlyComputerAction(
        new InMemoryAuthorityRepository([
          main.value,
          agent.value,
          critic.value,
        ]),
        new InMemoryComputerApprovalRepository([approval]),
        new NativeReadonlyWorkspace({
          helperPath: sourceHelper,
          helper: NEXT_SAFE_OPEN_HELPER,
          attestInterpreter: async () => "/usr/bin/python3",
          attestGit: async () => git,
        }),
        { now: () => 1_000 },
      ),
    );
    const executionSignals: (AbortSignal | undefined)[] = [];
    const contract: ReadonlyComputerContract = {
      execute(request, context) {
        executionSignals.push(context?.signal);
        return handler.execute(request, context);
      },
    };
    const server = createReadonlyComputerMcpServer(contract, {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    });
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "computer_workspace_bootstrap",
        "computer_guidance_search",
        "computer_guidance_fetch",
        "computer_workspace_list",
        "computer_workspace_read",
        "computer_workspace_search",
        "computer_workspace_git_status",
        "computer_workspace_git_head",
      ]);
      expect(
        listed.tools.every(
          (tool) =>
            tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint === false,
        ),
      ).toBe(true);

      const searched = await client.callTool({
        name: "computer_workspace_search",
        arguments: {
          workspaceId: "farol",
          relativePath: ".",
          pattern: "mcp-boundary",
        },
      });
      expect(searched.isError).not.toBe(true);
      expect(searched.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        output: {
          kind: "workspace.matches",
          matches: [{ path: "src/discovered.ts", line: 1 }],
        },
      });

      const read = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/discovered.ts",
        },
      });
      expect(read.structuredContent).toMatchObject({
        participantId: "critic-a",
        taskId: "task-a",
        output: {
          kind: "workspace.text",
          text: "export const protocol = 'mcp-boundary';\n",
          sha256: createHash("sha256")
            .update("export const protocol = 'mcp-boundary';\n")
            .digest("hex"),
        },
      });
      const content = read.content[0];
      expect(content?.type).toBe("text");
      if (content?.type !== "text") throw new Error("missing text content");
      const envelope = ReadonlyComputerCallResponseSchema.parse({
        ok: true,
        value: read.structuredContent,
      });
      if (!envelope.ok) throw new Error("missing read response");
      expect(JSON.parse(content.text)).toEqual(envelope.value.output);
      expect((read.structuredContent as { callId?: unknown }).callId).toEqual(
        expect.any(String),
      );

      const listedRoot = await client.callTool({
        name: "computer_workspace_list",
        arguments: { workspaceId: "farol", relativePath: "." },
      });
      expect(listedRoot.isError).not.toBe(true);
      expect(listedRoot.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        operation: { kind: "workspace.list", relativePath: "." },
        output: { kind: "workspace.entries", entries: ["src/"] },
      });

      const status = await client.callTool({
        name: "computer_workspace_git_status",
        arguments: { workspaceId: "farol" },
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        operation: {
          kind: "verification.run",
          command: "git.status",
          relativePath: ".",
        },
        output: {
          kind: "workspace.command",
          command: "git.status",
          exitCode: 0,
          network: "none",
        },
      });

      const exactHead = await client.callTool({
        name: "computer_workspace_git_head",
        arguments: { workspaceId: "farol" },
      });
      expect(exactHead.isError).not.toBe(true);
      expect(exactHead.structuredContent).toMatchObject({
        participantId: "critic-a",
        workspaceId: "farol",
        operation: {
          kind: "verification.run",
          command: "git.head",
          relativePath: ".",
        },
        output: {
          kind: "workspace.command",
          command: "git.head",
          stdout: head,
          exitCode: 0,
          network: "none",
        },
      });

      const injected = await client.callTool({
        name: "computer_workspace_git_status",
        arguments: { workspaceId: "farol", command: "rm -rf ." },
      });
      expect(injected.isError).toBe(true);

      const spoofed = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/discovered.ts",
          ownerId: "owner-attacker",
        },
      });
      expect(spoofed.isError).toBe(true);

      // The native helper bounds excerpts in Unicode code points, including
      // astral characters; the public MCP response must preserve that bound.
      for (const count of [251, 500, 501]) {
        await fs.writeFile(
          path.join(root, "src", "emoji.txt"),
          "😀".repeat(count),
        );
        const unicode = await client.callTool({
          name: "computer_workspace_search",
          arguments: {
            workspaceId: "farol",
            relativePath: "src/emoji.txt",
            pattern: "😀",
          },
        });
        expect(unicode.isError).not.toBe(true);
        expect(unicode.structuredContent).toMatchObject({
          output: {
            kind: "workspace.matches",
            matches: [
              {
                path: "src/emoji.txt",
                line: 1,
                text: "😀".repeat(Math.min(count, 500)),
                truncated: count > 500,
              },
            ],
            resultLimited: false,
            scanLimited: false,
          },
        });
      }

      // C05-06: a file over the whole-read ceiling is read in windows.
      await fs.writeFile(
        path.join(root, "src", "large.log"),
        "x".repeat(300_000),
        { mode: 0o600 },
      );
      const whole = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "src/large.log" },
      });
      expect(whole.isError).toBe(true);
      expect(whole.structuredContent).toMatchObject({
        error: { code: "WORKSPACE_FILE_TOO_LARGE" },
      });
      const first = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/large.log",
          offset: 0,
        },
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        operation: {
          kind: "workspace.read",
          relativePath: "src/large.log",
          range: { offset: 0, length: 65_536 },
        },
        output: {
          kind: "workspace.text",
          bytes: 65_536,
          page: { offset: 0, size: 300_000, nextOffset: 65_536 },
        },
      });
      const last = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/large.log",
          offset: 262_144,
          length: 262_144,
        },
      });
      expect(last.structuredContent).toMatchObject({
        output: {
          kind: "workspace.text",
          bytes: 37_856,
          page: { offset: 262_144, size: 300_000, nextOffset: null },
        },
      });
      const oversized = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "src/large.log",
          offset: 0,
          length: 262_145,
        },
      });
      expect(oversized.isError).toBe(true);
      expect(executionSignals.length).toBeGreaterThan(0);
      expect(
        executionSignals.every((signal) => signal instanceof AbortSignal),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("accepts only an exactly correlated refusal from the Computer contract", async () => {
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: false,
          correlation: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId:
              request.operation.relativePath === "foreign.txt"
                ? "agent-foreign"
                : request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            operation:
              request.operation.relativePath === "operation.txt"
                ? {
                    kind: "workspace.list" as const,
                    relativePath: request.operation.relativePath,
                  }
                : request.operation,
          },
          error: {
            code: "AUTHORITY_PATH_DENIED",
            source: "owner-restriction",
            retry: "never",
          },
        };
      },
    };
    const server = createReadonlyComputerMcpServer(contract, {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    });
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const exact = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "denied.txt" },
      });
      expect(exact.isError).toBe(true);
      expect(exact.structuredContent).toMatchObject({
        ok: false,
        correlation: { participantId: "critic-a", taskId: "task-a" },
        error: {
          code: "AUTHORITY_PATH_DENIED",
          source: "owner-restriction",
        },
      });

      const foreign = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "foreign.txt" },
      });
      expect(foreign.isError).toBe(true);
      expect(foreign.structuredContent).toEqual({
        ok: false,
        error: {
          code: "COMPUTER_CONTRACT_CORRELATION",
          source: "contract",
          retry: "never",
        },
      });

      const foreignOperation = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "operation.txt" },
      });
      expect(foreignOperation.isError).toBe(true);
      expect(foreignOperation.structuredContent).toEqual({
        ok: false,
        error: {
          code: "COMPUTER_CONTRACT_CORRELATION",
          source: "contract",
          retry: "never",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("CC-15 refuses every Computer tool while a summary-only fence is raised, before the contract is consulted, and admits it again once lowered", async () => {
    let executions = 0;
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        executions += 1;
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: false,
          correlation: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId: request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: request.operation.relativePath,
            operation: request.operation,
          },
          error: {
            code: "AUTHORITY_PATH_DENIED",
            source: "owner-restriction",
            retry: "never",
          },
        };
      },
    };
    let phase: "open" | "fenced" | "unreadable" = "fenced";
    const fence = {
      admits: async () =>
        phase === "open"
          ? { admitted: true as const }
          : {
              admitted: false as const,
              code:
                phase === "fenced"
                  ? ("COMPUTER_SUMMARY_PHASE_ACTIVE" as const)
                  : ("COMPUTER_EXECUTION_FENCE_UNREADABLE" as const),
            },
      acquireAdmission: async () =>
        phase === "open"
          ? { admitted: true as const, release: async () => undefined }
          : {
              admitted: false as const,
              code:
                phase === "fenced"
                  ? ("COMPUTER_SUMMARY_PHASE_ACTIVE" as const)
                  : ("COMPUTER_EXECUTION_FENCE_UNREADABLE" as const),
            },
      reserveShell: async () => undefined,
      clearShell: async () => undefined,
      quarantineShell: () => undefined,
    };
    const server = createReadonlyComputerMcpServer(
      contract,
      {
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        taskEpoch: 3,
        participantId: "main-a",
        turnId: "turn-a",
        generation: 2,
      },
      undefined,
      undefined,
      undefined,
      fence,
    );
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      // The catalogue stays visible; execution does not.
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain(
        "computer_workspace_read",
      );
      for (const call of [
        {
          name: "computer_workspace_list",
          arguments: { workspaceId: "farol", relativePath: "." },
        },
        {
          name: "computer_workspace_read",
          arguments: { workspaceId: "farol", relativePath: "src/a.ts" },
        },
        {
          name: "computer_workspace_search",
          arguments: { workspaceId: "farol", relativePath: ".", pattern: "x" },
        },
        {
          name: "computer_workspace_git_status",
          arguments: { workspaceId: "farol" },
        },
      ]) {
        const refused = await client.callTool(call);
        expect(refused.isError, call.name).toBe(true);
        expect(refused.structuredContent, call.name).toEqual({
          ok: false,
          error: {
            code: "COMPUTER_SUMMARY_PHASE_ACTIVE",
            source: "execution-fence",
            retry: "later",
          },
        });
      }
      expect(executions).toBe(0);

      // A fence that cannot be read fails closed too.
      phase = "unreadable";
      const unreadable = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "src/a.ts" },
      });
      expect(unreadable.structuredContent).toMatchObject({
        ok: false,
        error: { code: "COMPUTER_EXECUTION_FENCE_UNREADABLE" },
      });
      expect(executions).toBe(0);

      // Lowered: the same call reaches the contract.
      phase = "open";
      const admitted = await client.callTool({
        name: "computer_workspace_read",
        arguments: { workspaceId: "farol", relativePath: "src/a.ts" },
      });
      expect(admitted.structuredContent).toMatchObject({
        ok: false,
        error: { code: "AUTHORITY_PATH_DENIED" },
      });
      expect(executions).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("C05-06 accepts a window only for the exact range that was asked", async () => {
    // The fake contract answers every read successfully; the file name picks
    // how it misbehaves.
    const contract: ReadonlyComputerContract = {
      async execute(value) {
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        if (request.operation.kind !== "workspace.read") {
          throw new Error("unexpected operation");
        }
        const name = request.operation.relativePath;
        const range = request.operation.range;
        const echoed =
          name === "shifted.txt" && range
            ? { ...request.operation, range: { ...range, offset: 1 } }
            : request.operation;
        const page =
          name === "unwindowed.txt" || range === undefined
            ? { sha256: createHash("sha256").update("abcd").digest("hex") }
            : {
                page: {
                  offset: range.offset,
                  size: 100_000,
                  nextOffset: range.offset + 4,
                },
              };
        return {
          ok: true,
          value: {
            ownerId: request.ownerId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            taskEpoch: request.taskEpoch,
            participantId: request.participantId,
            turnId: request.turnId,
            generation: request.generation,
            callId: request.callId,
            workspaceId: request.workspaceId,
            relativePath: name,
            operation: echoed,
            output: {
              kind: "workspace.text",
              text: "abcd",
              bytes: 4,
              ...(name === "windowed-whole.txt"
                ? { page: { offset: 0, size: 4, nextOffset: null } }
                : page),
            },
          },
        };
      },
    };
    const server = createReadonlyComputerMcpServer(contract, {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    });
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const correlationFailure = {
      ok: false,
      error: {
        code: "COMPUTER_CONTRACT_CORRELATION",
        source: "contract",
        retry: "never",
      },
    };
    try {
      const exact = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: "farol",
          relativePath: "exact.txt",
          length: 4,
        },
      });
      expect(exact.isError).not.toBe(true);
      expect(exact.structuredContent).toMatchObject({
        operation: { range: { offset: 0, length: 4 } },
        output: { page: { offset: 0, nextOffset: 4 } },
      });

      for (const [relativePath, extra] of [
        ["shifted.txt", { offset: 8 }],
        ["unwindowed.txt", { offset: 8 }],
        ["windowed-whole.txt", {}],
      ] as const) {
        const answer = await client.callTool({
          name: "computer_workspace_read",
          arguments: { workspaceId: "farol", relativePath, ...extra },
        });
        expect(answer.isError).toBe(true);
        expect(answer.structuredContent).toEqual(
          relativePath === "shifted.txt"
            ? correlationFailure
            : {
                ok: false,
                error: {
                  code: "COMPUTER_CONTRACT_INVALID",
                  source: "contract",
                  retry: "never",
                },
              },
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses malformed or mismatched public read outputs at the MCP boundary", async () => {
    const contract: ReadonlyComputerContract = {
      async execute(raw) {
        const request = ReadonlyComputerCallRequestSchema.parse(raw);
        const output = {
          kind: "workspace.text" as const,
          text: "abcd",
          bytes: 4,
          sha256: createHash("sha256").update("abcd").digest("hex"),
        };
        const name = request.operation.relativePath;
        if (name === "missing.txt") Reflect.deleteProperty(output, "sha256");
        if (name === "malformed.txt")
          Reflect.set(output, "sha256", "A".repeat(64));
        if (name === "unknown.txt") Reflect.set(output, "extra", true);
        if (name === "sha-on-page.txt" || name === "page-for-full.txt") {
          Reflect.set(output, "page", { offset: 0, size: 4, nextOffset: null });
          if (name === "page-for-full.txt")
            Reflect.deleteProperty(output, "sha256");
        }
        return { ok: true, value: { ...request, relativePath: name, output } };
      },
    };
    const server = createReadonlyComputerMcpServer(contract, {
      ownerId: "owner-preview",
      sessionId: "session-a",
      taskId: "task-a",
      taskEpoch: 3,
      participantId: "critic-a",
      turnId: "turn-a",
      generation: 2,
    });
    const client = new Client({ name: "farol-next-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      for (const [relativePath, extra] of [
        ["missing.txt", {}],
        ["malformed.txt", {}],
        ["unknown.txt", {}],
        ["sha-on-page.txt", { offset: 0 }],
        ["page-for-full.txt", {}],
        ["full-for-range.txt", { offset: 0 }],
      ] as const) {
        const result = await client.callTool({
          name: "computer_workspace_read",
          arguments: { workspaceId: "farol", relativePath, ...extra },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
          ok: false,
          error: {
            code: "COMPUTER_CONTRACT_INVALID",
            source: "contract",
            retry: "never",
          },
        });
        expect(JSON.stringify(result.content)).not.toContain("abcd");
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
