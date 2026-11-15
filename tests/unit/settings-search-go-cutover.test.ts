import { describe, expect, it, vi } from "vitest";
import { BridgeError } from "../../apps/desktop/bridge/client";
import { createConfigurationComputer } from "../../apps/desktop/configuration/computer";
import type { ConfigurationComputerPorts } from "../../apps/desktop/configuration/computer";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

const workspaceId = "00000000-0000-4000-8000-000000000001";

function makeSettings(generation: number) {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: "00000000-0000-4000-8000-000000000010",
      generation,
      name: "This Mac",
      commands: "verification",
      workspaces: [
        {
          workspaceId,
          root: "/synthetic",
          label: "Primary",
          access: "read",
          excludedPaths: [],
          rootIdentity: SYNTHETIC_ROOT_IDENTITY,
        },
      ],
    },
    nativeHosts: { generation: 1, codex: null },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: {
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
      computer: {
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
      connect: {
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
      hosts: {
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
      verify: {
        visited: true,
        skipped: false,
        configured: true,
        reachable: "reachable",
        verified: null,
        needsAction: null,
        unavailable: null,
        outcomeUnknown: false,
      },
    },
  });
}

function fixture(mode: string) {
  let generation = 3;
  const search = vi.fn(async () => {
    if (mode === "refused")
      throw new BridgeError("refused", "WORKSPACE_PATH_REFUSED");
    if (mode === "unknown") throw new BridgeError("unknown", "lost_read");
    if (mode === "stale") generation++;
    return {
      root: {
        path: "/synthetic",
        device: mode === "crossed" ? "9" : "1",
        inode: "2",
      },
      matches: [
        { path: "note.md", line: "1", text: "match", truncated: false },
      ],
      resultLimited: true,
      scanLimited: false,
    };
  });
  const workspace = {
    workspaceId,
    root: "/synthetic",
    label: "Primary",
    access: "read" as const,
    excludedPaths: [],
    rootIdentity: SYNTHETIC_ROOT_IDENTITY,
  };
  const configuration = {
    snapshot: () => ({
      status: "ready" as const,
      settings: makeSettings(generation),
    }),
  };
  const ports = {
    configuration: () => configuration,
    codexAgentOperationActive: () => false,
    configurationFailure: vi.fn((error: string) => ({ ok: false, error })),
    getPendingWorkspacePick: () => null,
    setPendingWorkspacePick: vi.fn(),
    selectedWorkspace: vi.fn(async () => "cancelled" as const),
    measuredRootIdentity: vi.fn(async () => null),
    inspectOwnerWorkspace: vi.fn(async () => ({ ok: true })),
    buildIdentity: () => ({ buildId: "build" }),
    workspaceReadFailure: vi.fn((code: string) => ({ ok: false, error: code })),
    desktopAdmission: {
      occupied: () => false,
      reserveAdmitted: () => ({ release: vi.fn() }),
    },
    secureMcpConnectorRuntime: () => null,
    runtime: () => ({ identity: "runtime" }),
    verifiedProductWorkspace: vi.fn(() => ({
      status: "verified" as const,
      workspace,
    })),
    listOwnerWorkspace: vi.fn(async () => ({
      ok: false as const,
      code: "WORKSPACE_READ_FAILED",
    })),
    desktopGoCore: () =>
      mode === "missing" ? null : { searchSettingsWorkspace: search },
    compiledGoCore: () => (mode === "missing" ? null : {}),
    discoverWorkspaceGitMetadata: vi.fn(async () => null),
    verificationWorkspaceAction: vi.fn(() => null),
    getPendingWorkspaceEdit: () => null,
    setPendingWorkspaceEdit: vi.fn(),
    selectedWorkspaceFile: vi.fn(async () => "cancelled" as const),
    goWorkspaceEditResult: vi.fn(() => ({ ok: true })),
    statePaths: () => ({ workspaceMutations: "/tmp/mutations" }),
    workspaceMutationFailure: vi.fn((code: string) => ({
      ok: false,
      error: code,
    })),
    workspaceCommandFailure: vi.fn((code: string) => ({
      ok: false,
      error: code,
    })),
  } as unknown as ConfigurationComputerPorts;

  const computer = createConfigurationComputer(ports);
  const run = async () =>
    computer.configureAdmittedComputer({
      kind: "computer.search-workspace",
      workspaceId,
      relativePath: ".",
      pattern: "match",
    } as Parameters<typeof computer.configureAdmittedComputer>[0]);

  return { run, search };
}

describe("selected Settings search Go cutover", () => {
  it("calls Go once and maps decimal line transport without a Python helper", async () => {
    const f = fixture("ok");
    expect(await f.run()).toMatchObject({
      ok: true,
      evidence: {
        matches: [{ path: "note.md", line: 1 }],
        resultLimited: true,
        scanLimited: false,
      },
    });
    expect(f.search).toHaveBeenCalledExactlyOnceWith(
      3,
      workspaceId,
      ".",
      "match",
    );
  });
  it.each(["missing", "refused", "unknown", "stale", "crossed"])(
    "refuses %s without a legacy dispatch",
    async (mode) => {
      const f = fixture(mode);
      const result = await f.run();
      expect(result).toMatchObject({ ok: false });
      expect(f.search).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
    },
  );
});
