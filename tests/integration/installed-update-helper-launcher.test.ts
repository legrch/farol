import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startInstalledUpdateHelper,
  type InstalledUpdateRequest,
} from "../../src/modules/release/infra/native/installed-update-helper.js";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  FIXTURE_GO_EXECUTABLE,
  fakeGoHelper,
  goSelection,
} from "./fixtures/installed-update-go-helper";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw new Error("UNEXPECTED_HELPER_SPAWN");
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

const source = {
  digest: "1".repeat(64),
  version: "0.1.0",
  buildId: "2".repeat(64),
};
const target = {
  digest: "3".repeat(64),
  version: "0.1.1",
  buildId: "4".repeat(64),
};
const accepted: InstalledUpdateRequest = {
  action: "apply",
  operationId: "a".repeat(32),
  source,
  target,
  drain: {
    status: "reconciled",
    acceptedSource: source.buildId,
    acceptedTarget: target.buildId,
  },
  pid: 987654,
  processStart: "Tue Sep 29 23:00:00 2026",
  waitSeconds: 5,
  relaunch: false,
};

describe("installed update launcher", () => {
  it.each([
    ["0.1.11-owner.beta.1", "0.2.0-owner.beta.2"],
    ["0.2.0-owner.beta.3", "0.2.0-owner.beta.5"],
    ["0.2.0-owner.beta.9", "0.2.0-owner.beta.10"],
  ])(
    "B06 refuses app-only rollback to %s after a real incompatible settings save",
    async (sourceVersion, targetVersion) => {
      // Real module/file publication, not the later assembled app journey.
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-rollback-settings-"),
      );
      roots.push(root);
      const store = new ProductSettingsStore({ root });
      const service = new ProductConfigurationService(store);
      await service.initialize();
      expect(
        (await service.updateComputerFilePolicy("approved-roots-v1")).ok,
      ).toBe(true);
      expect(
        (
          await service.updateGeneral({
            ...(await store.load())!.general,
            openAtLaunch: "home",
          })
        ).ok,
      ).toBe(true);
      if (sourceVersion === "0.2.0-owner.beta.9") {
        const current = (await store.load())!;
        const proof = {
          tunnelId: "synthetic-catalogue",
          workspaceId: null,
          connectorGeneration: current.connectors.secureMcp.generation,
          runtimeGeneration: "a".repeat(64),
          computerGeneration: current.computer.generation,
          buildId: "b".repeat(64),
          challengeSha256: "c".repeat(64),
          receiptSha256: "d".repeat(64),
          verifiedAt: "2026-10-11T10:00:00.000Z",
        };
        await store.save({
          ...current,
          revision: current.revision + 1,
          connectors: {
            ...current.connectors,
            secureMcp: {
              ...current.connectors.secureMcp,
              attachment: proof,
              lastVerifiedAttachment: proof,
            },
          },
        });
        expect(
          (await store.load())!.connectors.secureMcp.lastVerifiedAttachment
            ?.workspaceId,
        ).toBeNull();
      }
      const file = path.join(root, "config.json");
      const saved = await fs.readFile(file);
      expect((await store.load())!.computer.filePolicy).toBe(
        "approved-roots-v1",
      );
      expect((await store.load())!.general.openAtLaunch).toBe("home");
      for (const closed of [false, true]) {
        const input = {
          ...accepted,
          action: "rollback" as const,
          source: { ...source, version: sourceVersion },
          target: { ...target, version: targetVersion },
          relaunch: false as const,
          ...(closed
            ? {
                predecessor: {
                  kind: "confirmed_closed" as const,
                  startedAt: new Date().toISOString(),
                  lastQuitSha256: "5".repeat(64),
                  stateIdentity: { device: "1", inode: "2" },
                },
              }
            : {}),
        };
        const release = vi.fn();
        const verify = vi.fn();
        const helper = fakeGoHelper();
        await expect(
          startInstalledUpdateHelper(goSelection(helper), input, {
            promotionLease: {
              descriptor: 99,
              identity: { device: "1", inode: "3" },
              verify,
              release,
            },
          }),
        ).rejects.toThrow("INSTALLED_UPDATE_PREDECESSOR_STATE_UNQUALIFIED");
        expect(spawn).not.toHaveBeenCalled();
        expect(helper.qualified).toBe(0);
        expect(verify).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
        expect(await fs.readFile(file)).toEqual(saved);
      }
    },
  );

  it.each([
    ["a Go capability that fails qualification", "qualify-throws"],
    ["a relative executable", "relative"],
    ["a non-canonical executable", "noncanonical"],
  ])("refuses %s before spawning it", async (_name, kind) => {
    const helper = fakeGoHelper(async () => {
      if (kind === "qualify-throws")
        throw new Error("UPDATE_EXECUTION_RESOURCES_UNCONFIRMED");
      return kind === "relative" ? "farol-backend" : "/fixture/./farol-backend";
    });
    const result = await startInstalledUpdateHelper(
      goSelection(helper),
      accepted,
    );
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_preflight_failed",
    });
    expect(result.operation.pid).toBeNull();
    expect(helper.qualified).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a legacy build with a closed reason, never an interpreter", async () => {
    const result = await startInstalledUpdateHelper(
      { kind: "refused", reason: "helper_go_core_required" },
      accepted,
    );
    expect(result).toMatchObject({
      status: "not_started",
      reason: "helper_go_core_required",
    });
    expect(result.operation.pid).toBeNull();
    expect(await result.operation.completion).toEqual({
      code: null,
      signal: null,
      terminal: null,
      protocolError: "helper_go_core_required",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("selects the live mode without a lease and the closed mode with one", async () => {
    const calls: unknown[][] = [];
    vi.mocked(spawn).mockImplementation(((...args: unknown[]) => {
      calls.push(args);
      throw new Error("STOP_AFTER_SPAWN_ARGS");
    }) as unknown as typeof spawn);
    const lease = {
      descriptor: 12,
      identity: { device: "1", inode: "3" },
      verify: vi.fn(async () => true),
      release: vi.fn(async () => undefined),
    };
    const closed: InstalledUpdateRequest = {
      ...accepted,
      action: "apply",
      predecessor: {
        kind: "confirmed_closed" as const,
        startedAt: "2026-09-29T22:00:00.000Z",
        lastQuitSha256: "5".repeat(64),
        stateIdentity: { device: "11", inode: "22" },
      },
    };
    await expect(
      startInstalledUpdateHelper(goSelection(), accepted),
    ).rejects.toThrow("STOP_AFTER_SPAWN_ARGS");
    await expect(
      startInstalledUpdateHelper(goSelection(), closed, {
        promotionLease: lease,
        recordSpawn: async () => undefined,
      }),
    ).rejects.toThrow("STOP_AFTER_SPAWN_ARGS");
    expect(calls.map((call) => [call[0], call[1]])).toEqual([
      [FIXTURE_GO_EXECUTABLE, ["run-live-release-helper"]],
      [FIXTURE_GO_EXECUTABLE, ["run-closed-release-helper"]],
    ]);
    // The retired interpreter is never an alternative on any branch.
    expect(JSON.stringify(calls)).not.toMatch(/python/u);
  });

  it("requires matching accepted build identities and a bounded process wait", async () => {
    await expect(
      startInstalledUpdateHelper(goSelection(), {
        ...accepted,
        drain: { ...accepted.drain, acceptedTarget: source.buildId },
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
    await expect(
      startInstalledUpdateHelper(goSelection(), {
        ...accepted,
        waitSeconds: 999,
      }),
    ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
  });

  it.each([
    ["recover", false],
    ["recover", true],
    ["rollback", true],
  ] as const)(
    "rejects closed %s with relaunch=%s at the TS input boundary",
    async (action, relaunch) => {
      const invalid = {
        ...accepted,
        action,
        relaunch,
        predecessor: {
          kind: "confirmed_closed",
          startedAt: "2026-09-29T22:00:00.000Z",
          lastQuitSha256: "5".repeat(64),
          stateIdentity: { device: "11", inode: "22" },
        },
      } as unknown as InstalledUpdateRequest;
      await expect(
        startInstalledUpdateHelper(goSelection(), invalid),
      ).rejects.toThrow("INSTALLED_UPDATE_INPUT_INVALID");
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});
