import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  AgentHost,
  AgentSpawnRequest,
} from "../../src/modules/agent/app/port/agent-host";
import { InMemoryAssignments } from "../../src/modules/agent/infra/repo/in-memory-assignments";
import {
  runProductAgentAssignment,
  type ProductAgentAssignmentDependencies,
} from "../../src/apps/desktop/product-agent-assignment";
import {
  productAgentInputMatchesContext,
  type ProductAgentContext,
} from "../../src/apps/desktop/product-agent-context";
import { resolveProductAgentScope } from "../../src/apps/desktop/product-agent-scope";
import type { ProductAgentInput } from "../../src/apps/desktop/product-agent-store";
import type { ProductAgentScopeSelection } from "../../src/modules/chat/contract/product-task";
import { ProductTaskSchema } from "../../src/modules/chat/contract/product-task";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";

// S35-TA-5. The assignment/context boundary for an owner's scope selection,
// driven end to end against a real folder: the owner's selection goes through
// the production resolver, into the production assignment builder, and the
// spawn request the native host would receive is asserted on the wire.
//
// The seam this closes is narrow and was the subject of a rejected review
// claim. `tests/integration/product-agent-assignment.test.ts` already asserts
// the exact-mode envelope, but it starts from a hand-written resolved scope,
// so it cannot show that the resolver produces that shape. These rows start
// from a `ProductAgentScopeSelection` — what the renderer actually sends —
// so resolver and envelope are pinned as one path.
//
// Two facts are load-bearing and neither is visible from the resolver alone:
// an exact selection is delivered as `{mode: "exact", root, paths}` rooted at
// the *workspace*, never as the subtree that happens to contain the files;
// and the parent task admission keeps the whole approved subtree while only
// the delegated Agent authority is narrowed to the files.

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-4000-8000-000000000010";
const GENERATION = 7;
const TIMESTAMP = "2026-09-20T12:00:00.000Z";
const EXECUTABLE_SHA = "1".repeat(64);
const SCHEMA_SHA = "3".repeat(64);
const BUILD_ID = "5".repeat(64);
const DELEGATION_DIGEST = "7".repeat(64);
const PARENT_THREAD_SHA = "8".repeat(64);
const CHILD_THREAD_SHA = "9".repeat(64);

/** The real folder the owner approved, and the real files inside it. */
let workspaceRoot: string;
let rootIdentity: Readonly<{ device: string; inode: string }>;

function at(...relative: string[]): string {
  return path.join(workspaceRoot, ...relative);
}

beforeAll(async () => {
  // `os.tmpdir()` is a symlink on macOS; the owner's approved root is always
  // the resolved path, so resolve it here rather than compare across the link.
  workspaceRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-agent-scope-")),
  );
  await fs.mkdir(at("docs", "drafts"), { recursive: true });
  await fs.mkdir(at("private"), { recursive: true });
  await fs.writeFile(at("README.md"), "# Approved\n");
  await fs.writeFile(at("docs", "plan.md"), "plan\n");
  await fs.writeFile(at("docs", "drafts", "wip.md"), "wip\n");
  await fs.writeFile(at("private", "secret.txt"), "secret\n");
  const stat = await fs.stat(workspaceRoot);
  rootIdentity = { device: String(stat.dev), inode: String(stat.ino) };
});

