import { describe, expect, it, vi } from "vitest";
import { computerSetup } from "../../src/ui/renderer/computer-setup";
import { WindowController } from "../../src/ui/renderer/controller";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { bootstrap, fixture, settings } from "./fixture";

// Pure projections over real controller doubles. No host/provider acceptance.
const buildId = "3".repeat(64);
const runtimeGeneration = "a".repeat(64);
const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-02T20:00:00.000Z";
function configured() {
  const value = settings();
  value.computer.workspaces = [
    {
      workspaceId,
      root: "/approved/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "1", inode: "2" },
      accessCheck: {
        buildId,
        computerGeneration: 1,
        verifiedAt: timestamp,
        rootIdentity: { device: "1", inode: "2" },
      },
    },
  ];
  const witness = {
    profile: "farol-next",
    configRevision: 1,
    workspaceId,
    runtimeGeneration,
    buildId,
    protocol: "secure-mcp",
    verifiedAt: timestamp,
  };
  value.setup.computer.verified = witness;
  value.setup.connect.verified = witness;
  value.connectors.secureMcp = {
    ...value.connectors.secureMcp,
    tunnelId: "owner-tunnel",
    credential: "stored",
    tunnelClient: {
      executablePath: "/approved/tunnel",
      executableSha256: "b".repeat(64),
      version: "1.0.0",
      protocol: "openai-tunnel-client/v1",
      verifiedAt: timestamp,
    },
    runtime: {
      state: "ready",
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      observedAt: timestamp,
    },
    challenge: {
      value: "33333333-3333-4333-8333-333333333333",
      challengeSha256: "c".repeat(64),
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      preparedAt: timestamp,
    },
    attachment: {
      tunnelId: "owner-tunnel",
      workspaceId,
      connectorGeneration: 1,
      computerGeneration: 1,
      runtimeGeneration,
      buildId,
      challengeSha256: "c".repeat(64),
      receiptSha256: "d".repeat(64),
      verifiedAt: timestamp,
    },
  };
  return ProductSettingsSchema.parse(value);
}
async function snapshot(value = configured()) {
  const f = fixture();
  vi.mocked(f.api.bootstrap).mockResolvedValue({
    ...bootstrap(),
    configuration: { status: "ready", settings: value },
  });
  const c = new WindowController(f.api);
  try {
    await c.start();
    return c.getSnapshot();
  } finally {
    c.dispose();
  }
}
describe("current Computer setup projection", () => {
  it("external Computer readiness needs no embedded login", async () => {
    const setup = computerSetup(await snapshot());
    expect(setup.ready).toBe(true);
    expect(setup.label).toBe("Computer ready");
    expect(setup.embeddedChatGPT).toBe("Sign-in check needed");
    expect(setup.canStart).toBe(false);
    expect(setup.canReconnect).toBe(true);
  });
  it("login alone never means Computer ready", async () => {
    const value = settings();
    value.setup.chatgpt.verified = configured().setup.computer.verified;
    const setup = computerSetup(await snapshot(value));
    expect(setup.ready).toBe(false);
    expect(setup.embeddedChatGPT).toBe("Ready");
  });
  it.each([
    "folder-build",
    "folder-generation",
    "folder-missing",
    "unchecked",
    "runtime-build",
    "runtime-generation",
    "connector-generation",
    "attachment-workspace",
    "attachment-tunnel",
    "witness-build",
    "witness-generation",
    "witness-runtime",
    "witness-workspace",
    "challenge-hash",
    "history-only",
  ])("does not reuse stale or mismatched readiness: %s", async (mismatch) => {
    const value = configured();
    const connector = value.connectors.secureMcp;
    if (mismatch === "folder-build")
      value.setup.computer.verified!.buildId = "e".repeat(64);
    if (mismatch === "folder-generation") value.computer.generation++;
    if (mismatch === "folder-missing")
      value.setup.computer.verified!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "unchecked")
      value.computer.workspaces[0]!.accessCheck = null;
    if (mismatch === "runtime-build")
      connector.runtime!.buildId = "e".repeat(64);
    if (mismatch === "runtime-generation")
      connector.runtime!.runtimeGeneration = "e".repeat(64);
    if (mismatch === "connector-generation") connector.generation++;
    if (mismatch === "attachment-workspace")
      connector.attachment!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "attachment-tunnel")
      connector.attachment!.tunnelId = "other-tunnel";
    if (mismatch === "witness-build")
      value.setup.connect.verified!.buildId = "e".repeat(64);
    if (mismatch === "witness-generation")
      value.setup.connect.verified!.configRevision++;
    if (mismatch === "witness-runtime")
      value.setup.connect.verified!.runtimeGeneration = "e".repeat(64);
    if (mismatch === "witness-workspace")
      value.setup.connect.verified!.workspaceId =
        "44444444-4444-4444-8444-444444444444";
    if (mismatch === "challenge-hash")
      connector.attachment!.challengeSha256 = "e".repeat(64);
    if (mismatch === "history-only") {
      connector.lastVerifiedAttachment = connector.attachment;
      connector.attachment = null;
    }
    expect(computerSetup(await snapshot(value)).ready).toBe(false);
  });
  it.each(["ready", "unreachable", "outcome_unknown"] as const)(
    "Start always requires a null runtime, including %s",
    async (state) => {
      const value = configured();
      value.connectors.secureMcp.runtime!.state = state;
      const setup = computerSetup(await snapshot(value));
      expect(setup.canStart).toBe(false);
      expect(setup.canReconnect).toBe(state !== "outcome_unknown");
    },
  );
  it("allows explicit Start only after host state records a stopped runtime", async () => {
    const value = configured();
    value.connectors.secureMcp.runtime = null;
    value.connectors.secureMcp.challenge = null;
    value.connectors.secureMcp.attachment = null;
    const setup = computerSetup(await snapshot(value));
    expect(setup.ready).toBe(false);
    expect(setup.canStart).toBe(true);
    expect(setup.canReconnect).toBe(false);
  });
  it.each(["pending", "unknown", "stale"])(
    "fences presentation and commands for %s",
    async (fence) => {
      const current = await snapshot();
      const next =
        fence === "stale"
          ? { ...current, status: "stale" as const }
          : {
              ...current,
              intents: {
                ...current.intents,
                foreign: {
                  id: "foreign",
                  state: fence as "pending" | "unknown",
                  code: null,
                },
              },
            };
      const setup = computerSetup(next);
      expect(setup.ready).toBe(false);
      expect(setup.canReconnect).toBe(false);
      expect(setup.externalChallenge).toBeNull();
    },
  );
});

