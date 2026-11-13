import { describe, expect, it } from "vitest";
import type { ProductSettings } from "../../../pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../../modules/computer/infra/repo/owner-settings-computer-approval";
import {
  advanceComputerApprovalGeneration,
  connectorConfigured,
  defaultSettings,
  invalidateStaleAgentVerification,
  invalidateStaleCodexTaskSource,
  invalidateStaleConnectorRuntime,
  invalidateUnboundComputerVerification,
  pendingAgentReadiness,
  pendingConnectorReadiness,
  readiness,
  settingsError,
  withoutRecovery,
} from "./rules";

const COMPUTER_ID = "5f7c2b0e-3a1d-4e8b-9c6a-0d4f1e2b3a45";
const sha = (digit: string): string => digit.repeat(64);

const approvedPolicy = (settings: ProductSettings): unknown =>
  ownerSettingsComputerApproval(settings, 0);

const fresh = (): ProductSettings => defaultSettings(() => COMPUTER_ID);

const withWorkspace = (
  settings: ProductSettings,
  rootIdentity?: { device: string; inode: string },
): ProductSettings => ({
  ...settings,
  computer: {
    ...settings.computer,
    workspaces: [
      {
        workspaceId: "workspace-1",
        root: "/Users/example/project",
        label: "Project",
        access: "read",
        excludedPaths: [],
        ...(rootIdentity ? { rootIdentity } : {}),
      },
    ],
  },
});

const withComputerVerification = (
  settings: ProductSettings,
): ProductSettings => ({
  ...settings,
  setup: {
    ...settings.setup,
    computer: {
      ...settings.setup.computer,
      configured: true,
      reachable: "reachable",
      needsAction: null,
      verified: {
        profile: "computer.local.read/1",
        runtimeGeneration: "runtime-1",
        buildId: sha("c"),
        protocol: "readonly-workspace/1",
        configRevision: settings.computer.generation,
        workspaceId: "workspace-1",
        verifiedAt: "2026-09-01T00:00:00.000Z",
      },
    },
  },
});

describe("settingsError", () => {
  it.each(["CONFIG_RENAME_REQUIRED", "SETTINGS_CORRUPT", "SETTINGS_UNSAFE"])(
    "keeps the classified code %s",
    (code) => {
      expect(settingsError(new Error(code))).toEqual({
        status: "error",
        error: code,
      });
    },
  );

  it("reports every other failure as an unreadable store", () => {
    expect(settingsError(new Error("EIO"))).toEqual({
      status: "error",
      error: "SETTINGS_READ_FAILED",
    });
    expect(settingsError("not an error")).toEqual({
      status: "error",
      error: "SETTINGS_READ_FAILED",
    });
  });
});

describe("readiness helpers", () => {
  it("starts a step unverified, unreachable-unknown and needing action", () => {
    expect(readiness("Do it.")).toEqual({
      visited: false,
      skipped: false,
      configured: false,
      reachable: "unknown",
      verified: null,
      needsAction: "Do it.",
      unavailable: null,
      outcomeUnknown: false,
    });
  });

  it("drops only the recovery record", () => {
    const step = {
      ...readiness("x"),
      recovery: { kind: "agent-rejoin" },
    } as unknown as ProductSettings["setup"]["verify"];
    const stripped = withoutRecovery(step);
    expect("recovery" in stripped).toBe(false);
    expect(stripped.needsAction).toBe("x");
  });

  it("withdraws agent evidence and clears an unknown outcome", () => {
    const previous = {
      ...readiness("old"),
      configured: true,
      reachable: "reachable",
      outcomeUnknown: true,
    } as ProductSettings["setup"]["verify"];
    expect(
      pendingAgentReadiness(previous, "Run the check.", false),
    ).toMatchObject({
      configured: false,
      reachable: "unknown",
      verified: null,
      needsAction: "Run the check.",
      unavailable: null,
      outcomeUnknown: false,
    });
  });
});