afterAll(async () => {
  if (workspaceRoot) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

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

function codexHost() {
  return {
    executablePath: "/usr/local/bin/codex",
    executableSha256: EXECUTABLE_SHA,
    version: "1.0.0",
    protocol: "codex-app-server/v2" as const,
    schemaSha256: SCHEMA_SHA,
    verifiedAt: TIMESTAMP,
    liveVerification: {
      model: "gpt-6-astra" as const,
      executableSha256: EXECUTABLE_SHA,
      schemaSha256: SCHEMA_SHA,
      buildId: BUILD_ID,
      dynamicTool: "farol_next_ping" as const,
      verifiedAt: TIMESTAMP,
    },
    agentVerification: {
      model: "gpt-6-astra" as const,
      executableSha256: EXECUTABLE_SHA,
      schemaSha256: SCHEMA_SHA,
      buildId: BUILD_ID,
      workspaceId: WORKSPACE_ID,
      computerGeneration: GENERATION,
      transport: "codex-native-agent/spawn-prompt-sha256-v1" as const,
      authorityRole: "agent" as const,
      hostRole: null,
      delegationDigest: DELEGATION_DIGEST,
      parentThreadSha256: PARENT_THREAD_SHA,
      childThreadSha256: CHILD_THREAD_SHA,
      boundedRunning: true as const,
      modelTurnsSubmitted: 1 as const,
      fallbackAllowed: false as const,
      descendantCount: 0 as const,
      resultRefProtocol: "codex-app-server" as const,
      resultRetention: "durable" as const,
      parentDelivery: "acknowledged" as const,
      workspaceEnforcement: "verified" as const,
      verifiedAt: TIMESTAMP,
    },
  };
}

/** Settings parsed by the real schema, around the real approved folder. */
function settingsOf(root: string = workspaceRoot): ProductSettings {
  return ProductSettingsSchema.parse({
    schema: 1,
    revision: 1,
    general: {
      openAtLaunch: "browser",
      sidebarDefault: "full",
      activityDetail: "summary",
    },
    computer: {
      computerId: COMPUTER_ID,
      generation: GENERATION,
      name: "This Mac",
      commands: "none",
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          root,
          label: "Approved",
          access: "read",
          excludedPaths: [path.join(root, "private")],
          rootIdentity,
        },
      ],
    },
    nativeHosts: { generation: 1, codex: codexHost() },
    setup: {
      journey: { currentStep: "verify", dismissed: false },
      chatgpt: readiness(),
      computer: readiness(),
      connect: readiness(),
      hosts: readiness(),
      verify: readiness(),
    },
  });
}

function contextOf(settings: ProductSettings): ProductAgentContext {
  const host = settings.nativeHosts.codex;
  const workspace = settings.computer.workspaces[0];
  if (!host || !workspace) throw new Error("TEST_CONTEXT_FIXTURE_INVALID");
  return { settings, host, workspace };
}

const task = ProductTaskSchema.parse({
  taskId: "task-a",
  sessionId: "session-a",
  turnId: "turn-a",
  label: "Owner task",
  provider: "chatgpt",
  requestedModel: "Account default",
  observedModel: null,
  requestedMode: "Account default",
  observedMode: null,
  hasComputer: false,
  pinned: false,
  lifecycle: "idle",
});

/**
 * The production path a `task.start-agent` command takes: resolve the owner's
 * selection against the approved workspace, then carry the resolved scope and
 * exclusions into the saved input verbatim, exactly as `main.ts` does.
 */
function inputFor(
  selection: ProductAgentScopeSelection,
  settings: ProductSettings = settingsOf(),
): ProductAgentInput {
  const workspace = settings.computer.workspaces[0];
  if (!workspace) throw new Error("TEST_WORKSPACE_FIXTURE_INVALID");
  const resolved = resolveProductAgentScope(
    workspace.root,
    workspace.excludedPaths,
    selection,
  );
  if (!resolved) throw new Error("TEST_SELECTION_REFUSED");
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    assignmentId: "assignment-a",
    authorityId: "authority-a",
    parentParticipantId: "main-a",
    agentParticipantId: "agent-a",
    taskEpoch: GENERATION,
    generation: 1,
    workspaceId: workspace.workspaceId,
    ...resolved,
    objective: "Find and summarize the continuity marker.",
    computerGeneration: GENERATION,
    executableSha256: EXECUTABLE_SHA,
    schemaSha256: SCHEMA_SHA,
    buildId: BUILD_ID,
    expiresAt: 10_000,
    createdAt: "1970-01-01T00:00:01.000Z",
  };
}

function dependencies() {
  const spawn = vi.fn(async (request: AgentSpawnRequest) => ({
    status: "started" as const,
    correlation: {
      ...request.identity,
      authorityId: request.authority.authorityId,
      participantId: request.authority.participantId,
      role: request.authority.role,
      parentThreadId: "parent-a",
      childId: "child-a",
      parentTurnId: "parent-turn-a",
      childTurnId: "child-turn-a",
      hostRole: "default",
      delegationDigest: DELEGATION_DIGEST,
    },
  }));
  const host: AgentHost = {
    spawn,
    wait: vi.fn(async (correlation) => ({
      status: "completed" as const,
      correlation,
      resultRef: "codex-app-server://thread/child-a/turn/turn-a",
      workspaceEnforcement: "verified" as const,
    })),
    cancel: vi.fn(async () => {
      throw new Error("unexpected cancel");
    }),
  };
  return {
    value: {
      host,
      assignments: new InMemoryAssignments(),
      now: () => 1_000,
    } satisfies ProductAgentAssignmentDependencies,
    spawn,
  };
}

