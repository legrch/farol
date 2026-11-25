import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";

import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import { CodexAgentWorkspaceProbe } from "../../src/apps/desktop/codex-agent-workspace-probe";
import { GoSettingsListWorkspace } from "../../src/apps/desktop/go-settings-workspace";
import { createConfigurationComputer } from "../../apps/desktop/configuration/computer";
import type { ConfigurationComputerPorts } from "../../apps/desktop/configuration/computer";
import { ProductSettingsSchema } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// Actual source composition of the Codex agent check workspace selection. The
// selection lives in the workspace commands owner; main lends its inputs.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const workspaceCommands = fs.readFileSync(
  "apps/desktop/configuration/files.ts",
  "utf8",
);
const runtimeStatus = fs.readFileSync("apps/desktop/runtime/status.ts", "utf8");
const configurationHost = fs.readFileSync(
  "apps/desktop/configuration/host.ts",
  "utf8",
);

function select(
  predicate: (node: Record<string, unknown>) => boolean,
  source = main,
) {
  const matches: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (predicate(node)) matches.push(node);
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  }
  visit(parse(source, { sourceType: "module", plugins: ["typescript"] }));
  if (matches.length !== 1) throw Error("COMPOSITION_MISSING");
  const match = matches[0]!;
  return source.slice(match.start as number, match.end as number);
}

const checkWorkspace = select(
  (node) =>
    node.type === "FunctionDeclaration" &&
    (node.id as { name?: string })?.name === "codexAgentCheckWorkspace",
  workspaceCommands,
);

const workspaceId = "00000000-0000-4000-8000-000000000001";
const referenceId = "00000000-0000-4000-8000-000000000002";

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

const settings = ProductSettingsSchema.parse({
  schema: 1,
  revision: 1,
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
        workspaceId,
        root: "/workspace/primary",
        label: "Primary",
        access: "read",
        excludedPaths: ["/workspace/primary/private"],
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
      },
      {
        workspaceId: referenceId,
        root: "/workspace/reference",
        label: "Reference",
        access: "read",
        excludedPaths: [],
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
      },
    ],
  },
  nativeHosts: { generation: 1, codex: null },
  setup: {
    journey: { currentStep: "verify", dismissed: false },
    chatgpt: readiness(),
    computer: readiness(),
    connect: readiness(),
    hosts: readiness(),
    verify: readiness(),
  },
});

// Ensure setup.computer.verified names the primary workspace for Git tests.
(
  settings as { setup: { computer: { verified: unknown } } }
).setup.computer.verified = {
  profile: "computer.local.read/1",
  configRevision: 7,
  workspaceId,
  runtimeGeneration: "runtime:build",
  buildId: "0".repeat(64),
  protocol: "readonly-workspace/1",
  verifiedAt: "2026-01-01T00:00:00.000Z",
};

const authority: DelegatedAgentAuthority = {
  authorityId: "authority-a",
  participantId: "critic-a",
  parentParticipantId: "agent-a",
  role: "critic",
  mutationOwnership: "none",
  ownerId: "owner-desktop",
  sessionId: "session-a",
  taskId: "task-a",
  taskEpoch: 7,
  computerId: settings.computer.computerId,
  computerGeneration: 7,
  workspaces: settings.computer.workspaces.map((workspace) => ({
    workspaceId: workspace.workspaceId,
    mode: "subtree" as const,
    root: workspace.root,
    access: "read" as const,
  })),
  excludedPaths: [{ workspaceId, path: "/workspace/primary/private" }],
  capabilities: ["workspace.list", "workspace.read", "workspace.search"],
  network: "none",
  commands: "none",
  expiresAt: 10_000,
};

const probeRequest = {
  identity: {
    assignmentId: "assignment-a",
    ownerId: "owner-desktop",
    sessionId: "session-a",
    taskId: "task-a",
    taskEpoch: 7,
    generation: 1,
  },
  authority,
  focusPath: "/workspace/primary",
  threadId: "child-a",
  turnId: "turn-a",
  callId: "call-a",
} as const;

function checkContext(
  compiledGoCore: unknown,
  listOwnerWorkspace: ReturnType<typeof vi.fn>,
) {
  const nativeExecute = vi.fn<ReadonlyWorkspace["execute"]>();
  const nativeWorkspace: ReadonlyWorkspace = { execute: nativeExecute };
  const chosen: ReadonlyWorkspace = vm.runInNewContext(
    `${stripTypeScriptTypes(checkWorkspace)}; codexAgentCheckWorkspace(settings)`,
    {
      compiledGoCore: () => compiledGoCore,
      nativeWorkspace,
      GoSettingsListWorkspace,
      listOwnerWorkspace,
      settings,
    },
  );
  return { chosen, nativeExecute, nativeWorkspace };
}

