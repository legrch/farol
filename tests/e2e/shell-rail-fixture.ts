import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";

/** Synthetic renderer evidence only. No account, provider, connection or disk access. */
export function shellRailFixture(ready: boolean) {
  const buildId = "3".repeat(64);
  const verifiedAt = "2026-10-22T10:24:00.000Z";
  const runtimeGeneration = "a".repeat(64);
  const workspaceId = "22222222-2222-4222-8222-222222222222";
  const readiness = {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  const settings = ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      name: "This Mac",
      workspaces: [],
    },
    setup: {
      chatgpt: readiness,
      computer: readiness,
      connect: readiness,
      hosts: readiness,
      verify: readiness,
    },
  });
  if (ready) {
    const rootIdentity = { device: "1", inode: "2" };
    settings.computer.workspaces = [
      {
        workspaceId,
        root: "/fixture/project",
        label: "Project",
        access: "read",
        excludedPaths: [],
        rootIdentity,
        accessCheck: {
          buildId,
          computerGeneration: 1,
          verifiedAt,
          rootIdentity,
        },
      },
    ];
    const witness = {
      profile: "farol",
      configRevision: 1,
      workspaceId,
      runtimeGeneration,
      buildId,
      protocol: "secure-mcp",
      verifiedAt,
    };
    settings.setup.chatgpt.verified = witness;
    settings.setup.chatgpt.configured = true;
    settings.setup.chatgpt.reachable = "reachable";
    settings.setup.computer.verified = witness;
    settings.setup.computer.reachable = "reachable";
    settings.setup.connect.verified = witness;
    settings.setup.connect.reachable = "reachable";
    Object.assign(settings.connectors.secureMcp, {
      tunnelId: "fixture-tunnel",
      credential: "stored",
      tunnelClient: {
        executablePath: "/fixture/tunnel",
        executableSha256: "b".repeat(64),
        version: "1.0.0",
        protocol: "openai-tunnel-client/v1",
        verifiedAt,
      },
      chatgptApp: {
        name: "Farol",
        tunnelId: "fixture-tunnel",
        connectorGeneration: 1,
      },
      runtime: {
        state: "ready",
        connectorGeneration: 1,
        computerGeneration: 1,
        runtimeGeneration,
        buildId,
        observedAt: verifiedAt,
      },
      attachment: {
        tunnelId: "fixture-tunnel",
        workspaceId,
        connectorGeneration: 1,
        computerGeneration: 1,
        runtimeGeneration,
        buildId,
        challengeSha256: "c".repeat(64),
        receiptSha256: "d".repeat(64),
        verifiedAt,
      },
    });
  }
  return {
    schema: 3,
    environment: "preview",
    build: {
      schema: 1,
      product: "Farol",
      version: "0.2.7",
      bundleId: "io.github.legrch.farol",
      updateChannel: "github-stable",
      buildVersion: "36",
      builtAt: verifiedAt,
      sourceCommit: "1".repeat(40),
      sourceTreeDigest: "2".repeat(64),
      sourceDirty: false,
      buildId,
    },
    configuration: {
      status: "ready",
      settings: ProductSettingsSchema.parse(settings),
    },
    runtimeState: "ready",
    taskRevision: 0,
    tasks: [],
    windowState: {
      focused: false,
      fullScreen: false,
      trafficLightPosition: null,
    },
  };
}