async function spawnRequestFor(
  selection: ProductAgentScopeSelection,
): Promise<AgentSpawnRequest> {
  const fixture = dependencies();
  const settings = settingsOf();
  const result = await runProductAgentAssignment(
    settings,
    task,
    inputFor(selection, settings),
    fixture.value,
  );
  expect(result).toMatchObject({ ok: true });
  const request = fixture.spawn.mock.calls[0]?.[0];
  if (!request) throw new Error("TEST_SPAWN_NOT_CALLED");
  return request;
}

describe("S35-TA-5 an owner's selection on the wire", () => {
  it("delivers an exact selection as an exact scope rooted at the workspace", async () => {
    const request = await spawnRequestFor({
      mode: "exact",
      relativePaths: ["README.md", "docs/plan.md"],
    });

    // Never a subtree, and never rooted at `docs` merely because both files
    // could be covered by it.
    expect(request.authority.workspaces.map((scope) => scope.mode)).toEqual([
      "exact",
    ]);
    expect(request.authority.workspaces).toMatchObject([
      {
        workspaceId: WORKSPACE_ID,
        mode: "exact",
        root: workspaceRoot,
        paths: [at("README.md"), at("docs", "plan.md")],
        access: "read",
      },
    ]);
    expect(request.focus.initialPaths).toEqual([
      at("README.md"),
      at("docs", "plan.md"),
    ]);
    // An exact grant is an allowlist matched by literal path equality
    // (`execution-authority.ts` `scope.paths.includes(path)`), so it reaches
    // the host carrying no exclusions at all: nothing outside the listed
    // files is reachable for an exclusion to subtract. Each listed path was
    // already checked against the owner's configured exclusions when the
    // selection was resolved, which is what makes the empty list safe.
    expect(request.authority.excludedPaths).toEqual([]);
    // Listing is what turns a directory path into a walk, so an exact grant
    // never carries it.
    expect(request.authority.capabilities).toEqual([
      "workspace.read",
      "workspace.search",
    ]);
    expect(request.authority.commands).toBe("none");
    expect(request.authority.network).toBe("none");
  });

  it("delivers a subtree selection as a subtree with its owner exclusions", async () => {
    const request = await spawnRequestFor({
      mode: "subtree",
      relativeRoot: "docs",
      excludedPaths: ["docs/drafts"],
    });

    expect(request.authority.workspaces).toMatchObject([
      {
        workspaceId: WORKSPACE_ID,
        mode: "subtree",
        root: at("docs"),
        access: "read",
      },
    ]);
    expect(request.focus.initialPaths).toEqual([at("docs")]);
    // The configured `private` exclusion is outside the narrowed subtree, so
    // only the exclusion the owner named inside it is carried.
    expect(request.authority.excludedPaths).toMatchObject([
      { workspaceId: WORKSPACE_ID, path: at("docs", "drafts") },
    ]);
    expect(request.authority.capabilities).toEqual([
      "workspace.list",
      "workspace.read",
      "workspace.search",
    ]);
  });

  it("never drops the owner's configured exclusion when narrowing can reach it", async () => {
    // A workspace-wide selection that adds one exclusion is the case where a
    // narrowing could plausibly replace the approved set instead of adding to
    // it. The configured exclusion survives as a task grant restriction and
    // the owner's addition arrives beside it, so narrowing only ever subtracts.
    const request = await spawnRequestFor({
      mode: "workspace",
      excludedPaths: ["docs/drafts"],
    });

    expect(request.authority.workspaces).toMatchObject([
      { workspaceId: WORKSPACE_ID, mode: "subtree", root: workspaceRoot },
    ]);
    expect(request.authority.excludedPaths).toMatchObject([
      {
        workspaceId: WORKSPACE_ID,
        path: at("private"),
        restrictionSource: "task-grant",
      },
      {
        workspaceId: WORKSPACE_ID,
        path: at("docs", "drafts"),
        restrictionSource: "owner-restriction",
      },
    ]);
  });

  it("keeps the parent task admission at the whole approved workspace", async () => {
    // The narrowing is the Agent's, not the task's. If the admission itself
    // were narrowed to the exact files, a later subtree turn on the same task
    // could not be granted without a new approval.
    const exact = await spawnRequestFor({
      mode: "exact",
      relativePaths: ["README.md"],
    });
    const subtree = await spawnRequestFor({
      mode: "subtree",
      relativeRoot: "docs",
      excludedPaths: [],
    });
    for (const request of [exact, subtree]) {
      expect(request.authority.taskId).toBe(task.taskId);
      expect(request.authority.taskEpoch).toBe(GENERATION);
      expect(request.authority.role).toBe("agent");
      expect(request.authority.mutationOwnership).toBe("none");
    }
  });
});

