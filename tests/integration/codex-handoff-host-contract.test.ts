import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCodexHandoffHostContract } from "../../src/apps/desktop/codex-host-contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const fields = (...names: string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, {}]));

async function schemaRoot(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-handoff-host-schema-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "v2"));
  const files: Record<string, unknown> = {
    "v2/ThreadStartParams.json": {
      properties: {
        ...fields(
          "projectId",
          "cwd",
          "ephemeral",
          "model",
          "allowProviderModelFallback",
          "sandbox",
          "approvalPolicy",
        ),
        dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
      },
    },
    "DynamicToolCallParams.json": {
      required: ["threadId", "turnId", "callId", "tool", "arguments"],
    },
    "ServerRequest.json": {
      oneOf: [{ properties: { method: { enum: ["item/tool/call"] } } }],
    },
    "ClientRequest.json": {
      oneOf: [
        "thread/compact/start",
        "project/list",
        "thread/start",
        "thread/read",
        "thread/turns/list",
        "turn/start",
      ].map((method) => ({ properties: { method: { enum: [method] } } })),
    },
    "v2/ThreadListParams.json": {
      properties: fields("parentThreadId", "ancestorThreadId"),
    },
    "v2/ThreadReadResponse.json": {
      definitions: {
        Thread: {
          properties: fields("id", "projectId", "cwd", "parentThreadId"),
        },
        ThreadItem: {
          oneOf: [{ properties: { type: { enum: ["collabAgentToolCall"] } } }],
        },
      },
    },
    "v2/ProjectListResponse.json": {
      properties: fields("data", "nextCursor"),
      definitions: {
        Project: { properties: fields("id", "roots") },
        ProjectRoot: { properties: fields("path") },
      },
    },
    "v2/ProjectListParams.json": {
      properties: fields("cursor", "limit"),
    },
    "v2/ThreadStartResponse.json": {
      properties: fields("thread", "cwd", "model", "sandbox", "approvalPolicy"),
      definitions: { Thread: { properties: fields("id", "projectId", "cwd") } },
    },
    "v2/TurnStartParams.json": {
      properties: fields(
        "threadId",
        "input",
        "cwd",
        "model",
        "effort",
        "sandboxPolicy",
        "approvalPolicy",
      ),
    },
    "v2/TurnStartResponse.json": {
      properties: fields("turn"),
      definitions: { Turn: { properties: fields("id") } },
    },
    "v2/ThreadReadParams.json": {
      properties: fields("threadId", "includeTurns"),
    },
    "v2/ThreadTurnsListParams.json": {
      properties: fields("threadId", "cursor", "limit", "itemsView"),
    },
    "v2/ThreadTurnsListResponse.json": {
      properties: fields("data", "nextCursor"),
      definitions: { Turn: { properties: fields("id", "status") } },
    },
    ...overrides,
  };
  await Promise.all(
    Object.entries(files).map(([relativePath, value]) =>
      fs.writeFile(
        path.join(root, relativePath),
        `${JSON.stringify(value)}\n`,
        {
          mode: 0o600,
        },
      ),
    ),
  );
  return root;
}

describe("installed Codex saved-project handoff schema", () => {
  it("recognizes the exact project-bound create and metadata-only status methods", async () => {
    const root = await schemaRoot();
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).resolves.toMatchObject({
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      projectBoundCreateStatus: true,
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("refuses a host without project-bound thread creation", async () => {
    const root = await schemaRoot({
      "v2/ThreadStartParams.json": {
        properties: {
          dynamicTools: { items: { $ref: "#/definitions/DynamicToolSpec" } },
          ...fields(
            "cwd",
            "ephemeral",
            "model",
            "allowProviderModelFallback",
            "sandbox",
            "approvalPolicy",
          ),
        },
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host without project discovery", async () => {
    const root = await schemaRoot({
      "ClientRequest.json": {
        oneOf: [
          "thread/compact/start",
          "thread/start",
          "thread/read",
          "thread/turns/list",
          "turn/start",
        ].map((method) => ({ properties: { method: { enum: [method] } } })),
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host without exact turn status metadata", async () => {
    const root = await schemaRoot({
      "v2/ThreadTurnsListResponse.json": {
        properties: fields("data", "nextCursor"),
        definitions: { Turn: { properties: fields("id") } },
      },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses a host that cannot request metadata-only thread reads", async () => {
    const root = await schemaRoot({
      "v2/ThreadReadParams.json": { properties: fields("threadId") },
    });
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_HANDOFF_UNAVAILABLE");
  });

  it("refuses symlinked schema evidence", async () => {
    const root = await schemaRoot();
    const file = path.join(root, "v2/ProjectListResponse.json");
    const source = path.join(root, "source.json");
    await fs.writeFile(source, "{}\n", { mode: 0o600 });
    await fs.rm(file);
    await fs.symlink(source, file);
    await expect(
      inspectCodexHandoffHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_SCHEMA_UNSAFE");
  });
});
