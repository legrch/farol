import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";

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
        setup: {
          journey: { currentStep: "chatgpt", dismissed: false },
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
});