describe("S35-TA-5 the workspace match through its real callers", () => {
  it("refuses an assignment whose scope no longer matches the workspace", async () => {
    const settings = settingsOf();
    for (const row of [
      {
        why: "an exact path outside the approved workspace",
        input: (): ProductAgentInput => ({
          ...inputFor(
            { mode: "exact", relativePaths: ["README.md"] },
            settings,
          ),
          scope: {
            mode: "exact",
            root: workspaceRoot,
            paths: [path.join(path.dirname(workspaceRoot), "elsewhere.md")],
          },
        }),
      },
      {
        why: "an exact path inside a configured exclusion",
        input: (): ProductAgentInput => ({
          ...inputFor(
            { mode: "exact", relativePaths: ["README.md"] },
            settings,
          ),
          scope: {
            mode: "exact",
            root: workspaceRoot,
            paths: [at("private", "secret.txt")],
          },
        }),
      },
      {
        why: "an exact scope rooted below the workspace",
        input: (): ProductAgentInput => ({
          ...inputFor(
            { mode: "exact", relativePaths: ["README.md"] },
            settings,
          ),
          scope: {
            mode: "exact",
            root: at("docs"),
            paths: [at("docs", "plan.md")],
          },
        }),
      },
      {
        why: "an exact scope carrying exclusions",
        input: (): ProductAgentInput => ({
          ...inputFor(
            { mode: "exact", relativePaths: ["README.md"] },
            settings,
          ),
          excludedPaths: [at("docs")],
        }),
      },
      {
        why: "a subtree rooted outside the approved workspace",
        input: (): ProductAgentInput => ({
          ...inputFor(
            { mode: "subtree", relativeRoot: "docs", excludedPaths: [] },
            settings,
          ),
          scope: {
            mode: "subtree",
            root: path.join(path.dirname(workspaceRoot), "elsewhere"),
          },
        }),
      },
    ]) {
      const fixture = dependencies();
      await expect(
        runProductAgentAssignment(
          settings,
          task,
          row.input(),
          fixture.value,
        ).then((result) => ({ why: row.why, result })),
      ).resolves.toEqual({
        why: row.why,
        result: {
          ok: false,
          error: { code: "AGENT_AUTHORITY_DENIED", retry: "never" },
        },
      });
      expect({
        why: row.why,
        spawned: fixture.spawn.mock.calls.length,
      }).toEqual({ why: row.why, spawned: 0 });
    }
  });

  it("accepts and refuses the same scopes through the context freshness gate", () => {
    const settings = settingsOf();
    const context = contextOf(settings);
    const exact = inputFor(
      { mode: "exact", relativePaths: ["README.md", "docs/plan.md"] },
      settings,
    );
    const subtree = inputFor(
      { mode: "subtree", relativeRoot: "docs", excludedPaths: ["docs/drafts"] },
      settings,
    );

    // The matching workspace is accepted for both modes.
    for (const input of [exact, subtree]) {
      expect({
        mode: input.scope.mode,
        matches: productAgentInputMatchesContext(input, context, BUILD_ID),
      }).toEqual({ mode: input.scope.mode, matches: true });
    }

    // A workspace whose root moved since the input was saved is refused, and
    // an exact path outside the approved root is refused with it.
    const moved = contextOf(
      settingsOf(path.join(path.dirname(workspaceRoot), "moved-workspace")),
    );
    for (const row of [
      {
        why: "the exact scope's workspace moved",
        input: exact,
        context: moved,
      },
      {
        why: "the subtree scope's workspace moved",
        input: subtree,
        context: moved,
      },
      {
        why: "an exact path sits outside the approved root",
        input: {
          ...exact,
          scope: {
            mode: "exact" as const,
            root: workspaceRoot,
            paths: [path.join(path.dirname(workspaceRoot), "elsewhere.md")],
          },
        },
        context,
      },
      {
        why: "an exact path sits inside a configured exclusion",
        input: {
          ...exact,
          scope: {
            mode: "exact" as const,
            root: workspaceRoot,
            paths: [at("private", "secret.txt")],
          },
        },
        context,
      },
    ]) {
      expect({
        why: row.why,
        matches: productAgentInputMatchesContext(
          row.input,
          row.context,
          BUILD_ID,
        ),
      }).toEqual({ why: row.why, matches: false });
    }
  });
});
