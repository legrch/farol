import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentHost,
  AgentSpawnRequest,
} from "../../src/modules/agent/app/port/agent-host";
import { PrivateAssignmentStore } from "../../src/modules/agent/infra/repo/private-assignment-store";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { runCodexNativeAgentCheck } from "../../src/apps/desktop/codex-native-agent-check";

const roots: string[] = [];
const executableSha256 = "a".repeat(64);
const schemaSha256 = "b".repeat(64);
const buildId = "c".repeat(64);
const selectedWorkspaceId = "00000000-0000-4000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function assignmentStore(): Promise<PrivateAssignmentStore> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-native-agent-check-"),
  );
  roots.push(root);
  return new PrivateAssignmentStore({ root: path.join(root, "assignments") });
}

function settings() {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 10,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000010",
      generation: 7,
      name: "This Mac",
      workspaces: [
        {
          workspaceId: selectedWorkspaceId,
          root: "/workspace/primary",
          label: "Primary",
          access: "read",
          excludedPaths: ["/workspace/primary/private"],
        },
        {
          workspaceId: "00000000-0000-4000-8000-000000000002",
          root: "/workspace/reference",
          label: "Reference",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    nativeHosts: {
      generation: 2,
      codex: {
        executablePath: "/usr/local/bin/codex",
        executableSha256,
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        schemaSha256,
        verifiedAt: "2026-09-16T10:00:00.000Z",
        liveVerification: {
          model: "gpt-6-astra",
          executableSha256,
          schemaSha256,
          buildId,
          dynamicTool: "farol_next_ping",
          verifiedAt: "2026-09-16T10:00:00.000Z",
        },
        agentVerification: null,
      },
    },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: {
        ...readiness(),
        configured: true,
        reachable: "reachable",
        verified: {
          profile: "computer.local.readonly/1",
          configRevision: 7,
          workspaceId: selectedWorkspaceId,
          runtimeGeneration: "runtime-1",
          buildId,
          protocol: "readonly-workspace/1",
          verifiedAt: "2026-09-16T10:00:00.000Z",
        },
        needsAction: null,
      },
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
    needsAction: "Complete this step.",
    unavailable: null,
    outcomeUnknown: false,
  };
}

function completingHost() {
  let request: AgentSpawnRequest | null = null;
  let spawnedCorrelation: Awaited<ReturnType<AgentHost["spawn"]>> | null = null;
  let waits = 0;
  const host: AgentHost = {
    spawn: vi.fn(async (input: AgentSpawnRequest) => {
      request = input;
      const receipt = {
        status: "started" as const,
        correlation: {
          ...input.identity,
          authorityId: input.authority.authorityId,
          participantId: input.authority.participantId,
          role: input.authority.role,
          parentThreadId: "parent-thread-a",
          childId: "child-thread-a",
          hostRole: "default",
          delegationDigest: "d".repeat(64),
        },
      };
      spawnedCorrelation = receipt;
      return receipt;
    }),
    wait: vi.fn(async (correlation) => {
      waits += 1;
      return waits === 1
        ? { status: "running" as const, correlation }
        : {
            status: "completed" as const,
            correlation,
            resultRef: "codex-app-server://thread/child-thread-a/turn/turn-a",
          };
    }),
  };
  return {
    host,
    request: () => request,
    correlation: () =>
      spawnedCorrelation?.status === "started"
        ? spawnedCorrelation.correlation
        : null,
  };
}

describe("desktop native Agent lineage check", () => {
  it("runs Main to Agent to Critic with one unchanged workspace grant and durable delivery", async () => {
    const assignments = await assignmentStore();
    const native = completingHost();

    const result = await runCodexNativeAgentCheck({
      host: native.host,
      assignments,
      settings: settings(),
      workspaceId: selectedWorkspaceId,
      executableSha256,
      schemaSha256,
      buildId,
      now: () => 1_000,
      pause: async () => undefined,
      maximumWaitCycles: 3,
    });

    expect(result).toMatchObject({
      status: "completed",
      evidence: {
        kind: "host.codex-agent-lineage",
        model: "gpt-6-astra",
        workspaceId: selectedWorkspaceId,
        computerGeneration: 7,
        authorityRole: "critic",
        hostRole: "default",
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      },
    });
    const spawn = native.request();
    if (!spawn) throw new Error("spawn missing");
    expect(spawn.authority).toMatchObject({
      role: "critic",
      parentParticipantId: expect.stringMatching(/^agent-/u),
      workspaces: [
        {
          workspaceId: selectedWorkspaceId,
          mode: "subtree",
          root: "/workspace/primary",
          access: "read",
        },
        {
          workspaceId: "00000000-0000-4000-8000-000000000002",
          mode: "subtree",
          root: "/workspace/reference",
          access: "read",
        },
      ],
      excludedPaths: [
        {
          workspaceId: selectedWorkspaceId,
          path: "/workspace/primary/private",
        },
      ],
      capabilities: ["workspace.list", "workspace.read", "workspace.search"],
      network: "none",
      commands: "none",
    });
    expect(spawn.focus.initialPaths).toEqual(["/workspace/primary"]);
    expect(native.host.spawn).toHaveBeenCalledTimes(1);
    expect(native.host.wait).toHaveBeenCalledTimes(2);

    const correlation = native.correlation();
    if (!correlation) throw new Error("correlation missing");
    const stored = await assignments.load(correlation);
    expect(stored).toMatchObject({
      assignment: { phase: "completed", terminal: true },
      resultRef: "codex-app-server://thread/child-thread-a/turn/turn-a",
      parentDelivery: "acknowledged",
    });
  });

  it("retains one running child for bounded same-assignment rejoin", async () => {
    const assignments = await assignmentStore();
    const native = completingHost();

    const result = await runCodexNativeAgentCheck({
      host: native.host,
      assignments,
      settings: settings(),
      workspaceId: selectedWorkspaceId,
      executableSha256,
      schemaSha256,
      buildId,
      now: () => 1_000,
      pause: async () => undefined,
      maximumWaitCycles: 1,
    });

    expect(result).toMatchObject({
      status: "running",
      code: "AGENT_STILL_RUNNING",
    });
    expect(native.host.spawn).toHaveBeenCalledTimes(1);
    expect(native.host.wait).toHaveBeenCalledTimes(1);

    const rejoined = await runCodexNativeAgentCheck({
      host: native.host,
      assignments,
      settings: settings(),
      workspaceId: selectedWorkspaceId,
      executableSha256,
      schemaSha256,
      buildId,
      now: () => 1_000,
      pause: async () => undefined,
      maximumWaitCycles: 1,
      boundedRunningObserved: true,
    });

    expect(rejoined).toMatchObject({
      status: "completed",
      evidence: { boundedRunning: true, parentDelivery: "acknowledged" },
    });
    expect(native.host.spawn).toHaveBeenCalledTimes(1);
    expect(native.host.wait).toHaveBeenCalledTimes(2);
  });

  it("does not retry a spawn with an unknown outcome", async () => {
    const assignments = await assignmentStore();
    const host: AgentHost = {
      spawn: vi.fn(async () => ({
        status: "outcome_unknown" as const,
        code: "AGENT_SPAWN_ACK_LOST" as const,
      })),
      wait: vi.fn(),
    };

    const result = await runCodexNativeAgentCheck({
      host,
      assignments,
      settings: settings(),
      workspaceId: selectedWorkspaceId,
      executableSha256,
      schemaSha256,
      buildId,
      now: () => 1_000,
      pause: async () => undefined,
      maximumWaitCycles: 3,
    });

    expect(result).toMatchObject({
      status: "outcome_unknown",
      code: "AGENT_SPAWN_ACK_LOST",
    });
    expect(host.spawn).toHaveBeenCalledTimes(1);
    expect(host.wait).not.toHaveBeenCalled();
  });
});