describe("defaultSettings", () => {
  it("builds a valid first-run document from the supplied id", () => {
    const settings = fresh();
    expect(settings.computer.computerId).toBe(COMPUTER_ID);
    expect(settings).toMatchObject({
      revision: 1,
      computer: { generation: 1, commands: "none", workspaces: [] },
      connectors: { secureMcp: { generation: 1, credential: "missing" } },
      setup: { journey: { currentStep: "chatgpt", dismissed: false } },
    });
  });
});

describe("invalidateUnboundComputerVerification", () => {
  it("leaves settings without a verification untouched", () => {
    const settings = fresh();
    expect(invalidateUnboundComputerVerification(settings)).toBe(settings);
  });

  it("keeps a verification of a workspace bound to a folder identity", () => {
    const settings = withComputerVerification(
      withWorkspace(fresh(), { device: "9", inode: "77" }),
    );
    expect(invalidateUnboundComputerVerification(settings)).toBe(settings);
  });

  it("withdraws a verification of a workspace with no folder identity", () => {
    const settings = withComputerVerification(withWorkspace(fresh()));
    const next = invalidateUnboundComputerVerification(settings);
    expect(next.setup.computer).toMatchObject({
      verified: null,
      reachable: "unknown",
    });
    expect(next.setup.computer.needsAction).toContain("Verify Project again");
  });

  it("withdraws a verification whose workspace no longer exists", () => {
    const settings = withComputerVerification(fresh());
    const next = invalidateUnboundComputerVerification(settings);
    expect(next.setup.computer).toMatchObject({
      verified: null,
      needsAction: "Verify a folder.",
    });
  });
});

describe("advanceComputerApprovalGeneration", () => {
  it("keeps the candidate when the approved policy is unchanged", () => {
    const previous = fresh();
    const candidate = { ...previous, revision: previous.revision + 1 };
    expect(
      advanceComputerApprovalGeneration(previous, candidate, approvedPolicy),
    ).toBe(candidate);
  });

  it("advances the generation when the approved policy changes", () => {
    const previous = withWorkspace(fresh(), { device: "9", inode: "77" });
    const candidate: ProductSettings = {
      ...previous,
      computer: { ...previous.computer, commands: "verification" },
    };
    const next = advanceComputerApprovalGeneration(
      previous,
      candidate,
      approvedPolicy,
    );
    expect(next.computer.generation).toBe(previous.computer.generation + 1);
  });

  it("carries a verification and fresh evidence to the new generation only", () => {
    const base = withComputerVerification(
      withWorkspace(fresh(), { device: "9", inode: "77" }),
    );
    const previous: ProductSettings = {
      ...base,
      computer: {
        ...base.computer,
        workspaces: base.computer.workspaces.map((workspace) => ({
          ...workspace,
          accessCheck: {
            buildId: sha("c"),
            computerGeneration: base.computer.generation,
            verifiedAt: "2026-09-01T00:00:00.000Z",
            rootIdentity: { device: "9", inode: "77" },
          },
        })),
      },
    };
    const candidate: ProductSettings = {
      ...previous,
      computer: { ...previous.computer, commands: "verification" },
    };
    const next = advanceComputerApprovalGeneration(
      previous,
      candidate,
      approvedPolicy,
    );
    const generation = previous.computer.generation + 1;
    expect(next.setup.computer.verified?.configRevision).toBe(generation);
    expect(next.computer.workspaces[0]?.accessCheck?.computerGeneration).toBe(
      generation,
    );
  });
});

