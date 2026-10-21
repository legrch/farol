import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateConnectorVerificationRecorder } from "../../src/modules/computer/infra/mcp/connector-verification-receipt";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerContract,
} from "../../src/modules/computer/contract/readonly-computer-contract";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("connector verification MCP tool", () => {
  it("executes one correlated native list and returns only content-free proof", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-connector-mcp-proof-"),
    );
    roots.push(root);
    const challenge = "00000000-0000-4000-8000-000000000001";
    const execute = vi.fn<ReadonlyComputerContract["execute"]>(
      async (value) => {
        const request = ReadonlyComputerCallRequestSchema.parse(value);
        return {
          ok: true,
          value: {
            ...request,
            relativePath: request.operation.relativePath,
            output: {
              kind: "workspace.entries",
              entries: ["private-name.txt", "src/"],
              truncated: false,
            },
          },
        };
      },
    );
    const binding = {
      ownerId: "owner-route-a",
      sessionId: "session-route-a",
      taskId: "task-route-a",
      taskEpoch: 7,
      participantId: "main-route-a",
      turnId: "turn-route-a",
      generation: 7,
    };
    const server = createReadonlyComputerMcpServer(
      { execute },
      binding,
      undefined,
      new PrivateConnectorVerificationRecorder({
        root,
        challengeSha256: createHash("sha256").update(challenge).digest("hex"),
      }),
    );
    const client = new Client({ name: "route-a-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain(
        "farol_connector_verify",
      );

      const refused = await client.callTool({
        name: "farol_connector_verify",
        arguments: {
          challenge: "00000000-0000-4000-8000-000000000002",
          workspaceId: "workspace-route-a",
        },
      });
      expect(refused.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();

      const verified = await client.callTool({
        name: "farol_connector_verify",
        arguments: { challenge, workspaceId: "workspace-route-a" },
      });
      expect(verified.isError).not.toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0]).toMatchObject({
        ...binding,
        workspaceId: "workspace-route-a",
        operation: { kind: "workspace.list", relativePath: "." },
      });
      expect(verified.structuredContent).toMatchObject({
        ok: true,
        challengeSha256: createHash("sha256").update(challenge).digest("hex"),
        workspaceId: "workspace-route-a",
        operation: "workspace.list",
        entryCount: 2,
        truncated: false,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(JSON.stringify(verified)).not.toContain("private-name.txt");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
