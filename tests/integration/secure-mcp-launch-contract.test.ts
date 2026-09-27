import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateSecureMcpLaunchStore,
  createSecureMcpLaunchContract,
} from "../../src/apps/desktop/secure-mcp-launch-contract";
import {
  loadReadonlyComputerLaunchContract,
  materializeReadonlyComputerLaunch,
} from "../../src/modules/computer/infra/mcp/launch-contract";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-secure-mcp-launch-"),
  );
  roots.push(value);
  return value;
}

function settings() {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 9,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000001",
      generation: 7,
      name: "Owner Mac",
      commands: "verification",
      workspaces: [
        {
          workspaceId: "00000000-0000-4000-8000-000000000002",
          root: "/Users/example/read",
          label: "Read",
          access: "read",
          excludedPaths: ["/Users/example/read/private"],
          rootIdentity: { device: "5", inode: "98" },
        },
        {
          workspaceId: "00000000-0000-4000-8000-000000000003",
          root: "/Users/example/write",
          label: "Write",
          access: "write",
          excludedPaths: [],
          rootIdentity: { device: "5", inode: "97" },
        },
      ],
    },
    setup: {
      chatgpt: readiness(),
      computer: readiness(),
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

function readiness() {
  return {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown" as const,
    verified: null,
    needsAction: "Pending.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

describe("secure MCP Computer launch contract", () => {
  it("requires a separately selected Codex host and exact approved Git workspace for tasks", () => {
    const base = settings();
    const selected = ProductSettingsSchema.parse({
      ...base,
      nativeHosts: {
        generation: 2,
        codex: {
          executablePath: "/Users/example/bin/codex",
          executableSha256: "a".repeat(64),
          version: "0.153.4",
          protocol: "codex-app-server/v2",
          schemaSha256: "b".repeat(64),
          verifiedAt: new Date(1_789_516_700_000).toISOString(),
        },
      },
      computer: {
        ...base.computer,
        workspaces: base.computer.workspaces.map((workspace) =>
          workspace.access === "write"
            ? {
                ...workspace,
                gitMetadata: {
                  gitDirectory: "/Users/example/write/.git",
                  commonDirectory: "/Users/example/write/.git",
                },
              }
            : workspace,
        ),
      },
    });
    const codexTasks = {
      transport: "codex-shared-proxy/v1" as const,
      host: {
        executablePath: "/Users/example/bin/codex",
        executableSha256: "a".repeat(64),
        socketPath: "/Users/example/private/codex.sock",
        expectedCodexHome: "/Users/example/.codex",
      },
      grant: {
        workspaceId: "00000000-0000-4000-8000-000000000003",
        writerRoot: "/Users/example/write",
        writerIdentity: { device: "5", inode: "97" },
        projectId: "saved-project",
        projectRoot: "/Users/example/write",
        projectIdentity: { device: "5", inode: "97" },
        gitCommonDirectory: "/Users/example/write/.git",
        execution: {
          sandbox: "workspace-write" as const,
          approvalPolicy: "on-request" as const,
        },
        model: "gpt-6-luna",
        reasoningEffort: "medium",
        expiresAt: 1_789_517_000_000,
      },
    };
    const input = {
      now: 1_789_516_800_000,
      runtimeId: "runtime-with-tasks",
      challengeSha256: "c".repeat(64),
      codexTasks,
    };
    const launch = createSecureMcpLaunchContract(selected, input);
    expect(
      materializeReadonlyComputerLaunch(launch, input.now).codexTasks,
    ).toEqual(codexTasks);
    expect(() => createSecureMcpLaunchContract(base, input)).toThrow(
      "SECURE_MCP_CODEX_TASK_ADMISSION_INVALID",
    );
    expect(() =>
      createSecureMcpLaunchContract(selected, {
        ...input,
        codexTasks: {
          ...codexTasks,
          grant: { ...codexTasks.grant, writerRoot: "/Users/example/read" },
        },
      }),
    ).toThrow();
    expect(() =>
      createSecureMcpLaunchContract(selected, {
        ...input,
        codexTasks: {
          ...codexTasks,
          grant: { ...codexTasks.grant, expiresAt: input.now - 1 },
        },
      }),
    ).toThrow("SECURE_MCP_CODEX_TASK_ADMISSION_INVALID");
  });

  it("carries only a generation-bound Farol DEV proof into the production launch", () => {
    const devMcpProof = {
      schema: 1 as const,
      proofId: "proof-generation-7",
      environment: "dev" as const,
      buildId: "f".repeat(64),
      workspaceId: "00000000-0000-4000-8000-000000000002",
      workspaceRoot: "/Users/example/read",
      computerGeneration: 7,
      sentinelSha256: "e".repeat(64),
      allowedPath: "sentinel.txt" as const,
      deniedPath: "outside-link.txt" as const,
      preparedAt: new Date(1_789_516_700_000).toISOString(),
    };
    const launch = createSecureMcpLaunchContract(settings(), {
      now: 1_789_516_800_000,
      runtimeId: "runtime-dev-proof",
      challengeSha256: "a".repeat(64),
      devMcpProof,
    });

    expect(launch.devMcpProof).toEqual(devMcpProof);
    expect(
      materializeReadonlyComputerLaunch(launch, 1_789_516_800_000).devMcpProof,
    ).toEqual(devMcpProof);

    expect(() =>
      createSecureMcpLaunchContract(settings(), {
        now: 1_789_516_800_000,
        runtimeId: "runtime-stale-proof",
        challengeSha256: "b".repeat(64),
        devMcpProof: { ...devMcpProof, computerGeneration: 6 },
      }),
    ).toThrow("SECURE_MCP_DEV_PROOF_STALE");
    expect(() =>
      createSecureMcpLaunchContract(settings(), {
        now: 1_789_516_800_000,
        runtimeId: "runtime-rebound-proof",
        challengeSha256: "c".repeat(64),
        devMcpProof: {
          ...devMcpProof,
          workspaceRoot: "/Users/example/write",
        },
      }),
    ).toThrow("SECURE_MCP_DEV_PROOF_STALE");
  });

  it("preserves all owner-approved workspace authority without per-file narrowing", () => {
    const launch = createSecureMcpLaunchContract(settings(), {
      now: 1_789_516_800_000,
      runtimeId: "runtime-generation-01",
      challengeSha256: "a".repeat(64),
      callerRelay: {
        protocol: "farol-next-caller-relay/v1",
        socketPath: "/private/tmp/farol-next-caller/relay.sock",
        token: "a-private-relay-token-that-is-long-enough",
      },
    });

    expect(launch).toMatchObject({
      schema: 2,
      approval: {
        generation: 7,
        commands: "verification",
        capabilities: [
          "workspace.list",
          "workspace.read",
          "workspace.search",
          "verification.run",
          "workspace.write",
        ],
        workspaces: [
          {
            workspaceId: "00000000-0000-4000-8000-000000000002",
            root: "/Users/example/read",
            access: "read",
            rootIdentity: { device: "5", inode: "98" },
          },
          {
            workspaceId: "00000000-0000-4000-8000-000000000003",
            root: "/Users/example/write",
            access: "write",
            rootIdentity: { device: "5", inode: "97" },
          },
        ],
        excludedPaths: [
          {
            workspaceId: "00000000-0000-4000-8000-000000000002",
            path: "/Users/example/read/private",
          },
        ],
      },
      admission: {
        computerGeneration: 7,
        workspaces: [
          {
            workspaceId: "00000000-0000-4000-8000-000000000002",
            mode: "subtree",
            root: "/Users/example/read",
            access: "read",
          },
          {
            workspaceId: "00000000-0000-4000-8000-000000000003",
            mode: "subtree",
            root: "/Users/example/write",
            access: "write",
          },
        ],
      },
      delegationChain: [
        {
          participantId: "secure-mcp-main-runtime-generation-01",
          role: "main",
          mutationOwnership: "task",
        },
      ],
      binding: {
        participantId: "secure-mcp-main-runtime-generation-01",
        generation: 7,
      },
      connectorVerification: { challengeSha256: "a".repeat(64) },
      callerRelay: {
        protocol: "farol-next-caller-relay/v1",
        socketPath: "/private/tmp/farol-next-caller/relay.sock",
      },
    });

    const materialized = materializeReadonlyComputerLaunch(
      launch,
      1_789_516_800_000,
    );
    expect(materialized.mutationEnabled).toBe(true);
    expect(materialized.connectorVerification).toEqual({
      challengeSha256: "a".repeat(64),
    });
    expect(materialized.callerRelay).toEqual({
      protocol: "farol-next-caller-relay/v1",
      socketPath: "/private/tmp/farol-next-caller/relay.sock",
      token: "a-private-relay-token-that-is-long-enough",
    });
    expect(materialized.participants[0]?.grant.workspaces).toMatchObject(
      launch.admission.workspaces,
    );
  });

  it("writes one private canonical launch file consumed by the shipping loader", async () => {
    const launchRoot = path.join(await root(), "runtime");
    const store = new PrivateSecureMcpLaunchStore({ root: launchRoot });
    const launch = createSecureMcpLaunchContract(settings(), {
      now: 1_789_516_800_000,
      runtimeId: "runtime-generation-02",
      challengeSha256: "b".repeat(64),
    });

    const file = await store.write(launch);
    expect(path.basename(file)).toBe("computer-launch.json");
    expect((await fs.stat(launchRoot)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    const workspace: ReadonlyWorkspace = {
      execute: async (request) => ({
        ok: true,
        value: {
          kind: "workspace.text",
          text: await fs.readFile(
            path.join(request.workspace.root, request.operation.relativePath),
            "utf8",
          ),
          bytes: (await fs.stat(file)).size,
        },
      }),
    };
    await expect(
      loadReadonlyComputerLaunchContract(file, workspace),
    ).resolves.toEqual(launch);
  });

  it("AUTH-10 carries each approved folder's identity through the launch file", async () => {
    const configured = settings();
    const bound = ProductSettingsSchema.parse({
      ...configured,
      computer: {
        ...configured.computer,
        workspaces: configured.computer.workspaces.map((workspace, index) => {
          if (index === 1) {
            return {
              ...workspace,
              rootIdentity: { device: "5", inode: "99" },
              gitMetadata: {
                gitDirectory: "/Users/example/repo/.git/worktrees/write",
                commonDirectory: "/Users/example/repo/.git",
              },
            };
          }
          // Saved before folder identities existed: it grants nothing.
          const { rootIdentity: _unbound, ...unbound } = workspace;
          return unbound;
        }),
      },
    });
    const launch = createSecureMcpLaunchContract(bound, {
      now: 1_789_516_800_000,
      runtimeId: "runtime-generation-03",
      challengeSha256: "c".repeat(64),
    });

    expect(launch.approval.workspaces).toEqual([
      {
        workspaceId: "00000000-0000-4000-8000-000000000003",
        root: "/Users/example/write",
        access: "write",
        rootIdentity: { device: "5", inode: "99" },
        gitMetadata: {
          gitDirectory: "/Users/example/repo/.git/worktrees/write",
          commonDirectory: "/Users/example/repo/.git",
        },
      },
    ]);
    const launchRoot = path.join(await root(), "runtime");
    const file = await new PrivateSecureMcpLaunchStore({
      root: launchRoot,
    }).write(launch);
    const workspace: ReadonlyWorkspace = {
      execute: async (request) => ({
        ok: true,
        value: {
          kind: "workspace.text",
          text: await fs.readFile(
            path.join(request.workspace.root, request.operation.relativePath),
            "utf8",
          ),
          bytes: (await fs.stat(file)).size,
        },
      }),
    };
    await expect(
      loadReadonlyComputerLaunchContract(file, workspace),
    ).resolves.toEqual(launch);
  });

  it("refuses an empty or oversized connector workspace grant", () => {
    const empty = settings();
    empty.computer.workspaces.splice(0);
    expect(() =>
      createSecureMcpLaunchContract(empty, {
        now: 1_789_516_800_000,
        runtimeId: "runtime-empty",
        challengeSha256: "c".repeat(64),
      }),
    ).toThrow("SECURE_MCP_WORKSPACE_REQUIRED");

    // F1-1: workspaces saved before folder identities grant the connector nothing.
    const unbound = settings();
    unbound.computer.workspaces = unbound.computer.workspaces.map(
      ({ rootIdentity: _unbound, ...workspace }) => workspace,
    );
    expect(() =>
      createSecureMcpLaunchContract(unbound, {
        now: 1_789_516_800_000,
        runtimeId: "runtime-unbound",
        challengeSha256: "e".repeat(64),
      }),
    ).toThrow("SECURE_MCP_WORKSPACE_REQUIRED");

    const oversized = settings();
    oversized.computer.workspaces = Array.from({ length: 33 }, (_, index) => ({
      workspaceId: `workspace-${index}`,
      root: `/Users/example/workspace-${index}`,
      label: `Workspace ${index}`,
      access: "read" as const,
      excludedPaths: [],
      rootIdentity: { device: "5", inode: String(1_000 + index) },
    }));
    expect(() =>
      createSecureMcpLaunchContract(oversized, {
        now: 1_789_516_800_000,
        runtimeId: "runtime-oversized",
        challengeSha256: "d".repeat(64),
      }),
    ).toThrow("SECURE_MCP_WORKSPACE_LIMIT");
  });
});
