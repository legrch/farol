import {
  workspaceReadbackBinding,
  workspaceReadbackConfirms,
} from "../../src/ui/guided-workspace-access";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  allFoldersChecked,
  folderAccessChecked,
} from "../../src/ui/folder-access-state";
import {
  fixtureBuildId,
  guidedSettingsFixture,
} from "../fixtures/guided-onboarding";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-setup-evidence-"),
  );
  roots.push(root);
  const store = new ProductSettingsStore({ root: path.join(root, "state") });
  const settings = guidedSettingsFixture();
  settings.computer.workspaces.push({
    ...structuredClone(settings.computer.workspaces[0]!),
    workspaceId: "00000000-0000-4000-8000-000000000099",
    root: path.join(root, "another-project"),
    accessCheck: null,
  });
  await store.save(settings);
  const service = new ProductConfigurationService(store, {
    now: () => "2026-09-23T18:00:00.000Z",
  });
  await service.initialize();
  return { root, store, service, settings };
}

describe("durable setup evidence, without changing workspace authority", () => {
  it.each(["computer.verify-workspace", "computer.check-folder"] as const)(
    "persists only the issued %s identity and never attributes an old or another check to it",
    async (kind) => {
      const { service, settings, store } = await fixture();
      const target = settings.computer.workspaces[0]!;
      const priorId = "00000000-0000-4000-8000-000000000090";
      const issuedId = "00000000-0000-4000-8000-000000000091";
      const otherId = "00000000-0000-4000-8000-000000000092";
      const prior = await service.recordFolderAccessCheck(
        target.workspaceId,
        settings.computer.generation,
        fixtureBuildId,
        target.rootIdentity!,
        true,
        priorId,
      );
      if (!prior.ok || prior.snapshot.status !== "ready")
        throw new Error("fixture prior check failed");
      const before = prior.snapshot.settings;
      const command = {
        kind,
        workspaceId: target.workspaceId,
        checkId: issuedId,
      };
      const pending = workspaceReadbackBinding(before, fixtureBuildId, command);
      // This request never reaches the native check. Reopening unchanged
      // durable settings must not turn the prior success into its receipt.
      const unchanged = await store.load();
      expect(
        workspaceReadbackConfirms(pending, unchanged!, fixtureBuildId),
      ).toBe(false);
      const record = (checkId: string) =>
        kind === "computer.check-folder"
          ? service.recordFolderAccessCheck(
              target.workspaceId,
              before.computer.generation,
              fixtureBuildId,
              target.rootIdentity!,
              true,
              checkId,
            )
          : service.recordComputerVerification(
              target.workspaceId,
              {
                profile: "computer.local.read/1",
                runtimeGeneration: "fixture-runtime",
                buildId: fixtureBuildId,
                protocol: "readonly-workspace/1",
              },
              {
                rootIdentity: target.rootIdentity!,
                expectedGeneration: before.computer.generation,
                expectedRoot: target.root,
                checkId,
              },
            );
      expect((await record(otherId)).ok).toBe(true);
      const other = await store.load();
      expect(other!.computer.workspaces[0]!.accessCheck?.checkId).toBe(otherId);
      expect(workspaceReadbackConfirms(pending, other!, fixtureBuildId)).toBe(
        false,
      );
      expect((await record(issuedId)).ok).toBe(true);
      const issued = await store.load();
      expect(issued!.computer.workspaces[0]!.accessCheck?.checkId).toBe(
        issuedId,
      );
      expect(workspaceReadbackConfirms(pending, issued!, fixtureBuildId)).toBe(
        true,
      );
      const restarted = new ProductConfigurationService(store);
      await restarted.initialize();
      expect(restarted.snapshot()).toMatchObject({
        status: "ready",
        settings: issued,
      });
      const frozen = service.snapshot();
      expect((await record("not-a-check-id")).ok).toBe(false);
      expect(service.snapshot()).toEqual(frozen);
    },
  );

  it("checks another folder without changing the selected witness or grant generation", async () => {
    const { service, settings, store } = await fixture();
    const other = settings.computer.workspaces[1]!;
    const result = await service.recordFolderAccessCheck(
      other.workspaceId,
      settings.computer.generation,
      fixtureBuildId,
      other.rootIdentity!,
      true,
    );
    expect(result.ok).toBe(true);
    if (result.snapshot.status !== "ready") throw new Error("missing snapshot");
    expect(result.snapshot.settings.computer.generation).toBe(
      settings.computer.generation,
    );
    expect(result.snapshot.settings.setup.computer.verified).toEqual(
      settings.setup.computer.verified,
    );
    expect(
      result.snapshot.settings.computer.workspaces.map((folder) => [
        folder.workspaceId,
        folder.root,
        folder.access,
      ]),
    ).toEqual(
      settings.computer.workspaces.map((folder) => [
        folder.workspaceId,
        folder.root,
        folder.access,
      ]),
    );
    expect(allFoldersChecked(result.snapshot.settings, fixtureBuildId)).toBe(
      true,
    );
    const reloaded = new ProductConfigurationService(store);
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(result.snapshot);
  });
  it("persists a failed check instead of falling back to a green legacy witness", async () => {
    const { service, settings, store } = await fixture();
    const first = settings.computer.workspaces[0]!;
    const failed = await service.recordFolderAccessCheck(
      first.workspaceId,
      settings.computer.generation,
      fixtureBuildId,
      first.rootIdentity!,
      false,
    );
    expect(failed.ok).toBe(true);
    const persisted = await store.load();
    if (!persisted) throw new Error("missing settings");
    expect(persisted.setup.computer.verified).toEqual(
      settings.setup.computer.verified,
    );
    expect(
      folderAccessChecked(
        persisted,
        persisted.computer.workspaces[0]!,
        fixtureBuildId,
      ),
    ).toBe(false);
  });
  it.each(["generation", "device", "inode", "unknown-folder"])(
    "refuses stale %s evidence without altering settings",
    async (field) => {
      const { service, settings } = await fixture();
      const first = settings.computer.workspaces[0]!;
      const identity = { ...first.rootIdentity! };
      if (field === "device") identity.device = "99";
      if (field === "inode") identity.inode = "99";
      const before = service.snapshot();
      const result = await service.recordFolderAccessCheck(
        field === "unknown-folder"
          ? "00000000-0000-4000-8000-000000000088"
          : first.workspaceId,
        settings.computer.generation + (field === "generation" ? 1 : 0),
        fixtureBuildId,
        identity,
        true,
      );
      expect(result.ok).toBe(false);
      expect(service.snapshot()).toEqual(before);
    },
  );
  it("retains pending app verification across a service restart", async () => {
    const { service, settings, store } = await fixture();
    const generation = settings.connectors.secureMcp.runtime!.runtimeGeneration;
    expect((await service.recordSecureMcpAppPending(generation)).ok).toBe(true);
    const restarted = new ProductConfigurationService(store);
    await restarted.initialize();
    const snapshot = restarted.snapshot();
    expect(snapshot).toMatchObject({
      status: "ready",
      settings: { setup: { connect: { outcomeUnknown: true } } },
    });
    expect((await service.recordSecureMcpAppPending("f".repeat(64))).ok).toBe(
      false,
    );
  });

  it("clears only the exact app attempt proved to have stopped before submit", async () => {
    const { service, settings, store } = await fixture();
    const runtimeGeneration =
      settings.connectors.secureMcp.runtime!.runtimeGeneration;
    expect(
      (
        await service.recordSecureMcpChallenge({
          challenge: "00000000-0000-4000-8000-000000000077",
          runtimeGeneration,
          computerGeneration: settings.computer.generation,
          buildId: fixtureBuildId,
        })
      ).ok,
    ).toBe(true);
    const prepared = service.snapshot();
    if (prepared.status !== "ready") throw new Error("missing snapshot");
    const challengeSha256 =
      prepared.settings.connectors.secureMcp.challenge!.challengeSha256;
    expect(
      (await service.recordSecureMcpAppPending(runtimeGeneration)).ok,
    ).toBe(true);
    const binding = {
      tunnelId: settings.connectors.secureMcp.tunnelId!,
      runtimeGeneration,
      challengeSha256,
      buildId: fixtureBuildId,
      computerGeneration: settings.computer.generation,
      connectorGeneration: settings.connectors.secureMcp.generation,
      workspaceId: settings.setup.computer.verified!.workspaceId!,
    };
    expect(
      (
        await service.clearSecureMcpAppPendingBeforeSubmit({
          ...binding,
          challengeSha256: "f".repeat(64),
        })
      ).ok,
    ).toBe(false);
    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: { setup: { connect: { outcomeUnknown: true } } },
    });
    expect(
      (await service.clearSecureMcpAppPendingBeforeSubmit(binding)).ok,
    ).toBe(true);
    const restarted = new ProductConfigurationService(store);
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: { setup: { connect: { outcomeUnknown: false } } },
    });
  });
});
