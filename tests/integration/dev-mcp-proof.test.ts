import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RunReadonlyComputerAction } from "../../src/modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import { createReadonlyComputerMcpServer } from "../../src/modules/computer/infra/mcp/create-readonly-computer-mcp";
import {
  DEV_MCP_PROOF_ALLOWED_PATH,
  DEV_MCP_PROOF_DENIED_PATH,
  type DevMcpProofPreparation,
  PrivateDevMcpProofRecorder,
  claimDevMcpProofAttempt,
  createDevMcpProofFixture,
  readDevMcpProofReceipt,
  writeDevMcpProofPreparation,
} from "../../src/modules/computer/infra/mcp/dev-mcp-proof";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../src/modules/computer/infra/native/native-readonly-workspace";
import { ReadonlyComputerContractHandler } from "../../src/modules/computer/infra/readonly-contract-handler";
import { InMemoryAuthorityRepository } from "../../src/modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../src/modules/computer/infra/repo/in-memory-computer-approvals";
import { rootIdentityOf } from "../fixtures/root-identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const created = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-dev-proof-")),
  );
  roots.push(created);
  return created;
}

describe("Farol DEV production MCP proof", () => {
  it("runs the unpredictable sentinel and adjacent symlink refusal through the production MCP adapter", async () => {
    const stateRoot = await root();
    const first = await createDevMcpProofFixture(stateRoot);
    const second = await createDevMcpProofFixture(stateRoot);
    const firstValue = await fs.readFile(
      path.join(first.workspaceRoot, DEV_MCP_PROOF_ALLOWED_PATH),
      "utf8",
    );
    const secondValue = await fs.readFile(
      path.join(second.workspaceRoot, DEV_MCP_PROOF_ALLOWED_PATH),
      "utf8",
    );

    expect(firstValue).toMatch(/^FAROL_DEV_[0-9A-Za-z_-]{43}$/u);
    expect(secondValue).not.toBe(firstValue);
    expect(first.sentinelSha256).not.toBe(second.sentinelSha256);
    await expect(
      fs.lstat(path.join(first.workspaceRoot, DEV_MCP_PROOF_DENIED_PATH)),
    ).resolves.toMatchObject({});
    expect(
      (
        await fs.lstat(
          path.join(first.workspaceRoot, DEV_MCP_PROOF_DENIED_PATH),
        )
      ).isSymbolicLink(),
    ).toBe(true);

    const preparation = {
      schema: 1 as const,
      proofId: first.proofId,
      environment: "dev" as const,
      buildId: "a".repeat(64),
      workspaceId: "workspace-proof",
      workspaceRoot: first.workspaceRoot,
      computerGeneration: 7,
      sentinelSha256: first.sentinelSha256,
      allowedPath: DEV_MCP_PROOF_ALLOWED_PATH,
      deniedPath: DEV_MCP_PROOF_DENIED_PATH,
      preparedAt: new Date(0).toISOString(),
    } satisfies DevMcpProofPreparation;
    await writeDevMcpProofPreparation(stateRoot, preparation);
    const approval: ComputerApproval = {
      ownerId: "owner-desktop",
      computerId: "computer-proof",
      generation: 7,
      workspaces: [
        {
          workspaceId: preparation.workspaceId,
          root: first.workspaceRoot,
          access: "read",
          rootIdentity: rootIdentityOf(first.workspaceRoot),
        },
      ],
      capabilities: ["workspace.read"],
      network: "none",
      commands: "none",
      expiresAt: 20_000,
    };
    const admission: TaskAdmission = {
      authorityId: "authority-proof",
      ownerId: "owner-desktop",
      sessionId: "session-proof",
      taskId: "task-proof",
      taskEpoch: 7,
      computerId: "computer-proof",
      computerGeneration: 7,
      workspaces: [
        {
          workspaceId: preparation.workspaceId,
          mode: "subtree",
          root: first.workspaceRoot,
          access: "read",
        },
      ],
      capabilities: ["workspace.read"],
      network: "none",
      commands: "none",
      expiresAt: 10_000,
    };
    const grant = deriveTaskGrant(approval, admission, 1_000);
    if (!grant.ok) throw new Error(grant.error.code);
    const participant = createParticipantAuthority(grant.value, {
      participantId: "main-proof",
      role: "main",
      mutationOwnership: "none",
    });
    if (!participant.ok) throw new Error(participant.error.code);
    const workspace = new NativeReadonlyWorkspace({
      helperPath: path.resolve(
        import.meta.dirname,
        "../../resources/native/safe_open.py",
      ),
      helper: NEXT_SAFE_OPEN_HELPER,
      attestInterpreter: async () => "/usr/bin/python3",
    });
    const contract = new ReadonlyComputerContractHandler(
      new RunReadonlyComputerAction(
        new InMemoryAuthorityRepository([participant.value]),
        new InMemoryComputerApprovalRepository([approval]),
        workspace,
        { now: () => 1_000 },
      ),
    );
    const binding = {
      ownerId: "owner-desktop",
      sessionId: "session-proof",
      taskId: "task-proof",
      taskEpoch: 7,
      participantId: "main-proof",
      turnId: "turn-proof",
      generation: 7,
    };
    const server = createReadonlyComputerMcpServer(
      contract,
      binding,
      undefined,
      undefined,
      undefined,
      undefined,
      new PrivateDevMcpProofRecorder(stateRoot, preparation),
    );
    const client = new Client({ name: "farol-dev-proof", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(
        "computer_workspace_read",
      );
      expect(JSON.stringify(tools)).not.toContain(firstValue);

      const allowed = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: preparation.workspaceId,
          relativePath: DEV_MCP_PROOF_ALLOWED_PATH,
        },
      });
      expect(allowed.isError).not.toBe(true);
      expect(allowed.structuredContent).toMatchObject({
        ...binding,
        workspaceId: preparation.workspaceId,
        output: {
          kind: "workspace.text",
          text: firstValue,
          bytes: Buffer.byteLength(firstValue),
        },
      });

      const denied = await client.callTool({
        name: "computer_workspace_read",
        arguments: {
          workspaceId: preparation.workspaceId,
          relativePath: DEV_MCP_PROOF_DENIED_PATH,
        },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        ok: false,
        error: { code: "WORKSPACE_PATH_REFUSED", retry: "never" },
      });

      const receipt = await readDevMcpProofReceipt(stateRoot);
      expect(receipt).toMatchObject({
        proofId: first.proofId,
        environment: "dev",
        buildId: preparation.buildId,
        computerGeneration: 7,
        workspaceId: preparation.workspaceId,
        sentinelSha256: first.sentinelSha256,
        allowed: {
          generation: 7,
          relativePath: DEV_MCP_PROOF_ALLOWED_PATH,
          outputSha256: first.sentinelSha256,
        },
        denied: {
          generation: 7,
          relativePath: DEV_MCP_PROOF_DENIED_PATH,
          errorCode: "WORKSPACE_PATH_REFUSED",
        },
      });
      expect(JSON.stringify(receipt)).not.toContain(firstValue);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retains only correlated hashes for the exact read and outside-grant refusal", async () => {
    const stateRoot = await root();
    const fixture = await createDevMcpProofFixture(stateRoot);
    const preparation = {
      schema: 1 as const,
      proofId: fixture.proofId,
      environment: "dev" as const,
      buildId: "a".repeat(64),
      workspaceId: "workspace-proof",
      workspaceRoot: fixture.workspaceRoot,
      computerGeneration: 7,
      sentinelSha256: fixture.sentinelSha256,
      allowedPath: DEV_MCP_PROOF_ALLOWED_PATH,
      deniedPath: DEV_MCP_PROOF_DENIED_PATH,
      preparedAt: new Date(0).toISOString(),
    } satisfies DevMcpProofPreparation;
    await writeDevMcpProofPreparation(stateRoot, preparation);
    const recorder = new PrivateDevMcpProofRecorder(stateRoot, preparation);
    const sentinel = await fs.readFile(
      path.join(fixture.workspaceRoot, DEV_MCP_PROOF_ALLOWED_PATH),
      "utf8",
    );
    const request = (relativePath: string, callId: string) => ({
      ownerId: "owner-desktop",
      sessionId: "session-proof",
      taskId: "task-proof",
      taskEpoch: 7,
      participantId: "participant-proof",
      turnId: "turn-proof",
      generation: 7,
      callId,
      workspaceId: preparation.workspaceId,
      operation: { kind: "workspace.read", relativePath },
    });

    await recorder.observe({
      request: request(DEV_MCP_PROOF_ALLOWED_PATH, "call-allowed"),
      response: {
        ok: true,
        output: {
          kind: "workspace.text",
          text: sentinel,
          bytes: Buffer.byteLength(sentinel),
        },
      },
    });
    await recorder.observe({
      request: request(DEV_MCP_PROOF_DENIED_PATH, "call-denied"),
      response: { ok: false, errorCode: "WORKSPACE_PATH_REFUSED" },
    });
    await recorder.observe({
      request: request(DEV_MCP_PROOF_ALLOWED_PATH, "call-late-overwrite"),
      response: {
        ok: true,
        output: { kind: "workspace.text", text: "wrong", bytes: 5 },
      },
    });

    const receipt = await readDevMcpProofReceipt(stateRoot);
    expect(receipt).toMatchObject({
      environment: "dev",
      buildId: "a".repeat(64),
      computerGeneration: 7,
      workspaceId: preparation.workspaceId,
      sentinelSha256: fixture.sentinelSha256,
      allowed: {
        callIdSha256: createHash("sha256").update("call-allowed").digest("hex"),
        outputSha256: fixture.sentinelSha256,
        relativePath: DEV_MCP_PROOF_ALLOWED_PATH,
        generation: 7,
      },
      denied: {
        errorCode: "WORKSPACE_PATH_REFUSED",
        relativePath: DEV_MCP_PROOF_DENIED_PATH,
        generation: 7,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain(sentinel);
  });

  it("claims a live attempt once and resets only for a fresh preparation", async () => {
    const stateRoot = await root();
    const fixture = await createDevMcpProofFixture(stateRoot);
    const preparation = {
      schema: 1 as const,
      proofId: fixture.proofId,
      environment: "dev" as const,
      buildId: "d".repeat(64),
      workspaceId: "workspace-proof",
      workspaceRoot: fixture.workspaceRoot,
      computerGeneration: 7,
      sentinelSha256: fixture.sentinelSha256,
      allowedPath: DEV_MCP_PROOF_ALLOWED_PATH,
      deniedPath: DEV_MCP_PROOF_DENIED_PATH,
      preparedAt: new Date().toISOString(),
    } satisfies DevMcpProofPreparation;

    await writeDevMcpProofPreparation(stateRoot, preparation);
    await claimDevMcpProofAttempt(stateRoot, preparation.proofId);
    await expect(
      claimDevMcpProofAttempt(stateRoot, preparation.proofId),
    ).rejects.toThrow("DEV_MCP_PROOF_ALREADY_ATTEMPTED");

    await writeDevMcpProofPreparation(stateRoot, preparation);
    await expect(
      claimDevMcpProofAttempt(stateRoot, preparation.proofId),
    ).resolves.toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});
