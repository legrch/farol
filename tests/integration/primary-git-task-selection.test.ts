import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  createSecureMcpLaunchContract,
  selectedCodexTaskRouteLaunch,
} from "../../src/apps/desktop/secure-mcp-launch-contract";
import { materializeReadonlyComputerLaunch } from "../../src/modules/computer/infra/mcp/launch-contract";
import { discoverWorkspaceGitMetadata } from "../../src/modules/computer/infra/native/native-verification-command";
import { PhysicalCodexHandoffAuthority } from "../../src/modules/chat/infra/native/physical-codex-handoff-authority";
import { taskPolicy } from "../fixtures/task-policy";

const execute = promisify(execFile);
const roots: string[] = [];
const now = Date.parse("2026-09-29T22:00:00.000Z");
const verifiedAt = new Date(now).toISOString();

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function repository() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-primary-task-")),
  );
  roots.push(base);
  const root = path.join(base, "project");
  await fs.mkdir(path.join(base, "home"));
  await execute("/usr/bin/git", ["init", root], {
    env: {
      HOME: path.join(base, "home"),
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    timeout: 3_000,
    maxBuffer: 4_096,
  });
  const stat = await fs.lstat(root, { bigint: true });
  return {
    base,
    root,
    rootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
  };
}

it("carries an explicitly approved primary checkout from folder verification to the task launch contract", async () => {
  const { base, root, rootIdentity } = await repository();
  const store = new ProductSettingsStore({ root: path.join(base, "state") });
  const seed = new ProductConfigurationService(store, {
    now: () => verifiedAt,
  });
  await seed.initialize();
  const initial = seed.snapshot();
  if (initial.status !== "ready")
    throw new Error("fixture settings unavailable");
  const workspaceId = "00000000-0000-4000-8000-000000000002";
  // Host fields are fixture evidence only; this test never connects or runs a model.
  await store.save({
    ...initial.settings,
    revision: initial.settings.revision + 1,
    tasks: taskPolicy(),
    computer: {
      ...initial.settings.computer,
      workspaces: [
        {
          workspaceId,
          root,
          label: "Primary",
          access: "read",
          excludedPaths: [],
          rootIdentity,
          gitHistoryApproved: true,
        },
      ],
    },
    nativeHosts: {
      generation: 2,
      codex: {
        executablePath: "/fixture/codex",
        executableSha256: "a".repeat(64),
        version: "0.159.0",
        protocol: "codex-app-server/v2",
        schemaSha256: "b".repeat(64),
        verifiedAt,
        localVerification: {
          executableSha256: "a".repeat(64),
          schemaSha256: "b".repeat(64),
          buildId: "c".repeat(64),
          verifiedAt,
        },
        liveVerification: null,
        agentVerification: null,
      },
      taskRoute: null,
    },
  });
  const service = new ProductConfigurationService(store, {
    now: () => verifiedAt,
  });
  await service.initialize();
  const metadata = await discoverWorkspaceGitMetadata(root, true);
  const verified = await service.recordComputerVerification(
    workspaceId,
    {
      profile: "computer.local.read/1",
      runtimeGeneration: "fixture",
      buildId: "c".repeat(64),
      protocol: "readonly-workspace/1",
    },
    { rootIdentity, gitMetadata: metadata },
  );
  if (verified.snapshot.status !== "ready")
    throw new Error("fixture verification unavailable");
  const selection = {
    transport: "codex-shared-proxy/v1",
    socketPath: "/fixture/codex.sock",
    expectedCodexHome: "/fixture/codex-home",
    workspaceId,
    projectId: "00000000-0000-4000-8000-000000000003",
    projectRoot: root,
    projectIdentity: rootIdentity,
    gitCommonDirectory: path.join(root, ".git"),
    execution: { sandbox: "read-only", approvalPolicy: "on-request" },
    harness: "codex",
    computerGeneration: verified.snapshot.settings.computer.generation,
    hostGeneration: 2,
    approvedAt: verifiedAt,
    expiresAt: now + 60_000,
  };
  const recorded = await service.recordCodexTaskRoute(selection);
  expect(recorded.ok).toBe(true);
  if (recorded.snapshot.status !== "ready")
    throw new Error("fixture route unavailable");
  const route = selectedCodexTaskRouteLaunch(recorded.snapshot.settings, now);
  expect(route?.grant.gitCommonDirectory).toBe(path.join(root, ".git"));
  const launch = createSecureMcpLaunchContract(recorded.snapshot.settings, {
    now,
    runtimeId: "primary-fixture",
    challengeSha256: "d".repeat(64),
  });
  expect(materializeReadonlyComputerLaunch(launch, now).codexTasks).toEqual(
    route,
  );
  if (!route) throw new Error("fixture route missing");
  expect(
    await new PhysicalCodexHandoffAuthority(route.grant).resolve(workspaceId),
  ).not.toBeNull();

  // A path replaced by a symlink never inherits the measured Git authority.
  await fs.rename(path.join(root, ".git"), path.join(base, "moved-git"));
  await fs.symlink(path.join(base, "moved-git"), path.join(root, ".git"));
  expect(await discoverWorkspaceGitMetadata(root, true)).toBeNull();
  expect(
    await new PhysicalCodexHandoffAuthority(route.grant).resolve(workspaceId),
  ).toBeNull();
});

it("does not turn ordinary primary-folder verification into full Git approval", async () => {
  const { root } = await repository();
  expect(await discoverWorkspaceGitMetadata(root, false)).toBeNull();
});

it("refuses missing, file and symlink Git entries even with explicit approval", async () => {
  const { base, root } = await repository();
  await fs.rename(path.join(root, ".git"), path.join(base, "actual-git"));
  expect(await discoverWorkspaceGitMetadata(root, true)).toBeNull();
  await fs.writeFile(path.join(root, ".git"), "not a git pointer\n");
  expect(await discoverWorkspaceGitMetadata(root, true)).toBeNull();
  await fs.unlink(path.join(root, ".git"));
  await fs.symlink(path.join(base, "actual-git"), path.join(root, ".git"));
  expect(await discoverWorkspaceGitMetadata(root, true)).toBeNull();
});