describe("external verification challenge provenance", () => {
  it("uses the exact verified workspace even when another saved folder comes first", async () => {
    const value = configured();
    value.connectors.secureMcp.attachment = null;
    value.setup.connect.verified = null;
    const other = structuredClone(value.computer.workspaces[0]!);
    other.workspaceId = "44444444-4444-4444-8444-444444444444";
    other.root = "/other/folder";
    value.computer.workspaces.unshift(other);
    const setup = computerSetup(await snapshot(value));
    expect(setup.externalChallenge).toEqual({
      value: value.connectors.secureMcp.challenge!.value,
      workspaceId,
      root: "/approved/project",
      tunnelId: "owner-tunnel",
    });
  });
  it.each(["build", "runtime", "computer", "connector", "missing-workspace"])(
    "hides a mismatched challenge instead of selecting another grant: %s",
    async (mismatch) => {
      const value = configured();
      const connector = value.connectors.secureMcp;
      connector.attachment = null;
      value.setup.connect.verified = null;
      if (mismatch === "build") connector.challenge!.buildId = "e".repeat(64);
      if (mismatch === "runtime")
        connector.challenge!.runtimeGeneration = "e".repeat(64);
      if (mismatch === "computer") connector.challenge!.computerGeneration++;
      if (mismatch === "connector") connector.generation++;
      if (mismatch === "missing-workspace")
        value.setup.computer.verified!.workspaceId =
          "44444444-4444-4444-8444-444444444444";
      expect(computerSetup(await snapshot(value)).externalChallenge).toBeNull();
    },
  );
});
