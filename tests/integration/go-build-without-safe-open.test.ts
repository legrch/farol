import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { describe, expect, it, vi } from "vitest";

import type { DelegatedAgentAuthority } from "../../src/modules/agent/app/port/execution-authority";
import type { ReadonlyWorkspace } from "../../src/modules/computer/app/port/readonly-workspace";
import { CodexAgentWorkspaceProbe } from "../../src/apps/desktop/codex-agent-workspace-probe";
import { GoSettingsListWorkspace } from "../../src/apps/desktop/go-settings-workspace";
import {
  ProductConfigurationResultSchema,
  ProductSettingsSchema,
} from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// Actual main.ts source composition with controlled producers, not a native
// host: the Go-aware gates are extracted from the source and run in a context
// whose Python-backed collaborators are spies.
const main = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const shell = fs.readFileSync("src/ui/shell.ts", "utf8");

function select(predicate: (node: Record<string, unknown>) => boolean) {
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
  visit(parse(main, { sourceType: "module", plugins: ["typescript"] }));
  if (matches.length !== 1) throw Error("COMPOSITION_MISSING");
  const match = matches[0]!;
  return main.slice(match.start as number, match.end as number);
}

const gitCase = select(
  (node) =>
    node.type === "SwitchCase" &&
    (node.test as { value?: string } | null)?.value === "computer.run-git-head",
);
const checkWorkspace = select(
  (node) =>
    node.type === "FunctionDeclaration" &&
    (node.id as { name?: string })?.name === "codexAgentCheckWorkspace",
);

const unavailableSnapshot = { status: "error", error: "SETTINGS_READ_FAILED" };

function configurationFailure(error: string) {
  return ProductConfigurationResultSchema.parse({
    ok: false,
    error,
    snapshot: unavailableSnapshot,
  });
}

const workspaceId = "00000000-0000-4000-8000-000000000001";

function gitContext(
  overrides: Readonly<{
    compiledGoCore: unknown;
    commands?: "none" | "verification";
    verified?: boolean;
  }>,
) {
  const spies = {
    verificationWorkspaceAction: vi.fn(),
    nativeWorkspaceExecute: vi.fn(),
    spawnSnapshotHelper: vi.fn(),
    runHelper: vi.fn(),
    randomUUID: vi.fn(() => "call-id"),
  };
  const settings = {
    computer: {
      commands: overrides.commands ?? "verification",
      generation: 7,
    },
  };
  const context = {
    compiledGoCore: overrides.compiledGoCore,
    configuration: {
      snapshot: () => ({ status: "ready", settings }),
    },
    configurationFailure,
    verifiedProductWorkspace: () =>
      overrides.verified === false
        ? { status: "not_verified" }
        : {
            status: "verified",
            workspace: { workspaceId, root: "/workspace/primary" },
          },
    verificationWorkspaceAction: spies.verificationWorkspaceAction,
    nativeWorkspace: { execute: spies.nativeWorkspaceExecute },
    spawnSnapshotHelper: spies.spawnSnapshotHelper,
    runHelper: spies.runHelper,
    randomUUID: spies.randomUUID,
    workspaceCommandFailure: (code: string) => configurationFailure(code),
    ProductConfigurationResultSchema: {
      parse: (value: unknown) => value,
    },
    Date,
  };
  return { context, spies };
}

function runGitCommand(
  context: object,
  kind: "computer.run-git-status" | "computer.run-git-head",
): Promise<{ ok: boolean; error?: string; evidence?: { command: string } }> {
  // The head case carries the body shared with the status label above it.
  const source = stripTypeScriptTypes(
    `async function run(command: any) { switch (command.kind) { case "computer.run-git-status": ${gitCase} } }`,
  );
  return vm.runInNewContext(
    `${source}; run({ kind: ${JSON.stringify(kind)}, workspaceId: ${JSON.stringify(workspaceId)} })`,
    context,
  );
}

describe("Git status and Git HEAD in a Go-aware build", () => {
  it("extracts the one case that serves both commands", () => {
    expect(gitCase).toContain("verificationWorkspaceAction(");
    expect(gitCase).toContain("compiledGoCore !== null");
  });

  for (const kind of [
    "computer.run-git-status",
    "computer.run-git-head",
  ] as const) {
    it(`${kind} refuses with the closed unavailable code and reaches neither Python nor git`, async () => {
      const { context, spies } = gitContext({ compiledGoCore: { go: true } });
      const result = await runGitCommand(context, kind);
      expect(result).toMatchObject({
        ok: false,
        error: "WORKSPACE_COMMAND_UNAVAILABLE",
      });
      expect(spies.verificationWorkspaceAction).not.toHaveBeenCalled();
      expect(spies.nativeWorkspaceExecute).not.toHaveBeenCalled();
      expect(spies.spawnSnapshotHelper).not.toHaveBeenCalled();
      expect(spies.runHelper).not.toHaveBeenCalled();
      expect(spies.randomUUID).not.toHaveBeenCalled();
    });
  }

  it("keeps the earlier owner-facing refusals in front of the unavailable one", async () => {
    const off = gitContext({ compiledGoCore: {}, commands: "none" });
    await expect(
      runGitCommand(off.context, "computer.run-git-status"),
    ).resolves.toMatchObject({
      error: "WORKSPACE_COMMAND_APPROVAL_REQUIRED",
    });
    const unverified = gitContext({ compiledGoCore: {}, verified: false });
    await expect(
      runGitCommand(unverified.context, "computer.run-git-head"),
    ).resolves.toMatchObject({ error: "WORKSPACE_VERIFICATION_REQUIRED" });
    for (const { spies } of [off, unverified]) {
      expect(spies.verificationWorkspaceAction).not.toHaveBeenCalled();
    }
  });

  for (const [kind, command] of [
    ["computer.run-git-status", "git.status"],
    ["computer.run-git-head", "git.head"],
  ] as const) {
    it(`a legacy build still runs ${kind} through the native verifier unchanged`, async () => {
      const { context, spies } = gitContext({ compiledGoCore: null });
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
      spies.verificationWorkspaceAction.mockReturnValue({ execute });
      const result = await runGitCommand(context, kind);
      expect(spies.verificationWorkspaceAction).toHaveBeenCalledTimes(1);
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
      compiledGoCore,
      nativeWorkspace,
      GoSettingsListWorkspace,
      listOwnerWorkspace,
      settings,
    },
  );
  return { chosen, nativeExecute, nativeWorkspace };
}

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
    // One allowed list; the foreign scope and the exclusion are denied before
    // any workspace access.
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
    expect(flat).toContain(
      "new CodexAgentWorkspaceProbe( settings, codexAgentCheckWorkspace(settings), () => Date.now(), )",
    );
  });

  it("publishes whether the Git checks exist and the shell disables both buttons from it", () => {
    expect(flat).toContain("gitVerificationAvailable: compiledGoCore === null");
    expect(shell).toContain("gitVerificationAvailable: z.boolean()");
    expect(shell).toContain("available: bootstrap.gitVerificationAvailable");
    expect(shell).toContain("gitStatus.disabled = gitChecksBlocked");
    expect(shell).toContain("gitHead.disabled = gitChecksBlocked");
  });
});
