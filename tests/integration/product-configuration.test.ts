import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
} from "../../src/pkg/product-settings/contract";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-product-settings-"),
  );
  roots.push(root);
  return path.join(root, "state");
}

function dependencies() {
  let sequence = 0;
  return {
    now: () => "2026-09-16T10:00:00.000Z",
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  };
}

describe("Farol Next product configuration", () => {
  it("persists working preferences and workspace approval across restart", async () => {
    const root = await stateRoot();
    const first = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await first.initialize();

    const general = await first.updateGeneral({
      openAtLaunch: "activity",
      sidebarDefault: "rail",
      activityDetail: "technical",
    });
    expect(general.ok).toBe(true);
    const workspace = await first.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    expect(workspace.ok).toBe(true);
    expect(workspace.snapshot.status).toBe("ready");
    await first.setSetupJourney({
      currentStep: "computer",
      dismissed: false,
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    const snapshot = restarted.snapshot();
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") throw new Error("settings unavailable");
    expect(snapshot.settings.general).toEqual({
      openAtLaunch: "activity",
      sidebarDefault: "rail",
      activityDetail: "technical",
    });
    expect(snapshot.settings.computer.workspaces).toEqual([
      {
        workspaceId: "00000000-0000-4000-8000-000000000002",
        root: "/Users/example/project",
        label: "Project",
        access: "read",
        excludedPaths: [],
      },
    ]);
    expect(snapshot.settings.setup.computer.configured).toBe(true);
    expect(snapshot.settings.setup.computer.visited).toBe(true);
    expect(snapshot.settings.setup.computer.verified).toBeNull();
    expect(snapshot.settings.setup.journey).toEqual({
      currentStep: "computer",
      dismissed: false,
    });
  });

  it("defaults commands to none and persists explicit verification authority across restart", async () => {
    const root = await stateRoot();
    const first = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await first.initialize();
    expect(first.snapshot()).toMatchObject({
      status: "ready",
      settings: { computer: { commands: "none", generation: 1 } },
    });

    const updated = await first.updateComputerCommands("verification");
    expect(updated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          computer: { commands: "verification", generation: 2 },
          setup: {
            computer: {
              verified: null,
              needsAction: "Add a read-only workspace.",
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(updated.snapshot);
  });

  it("persists a Next-only secure MCP connector without persisting its credential", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        connectors: {
          secureMcp: {
            generation: 1,
            profile: "farol-next",
            tunnelId: null,
            tunnelClient: null,
            credential: "missing",
            runtime: null,
            attachment: null,
          },
        },
      },
    });

    await service.recordSecureMcpTunnelClient({
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    await service.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" });
    await service.recordSecureMcpCredential("stored");
    await service.recordSecureMcpRuntime({
      state: "ready",
      runtimeGeneration: "b".repeat(64),
      computerGeneration: 1,
      buildId: "c".repeat(64),
    });
    const attached = await service.recordSecureMcpAttachment({
      runtimeGeneration: "b".repeat(64),
      computerGeneration: 1,
      buildId: "c".repeat(64),
      challengeSha256: "d".repeat(64),
      receiptSha256: "e".repeat(64),
    });

    expect(attached).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          connectors: {
            secureMcp: {
              generation: 4,
              profile: "farol-next",
              tunnelId: "tunnel_farol_next",
              credential: "stored",
              runtime: {
                state: "ready",
                runtimeGeneration: "b".repeat(64),
                computerGeneration: 1,
                buildId: "c".repeat(64),
              },
              attachment: {
                runtimeGeneration: "b".repeat(64),
                computerGeneration: 1,
                buildId: "c".repeat(64),
                challengeSha256: "d".repeat(64),
                receiptSha256: "e".repeat(64),
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
          setup: {
            connect: {
              configured: true,
              reachable: "reachable",
              outcomeUnknown: false,
              needsAction: null,
              unavailable: null,
              verified: {
                profile: "farol-next",
                configRevision: 4,
                workspaceId: null,
                runtimeGeneration: "b".repeat(64),
                buildId: "c".repeat(64),
                protocol: "openai-tunnel-client/v1",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(attached.snapshot);

    const saved = await fs.readFile(
      path.join(root, "product-settings.json"),
      "utf8",
    );
    expect(saved).not.toMatch(/api[-_ ]?key|secret|bearer/iu);
  });

  it("invalidates connector runtime and attachment when Computer authority changes", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordSecureMcpTunnelClient({
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    await service.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" });
    await service.recordSecureMcpCredential("stored");
    await service.recordSecureMcpRuntime({
      state: "ready",
      runtimeGeneration: "b".repeat(64),
      computerGeneration: 1,
      buildId: "c".repeat(64),
    });
    await service.recordSecureMcpAttachment({
      runtimeGeneration: "b".repeat(64),
      computerGeneration: 1,
      buildId: "c".repeat(64),
      challengeSha256: "d".repeat(64),
      receiptSha256: "e".repeat(64),
    });

    const changed = await service.renameComputer("Owner Mac");

    expect(changed).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          computer: { generation: 2 },
          connectors: {
            secureMcp: {
              generation: 5,
              credential: "stored",
              runtime: null,
              attachment: null,
            },
          },
          setup: {
            connect: {
              configured: true,
              reachable: "unknown",
              verified: null,
              needsAction:
                "Restart the connector after changing Computer authority.",
              outcomeUnknown: false,
            },
          },
        },
      },
    });
  });

  it("keeps the last verified state when an atomic save fails", async () => {
    const root = await stateRoot();
    const baseline = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await baseline.initialize();
    const before = baseline.snapshot();

    const failing = new ProductConfigurationService(
      new ProductSettingsStore(
        { root },
        {
          beforeCommit: async () => {
            throw new Error("denied");
          },
        },
      ),
      dependencies(),
    );
    await failing.initialize();
    const result = await failing.updateGeneral({
      openAtLaunch: "settings",
      sidebarDefault: "full",
      activityDetail: "summary",
    });
    expect(result).toMatchObject({ ok: false, error: "SETTINGS_WRITE_FAILED" });
    expect(result.snapshot).toEqual(before);

    const readBack = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await readBack.initialize();
    expect(readBack.snapshot()).toEqual(before);
  });

  it("loads the initial preview schema before setup journey persistence", async () => {
    const root = await stateRoot();
    const original = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await original.initialize();
    const settingsPath = path.join(root, "product-settings.json");
    const legacy = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      setup?: Record<string, unknown>;
    };
    if (!legacy.setup) throw new Error("setup missing");
    delete legacy.setup.journey;
    await fs.writeFile(settingsPath, `${JSON.stringify(legacy, null, 2)}\n`, {
      mode: 0o600,
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();

    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        nativeHosts: { generation: 1, codex: null },
        setup: {
          journey: { currentStep: "chatgpt", dismissed: false },
        },
      },
    });
  });

  it("persists a verified Codex host contract across restart", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const recorded = await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    expect(recorded).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            generation: 2,
            codex: {
              executablePath: "/Users/example/bin/codex",
              executableSha256: "a".repeat(64),
              version: "0.153.4",
              protocol: "codex-app-server/v2",
              schemaSha256: "b".repeat(64),
              verifiedAt: "2026-09-16T10:00:00.000Z",
              liveVerification: null,
            },
          },
          setup: {
            hosts: {
              configured: true,
              reachable: "reachable",
              needsAction: "Run the live Codex host check.",
              unavailable: null,
              outcomeUnknown: false,
              verified: null,
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(recorded.snapshot);
  });

  it("records live Codex readiness only for the exact selected contract", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const live = await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    expect(live).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            generation: 2,
            codex: {
              liveVerification: {
                model: "gpt-6-astra",
                executableSha256: "a".repeat(64),
                schemaSha256: "b".repeat(64),
                buildId: "c".repeat(64),
                dynamicTool: "farol_next_ping",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
          setup: {
            hosts: {
              configured: true,
              reachable: "reachable",
              needsAction: null,
              unavailable: null,
              outcomeUnknown: false,
              verified: {
                profile: "codex.app-server.live/1",
                configRevision: 2,
                workspaceId: null,
                runtimeGeneration: "a".repeat(64),
                buildId: "c".repeat(64),
                protocol: "codex-app-server/v2",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    await expect(
      service.recordCodexHostLiveVerification({
        model: "gpt-6-astra",
        executableSha256: "d".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
  });

  it("persists exact native Agent lineage and workspace enforcement evidence", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    const computerGeneration = added.snapshot.settings.computer.generation;
    await service.recordComputerVerification(workspaceId, {
      profile: "computer.local.readonly/1",
      runtimeGeneration: "runtime-1",
      buildId: "c".repeat(64),
      protocol: "readonly-workspace/1",
    });
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });
    await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const recorded = await service.recordCodexAgentVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
      workspaceId,
      computerGeneration,
      transport: "codex-native-agent/spawn-prompt-sha256-v1",
      authorityRole: "critic",
      hostRole: "default",
      delegationDigest: "d".repeat(64),
      parentThreadSha256: "e".repeat(64),
      childThreadSha256: "f".repeat(64),
      boundedRunning: true,
      modelTurnsSubmitted: 1,
      fallbackAllowed: false,
      descendantCount: 0,
      resultRefProtocol: "codex-app-server",
      resultRetention: "durable",
      parentDelivery: "acknowledged",
      workspaceEnforcement: "verified",
    });

    expect(recorded).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            codex: {
              agentVerification: {
                authorityRole: "critic",
                hostRole: "default",
                workspaceId,
                computerGeneration,
                delegationDigest: "d".repeat(64),
                boundedRunning: true,
                descendantCount: 0,
                resultRetention: "durable",
                parentDelivery: "acknowledged",
                workspaceEnforcement: "verified",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
          setup: {
            verify: {
              configured: true,
              reachable: "reachable",
              outcomeUnknown: false,
              verified: {
                profile: "codex.native-agent.lineage/1",
                workspaceId,
                protocol: "codex-native-agent/spawn-prompt-sha256-v1",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(recorded.snapshot);

    await expect(
      service.recordCodexAgentVerification({
        model: "gpt-6-astra",
        executableSha256: "0".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
        workspaceId,
        computerGeneration,
        transport: "codex-native-agent/spawn-prompt-sha256-v1",
        authorityRole: "critic",
        hostRole: "default",
        delegationDigest: "d".repeat(64),
        parentThreadSha256: "e".repeat(64),
        childThreadSha256: "f".repeat(64),
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      }),
    ).resolves.toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });

    const invalidated = await service.updateWorkspaceExclusions(workspaceId, [
      "/Users/example/project/private",
    ]);
    expect(invalidated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: { codex: { agentVerification: null } },
          setup: {
            verify: {
              verified: null,
              needsAction: "Run the native Agent lineage check.",
            },
          },
        },
      },
    });
  });

  it("accepts the native Agent command and content-free evidence contracts", () => {
    expect(
      ProductConfigurationCommandSchema.parse({
        kind: "host.run-codex-agent-check",
      }),
    ).toEqual({ kind: "host.run-codex-agent-check" });
    expect(
      ProductConfigurationEvidenceSchema.parse({
        kind: "host.codex-agent-lineage",
        model: "gpt-6-astra",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
        workspaceId: "00000000-0000-4000-8000-000000000001",
        computerGeneration: 2,
        transport: "codex-native-agent/spawn-prompt-sha256-v1",
        authorityRole: "critic",
        hostRole: "default",
        delegationDigest: "d".repeat(64),
        parentThreadSha256: "e".repeat(64),
        childThreadSha256: "f".repeat(64),
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      }),
    ).toMatchObject({ kind: "host.codex-agent-lineage" });
  });

  it("retains an outcome-unknown live host turn without permitting a blind green retry", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });
    await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const failed = await service.recordCodexHostLiveFailure("outcome_unknown");

    expect(failed).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: { codex: { liveVerification: null } },
          setup: {
            hosts: {
              configured: true,
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the Codex host before deliberately running another live check.",
            },
          },
        },
      },
    });
  });

  it("clears a selected Codex host and invalidates host readiness", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const cleared = await service.clearCodexHost();

    expect(cleared).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: { generation: 3, codex: null },
          setup: {
            hosts: {
              configured: false,
              reachable: "unknown",
              verified: null,
              needsAction: "Choose a Codex executable to verify.",
              outcomeUnknown: false,
            },
          },
        },
      },
    });
  });

  it("reports corrupt state without silently replacing it", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, "product-settings.json"), "{broken", {
      mode: 0o600,
    });
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );

    await service.initialize();

    expect(service.snapshot()).toEqual({
      status: "error",
      error: "SETTINGS_CORRUPT",
    });
  });

  it("revokes a workspace and invalidates its verification", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    await service.recordComputerVerification(workspaceId, {
      profile: "computer.local.readonly/1",
      runtimeGeneration: "runtime-1",
      buildId: "a".repeat(64),
      protocol: "readonly-workspace/1",
    });

    const removed = await service.removeWorkspace(workspaceId);

    expect(removed.ok).toBe(true);
    expect(removed.snapshot.status).toBe("ready");
    if (removed.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(removed.snapshot.settings.computer.workspaces).toEqual([]);
    expect(removed.snapshot.settings.setup.computer).toMatchObject({
      configured: false,
      reachable: "unknown",
      verified: null,
    });
  });

  it("persists workspace exclusions and invalidates stale verification", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    await service.recordComputerVerification(workspaceId, {
      profile: "computer.local.readonly/1",
      runtimeGeneration: "runtime-1",
      buildId: "a".repeat(64),
      protocol: "readonly-workspace/1",
    });

    const updated = await service.updateWorkspaceExclusions(workspaceId, [
      "/Users/example/project/private",
      "/Users/example/project/status.txt",
    ]);

    expect(updated.ok).toBe(true);
    expect(updated.snapshot.status).toBe("ready");
    if (updated.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(
      updated.snapshot.settings.computer.workspaces[0]?.excludedPaths,
    ).toEqual([
      "/Users/example/project/private",
      "/Users/example/project/status.txt",
    ]);
    expect(updated.snapshot.settings.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify read access after changing exclusions.",
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        computer: {
          workspaces: [
            {
              workspaceId,
              excludedPaths: [
                "/Users/example/project/private",
                "/Users/example/project/status.txt",
              ],
            },
          ],
        },
      },
    });
  });

  it("persists explicit write access and invalidates stale verification", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    await service.recordComputerVerification(workspaceId, {
      profile: "computer.local.readonly/1",
      runtimeGeneration: "runtime-1",
      buildId: "a".repeat(64),
      protocol: "readonly-workspace/1",
    });
    const before = service.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    const beforeGeneration = before.settings.computer.generation;

    const updated = await service.updateWorkspaceAccess(workspaceId, "write");

    expect(updated.ok).toBe(true);
    expect(updated.snapshot.status).toBe("ready");
    if (updated.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(updated.snapshot.settings.computer.generation).toBe(
      beforeGeneration + 1,
    );
    expect(updated.snapshot.settings.computer.workspaces[0]?.access).toBe(
      "write",
    );
    expect(updated.snapshot.settings.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify write access after changing workspace access.",
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        computer: {
          workspaces: [{ workspaceId, access: "write" }],
        },
      },
    });
  });

  it("persists an unknown workspace mutation outcome until reverification", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    await service.updateWorkspaceAccess(workspaceId, "write");
    await service.recordComputerVerification(workspaceId, {
      profile: "computer.local.write/1",
      runtimeGeneration: "runtime-1",
      buildId: "a".repeat(64),
      protocol: "mutable-workspace/1",
    });

    const unknown =
      await service.recordComputerMutationOutcomeUnknown(workspaceId);

    expect(unknown).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            computer: {
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the selected file, then verify workspace access again.",
            },
          },
        },
      },
    });
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(unknown.snapshot);
  });

  it("persists truthful ChatGPT readiness without credentials or page content", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const signedOut = await service.recordChatGptObservation({
      state: "signed_out",
    });
    expect(signedOut).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              visited: true,
              configured: false,
              reachable: "reachable",
              verified: null,
              needsAction: "Sign in to ChatGPT in the isolated Next window.",
            },
          },
        },
      },
    });

    const authenticated = await service.recordChatGptObservation({
      state: "authenticated",
      profile: "chatgpt.next-partition/1",
      runtimeGeneration: "persist:farol-next-chatgpt",
      buildId: "a".repeat(64),
      protocol: "chatgpt-page-readiness/1",
    });
    expect(authenticated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              configured: true,
              reachable: "reachable",
              needsAction: null,
              unavailable: null,
              outcomeUnknown: false,
              verified: {
                profile: "chatgpt.next-partition/1",
                workspaceId: null,
                runtimeGeneration: "persist:farol-next-chatgpt",
                buildId: "a".repeat(64),
                protocol: "chatgpt-page-readiness/1",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(authenticated.snapshot);

    const saved = await fs.readFile(path.join(root, "product-settings.json"), {
      encoding: "utf8",
    });
    expect(saved).not.toMatch(/cookie|token|conversation|prompt|answer/iu);
  });

  it("persists an outcome-unknown ChatGPT task without permitting a blind green retry", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const result = await service.recordChatGptObservation({
      state: "outcome_unknown",
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              configured: true,
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the isolated ChatGPT window before starting another task.",
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(result.snapshot);
  });

  it("admits bounded workspace list and search actions through the product contract", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.list-workspace",
        workspaceId,
        relativePath: ".",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.search-workspace",
        workspaceId,
        relativePath: ".",
        pattern: "verification",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-list",
        workspaceId,
        relativePath: ".",
        entries: ["README.md", "src/"],
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-search",
        workspaceId,
        relativePath: ".",
        pattern: "verification",
        matches: [
          {
            path: "README.md",
            line: 1,
            text: "Farol Next workspace verification fixture",
            truncated: false,
          },
        ],
        resultLimited: false,
        scanLimited: false,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.list-workspace",
        workspaceId,
        relativePath: "..",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.search-workspace",
        workspaceId,
        relativePath: ".",
        pattern: "line\nsecond line",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-list",
        workspaceId,
        relativePath: ".",
        entries: ["../escape"],
        truncated: false,
      }).success,
    ).toBe(false);

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.update-commands",
        commands: "verification",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.run-git-status",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.run-git-status",
        workspaceId,
        command: "sh -c whoami",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-command",
        workspaceId,
        command: "git.status",
        exitCode: 0,
        stdout: "## main\n",
        stderr: "",
        outputBytes: 8,
        network: "none",
      }).success,
    ).toBe(true);
  });

  it("admits a reviewed guarded edit and content-free mutation receipt", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const operationId = "00000000-0000-4000-8000-000000000002";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.prepare-workspace-edit",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.apply-workspace-edit",
        operationId,
        oldText: "before",
        newText: "after",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.cancel-workspace-edit",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-edit-preview",
        operationId,
        workspaceId,
        relativePath: "README.md",
        bytes: 7,
        beforeSha256: "a".repeat(64),
        expiresAt: "2026-09-16T10:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-mutation",
        operationId,
        workspaceId,
        relativePath: "README.md",
        operation: "edit",
        bytes: 6,
        replacements: 1,
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        resultRetention: "durable",
        redelivered: false,
      }).success,
    ).toBe(true);
  });

  it("separates ChatGPT context preparation from one-shot submission", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const operationId = "00000000-0000-4000-8000-000000000002";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.prepare-readonly-task",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.submit-readonly-task",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.cancel-readonly-task",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.recover-task-result",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.ack-task-result",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.reset-conversation",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task-preview",
        operationId,
        workspaceId,
        workspaceLabel: "Owner workspace",
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        excludedPaths: ["private"],
        expiresAt: "2026-09-16T10:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task",
        operationId,
        state: "completed",
        code: null,
        workspaceId,
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        deltaCount: 2,
        observedCharacters: 84,
        conversationContinuity: "retained",
        redelivered: false,
        deliveryAckRequired: true,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.task-recovery",
        operationId,
        taskKind: "readonly",
        state: "outcome_unknown",
        code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
        deltaCount: 0,
        observedCharacters: 0,
        attachmentCount: 0,
        totalBytes: 0,
        stagingCleanup: null,
        conversationContinuity: "review_required",
        redelivered: true,
        deliveryAckRequired: true,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.conversation-reset",
        state: "new",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task",
        state: "completed",
        code: null,
        workspaceId,
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        deltaCount: 2,
        observedCharacters: 84,
        conversationContinuity: "retained",
        redelivered: false,
        deliveryAckRequired: true,
      }).success,
    ).toBe(false);
  });

  it("admits bounded native host setup commands and content-free evidence", () => {
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.select-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.verify-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.remove-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.run-codex-smoke",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-probe",
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        capabilities: {
          dynamicTools: true,
          correlatedToolCalls: true,
          descendantObservation: true,
          collabObservation: true,
          compaction: true,
        },
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-probe",
        executablePath: "/Users/example/bin/codex",
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        capabilities: {
          dynamicTools: true,
          correlatedToolCalls: true,
          descendantObservation: true,
          collabObservation: true,
          compaction: true,
        },
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-live",
        model: "gpt-6-astra",
        threadState: "completed",
        dynamicToolCalls: 1,
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
      }).success,
    ).toBe(true);
  });
});
