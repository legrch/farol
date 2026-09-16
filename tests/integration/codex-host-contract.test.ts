import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCodexHostContract } from "../../src/apps/desktop/codex-host-contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function schemaRoot(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-codex-contract-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "v2"));
  const files: Record<string, unknown> = {
    "v2/ThreadStartParams.json": {
      properties: {
        dynamicTools: {
          items: { $ref: "#/definitions/DynamicToolSpec" },
        },
      },
    },
    "DynamicToolCallParams.json": {
      required: ["threadId", "turnId", "callId", "tool", "arguments"],
    },
    "ServerRequest.json": {
      oneOf: [{ properties: { method: { enum: ["item/tool/call"] } } }],
    },
    "ClientRequest.json": {
      oneOf: [{ properties: { method: { enum: ["thread/compact/start"] } } }],
    },
    "v2/ThreadListParams.json": {
      properties: { parentThreadId: {}, ancestorThreadId: {} },
    },
    "v2/ThreadReadResponse.json": {
      definitions: {
        Thread: { properties: { parentThreadId: {} } },
        ThreadItem: {
          oneOf: [
            {
              properties: {
                type: { enum: ["collabAgentToolCall"] },
                receiverThreadIds: { type: "array" },
                senderThreadId: { type: "string" },
              },
            },
          ],
        },
      },
    },
    ...overrides,
  };
  await Promise.all(
    Object.entries(files).map(async ([relativePath, value]) => {
      await fs.writeFile(
        path.join(root, relativePath),
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      );
    }),
  );
  return root;
}

describe("installed Codex host contract", () => {
  it("recognizes the bounded host, child and compaction seams", async () => {
    const root = await schemaRoot();

    await expect(
      inspectCodexHostContract(root, "codex-cli 0.153.4"),
    ).resolves.toMatchObject({
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      capabilities: {
        dynamicTools: true,
        correlatedToolCalls: true,
        descendantObservation: true,
        collabObservation: true,
        compaction: true,
      },
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("refuses a host without thread-scoped dynamic tools", async () => {
    const root = await schemaRoot({
      "v2/ThreadStartParams.json": { properties: {} },
    });

    await expect(
      inspectCodexHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_DYNAMIC_TOOLS_UNAVAILABLE");
  });

  it("refuses a host that cannot observe a correlated native child", async () => {
    const root = await schemaRoot({
      "v2/ThreadReadResponse.json": {
        definitions: {
          Thread: { properties: { parentThreadId: {} } },
          ThreadItem: { oneOf: [] },
        },
      },
    });

    await expect(
      inspectCodexHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_AGENT_OBSERVATION_UNAVAILABLE");
  });

  it("refuses linked schema evidence", async () => {
    const root = await schemaRoot();
    const source = path.join(root, "source.json");
    await fs.writeFile(source, "{}\n", { mode: 0o600 });
    await fs.rm(path.join(root, "DynamicToolCallParams.json"));
    await fs.symlink(source, path.join(root, "DynamicToolCallParams.json"));

    await expect(
      inspectCodexHostContract(root, "codex-cli 0.153.4"),
    ).rejects.toThrow("CODEX_HOST_SCHEMA_UNSAFE");
  });
});
