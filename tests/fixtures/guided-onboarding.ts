import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";

// Synthetic configuration only. Never proof of a live account/tunnel/model.
export const fixtureBuildId = "a".repeat(64);
export const fixtureWorkspaceId = "00000000-0000-4000-8000-000000000001";
export function guidedSettingsFixture() {
  const verified = {
    profile: "computer.local.read/1",
    configRevision: 1,
    workspaceId: fixtureWorkspaceId,
    runtimeGeneration: "b".repeat(64),
    buildId: fixtureBuildId,
    protocol: "readonly-workspace/1",
    verifiedAt: "2026-01-01T00:00:00.000Z",
  };
  const ready = {
    visited: true,
    skipped: false,
    configured: true,
    reachable: "reachable",
    verified,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  const blank = {
    visited: false,
    skipped: false,
    configured: false,
    reachable: "unknown",
    verified: null,
    needsAction: null,
    unavailable: null,
    outcomeUnknown: false,
  };
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "computer",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000002",
      generation: 1,
      name: "Fixture computer",
      workspaces: [
        {
          workspaceId: fixtureWorkspaceId,
          root: "/tmp/farol-onboarding-fixture",
          label: "Demo project",
          access: "read",
          excludedPaths: [],
        },
      ],
    },
    nativeHosts: { generation: 1, codex: null },
    connectors: {
      secureMcp: {
        generation: 1,
        profile: "farol-next",
        tunnelId: "tunnel_ui_fixture",
        credential: "stored",
        tunnelClient: {
          executablePath: "/tmp/farol-onboarding-fixture/tunnel-client",
          executableSha256: "e".repeat(64),
          version: "1.0.0",
          protocol: "openai-tunnel-client/v1",
          verifiedAt: verified.verifiedAt,
        },
        runtime: {
          state: "ready",
          connectorGeneration: 1,
          runtimeGeneration: verified.runtimeGeneration,
          computerGeneration: 1,
          buildId: fixtureBuildId,
          observedAt: verified.verifiedAt,
        },
        challenge: null,
        attachment: {
          tunnelId: "tunnel_ui_fixture",
          workspaceId: fixtureWorkspaceId,
          connectorGeneration: 1,
          runtimeGeneration: verified.runtimeGeneration,
          computerGeneration: 1,
          buildId: fixtureBuildId,
          challengeSha256: "c".repeat(64),
          receiptSha256: "d".repeat(64),
          verifiedAt: verified.verifiedAt,
        },
      },
    },
    setup: {
      journey: { currentStep: "chatgpt", dismissed: false },
      chatgpt: ready,
      computer: ready,
      connect: ready,
      hosts: blank,
      verify: blank,
    },
  });
}