describe("invalidateStaleAgentVerification", () => {
  it("ignores settings with no native Agent verification", () => {
    const settings = fresh();
    expect(invalidateStaleAgentVerification(settings)).toBe(settings);
  });

  it("withdraws the evidence and asks for the live host check first", () => {
    const base = withComputerVerification(
      withWorkspace(fresh(), { device: "9", inode: "77" }),
    );
    const settings = {
      ...base,
      nativeHosts: {
        ...base.nativeHosts,
        codex: {
          executableSha256: sha("a"),
          schemaSha256: sha("b"),
          liveVerification: null,
          agentVerification: {
            workspaceId: "workspace-1",
            executableSha256: sha("a"),
            schemaSha256: sha("b"),
            buildId: sha("c"),
            computerGeneration: base.computer.generation,
          },
        },
      },
    } as unknown as ProductSettings;
    const next = invalidateStaleAgentVerification(settings);
    expect(next.nativeHosts.codex?.agentVerification).toBeNull();
    expect(next.setup.verify.needsAction).toBe(
      "Run the live Codex host check first.",
    );
    expect(next.setup.verify.configured).toBe(false);
  });
});

describe("invalidateStaleCodexTaskSource", () => {
  it("ignores settings with no Task source", () => {
    const settings = fresh();
    expect(invalidateStaleCodexTaskSource(settings)).toBe(settings);
  });

  it("drops a source that no host evidence supports and bumps the host generation", () => {
    const base = fresh();
    const settings = {
      ...base,
      nativeHosts: {
        ...base.nativeHosts,
        codex: {
          executablePath: "/opt/codex",
          executableSha256: sha("a"),
          schemaSha256: sha("b"),
          version: "1",
          localVerification: null,
          taskSource: { hostGeneration: base.nativeHosts.generation },
        },
      },
    } as unknown as ProductSettings;
    const next = invalidateStaleCodexTaskSource(settings);
    expect(next.nativeHosts.codex?.taskSource).toBeNull();
    expect(next.nativeHosts.taskRoute).toBeNull();
    expect(next.nativeHosts.generation).toBe(base.nativeHosts.generation + 1);
  });
});

describe("connector rules", () => {
  const secure = (
    patch: Partial<ProductSettings["connectors"]["secureMcp"]>,
  ): ProductSettings["connectors"]["secureMcp"] => ({
    ...fresh().connectors.secureMcp,
    ...patch,
  });

  it("is configured only with a client, a tunnel and a stored credential", () => {
    const client = {
      executablePath: "/opt/tunnel-client",
      executableSha256: sha("a"),
      version: "0.0.14",
      protocol: "openai-tunnel-client/v1",
    } as ProductSettings["connectors"]["secureMcp"]["tunnelClient"];
    expect(connectorConfigured(secure({}))).toBe(false);
    expect(
      connectorConfigured(
        secure({ tunnelClient: client, tunnelId: "t", credential: "stored" }),
      ),
    ).toBe(true);
    expect(
      connectorConfigured(
        secure({ tunnelClient: client, tunnelId: "t", credential: "missing" }),
      ),
    ).toBe(false);
  });

  it("names the next action in order", () => {
    const previous = fresh().setup.connect;
    expect(pendingConnectorReadiness(previous, secure({})).needsAction).toBe(
      "Choose the verified tunnel-client executable.",
    );
    expect(
      pendingConnectorReadiness(previous, secure({}), "Custom.").needsAction,
    ).toBe("Custom.");
  });

  it("keeps a runtime that matches both generations", () => {
    const settings = fresh();
    expect(invalidateStaleConnectorRuntime(settings)).toBe(settings);
  });

  it("drops runtime evidence made under an older Computer generation", () => {
    const base = fresh();
    const settings = {
      ...base,
      connectors: {
        secureMcp: {
          ...base.connectors.secureMcp,
          runtime: {
            state: "ready",
            connectorGeneration: base.connectors.secureMcp.generation,
            computerGeneration: base.computer.generation + 1,
            runtimeGeneration: sha("d"),
            buildId: sha("c"),
          },
        },
      },
    } as unknown as ProductSettings;
    const next = invalidateStaleConnectorRuntime(settings);
    expect(next.connectors.secureMcp).toMatchObject({
      generation: base.connectors.secureMcp.generation + 1,
      runtime: null,
      challenge: null,
      attachment: null,
    });
    expect(next.setup.connect.needsAction).toBe(
      "Restart the connector after changing Computer authority.",
    );
  });
});