describe("Git status and Git HEAD in a Go-aware build", () => {
  const primaryWorkspace = {
    workspaceId,
    root: "/workspace/primary",
    label: "Primary",
    access: "read" as const,
    excludedPaths: ["/workspace/primary/private"],
    rootIdentity: SYNTHETIC_ROOT_IDENTITY,
  };

  function gitSettings(commands: "none" | "verification" = "verification") {
    return ProductSettingsSchema.parse({
      ...settings,
      computer: { ...settings.computer, commands },
    });
  }

  function gitPorts(overrides: {
    compiledGoCore: unknown;
    commands?: "none" | "verification";
    verified?: boolean;
    verificationAction?: unknown;
  }) {
    const s = gitSettings(overrides.commands ?? "verification");
    const verifiedWorkspace =
      overrides.verified === false
        ? { status: "not_verified" as const }
        : { status: "verified" as const, workspace: primaryWorkspace };
    // This fake owner implements only the branch collaborators exercised below.
    const ports = {
      configuration: () => ({
        snapshot: () => ({ status: "ready" as const, settings: s }),
      }),
      codexAgentOperationActive: () => false,
      configurationFailure: vi.fn((error: string) => ({ ok: false, error })),
      getPendingWorkspacePick: () => null,
      setPendingWorkspacePick: vi.fn(),
      selectedWorkspace: vi.fn(async () => "cancelled" as const),
      measuredRootIdentity: vi.fn(async () => null),
      inspectOwnerWorkspace: vi.fn(async () => ({ ok: true })),
      buildIdentity: () => ({ buildId: "build" }),
      workspaceReadFailure: vi.fn((code: string) => ({
        ok: false,
        error: code,
      })),
      desktopAdmission: {
        occupied: () => false,
        reserveAdmitted: () => ({ release: vi.fn() }),
      },
      secureMcpConnectorRuntime: () => null,
      runtime: () => ({ identity: "runtime" }),
      verifiedProductWorkspace: vi.fn(() => verifiedWorkspace),
      listOwnerWorkspace: vi.fn(async () => ({
        ok: false as const,
        code: "WORKSPACE_READ_FAILED",
      })),
      desktopGoCore: () => null,
      compiledGoCore: () => overrides.compiledGoCore,
      discoverWorkspaceGitMetadata: vi.fn(async () => null),
      verificationWorkspaceAction: vi.fn(
        () => overrides.verificationAction ?? null,
      ),
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
    return ports;
  }

  it.each(["computer.run-git-status", "computer.run-git-head"] as const)(
    "%s refuses a non-command verifier output",
    async (kind) => {
      const execute = vi.fn(async () => ({
        ok: true,
        value: {
          output: { kind: "workspace.entries", entries: [], truncated: false },
        },
      }));
      const ports = gitPorts({
        compiledGoCore: null,
        verificationAction: { execute },
      });
      const computer = createConfigurationComputer(ports);
      await expect(
        computer.configureAdmittedComputer({ kind, workspaceId }),
      ).resolves.toMatchObject({
        ok: false,
        error: "WORKSPACE_COMMAND_FAILED",
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  for (const kind of [
    "computer.run-git-status",
    "computer.run-git-head",
  ] as const) {
    it(`${kind} refuses with the closed unavailable code and reaches neither Python nor git`, async () => {
      const ports = gitPorts({ compiledGoCore: { go: true } });
      const computer = createConfigurationComputer(ports);
      const result = await computer.configureAdmittedComputer({
        kind,
        workspaceId,
      });
      expect(result).toMatchObject({
        ok: false,
        error: "WORKSPACE_COMMAND_UNAVAILABLE",
      });
      expect(ports.verificationWorkspaceAction).not.toHaveBeenCalled();
    });
  }

  it("keeps the earlier owner-facing refusals in front of the unavailable one", async () => {
    const off = gitPorts({ compiledGoCore: {}, commands: "none" });
    const offComputer = createConfigurationComputer(off);
    await expect(
      offComputer.configureAdmittedComputer({
        kind: "computer.run-git-status",
        workspaceId,
      }),
    ).resolves.toMatchObject({
      error: "WORKSPACE_COMMAND_APPROVAL_REQUIRED",
    });

    const unverified = gitPorts({ compiledGoCore: {}, verified: false });
    const unverifiedComputer = createConfigurationComputer(unverified);
    await expect(
      unverifiedComputer.configureAdmittedComputer({
        kind: "computer.run-git-head",
        workspaceId,
      }),
    ).resolves.toMatchObject({ error: "WORKSPACE_VERIFICATION_REQUIRED" });

    for (const ports of [off, unverified]) {
      expect(ports.verificationWorkspaceAction).not.toHaveBeenCalled();
    }
  });

  for (const [kind, command] of [
    ["computer.run-git-status", "git.status"],
    ["computer.run-git-head", "git.head"],
  ] as const) {
    it(`a legacy build still runs ${kind} through the native verifier unchanged`, async () => {
      const execute = vi.fn(async (_request: unknown) => ({
        ok: true,
        value: {
          output: {
            kind: "workspace.command",
            command,
            exitCode: 0,
            stdout: "out",
            stderr: "",
            outputBytes: 3,
            network: "none",
            coverage: "tracked-files-only",
            layout: "primary",
          },
        },
      }));
      const ports = gitPorts({
        compiledGoCore: null,
        verificationAction: { execute },
      });
      const computer = createConfigurationComputer(ports);
      const result = await computer.configureAdmittedComputer({
        kind,
        workspaceId,
      });
      expect(ports.verificationWorkspaceAction).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]![0]).toMatchObject({
        workspaceId,
        operation: { kind: "verification.run", command, relativePath: "." },
      });
      expect(result).toMatchObject({
        ok: true,
        evidence: { command },
      });
    });
  }
});

describe("Codex agent check workspace in a Go-aware build", () => {
  it("lists through the Go settings list and never dispatches the Python workspace", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      entries: ["README.md"],
      truncated: false,
    }));
    const { chosen, nativeExecute } = checkContext({ go: true }, list);
    expect(chosen).toBeInstanceOf(GoSettingsListWorkspace);
    const probe = new CodexAgentWorkspaceProbe(settings, chosen, () => 1_000);

    await expect(probe.verify(probeRequest)).resolves.toEqual({
      status: "verified",
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        workspaceId,
        root: "/workspace/primary",
        approvedRoot: {
          path: "/workspace/primary",
          ...SYNTHETIC_ROOT_IDENTITY,
        },
      }),
      { path: "/workspace/primary", ...SYNTHETIC_ROOT_IDENTITY },
      ".",
    );
    expect(nativeExecute).not.toHaveBeenCalled();
  });

  for (const failure of [
    ["a refused list", async () => ({ ok: false as const, code: "NOPE" })],
    [
      "a root that changed",
      async () => ({ ok: false as const, code: "WORKSPACE_ROOT_CHANGED" }),
    ],
    [
      "a thrown Go error",
      async () => {
        throw new Error("go unavailable");
      },
    ],
  ] as const) {
    it(`fails the check on ${failure[0]} and never falls back to Python`, async () => {
      const list = vi.fn(failure[1]);
      const { chosen, nativeExecute } = checkContext({ go: true }, list);
      const probe = new CodexAgentWorkspaceProbe(settings, chosen, () => 1_000);

      await expect(probe.verify(probeRequest)).resolves.toEqual({
        status: "failed",
        code: "AGENT_WORKSPACE_ALLOWED_PROBE_FAILED",
      });
      expect(list).toHaveBeenCalledTimes(1);
      expect(nativeExecute).not.toHaveBeenCalled();
    });
  }

  it("refuses every operation but a list and never reaches the Go list for them", async () => {
    const list = vi.fn();
    const { chosen, nativeExecute } = checkContext({ go: true }, list);
    const workspace = {
      workspaceId,
      root: "/workspace/primary",
      deniedPaths: [],
      approvedRoot: {
        path: "/workspace/primary",
        ...SYNTHETIC_ROOT_IDENTITY,
      },
    };
    for (const operation of [
      { kind: "workspace.read", relativePath: "a" },
      { kind: "workspace.search", relativePath: ".", pattern: "x" },
      { kind: "verification.run", command: "git.status", relativePath: "." },
    ] as const) {
      await expect(
        chosen.execute({ workspace, operation }),
      ).resolves.toMatchObject({ ok: false });
    }
    expect(list).not.toHaveBeenCalled();
    expect(nativeExecute).not.toHaveBeenCalled();
  });

  it("keeps the native workspace for the explicit legacy build", async () => {
    const list = vi.fn();
    const { chosen, nativeWorkspace, nativeExecute } = checkContext(null, list);
    expect(chosen).toBe(nativeWorkspace);
    nativeExecute.mockResolvedValue({
      ok: true,
      value: { kind: "workspace.entries", entries: [], truncated: false },
    });
    const probe = new CodexAgentWorkspaceProbe(settings, chosen, () => 1_000);
    await expect(probe.verify(probeRequest)).resolves.toEqual({
      status: "verified",
    });
    expect(nativeExecute).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("main process and renderer wiring", () => {
  const flat = main.replace(/\s+/gu, " ");

  it("builds the Codex agent check probe from the Go-aware selection", () => {
    expect(configurationHost.replace(/\s+/gu, " ")).toContain(
      "new CodexAgentWorkspaceProbe( settings, codexAgentCheckWorkspace(settings), () => Date.now(), )",
    );
  });

  it("publishes whether the Git checks exist", () => {
    expect(runtimeStatus.replace(/\s+/gu, " ")).toContain(
      "gitVerificationAvailable: compiledGoCore === null",
    );
    // Main still lends the compiled declaration it reads that from.
    expect(flat).toContain("compiledGoCore, WORKSPACE_EDIT_ACK_HOLD_ENV,");
  });
});
