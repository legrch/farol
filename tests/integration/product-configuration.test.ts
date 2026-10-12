import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { PrivateConnectorKeyStore } from "../../src/apps/desktop/connector-key-store";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationEvidenceSchema,
  type ProductConfigurationSnapshot,
} from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

import { taskPolicy } from "../fixtures/task-policy";
import { resumeComputerConnector } from "../../src/apps/desktop/connector-resume-policy";
import { GuidedWorkspaceAccess } from "../../src/ui/guided-workspace-access";
import { onboardingFacts } from "../../src/ui/guided-onboarding";
const roots: string[] = [];

describe("workspace stopped publication revision", () => {
  async function connected() {
    const root = await stateRoot();
    const store = new ProductSettingsStore({ root });
    const service = new ProductConfigurationService(store, dependencies());
    await service.initialize();
    await service.recordSecureMcpTunnelClient({
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    await service.configureSecureMcpTunnel({ tunnelId: "synthetic" });
    await service.recordSecureMcpCredential("stored");
    const before = service.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    await service.recordSecureMcpRuntime({
      state: "ready",
      runtimeGeneration: "b".repeat(64),
      computerGeneration: before.settings.computer.generation,
      buildId: "c".repeat(64),
    });
    const original = service.snapshot();
    if (original.status !== "ready") throw new Error("settings missing");
    return { store, service, original };
  }

  it("persists explicit empty-catalogue attachment without granting file access", async () => {
    const { store, service, original } = await connected();
    expect(original.settings.computer.workspaces).toEqual([]);
    const challenge = "00000000-0000-4000-8000-000000000099";
    const identity = {
      runtimeGeneration: "b".repeat(64),
      computerGeneration: original.settings.computer.generation,
      buildId: "c".repeat(64),
    };
    expect(
      (await service.recordSecureMcpChallenge({ ...identity, challenge })).ok,
    ).toBe(true);
    const input = {
      ...identity,
      workspaceId: null,
      challengeSha256: createHash("sha256").update(challenge).digest("hex"),
      receiptSha256: "e".repeat(64),
    };
    expect(
      await service.recordSecureMcpAttachment({
        ...input,
        computerGeneration: input.computerGeneration + 1,
      }),
    ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
    expect(
      await service.recordSecureMcpAttachment({
        ...input,
        challengeSha256: "f".repeat(64),
      }),
    ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
    expect(await service.recordSecureMcpAttachment(input)).toMatchObject({
      ok: true,
    });
    const saved = await store.load();
    expect(saved?.computer.workspaces).toEqual([]);
    expect(saved?.setup.computer.verified).toBeNull();
    expect(saved?.setup.connect.verified?.workspaceId).toBeNull();
    expect(saved?.connectors.secureMcp.attachment).toMatchObject({
      workspaceId: null,
      receiptSha256: input.receiptSha256,
    });
    expect(saved?.connectors.secureMcp.lastVerifiedAttachment).toEqual(
      saved?.connectors.secureMcp.attachment,
    );
  });

  it("refuses a general write queued before the original stopped publication", async () => {
    const { store, service, original } = await connected();
    let entered!: () => void;
    let release!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = store.save.bind(store);
    const writes = vi
      .spyOn(store, "save")
      .mockImplementationOnce(async (...args) => {
        entered();
        await pending;
        return save(...args);
      });
    const general = service.updateGeneral({
      ...original.settings.general,
      openAtLaunch: "activity",
    });
    await entering;
    // The old in-memory revision is still visible while the previous write
    // owns the serialized turn. The stop must validate after it acquires it.
    expect(service.snapshot()).toEqual(original);
    const stopped = service.recordSecureMcpStopped(
      undefined,
      "stop",
      original.settings.revision,
    );
    release();
    expect((await general).ok).toBe(true);
    const changed = service.snapshot();
    await expect(stopped).resolves.toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(writes).toHaveBeenCalledOnce();
    expect(service.snapshot()).toEqual(changed);
    if (changed.status !== "ready") throw new Error("settings missing");
    expect(changed.settings.connectors.secureMcp.runtime).toEqual(
      original.settings.connectors.secureMcp.runtime,
    );
    expect(changed.settings.computer.generation).toBe(
      original.settings.computer.generation,
    );
    writes.mockRestore();
  });

  it("publishes only the confirmed current revision without changing credential or authority generations", async () => {
    const { service, original } = await connected();
    const stopped = await service.recordSecureMcpStopped(
      undefined,
      "stop",
      original.settings.revision,
    );
    expect(stopped.ok).toBe(true);
    if (!stopped.ok || stopped.snapshot.status !== "ready")
      throw new Error("stop refused");
    const settings = stopped.snapshot.settings;
    expect(settings.revision).toBe(original.settings.revision + 1);
    expect(settings.connectors.secureMcp.runtime).toBeNull();
    expect(settings.connectors.secureMcp.credential).toBe("stored");
    expect(settings.connectors.secureMcp.generation).toBe(
      original.settings.connectors.secureMcp.generation,
    );
    expect(settings.computer).toEqual(original.settings.computer);
    const stale = await service.recordSecureMcpStopped(
      undefined,
      "stop",
      original.settings.revision,
    );
    expect(stale).toMatchObject({
      ok: false,
      error: "AUTHORITY_CHANGE_IN_PROGRESS",
    });
    expect(service.snapshot()).toEqual(stopped.snapshot);
  });
});

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("connector credential publication fence", () => {
  it("retains an uncertain replacement across restart after the key file changed", async () => {
    const root = await stateRoot();
    const settings = new ProductSettingsStore({ root });
    const credentials = new PrivateConnectorKeyStore({
      root: path.join(path.dirname(root), "private-key"),
    });
    const service = new ProductConfigurationService(settings, dependencies());
    await service.initialize();
    await service.configureSecureMcpTunnel({ tunnelId: "original" });
    await credentials.store("synthetic-original-key-1234567890");
    await service.recordSecureMcpCredential("stored");

    const begun = await service.beginSecureMcpCredentialChange();
    expect(begun.ok).toBe(true);
    vi.spyOn(fs, "chmod").mockRejectedValueOnce(
      new Error("synthetic post-rename failure"),
    );
    await expect(
      credentials.store("synthetic-replacement-key-1234567890"),
    ).rejects.toThrow("synthetic post-rename failure");
    vi.restoreAllMocks();
    expect(
      await fs.readFile(
        path.join(path.dirname(root), "private-key", "control-plane-api-key"),
        "utf8",
      ),
    ).toBe("synthetic-replacement-key-1234567890");

    const restarted = new ProductConfigurationService(settings, dependencies());
    await restarted.initialize();
    const retained = restarted.snapshot();
    if (retained.status !== "ready") throw new Error("settings missing");
    expect(retained.settings.setup.connect.outcomeUnknown).toBe(true);
    expect(retained.settings.connectors.secureMcp.tunnelId).toBe("original");
    expect(await credentials.status()).toBe("stored");
    expect(await restarted.recordSecureMcpCredential("stored")).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(await restarted.beginSecureMcpCredentialChange()).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(
      await restarted.configureSecureMcpTunnel({ tunnelId: "replacement" }),
    ).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    expect(restarted.snapshot()).toEqual(retained);
  });

  it("clears the pending fence only after the exact known write", async () => {
    const root = await stateRoot();
    const settings = new ProductSettingsStore({ root });
    const credentials = new PrivateConnectorKeyStore({
      root: path.join(path.dirname(root), "private-key"),
    });
    const service = new ProductConfigurationService(settings, dependencies());
    await service.initialize();
    const begun = await service.beginSecureMcpCredentialChange();
    if (!begun.ok || begun.snapshot.status !== "ready")
      throw new Error("begin failed");
    const generation = begun.snapshot.settings.connectors.secureMcp.generation;
    expect(
      await service.completeSecureMcpCredentialChange(
        { tunnelId: "synthetic" },
        generation + 1,
      ),
    ).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
    await credentials.store("synthetic-new-key-1234567890");
    const completed = await service.completeSecureMcpCredentialChange(
      { tunnelId: "synthetic" },
      generation,
    );
    expect(completed.ok).toBe(true);
    const restarted = new ProductConfigurationService(settings, dependencies());
    await restarted.initialize();
    const retained = restarted.snapshot();
    if (retained.status !== "ready") throw new Error("settings missing");
    expect(retained.settings.setup.connect.outcomeUnknown).toBe(false);
    expect(retained.settings.connectors.secureMcp.tunnelId).toBe("synthetic");
    expect(retained.settings.connectors.secureMcp.credential).toBe("stored");
  });

  it("reports a failed completion readback with the recovered unfenced snapshot", async () => {
    const root = await stateRoot();
    const settings = new ProductSettingsStore({ root });
    const service = new ProductConfigurationService(settings, dependencies());
    await service.initialize();
    const begun = await service.beginSecureMcpCredentialChange();
    if (!begun.ok || begun.snapshot.status !== "ready")
      throw new Error("begin failed");
    const generation = begun.snapshot.settings.connectors.secureMcp.generation;
    // The trusted host's credential store has already returned known success.
    // Inject only the first Settings readback failure, after the Settings save.
    vi.spyOn(settings, "load").mockRejectedValueOnce(
      new Error("synthetic first readback failure"),
    );
    const completed = await service.completeSecureMcpCredentialChange(
      { tunnelId: "synthetic" },
      generation,
    );
    expect(completed).toMatchObject({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
      snapshot: {
        status: "ready",
        settings: {
          setup: { connect: { outcomeUnknown: false } },
          connectors: {
            secureMcp: { tunnelId: "synthetic", credential: "stored" },
          },
        },
      },
    });
    const restarted = new ProductConfigurationService(settings, dependencies());
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(completed.snapshot);
    expect((await restarted.beginSecureMcpCredentialChange()).ok).toBe(true);
  });
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

function approval(snapshot: ProductConfigurationSnapshot, now = 0) {
  if (snapshot.status !== "ready") throw new Error("settings missing");
  return ownerSettingsComputerApproval(snapshot.settings, now);
}

async function computerEvidenceFixture(
  commands: "none" | "verification" | "workspace" = "workspace",
) {
  // Disposable settings with synthetic observations; no native/provider proof.
  const root = await stateRoot();
  const store = new ProductSettingsStore({ root });
  let now = "2026-09-16T10:00:00.000Z";
  const service = new ProductConfigurationService(store, {
    ...dependencies(),
    now: () => now,
  });
  await service.initialize();
  const rootIdentity = { device: "1", inode: "2" };
  const added = await service.addReadonlyWorkspace({
    root: "/Users/example/project",
    label: "Project",
    rootIdentity,
  });
  const workspaceId = approval(added.snapshot).workspaces[0]!.workspaceId;
  await service.updateComputerFilePolicy("approved-roots-v1");
  await service.updateComputerCommands(commands);
  const verification = {
    profile: "computer.local.read/1",
    runtimeGeneration: "runtime-1",
    buildId: "c".repeat(64),
    protocol: "readonly-workspace/1",
  };
  return {
    root,
    store,
    service,
    workspaceId,
    rootIdentity,
    verification,
    advanceTime: () => {
      now = "2026-09-16T11:00:00.000Z";
    },
  };
}

describe("Computer evidence approval generations", () => {
  it.each(["ready", "update-drained"] as const)(
    "resumes %s after a real verification commit withdraws old-build Shell evidence",
    async (mode) => {
      const { service, workspaceId, rootIdentity, verification } =
        await computerEvidenceFixture();
      const second = await service.addReadonlyWorkspace({
        root: "/Users/example/other",
        label: "Other",
        rootIdentity: { device: "1", inode: "3" },
      });
      expect(second.ok).toBe(true);
      const otherId = approval(second.snapshot).workspaces[1]!.workspaceId;
      for (const [id, identity] of [
        [workspaceId, rootIdentity],
        [otherId, { device: "1", inode: "3" }],
      ] as const)
        expect(
          (
            await service.recordComputerVerification(id, verification, {
              rootIdentity: identity,
            })
          ).ok,
        ).toBe(true);
      await service.recordComputerVerification(workspaceId, verification, {
        rootIdentity,
      });
      await service.recordSecureMcpTunnelClient({
        executablePath: "/selected/tunnel-client",
        executableSha256: "a".repeat(64),
        version: "1.0.0",
        protocol: "openai-tunnel-client/v1",
      });
      await service.configureSecureMcpTunnel({ tunnelId: "synthetic" });
      await service.recordSecureMcpCredential("stored");
      const generation = approval(service.snapshot()).generation;
      expect(
        (
          await service.recordSecureMcpRuntime({
            state: "ready",
            runtimeGeneration: "b".repeat(64),
            computerGeneration: generation,
            buildId: verification.buildId,
          })
        ).ok,
      ).toBe(true);
      if (mode === "update-drained")
        expect((await service.recordSecureMcpDrainedForUpdate()).ok).toBe(true);
      const before = service.snapshot();
      expect(approval(before).workspaces.map((w) => w.shellVerified)).toEqual([
        true,
        true,
      ]);
      const buildId = "d".repeat(64);
      const start = vi.fn(async () => {
        const snapshot = service.snapshot();
        expect(snapshot).toMatchObject({
          settings: {
            computer: { generation: generation + 2 },
            connectors: { secureMcp: { runtime: null } },
          },
        });
        expect(
          approval(snapshot).workspaces.map((w) => w.shellVerified),
        ).toEqual([true, true]);
        return { ok: true };
      });
      expect(
        await resumeComputerConnector(
          {
            environment: "preview",
            buildEnvironment: "preview",
            previousRunClean: true,
            buildId,
            snapshot: before,
          },
          {
            current: () => service.snapshot(),
            mayContinue: () => true,
            verifyWorkspace: (id) =>
              service.recordComputerVerification(
                id,
                { ...verification, buildId },
                {
                  rootIdentity:
                    id === workspaceId
                      ? rootIdentity
                      : { device: "1", inode: "3" },
                  expectedGeneration: approval(service.snapshot()).generation,
                },
              ),
            start,
          },
        ),
      ).toBe("started");
      expect(start).toHaveBeenCalledOnce();
      // This proves settings-owner composition, not a native tunnel launch.
    },
  );

  it.each([false, true])(
    "continues guided recovery across the real owner's seal (revoked Git: %s)",
    async (revokedGit) => {
      const { service, workspaceId, rootIdentity, verification } =
        await computerEvidenceFixture();
      if (revokedGit) {
        expect(
          (
            await service.recordComputerVerification(
              workspaceId,
              verification,
              { rootIdentity },
            )
          ).ok,
        ).toBe(true);
        expect(
          (await service.updateWorkspaceGitHistory(workspaceId, true)).ok,
        ).toBe(true);
        expect(
          (
            await service.recordComputerVerification(
              workspaceId,
              verification,
              {
                rootIdentity,
                gitMetadata: {
                  gitDirectory: "/Users/example/project/.git",
                  commonDirectory: "/Users/example/project/.git",
                },
              },
            )
          ).ok,
        ).toBe(true);
        expect(
          (await service.updateWorkspaceAccess(workspaceId, "write")).ok,
        ).toBe(true);
        expect(service.snapshot()).toMatchObject({
          settings: {
            computer: {
              workspaces: [
                {
                  gitHistoryApproved: false,
                  gitMetadata: { gitDirectory: "/Users/example/project/.git" },
                },
              ],
            },
          },
        });
      }
      const settings = () => {
        const snapshot = service.snapshot();
        if (snapshot.status !== "ready") throw new Error("settings missing");
        return snapshot.settings;
      };
      const generation = settings().computer.generation;
      const run = vi.fn(
        async (
          command: import("../../src/pkg/product-settings/contract").ProductConfigurationCommand,
        ) => {
          if (command.kind !== "computer.verify-workspace" || !command.checkId)
            throw new Error("unexpected command");
          const result = await service.recordComputerVerification(
            workspaceId,
            verification,
            {
              rootIdentity,
              checkId: command.checkId,
              ...(revokedGit ? { gitMetadata: null } : {}),
            },
          );
          return result.ok ? ("applied" as const) : ("refused" as const);
        },
      );
      const result = await new GuidedWorkspaceAccess().run(
        {
          settings,
          buildId: () => verification.buildId,
          issueCheckId: () => "00000000-0000-4000-8000-000000000099",
          run,
        },
        { workspaceId },
        onboardingFacts(settings(), verification.buildId),
      );
      expect(result).toEqual({ ok: true, reconnected: false });
      expect(settings().computer.generation).toBe(generation + 1);
      expect(run).toHaveBeenCalledOnce();
      expect(approval(service.snapshot()).capabilities).toContain(
        "workspace.shell",
      );
      if (revokedGit) {
        expect(settings().computer.workspaces[0]!.gitMetadata).toBeUndefined();
        expect(settings().computer.workspaces[0]!.gitHistoryApproved).toBe(
          false,
        );
      }
    },
  );

  it.each(["none", "verification", "workspace"] as const)(
    "advances %s verification only when the projected policy changes",
    async (commands) => {
      const fixture = await computerEvidenceFixture(commands);
      const { service, workspaceId, rootIdentity, verification } = fixture;
      const before = approval(service.snapshot());
      const sealed = structuredClone(before);
      expect(before.capabilities).not.toContain("workspace.shell");
      const verified = await service.recordComputerVerification(
        workspaceId,
        verification,
        { rootIdentity },
      );
      expect(verified.ok).toBe(true);
      const after = approval(verified.snapshot);
      expect(after.generation).toBe(
        before.generation + (commands === "workspace" ? 1 : 0),
      );
      expect(after.commands).toBe(commands);
      expect(after.capabilities).toEqual([
        "workspace.list",
        "workspace.read",
        "workspace.search",
        ...(commands !== "none" ? ["verification.run"] : []),
        ...(commands === "workspace" ? ["workspace.shell"] : []),
      ]);
      expect(after.workspaces[0]?.shellVerified).toBe(commands === "workspace");
      expect(verified.snapshot).toMatchObject({
        settings: {
          computer: {
            workspaces: [
              { accessCheck: { computerGeneration: after.generation } },
            ],
          },
          setup: {
            computer: { verified: { configRevision: after.generation } },
          },
        },
      });
      fixture.advanceTime();
      const renewed = await service.recordComputerVerification(
        workspaceId,
        { ...verification, runtimeGeneration: "runtime-2" },
        { rootIdentity },
      );
      expect(renewed.ok).toBe(true);
      expect(approval(renewed.snapshot)).toEqual(after);
      expect(approval(renewed.snapshot, 1_000).expiresAt).toBe(
        after.expiresAt + 1_000,
      );
      expect(renewed.snapshot).toMatchObject({
        settings: {
          setup: {
            computer: { verified: { verifiedAt: "2026-09-16T11:00:00.000Z" } },
          },
        },
      });
      expect(before).toEqual(sealed);
      const restarted = new ProductConfigurationService(
        new ProductSettingsStore({ root: fixture.root }),
        dependencies(),
      );
      await restarted.initialize();
      expect(restarted.snapshot()).toEqual(renewed.snapshot);
    },
  );

  it("seals folder policy changes without invalidating another fresh folder or bumping a no-op", async () => {
    const { service, workspaceId, rootIdentity, verification } =
      await computerEvidenceFixture();
    const secondIdentity = { device: "1", inode: "3" };
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/second",
      label: "Second",
      rootIdentity: secondIdentity,
    });
    const secondId = approval(added.snapshot).workspaces[1]!.workspaceId;
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity,
    });
    const before = approval(service.snapshot());
    const sealed = structuredClone(before);
    expect(
      before.workspaces.map((workspace) => workspace.shellVerified),
    ).toEqual([true, false]);
    const checked = await service.recordFolderAccessCheck(
      secondId,
      before.generation,
      verification.buildId,
      secondIdentity,
      true,
    );
    expect(checked.ok).toBe(true);
    const both = approval(checked.snapshot);
    expect(both.generation).toBe(before.generation + 1);
    expect(both.workspaces.map((workspace) => workspace.shellVerified)).toEqual(
      [true, true],
    );
    expect(both.capabilities).toContain("workspace.shell");
    const repeated = await service.recordFolderAccessCheck(
      secondId,
      both.generation,
      verification.buildId,
      secondIdentity,
      true,
    );
    expect(repeated.ok).toBe(true);
    expect(approval(repeated.snapshot)).toEqual(both);
    const refused = await service.recordFolderAccessCheck(
      secondId,
      before.generation,
      verification.buildId,
      secondIdentity,
      false,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: "WORKSPACE_ROOT_CHANGED",
    });
    expect(approval(refused.snapshot)).toEqual(both);
    const withdrawn = await service.recordFolderAccessCheck(
      secondId,
      both.generation,
      verification.buildId,
      secondIdentity,
      false,
    );
    expect(withdrawn.ok).toBe(true);
    const one = approval(withdrawn.snapshot);
    expect(one.generation).toBe(both.generation + 1);
    expect(one.workspaces.map((workspace) => workspace.shellVerified)).toEqual([
      true,
      false,
    ]);
    const stopped = await service.recordFolderAccessCheck(
      workspaceId,
      one.generation,
      verification.buildId,
      rootIdentity,
      false,
    );
    expect(stopped.ok).toBe(true);
    const none = approval(stopped.snapshot);
    expect(none.generation).toBe(one.generation + 1);
    expect(none.commands).toBe("verification");
    expect(none.capabilities).not.toContain("workspace.shell");
    const repeatedWithdrawal = await service.recordFolderAccessCheck(
      workspaceId,
      none.generation,
      verification.buildId,
      rootIdentity,
      false,
    );
    expect(repeatedWithdrawal.ok).toBe(true);
    expect(approval(repeatedWithdrawal.snapshot)).toEqual(none);
    expect(before).toEqual(sealed);
  });

  it("keeps stale sibling checks stale when verification advances policy", async () => {
    const { service, workspaceId, rootIdentity, verification } =
      await computerEvidenceFixture();
    const secondIdentity = { device: "1", inode: "3" };
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/second",
      label: "Second",
      rootIdentity: secondIdentity,
    });
    const secondId = approval(added.snapshot).workspaces[1]!.workspaceId;
    await service.recordComputerVerification(secondId, verification, {
      rootIdentity: secondIdentity,
    });
    await service.updateComputerCommands("verification");
    await service.updateComputerCommands("workspace");
    const before = approval(service.snapshot());
    const verified = await service.recordComputerVerification(
      workspaceId,
      verification,
      { rootIdentity },
    );
    expect(verified.ok).toBe(true);
    const after = approval(verified.snapshot);
    expect(after.generation).toBe(before.generation + 1);
    expect(
      after.workspaces.map((workspace) => workspace.shellVerified),
    ).toEqual([true, false]);
  });

  it.each(["save", "readback"] as const)(
    "retains durable authority truth after a %s failure",
    async (fault) => {
      const { service, store, root, workspaceId, rootIdentity, verification } =
        await computerEvidenceFixture();
      const before = service.snapshot();
      const beforeApproval = approval(before);
      const spy =
        fault === "save"
          ? vi
              .spyOn(store, "save")
              .mockRejectedValueOnce(new Error("save failed"))
          : vi
              .spyOn(store, "load")
              .mockRejectedValueOnce(new Error("readback failed"));
      const failed = await service.recordComputerVerification(
        workspaceId,
        verification,
        { rootIdentity },
      );
      spy.mockRestore();
      expect(failed).toMatchObject({
        ok: false,
        error: "SETTINGS_WRITE_FAILED",
      });
      if (fault === "save") expect(failed.snapshot).toEqual(before);
      else {
        const saved = approval(failed.snapshot);
        expect(saved.generation).toBe(beforeApproval.generation + 1);
        expect(saved.commands).toBe("workspace");
        expect(saved.capabilities).toContain("workspace.shell");
      }
      const restarted = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await restarted.initialize();
      expect(restarted.snapshot()).toEqual(failed.snapshot);
      expect(approval(before)).toEqual(beforeApproval);
    },
  );
});

describe("Farol Next product configuration", () => {
  it("roundtrips exact Codex read selection through the Settings command and save with generation guards", async () => {
    const root = await stateRoot();
    const store = new ProductSettingsStore({ root });
    const saves = vi.spyOn(store, "save");
    const seed = new ProductConfigurationService(store, dependencies());
    await seed.initialize();
    const snapshot = seed.snapshot();
    if (snapshot.status !== "ready") throw new Error("settings missing");
    const base = snapshot.settings;
    const workspaceId = "00000000-0000-4000-8000-000000000002";
    const verifiedAt = "2026-09-16T10:00:00.000Z";
    await store.save({
      ...base,
      tasks: taskPolicy(),
      revision: base.revision + 1,
      computer: {
        ...base.computer,
        workspaces: [
          {
            workspaceId,
            root: "/Users/example/writer",
            label: "Writer",
            access: "read",
            excludedPaths: [],
            rootIdentity: { device: "5", inode: "11" },
            gitMetadata: {
              gitDirectory: "/Users/example/project/.git/worktrees/writer",
              commonDirectory: "/Users/example/project/.git",
            },
          },
        ],
      },
      nativeHosts: {
        generation: 2,
        codex: {
          executablePath: "/Users/example/bin/codex",
          executableSha256: "a".repeat(64),
          version: "0.153.4",
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
      setup: {
        ...base.setup,
        computer: {
          ...base.setup.computer,
          verified: {
            profile: "fixture",
            configRevision: base.computer.generation,
            workspaceId,
            runtimeGeneration: "fixture",
            buildId: "d".repeat(64),
            protocol: "fixture",
            verifiedAt,
          },
        },
      },
    });
    const service = new ProductConfigurationService(store, dependencies());
    await service.initialize();
    const selection = {
      transport: "codex-shared-proxy/v1",
      socketPath: "/Users/example/private/codex.sock",
      expectedCodexHome: "/Users/example/.codex",
      workspaceId,
      projectId: "00000000-0000-4000-8000-000000000003",
      observeThreadId: "0e4b2463-5506-47d5-a1a0-b4b84e941301",
      projectRoot: "/Users/example/project",
      projectIdentity: { device: "5", inode: "10" },
      gitCommonDirectory: "/Users/example/project/.git",
      execution: { sandbox: "read-only", approvalPolicy: "on-request" },
      harness: "codex",
      computerGeneration: base.computer.generation,
      hostGeneration: 2,
      approvedAt: verifiedAt,
      expiresAt: Date.parse(verifiedAt) + 60_000,
    };
    await expect(
      service.recordCodexTaskRoute(selection),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: { settings: { nativeHosts: { taskRoute: selection } } },
    });
    const command = ProductConfigurationCommandSchema.parse({
      kind: "host.configure-codex-tasks",
      socketPath: selection.socketPath,
      expectedCodexHome: selection.expectedCodexHome,
      workspaceId,
      projectId: selection.projectId,
      observeThreadId: selection.observeThreadId,
      observeTurnId: "turn-exact_1",
      projectRoot: selection.projectRoot,
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
    if (command.kind !== "host.configure-codex-tasks")
      throw new Error("fixture command missing");
    const exact = {
      ...selection,
      observeThreadId: command.observeThreadId,
      observeTurnId: command.observeTurnId,
    };
    await expect(service.recordCodexTaskRoute(exact)).resolves.toMatchObject({
      ok: true,
      snapshot: { settings: { nativeHosts: { taskRoute: exact } } },
    });
    const restarted = new ProductConfigurationService(store, dependencies());
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(service.snapshot());
    const publish = vi.fn(async () => {});
    const withdraw = vi.fn(async () => ({ publish }));
    service.attachComputerAuthority(withdraw);
    const beforeInvalid = service.snapshot();
    const saveCount = saves.mock.calls.length;
    for (const invalid of [
      { ...exact, observeThreadId: undefined },
      { ...exact, observeTurnId: "" },
      { ...exact, observeTurnId: "foreign/path" },
      { ...exact, observeTurnId: null },
    ]) {
      await expect(
        service.recordCodexTaskRoute(invalid),
      ).resolves.toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
      expect(service.snapshot()).toEqual(beforeInvalid);
    }
    expect(saves.mock.calls.length).toBe(saveCount);
    expect(withdraw).not.toHaveBeenCalled();
    await expect(
      service.recordCodexTaskRoute({ ...exact, observeTurnId: "turn-later" }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          nativeHosts: { taskRoute: { ...exact, observeTurnId: "turn-later" } },
        },
      },
    });
    expect(withdraw).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeHosts: expect.objectContaining({
          taskRoute: { ...exact, observeTurnId: "turn-later" },
        }),
      }),
    );
    await expect(
      service.recordCodexTaskRoute({ ...selection, hostGeneration: 1 }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      service.recordCodexTaskRoute({
        ...selection,
        observeThreadId: "not-a-thread-id",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(service.clearCodexTaskRoute()).resolves.toMatchObject({
      ok: true,
      snapshot: { settings: { nativeHosts: { taskRoute: null } } },
    });
  });

  it("AUTH-06 refuses to approve a root inside a home credential store", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      { ...dependencies(), homeDirectory: "/Users/example" },
    );
    await service.initialize();

    for (const candidate of [
      "/Users/example/.ssh",
      "/Users/example/.aws/profiles",
      "/Users/example/Library/Keychains",
      // U+017F LONG S folds to "s" on APFS: this names ~/.ssh.
      "/Users/example/.\u017f\u017fh",
    ]) {
      await expect(
        service.addReadonlyWorkspace({ root: candidate, label: "Store" }),
      ).resolves.toMatchObject({
        ok: false,
        error: "WORKSPACE_SELECTION_PROTECTED",
        snapshot: {
          status: "ready",
          settings: { computer: { workspaces: [] } },
        },
      });
    }
    // The home itself and ordinary folders beside the stores stay approvable;
    // the stores inside them remain denied by the native helper policy.
    for (const candidate of ["/Users/example", "/Users/example/.ssh-notes"]) {
      await expect(
        service.addReadonlyWorkspace({ root: candidate, label: "Folder" }),
      ).resolves.toMatchObject({ ok: true });
    }
  });

  it.each([".codex", ".claude", ".Codex", ".CLAUDE"])(
    "allows explicit read/write approval of the %s agent store without auto-enabling shell",
    async (directory) => {
      // Only synthetic settings are persisted in temporary state. No actual
      // agent directory, transcript, config or credentials are read or changed.
      const root = await stateRoot();
      const service = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        { ...dependencies(), homeDirectory: "/Users/example" },
      );
      await service.initialize();
      const added = await service.addReadonlyWorkspace({
        root: "/Users/example/" + directory,
        label: "Agent store",
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
      });
      expect(added.ok).toBe(true);
      const snapshot = service.snapshot();
      if (snapshot.status !== "ready") throw new Error("settings missing");
      const selected = snapshot.settings.computer.workspaces[0]!;
      expect(selected.access).toBe("read");
      expect(selected.rootIdentity).toEqual(SYNTHETIC_ROOT_IDENTITY);
      const excluded = selected.root + "/private";
      const commands = snapshot.settings.computer.commands;
      const generation = snapshot.settings.computer.generation;
      await expect(
        service.updateWorkspaceAccess(selected.workspaceId, "write"),
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          settings: {
            computer: {
              generation: generation + 1,
              commands,
              workspaces: [{ access: "write", gitHistoryApproved: false }],
            },
            setup: { computer: { verified: null } },
          },
        },
      });
      await expect(
        service.updateWorkspaceExclusions(selected.workspaceId, [excluded]),
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          settings: {
            computer: {
              workspaces: [{ excludedPaths: [excluded], access: "write" }],
            },
          },
        },
      });
      await expect(
        service.updateWorkspaceAccess(selected.workspaceId, "read"),
      ).resolves.toMatchObject({
        ok: true,
        snapshot: {
          settings: {
            computer: {
              commands,
              workspaces: [{ excludedPaths: [excluded], access: "read" }],
            },
          },
        },
      });
    },
  );

  it("AUTH-10 binds an approved workspace to the folder identity seen at approval", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const rootIdentity = { device: "16777232", inode: "4242" };

    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
      rootIdentity,
    });
    expect(added).toMatchObject({
      ok: true,
      snapshot: {
        settings: { computer: { workspaces: [{ rootIdentity }] } },
      },
    });
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(added.snapshot);
  });

  it("persists the selected write default without granting shell or full Git access", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const before = service.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    const added = await service.addWorkspace(
      {
        root: "/Users/example/project",
        label: "Project",
        rootIdentity: SYNTHETIC_ROOT_IDENTITY,
      },
      "write",
    );
    expect(added).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: {
            commands: before.settings.computer.commands,
            workspaces: [
              { access: "write", rootIdentity: SYNTHETIC_ROOT_IDENTITY },
            ],
          },
        },
      },
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    expect(
      added.snapshot.settings.computer.workspaces[0]!.gitHistoryApproved,
    ).not.toBe(true);
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(added.snapshot);
  });

  it("does not broaden an existing read-only workspace when the same root is selected again", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const input = {
      root: "/Users/example/project",
      label: "Project",
      rootIdentity: SYNTHETIC_ROOT_IDENTITY,
    };
    const original = await service.addReadonlyWorkspace(input);
    expect(await service.addWorkspace(input, "write")).toEqual(original);
  });

  it("F1-1 withdraws a persisted verification of a workspace that has no folder identity", async () => {
    const root = await stateRoot();
    const store = new ProductSettingsStore({ root });
    const seed = new ProductConfigurationService(store, dependencies());
    await seed.initialize();
    const added = await seed.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const settings = added.snapshot.settings;
    const workspace = settings.computer.workspaces[0];
    if (!workspace) throw new Error("workspace missing");
    expect(workspace.rootIdentity).toBeUndefined();
    // What a build from before folder identities saved: a verification that
    // names a workspace bound to nothing but its pathname.
    await store.save({
      ...settings,
      revision: settings.revision + 1,
      setup: {
        ...settings.setup,
        computer: {
          ...settings.setup.computer,
          configured: true,
          reachable: "reachable",
          verified: {
            profile: "computer.local.read/1",
            runtimeGeneration: "runtime-1",
            buildId: "c".repeat(64),
            protocol: "readonly-workspace/1",
            configRevision: settings.computer.generation,
            workspaceId: workspace.workspaceId,
            verifiedAt: "2026-09-01T00:00:00.000Z",
          },
          needsAction: null,
        },
      },
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
          computer: {
            verified: null,
            reachable: "unknown",
            needsAction: expect.stringContaining("Verify Project again"),
          },
        },
      },
    });
    // The withdrawal is durable, not only in memory.
    const persisted = await new ProductSettingsStore({ root }).load();
    expect(persisted?.setup.computer.verified).toBeNull();

    // Only an explicit owner verification binds the folder again.
    const verified = await restarted.recordComputerVerification(
      workspace.workspaceId,
      {
        profile: "computer.local.read/1",
        runtimeGeneration: "runtime-2",
        buildId: "c".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: { device: "9", inode: "77" } },
    );
    expect(verified).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: {
            workspaces: [{ rootIdentity: { device: "9", inode: "77" } }],
          },
          setup: {
            computer: { verified: { workspaceId: workspace.workspaceId } },
          },
        },
      },
    });
  });

  it("AUTH-10 binds a workspace approved without an identity at its next owner verification only", async () => {
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
    const workspace = added.snapshot.settings.computer.workspaces[0];
    if (!workspace) throw new Error("workspace missing");
    expect(workspace.rootIdentity).toBeUndefined();
    const verification = {
      profile: "computer.local.read/1",
      runtimeGeneration: "runtime-1",
      buildId: "c".repeat(64),
      protocol: "readonly-workspace/1",
    };

    await expect(
      service.recordComputerVerification(workspace.workspaceId, verification, {
        rootIdentity: { device: "1", inode: "2" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: {
            generation: added.snapshot.settings.computer.generation + 1,
            workspaces: [{ rootIdentity: { device: "1", inode: "2" } }],
          },
        },
      },
    });
    // A bound workspace is never silently rebound to another object.
    await expect(
      service.recordComputerVerification(workspace.workspaceId, verification, {
        rootIdentity: { device: "1", inode: "3" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "WORKSPACE_ROOT_CHANGED",
      snapshot: {
        settings: {
          computer: {
            workspaces: [{ rootIdentity: { device: "1", inode: "2" } }],
          },
        },
      },
    });
  });

  it("AUTH-09 records linked Git metadata only as the owner's verification observed it", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/checkout",
      label: "Checkout",
      rootIdentity: { device: "1", inode: "2" },
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    const verification = {
      profile: "computer.local.read/1",
      runtimeGeneration: "runtime-1",
      buildId: "c".repeat(64),
      protocol: "readonly-workspace/1",
    };
    const gitMetadata = {
      gitDirectory: "/Users/example/repo/.git/worktrees/checkout",
      commonDirectory: "/Users/example/repo/.git",
    };

    await service.updateComputerCommands("workspace");
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity: { device: "1", inode: "2" },
    });
    expect(
      await service.updateWorkspaceGitHistory(workspaceId, true),
    ).toMatchObject({ ok: true });

    const beforeLinked = approval(service.snapshot());
    const linked = await service.recordComputerVerification(
      workspaceId,
      verification,
      { rootIdentity: { device: "1", inode: "2" }, gitMetadata },
    );
    expect(linked).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: {
            workspaces: [
              { workspaceId, gitMetadata, gitHistoryApproved: false },
            ],
          },
        },
      },
    });
    const linkedApproval = approval(linked.snapshot);
    expect(linkedApproval.generation).toBe(beforeLinked.generation + 1);
    expect(linkedApproval.workspaces[0]).toMatchObject({
      gitMetadata,
      gitHistoryApproved: false,
      shellVerified: false, // Legacy file policy does not qualify the Go Shell.
    });
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(linked.snapshot);

    expect(
      await service.updateWorkspaceGitHistory(workspaceId, true),
    ).toMatchObject({ ok: true });
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity: { device: "1", inode: "2" },
      gitMetadata,
    });
    expect(service.snapshot()).toMatchObject({
      settings: { computer: { workspaces: [{ gitHistoryApproved: true }] } },
    });
    const sameMetadata = approval(service.snapshot());
    const renewed = await service.recordComputerVerification(
      workspaceId,
      verification,
      {
        rootIdentity: { device: "1", inode: "2" },
        gitMetadata,
      },
    );
    expect(renewed.ok).toBe(true);
    expect(approval(renewed.snapshot)).toEqual(sameMetadata);

    const replacementMetadata = {
      gitDirectory: "/Users/example/other/.git/worktrees/checkout",
      commonDirectory: "/Users/example/other/.git",
    };
    const replaced = await service.recordComputerVerification(
      workspaceId,
      verification,
      {
        rootIdentity: { device: "1", inode: "2" },
        gitMetadata: replacementMetadata,
      },
    );
    expect(replaced.ok).toBe(true);
    const replacedApproval = approval(replaced.snapshot);
    expect(replacedApproval.generation).toBe(sameMetadata.generation + 1);
    expect(replacedApproval.workspaces[0]).toMatchObject({
      gitMetadata: replacementMetadata,
      gitHistoryApproved: false,
      shellVerified: false,
    });
    expect(sameMetadata.workspaces[0]?.gitMetadata).toEqual(gitMetadata);

    // The owner verified a layout whose metadata now lives inside the root.
    const primary = await service.recordComputerVerification(
      workspaceId,
      verification,
      { rootIdentity: { device: "1", inode: "2" }, gitMetadata: null },
    );
    if (primary.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(primary.ok).toBe(true);
    expect(
      primary.snapshot.settings.computer.workspaces[0]?.gitMetadata,
    ).toBeUndefined();
    expect(
      primary.snapshot.settings.computer.workspaces[0]?.gitHistoryApproved,
    ).toBe(false);
    expect(approval(primary.snapshot).generation).toBe(
      replacedApproval.generation + 1,
    );
    expect(linkedApproval.workspaces[0]?.gitMetadata).toEqual(gitMetadata);
  });

  it.each(["home", "browser", "computer", "activity", "settings"] as const)(
    "defaults fresh state to Home and retains an explicit %s launch preference across restart",
    async (openAtLaunch) => {
      const root = await stateRoot();
      const first = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await first.initialize();
      const fresh = first.snapshot();
      if (fresh.status !== "ready") throw new Error("settings unavailable");
      expect(fresh.settings.general.openAtLaunch).toBe("home");
      const command = ProductConfigurationCommandSchema.parse({
        kind: "general.update",
        ...fresh.settings.general,
        openAtLaunch,
      });
      if (command.kind !== "general.update") throw new Error("wrong command");
      const { kind: _kind, ...preferences } = command;
      expect((await first.updateGeneral(preferences)).ok).toBe(true);
      const restarted = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await restarted.initialize();
      expect(restarted.snapshot()).toMatchObject({
        status: "ready",
        settings: { general: { openAtLaunch } },
      });
    },
  );

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

  it("defaults commands to none and persists explicit verification authority across restart", async () => {
    const root = await stateRoot();
    const first = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await first.initialize();
    expect(first.snapshot()).toMatchObject({
      status: "ready",
      settings: { computer: { commands: "none", generation: 1 } },
    });

    const updated = await first.updateComputerCommands("verification");
    expect(updated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          computer: { commands: "verification", generation: 2 },
          setup: {
            computer: {
              verified: null,
              needsAction: "Add a read-only workspace.",
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(updated.snapshot);
  });

  it("requires a verified, separate Git history approval and resets it on exclusions", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const added = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
      rootIdentity: { device: "1", inode: "2" },
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspaceId =
      added.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    await service.updateComputerCommands("workspace");
    expect(
      await service.updateWorkspaceGitHistory(workspaceId, true),
    ).toMatchObject({
      ok: false,
      error: "SETTINGS_INPUT_INVALID",
    });
    const verification = {
      profile: "computer.local.read/1",
      runtimeGeneration: "runtime-1",
      buildId: "c".repeat(64),
      protocol: "readonly-workspace/1",
    };
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity: { device: "1", inode: "2" },
    });
    const approved = await service.updateWorkspaceGitHistory(workspaceId, true);
    expect(approved).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: { workspaces: [{ gitHistoryApproved: true }] },
          setup: { computer: { verified: null } },
        },
      },
    });
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity: { device: "1", inode: "2" },
      gitMetadata: {
        gitDirectory: "/Users/example/project/.git",
        commonDirectory: "/Users/example/project/.git",
      },
    });
    expect(service.snapshot()).toMatchObject({
      settings: { computer: { workspaces: [{ gitHistoryApproved: true }] } },
    });
    const elevated = await service.updateWorkspaceAccess(workspaceId, "write");
    expect(elevated).toMatchObject({
      ok: true,
      snapshot: {
        settings: {
          computer: {
            workspaces: [{ access: "write", gitHistoryApproved: false }],
          },
        },
      },
    });
    await service.recordComputerVerification(workspaceId, verification, {
      rootIdentity: { device: "1", inode: "2" },
    });
    expect(
      await service.updateWorkspaceGitHistory(workspaceId, true),
    ).toMatchObject({ ok: true });
    const excluded = await service.updateWorkspaceExclusions(workspaceId, [
      "/Users/example/project/private",
    ]);
    expect(excluded).toMatchObject({
      snapshot: {
        settings: { computer: { workspaces: [{ gitHistoryApproved: false }] } },
      },
    });
  });

  it("persists a Next-only secure MCP connector without persisting its credential", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        connectors: {
          secureMcp: {
            generation: 1,
            profile: "farol-next",
            tunnelId: null,
            tunnelClient: null,
            credential: "missing",
            runtime: null,
            attachment: null,
          },
        },
      },
    });

    const approved = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (!approved.ok || approved.snapshot.status !== "ready") {
      throw new Error("workspace approval failed");
    }
    const workspaceId =
      approved.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    const computerGeneration = approved.snapshot.settings.computer.generation;

    await service.recordSecureMcpTunnelClient({
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    await service.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" });
    await service.recordSecureMcpCredential("stored");
    await service.recordSecureMcpRuntime({
      state: "ready",
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
    });
    const challenge = "00000000-0000-4000-8000-000000000099";
    const challengeSha256 = createHash("sha256")
      .update(challenge)
      .digest("hex");
    const challenged = await service.recordSecureMcpChallenge({
      challenge,
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
    });
    expect(challenged).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          connectors: {
            secureMcp: {
              challenge: {
                value: challenge,
                challengeSha256,
                runtimeGeneration: "b".repeat(64),
                computerGeneration,
                buildId: "c".repeat(64),
                preparedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });
    expect((await service.recordSecureMcpAppPending("b".repeat(64))).ok).toBe(
      true,
    );
    const wrongChallenge = await service.recordSecureMcpAttachment({
      workspaceId,
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
      challengeSha256: "d".repeat(64),
      receiptSha256: "e".repeat(64),
    });
    expect(wrongChallenge).toMatchObject({
      ok: false,
      error: "SETTINGS_INPUT_INVALID",
    });
    const wrongWorkspace = await service.recordSecureMcpAttachment({
      workspaceId: "00000000-0000-4000-8000-000000000999",
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
      challengeSha256,
      receiptSha256: "e".repeat(64),
    });
    expect(wrongWorkspace).toMatchObject({
      ok: false,
      error: "SETTINGS_INPUT_INVALID",
    });
    expect(
      await service.recordSecureMcpAttachment({
        workspaceId: null,
        runtimeGeneration: "b".repeat(64),
        computerGeneration,
        buildId: "c".repeat(64),
        challengeSha256,
        receiptSha256: "e".repeat(64),
      }),
    ).toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
    const attached = await service.recordSecureMcpAttachment({
      workspaceId,
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
      challengeSha256,
      receiptSha256: "e".repeat(64),
    });

    expect(attached).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          connectors: {
            secureMcp: {
              generation: 4,
              profile: "farol-next",
              tunnelId: "tunnel_farol_next",
              credential: "stored",
              runtime: {
                state: "ready",
                runtimeGeneration: "b".repeat(64),
                computerGeneration,
                buildId: "c".repeat(64),
              },
              attachment: {
                workspaceId,
                runtimeGeneration: "b".repeat(64),
                computerGeneration,
                buildId: "c".repeat(64),
                challengeSha256,
                receiptSha256: "e".repeat(64),
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
              lastVerifiedAttachment: {
                workspaceId,
                runtimeGeneration: "b".repeat(64),
                computerGeneration,
                buildId: "c".repeat(64),
              },
              challenge: null,
            },
          },
          setup: {
            connect: {
              configured: true,
              reachable: "reachable",
              outcomeUnknown: false,
              needsAction: null,
              unavailable: null,
              verified: {
                profile: "farol-next",
                configRevision: 4,
                workspaceId,
                runtimeGeneration: "b".repeat(64),
                buildId: "c".repeat(64),
                protocol: "openai-tunnel-client/v1",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(attached.snapshot);

    const saved = await fs.readFile(path.join(root, "config.json"), "utf8");
    expect(saved).not.toMatch(/api[-_ ]?key|secret|bearer/iu);

    const previousProfile = service.snapshot();
    if (previousProfile.status !== "ready")
      throw new Error("FIXTURE_NOT_READY");
    previousProfile.settings.connectors.secureMcp.lastVerifiedAttachment = null;
    await new ProductSettingsStore({ root }).save(previousProfile.settings);
    const migrated = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await migrated.initialize();
    const migratedSnapshot = migrated.snapshot();
    expect(migratedSnapshot).toMatchObject({
      status: "ready",
      settings: {
        connectors: {
          secureMcp: {
            lastVerifiedAttachment:
              previousProfile.settings.connectors.secureMcp.attachment,
          },
        },
      },
    });
  });

  it("invalidates connector runtime and attachment when Computer authority changes", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    const approved = await service.addReadonlyWorkspace({
      root: "/Users/example/project",
      label: "Project",
    });
    if (!approved.ok || approved.snapshot.status !== "ready") {
      throw new Error("workspace approval failed");
    }
    const workspaceId =
      approved.snapshot.settings.computer.workspaces[0]?.workspaceId;
    if (!workspaceId) throw new Error("workspace missing");
    const computerGeneration = approved.snapshot.settings.computer.generation;
    await service.recordSecureMcpTunnelClient({
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    });
    await service.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" });
    await service.recordSecureMcpCredential("stored");
    await service.recordSecureMcpRuntime({
      state: "ready",
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
    });
    const authorityChallenge = "00000000-0000-4000-8000-000000000098";
    const authorityChallengeSha256 = createHash("sha256")
      .update(authorityChallenge)
      .digest("hex");
    await service.recordSecureMcpChallenge({
      challenge: authorityChallenge,
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
    });
    await service.recordSecureMcpAttachment({
      workspaceId,
      runtimeGeneration: "b".repeat(64),
      computerGeneration,
      buildId: "c".repeat(64),
      challengeSha256: authorityChallengeSha256,
      receiptSha256: "e".repeat(64),
    });

    const changed = await service.renameComputer("Owner Mac");

    expect(changed).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          computer: { generation: computerGeneration + 1 },
          connectors: {
            secureMcp: {
              generation: 5,
              credential: "stored",
              runtime: null,
              attachment: null,
            },
          },
          setup: {
            connect: {
              configured: true,
              reachable: "unknown",
              verified: null,
              needsAction:
                "Restart the connector after changing Computer authority.",
              outcomeUnknown: false,
            },
          },
        },
      },
    });
  });

  it.each([
    undefined,
    "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
    "TUNNEL_CLIENT_EXECUTABLE_UNSAFE",
  ] as const)(
    "clears runtime proof after stop or resume refusal %s",
    async (refusal) => {
      const root = await stateRoot();
      const service = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await service.initialize();
      const approved = await service.addReadonlyWorkspace({
        root: "/Users/example/project",
        label: "Project",
      });
      if (!approved.ok || approved.snapshot.status !== "ready") {
        throw new Error("workspace approval failed");
      }
      const workspaceId =
        approved.snapshot.settings.computer.workspaces[0]?.workspaceId;
      if (!workspaceId) throw new Error("workspace missing");
      const computerGeneration = approved.snapshot.settings.computer.generation;
      await service.recordSecureMcpTunnelClient({
        executablePath: "/opt/homebrew/bin/tunnel-client",
        executableSha256: "a".repeat(64),
        version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
        protocol: "openai-tunnel-client/v1",
      });
      await service.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" });
      await service.recordSecureMcpCredential("stored");
      await service.recordSecureMcpRuntime({
        state: "ready",
        runtimeGeneration: "b".repeat(64),
        computerGeneration,
        buildId: "c".repeat(64),
      });
      const stopChallenge = "00000000-0000-4000-8000-000000000097";
      const stopChallengeSha256 = createHash("sha256")
        .update(stopChallenge)
        .digest("hex");
      await service.recordSecureMcpChallenge({
        challenge: stopChallenge,
        runtimeGeneration: "b".repeat(64),
        computerGeneration,
        buildId: "c".repeat(64),
      });
      await service.recordSecureMcpAttachment({
        workspaceId,
        runtimeGeneration: "b".repeat(64),
        computerGeneration,
        buildId: "c".repeat(64),
        challengeSha256: stopChallengeSha256,
        receiptSha256: "e".repeat(64),
      });

      if (refusal === undefined) {
        const updateDrain = await service.recordSecureMcpDrainedForUpdate();
        expect(updateDrain).toMatchObject({
          ok: true,
          snapshot: {
            status: "ready",
            settings: {
              connectors: {
                secureMcp: {
                  runtime: {
                    state: "unreachable",
                    runtimeGeneration: "b".repeat(64),
                  },
                  challenge: null,
                  attachment: null,
                },
              },
              setup: {
                connect: {
                  verified: null,
                  reachable: "unknown",
                  unavailable: "CONNECTOR_UPDATE_DRAINED",
                  outcomeUnknown: false,
                },
              },
            },
          },
        });
        const reload = new ProductConfigurationService(
          new ProductSettingsStore({ root }),
          dependencies(),
        );
        await reload.initialize();
        expect(reload.snapshot()).toMatchObject({
          status: "ready",
          settings: {
            connectors: { secureMcp: { runtime: { state: "unreachable" } } },
            setup: { connect: { unavailable: "CONNECTOR_UPDATE_DRAINED" } },
          },
        });
      }
      const stopped = await service.recordSecureMcpStopped(refusal);

      if (refusal !== undefined) {
        const repeated = await service.recordSecureMcpStopped(refusal);
        expect(repeated).toMatchObject({ ok: true });
        const reloaded = new ProductConfigurationService(
          new ProductSettingsStore({ root }),
          dependencies(),
        );
        await reloaded.initialize();
        expect(reloaded.snapshot()).toMatchObject({
          status: "ready",
          settings: {
            connectors: {
              secureMcp: {
                runtime: null,
                attachment: null,
                lastVerifiedAttachment: { workspaceId },
              },
            },
            setup: { connect: { unavailable: refusal } },
          },
        });
      }
      expect(stopped).toMatchObject({
        ok: true,
        snapshot: {
          status: "ready",
          settings: {
            connectors: {
              secureMcp: {
                runtime: null,
                challenge: null,
                attachment: null,
                lastVerifiedAttachment: {
                  workspaceId,
                  runtimeGeneration: "b".repeat(64),
                  computerGeneration,
                  buildId: "c".repeat(64),
                },
              },
            },
            setup: {
              connect: {
                configured: true,
                reachable: "unknown",
                verified: null,
                needsAction:
                  refusal === undefined
                    ? "Start the connector and check readiness."
                    : "Choose the tunnel-client executable again before reconnecting.",
                unavailable: refusal ?? null,
                outcomeUnknown: false,
              },
            },
          },
        },
      });
    },
  );

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
    const settingsPath = path.join(root, "config.json");
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
        nativeHosts: { generation: 1, codex: null },
        setup: {
          journey: { currentStep: "chatgpt", dismissed: false },
        },
      },
    });
  });

  it("persists a verified Codex host contract across restart", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const recorded = await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    expect(recorded).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            generation: 2,
            codex: {
              executablePath: "/Users/example/bin/codex",
              executableSha256: "a".repeat(64),
              version: "0.153.4",
              protocol: "codex-app-server/v2",
              schemaSha256: "b".repeat(64),
              verifiedAt: "2026-09-16T10:00:00.000Z",
              localVerification: {
                executableSha256: "a".repeat(64),
                schemaSha256: "b".repeat(64),
                buildId: "c".repeat(64),
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
              liveVerification: null,
            },
          },
          setup: {
            hosts: {
              configured: true,
              reachable: "reachable",
              needsAction: "Run the live Codex host check.",
              unavailable: null,
              outcomeUnknown: false,
              verified: null,
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(recorded.snapshot);
  });

  it("invalidates local Codex contract evidence after a failed recheck without forgetting the selected path", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const failed = await service.recordCodexHostFailure("unreachable");

    expect(failed).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            codex: {
              executablePath: "/Users/example/bin/codex",
              localVerification: null,
            },
          },
          setup: {
            hosts: {
              reachable: "unreachable",
              verified: null,
            },
          },
        },
      },
    });
  });

  it("records live Codex readiness only for the exact selected contract", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const live = await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    expect(live).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            generation: 2,
            codex: {
              liveVerification: {
                model: "gpt-6-astra",
                executableSha256: "a".repeat(64),
                schemaSha256: "b".repeat(64),
                buildId: "c".repeat(64),
                dynamicTool: "farol_next_ping",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
          setup: {
            hosts: {
              configured: true,
              reachable: "reachable",
              needsAction: null,
              unavailable: null,
              outcomeUnknown: false,
              verified: {
                profile: "codex.app-server.live/1",
                configRevision: 2,
                workspaceId: null,
                runtimeGeneration: "a".repeat(64),
                buildId: "c".repeat(64),
                protocol: "codex-app-server/v2",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    await expect(
      service.recordCodexHostLiveVerification({
        model: "gpt-6-astra",
        executableSha256: "d".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
      }),
    ).resolves.toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });
  });

  it("persists exact native Agent lineage and workspace enforcement evidence", async () => {
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
    const computerVerified = await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.readonly/1",
        runtimeGeneration: "runtime-1",
        buildId: "c".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );
    expect(computerVerified.ok).toBe(true);
    const computerGeneration = approval(computerVerified.snapshot).generation;
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });
    await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const recorded = await service.recordCodexAgentVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
      workspaceId,
      computerGeneration,
      transport: "codex-native-agent/spawn-prompt-sha256-v1",
      authorityRole: "critic",
      hostRole: "default",
      delegationDigest: "d".repeat(64),
      parentThreadSha256: "e".repeat(64),
      childThreadSha256: "f".repeat(64),
      boundedRunning: true,
      modelTurnsSubmitted: 1,
      fallbackAllowed: false,
      descendantCount: 0,
      resultRefProtocol: "codex-app-server",
      resultRetention: "durable",
      parentDelivery: "acknowledged",
      workspaceEnforcement: "verified",
    });

    expect(recorded).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            codex: {
              agentVerification: {
                authorityRole: "critic",
                hostRole: "default",
                workspaceId,
                computerGeneration,
                delegationDigest: "d".repeat(64),
                boundedRunning: true,
                descendantCount: 0,
                resultRetention: "durable",
                parentDelivery: "acknowledged",
                workspaceEnforcement: "verified",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
          setup: {
            verify: {
              configured: true,
              reachable: "reachable",
              outcomeUnknown: false,
              verified: {
                profile: "codex.native-agent.lineage/1",
                workspaceId,
                protocol: "codex-native-agent/spawn-prompt-sha256-v1",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(recorded.snapshot);

    await expect(
      service.recordCodexAgentVerification({
        model: "gpt-6-astra",
        executableSha256: "0".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
        workspaceId,
        computerGeneration,
        transport: "codex-native-agent/spawn-prompt-sha256-v1",
        authorityRole: "critic",
        hostRole: "default",
        delegationDigest: "d".repeat(64),
        parentThreadSha256: "e".repeat(64),
        childThreadSha256: "f".repeat(64),
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      }),
    ).resolves.toMatchObject({ ok: false, error: "SETTINGS_INPUT_INVALID" });

    const invalidated = await service.updateWorkspaceExclusions(workspaceId, [
      "/Users/example/project/private",
    ]);
    expect(invalidated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: { codex: { agentVerification: null } },
          setup: {
            verify: {
              verified: null,
              needsAction: "Run the native Agent lineage check.",
            },
          },
        },
      },
    });
  });

  it("C05-09 keeps native Agent evidence for a write-approved workspace read through its projection", async () => {
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
    const editable = await service.updateWorkspaceAccess(workspaceId, "write");
    if (editable.snapshot.status !== "ready") {
      throw new Error("settings missing");
    }
    const computerVerified = await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.write/1",
        runtimeGeneration: "runtime-1",
        buildId: "c".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );
    expect(computerVerified.ok).toBe(true);
    const computerGeneration = approval(computerVerified.snapshot).generation;
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });
    await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const recorded = await service.recordCodexAgentVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
      workspaceId,
      computerGeneration,
      transport: "codex-native-agent/spawn-prompt-sha256-v1",
      authorityRole: "critic",
      hostRole: "default",
      delegationDigest: "d".repeat(64),
      parentThreadSha256: "e".repeat(64),
      childThreadSha256: "f".repeat(64),
      boundedRunning: true,
      modelTurnsSubmitted: 1,
      fallbackAllowed: false,
      descendantCount: 0,
      resultRefProtocol: "codex-app-server",
      resultRetention: "durable",
      parentDelivery: "acknowledged",
      workspaceEnforcement: "verified",
    });
    expect(recorded).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          computer: { workspaces: [{ workspaceId, access: "write" }] },
          nativeHosts: {
            codex: { agentVerification: { workspaceId, computerGeneration } },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toEqual(recorded.snapshot);
  });

  it("OUX-07 records the Agent rejoin as a typed recovery, not only as wording", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    for (const [failure, recovery] of [
      ["running", "rejoin_agent"],
      ["outcome_unknown", "rejoin_agent"],
      ["failed", undefined],
    ] as const) {
      const recorded = await service.recordCodexAgentFailure(failure);
      if (recorded.snapshot.status !== "ready") {
        throw new Error("settings missing");
      }
      expect(recorded.snapshot.settings.setup.verify.recovery, failure).toBe(
        recovery,
      );
    }
  });

  it("accepts the native Agent command and content-free evidence contracts", () => {
    expect(
      ProductConfigurationCommandSchema.parse({
        kind: "host.run-codex-agent-check",
      }),
    ).toEqual({ kind: "host.run-codex-agent-check" });
    expect(
      ProductConfigurationEvidenceSchema.parse({
        kind: "host.codex-agent-lineage",
        model: "gpt-6-astra",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        buildId: "c".repeat(64),
        workspaceId: "00000000-0000-4000-8000-000000000001",
        computerGeneration: 2,
        transport: "codex-native-agent/spawn-prompt-sha256-v1",
        authorityRole: "critic",
        hostRole: "default",
        delegationDigest: "d".repeat(64),
        parentThreadSha256: "e".repeat(64),
        childThreadSha256: "f".repeat(64),
        boundedRunning: true,
        modelTurnsSubmitted: 1,
        fallbackAllowed: false,
        descendantCount: 0,
        resultRefProtocol: "codex-app-server",
        resultRetention: "durable",
        parentDelivery: "acknowledged",
        workspaceEnforcement: "not_verified",
      }),
    ).toMatchObject({ kind: "host.codex-agent-lineage" });
  });

  it("retains an outcome-unknown live host turn without permitting a blind green retry", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });
    await service.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "a".repeat(64),
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const failed = await service.recordCodexHostLiveFailure("outcome_unknown");

    expect(failed).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: {
            codex: {
              localVerification: {
                executableSha256: "a".repeat(64),
                schemaSha256: "b".repeat(64),
                buildId: "c".repeat(64),
              },
              liveVerification: null,
            },
          },
          setup: {
            hosts: {
              configured: true,
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the Codex host before deliberately running another live check.",
            },
          },
        },
      },
    });
  });

  it("clears a selected Codex host and invalidates host readiness", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();
    await service.recordCodexHost({
      executablePath: "/Users/example/bin/codex",
      executableSha256: "a".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "b".repeat(64),
      buildId: "c".repeat(64),
    });

    const cleared = await service.clearCodexHost();

    expect(cleared).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          nativeHosts: { generation: 3, codex: null },
          setup: {
            hosts: {
              configured: false,
              reachable: "unknown",
              verified: null,
              needsAction: "Choose a Codex executable to verify.",
              outcomeUnknown: false,
            },
          },
        },
      },
    });
  });

  it("reports corrupt state without silently replacing it", async () => {
    const root = await stateRoot();
    await fs.mkdir(root, { mode: 0o700 });
    await fs.writeFile(path.join(root, "config.json"), "{broken", {
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

  it("Q-07 leaves settings written by a newer schema intact after a rollback", async () => {
    // A newer build wrote its own schema. This build must refuse it rather
    // than rewrite it to defaults or its own shape, so running the newer build
    // again still finds its configuration.
    const root = await stateRoot();
    const first = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await first.initialize();
    const target = path.join(root, "config.json");
    const current = JSON.parse(await fs.readFile(target, "utf8")) as Record<
      string,
      unknown
    >;
    const newer = `${JSON.stringify(
      { ...current, schema: 2, futureSection: { enabled: true } },
      null,
      2,
    )}\n`;
    await fs.writeFile(target, newer, { mode: 0o600 });

    const rolledBack = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await rolledBack.initialize();

    expect(rolledBack.snapshot()).toEqual({
      status: "error",
      error: "SETTINGS_CORRUPT",
    });
    await expect(
      rolledBack.updateGeneral({
        openAtLaunch: "activity",
        sidebarDefault: "rail",
        activityDetail: "technical",
      }),
    ).resolves.toMatchObject({ ok: false, error: "SETTINGS_UNAVAILABLE" });
    await expect(
      rolledBack.addReadonlyWorkspace({
        root: "/Users/example/project",
        label: "Project",
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(await fs.readFile(target, "utf8")).toBe(newer);
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
    await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.readonly/1",
        runtimeGeneration: "runtime-1",
        buildId: "a".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );

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

  it("persists workspace exclusions and invalidates stale verification", async () => {
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
    await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.readonly/1",
        runtimeGeneration: "runtime-1",
        buildId: "a".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );

    const updated = await service.updateWorkspaceExclusions(workspaceId, [
      "/Users/example/project/private",
      "/Users/example/project/status.txt",
    ]);

    expect(updated.ok).toBe(true);
    expect(updated.snapshot.status).toBe("ready");
    if (updated.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(
      updated.snapshot.settings.computer.workspaces[0]?.excludedPaths,
    ).toEqual([
      "/Users/example/project/private",
      "/Users/example/project/status.txt",
    ]);
    expect(updated.snapshot.settings.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify read access after changing exclusions.",
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        computer: {
          workspaces: [
            {
              workspaceId,
              excludedPaths: [
                "/Users/example/project/private",
                "/Users/example/project/status.txt",
              ],
            },
          ],
        },
      },
    });
  });

  it("persists explicit write access and invalidates stale verification", async () => {
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
    await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.readonly/1",
        runtimeGeneration: "runtime-1",
        buildId: "a".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );
    const before = service.snapshot();
    if (before.status !== "ready") throw new Error("settings missing");
    const beforeGeneration = before.settings.computer.generation;

    const updated = await service.updateWorkspaceAccess(workspaceId, "write");

    expect(updated.ok).toBe(true);
    expect(updated.snapshot.status).toBe("ready");
    if (updated.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(updated.snapshot.settings.computer.generation).toBe(
      beforeGeneration + 1,
    );
    expect(updated.snapshot.settings.computer.workspaces[0]?.access).toBe(
      "write",
    );
    expect(updated.snapshot.settings.setup.computer).toMatchObject({
      configured: true,
      reachable: "unknown",
      verified: null,
      needsAction: "Verify write access after changing workspace access.",
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        computer: {
          workspaces: [{ workspaceId, access: "write" }],
        },
      },
    });
  });

  it("persists an unknown workspace mutation outcome until reverification", async () => {
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
    await service.updateWorkspaceAccess(workspaceId, "write");
    await service.recordComputerVerification(
      workspaceId,
      {
        profile: "computer.local.write/1",
        runtimeGeneration: "runtime-1",
        buildId: "a".repeat(64),
        protocol: "mutable-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );

    const unknown =
      await service.recordComputerMutationOutcomeUnknown(workspaceId);

    expect(unknown).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            computer: {
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the selected file, then verify workspace access again.",
            },
          },
        },
      },
    });
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(unknown.snapshot);
  });

  it.each(["legacy", "go"])(
    "C05-08 keeps a submitted %s edit observable across restart until its delivery is acknowledged",
    async (backend) => {
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
      if (added.snapshot.status !== "ready")
        throw new Error("settings missing");
      expect(added.snapshot.settings.computer.pendingEdit).toBeNull();
      const workspaceId =
        added.snapshot.settings.computer.workspaces[0]?.workspaceId;
      if (!workspaceId) throw new Error("workspace missing");
      await service.updateWorkspaceAccess(workspaceId, "write");
      await service.recordComputerVerification(
        workspaceId,
        {
          profile: "computer.local.write/1",
          runtimeGeneration: "runtime-1",
          buildId: "a".repeat(64),
          protocol: "mutable-workspace/1",
        },
        { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
      );
      const verified = service.snapshot();
      if (verified.status !== "ready") throw new Error("settings missing");
      const pendingEdit = {
        operationId: "00000000-0000-4000-8000-0000000000aa",
        workspaceId,
        relativePath: "README.md",
        computerGeneration: verified.settings.computer.generation,
        submittedAt: "2026-09-16T10:01:00.000Z",
        ...(backend === "go"
          ? {
              backend: "go-owner-v2" as const,
              profileId: "33333333-3333-4333-8333-333333333333",
              beforeSha256: "a".repeat(64),
            }
          : {}),
      };

      const scope = {
        profileId: "33333333-3333-4333-8333-333333333333",
        ownerId: "owner-desktop",
      };
      if (backend === "legacy") {
        // Historical bytes are existing-only input, never new TS admission.
        const historical = structuredClone(verified.settings);
        historical.revision += 1;
        historical.computer.pendingEdit = pendingEdit;
        await new ProductSettingsStore({ root }).save(historical);
        await service.initialize();
      } else {
        const adapter = service.attachSettingsDeliveryStore(scope);
        const read = await adapter.read();
        expect(read.status).toBe("ok");
        expect(
          await adapter.replace({
            expected: read.snapshot!,
            next: {
              backend: "go-owner-v2",
              operationId: pendingEdit.operationId,
              profileId: scope.profileId,
              workspaceId,
              relativePath: pendingEdit.relativePath,
              computerGeneration: String(pendingEdit.computerGeneration),
              beforeSHA256: pendingEdit.beforeSha256,
              submittedAt: pendingEdit.submittedAt,
            },
            invalidateVerification: false,
          }),
        ).toMatchObject({ status: "committed" });
      }
      const recorded = service.snapshot();
      expect(recorded).toMatchObject({
        status: "ready",
        settings: {
          computer: {
            generation: verified.settings.computer.generation,
            pendingEdit,
          },
          setup: { computer: verified.settings.setup.computer },
        },
      });
      const restarted = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await restarted.initialize();
      expect(restarted.snapshot()).toEqual(recorded);
      if (backend === "legacy") {
        await expect(
          restarted.clearPendingWorkspaceEdit(
            "00000000-0000-4000-8000-0000000000bb",
          ),
        ).resolves.toMatchObject({
          ok: false,
          error: "WORKSPACE_MUTATION_NOT_PENDING",
        });
        expect(restarted.snapshot()).toEqual(recorded);
        await expect(
          restarted.clearPendingWorkspaceEdit(pendingEdit.operationId),
        ).resolves.toMatchObject({ ok: true });
      } else {
        // The historical compatibility ACK must never clear a Go-owned record.
        expect(
          await restarted.clearPendingWorkspaceEdit(pendingEdit.operationId),
        ).toMatchObject({
          ok: false,
          error: "WORKSPACE_MUTATION_NOT_PENDING",
        });
        expect(restarted.snapshot()).toEqual(recorded);
        // Mechanical storage identity fencing; Go ACK policy is separate.
        const adapter = restarted.attachSettingsDeliveryStore(scope);
        const read = await adapter.read();
        expect(read.status).toBe("ok");
        const crossed = {
          ...read.snapshot!,
          pending: {
            ...read.snapshot!.pending!,
            operationId: "00000000-0000-4000-8000-0000000000bb",
          },
        };
        expect(
          await adapter.replace({
            expected: crossed,
            invalidateVerification: false,
          }),
        ).toEqual({ status: "not_written" });
        expect(restarted.snapshot()).toEqual(recorded);
        expect(
          await adapter.replace({
            expected: read.snapshot!,
            invalidateVerification: false,
          }),
        ).toMatchObject({ status: "committed" });
      }
      expect(restarted.snapshot()).toMatchObject({
        status: "ready",
        settings: { computer: { pendingEdit: null } },
      });
    },
  );

  it("C05-09 commits concurrent changes one after another, so neither erases the edit journal", async () => {
    const root = await stateRoot();
    let gate: Promise<void> | null = null;
    const service = new ProductConfigurationService(
      new ProductSettingsStore(
        { root },
        {
          // Holds exactly one commit open while another change arrives.
          beforeCommit: async () => {
            const held = gate;
            gate = null;
            if (held) await held;
          },
        },
      ),
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
    const pendingEdit = {
      operationId: "00000000-0000-4000-8000-0000000000cc",
      workspaceId,
      relativePath: "README.md",
      computerGeneration: added.snapshot.settings.computer.generation,
      submittedAt: "2026-09-16T10:01:00.000Z",
      backend: "go-owner-v2" as const,
      profileId: "33333333-3333-4333-8333-333333333333",
      beforeSha256: "a".repeat(64),
    };
    const general = {
      openAtLaunch: "activity",
      sidebarDefault: "rail",
      activityDetail: "technical",
    } as const;

    const adapter = service.attachSettingsDeliveryStore({
      profileId: pendingEdit.profileId,
      ownerId: "owner-desktop",
    });
    const read = await adapter.read();
    expect(read.status).toBe("ok");
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const journal = adapter.replace({
      expected: read.snapshot!,
      next: {
        backend: pendingEdit.backend,
        operationId: pendingEdit.operationId,
        profileId: pendingEdit.profileId,
        workspaceId,
        relativePath: pendingEdit.relativePath,
        computerGeneration: String(pendingEdit.computerGeneration),
        beforeSHA256: pendingEdit.beforeSha256,
        submittedAt: pendingEdit.submittedAt,
      },
      invalidateVerification: false,
    });
    const preference = service.updateGeneral(general);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [recorded, updated] = await Promise.all([journal, preference]);

    expect(recorded.status).toBe("committed");
    expect(updated.ok).toBe(true);
    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({
      status: "ready",
      settings: { general, computer: { pendingEdit } },
    });
    expect(service.snapshot()).toEqual(restarted.snapshot());
  });

  it("persists truthful ChatGPT readiness without credentials or page content", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const signedOut = await service.recordChatGptObservation({
      state: "signed_out",
    });
    expect(signedOut).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              visited: true,
              configured: false,
              reachable: "reachable",
              verified: null,
              needsAction: "Sign in to ChatGPT in the isolated Next window.",
            },
          },
        },
      },
    });

    const authenticated = await service.recordChatGptObservation({
      state: "authenticated",
      profile: "chatgpt.next-partition/1",
      runtimeGeneration: "persist:farol-next-chatgpt",
      buildId: "a".repeat(64),
      protocol: "chatgpt-page-readiness/1",
    });
    expect(authenticated).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              configured: true,
              reachable: "reachable",
              needsAction: null,
              unavailable: null,
              outcomeUnknown: false,
              verified: {
                profile: "chatgpt.next-partition/1",
                workspaceId: null,
                runtimeGeneration: "persist:farol-next-chatgpt",
                buildId: "a".repeat(64),
                protocol: "chatgpt-page-readiness/1",
                verifiedAt: "2026-09-16T10:00:00.000Z",
              },
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(authenticated.snapshot);

    const saved = await fs.readFile(path.join(root, "config.json"), {
      encoding: "utf8",
    });
    expect(saved).not.toMatch(/cookie|token|conversation|prompt|answer/iu);
  });

  it("persists an outcome-unknown ChatGPT task without permitting a blind green retry", async () => {
    const root = await stateRoot();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await service.initialize();

    const result = await service.recordChatGptObservation({
      state: "outcome_unknown",
    });

    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        status: "ready",
        settings: {
          setup: {
            chatgpt: {
              configured: true,
              reachable: "unknown",
              verified: null,
              outcomeUnknown: true,
              needsAction:
                "Inspect the isolated ChatGPT window before starting another task.",
            },
          },
        },
      },
    });

    const restarted = new ProductConfigurationService(
      new ProductSettingsStore({ root }),
      dependencies(),
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject(result.snapshot);
  });

  it.each(["authenticated", "signed_out"] as const)(
    "automatic sign-in return preserves queued task uncertainty for %s",
    async (state) => {
      const root = await stateRoot();
      const store = new ProductSettingsStore({ root });
      const service = new ProductConfigurationService(store, dependencies());
      await service.initialize();
      const before = service.snapshot();
      if (before.status !== "ready") throw new Error("settings missing");
      let entered!: () => void;
      let release!: () => void;
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const save = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementationOnce(async (...args) => {
        entered();
        await waiting;
        return save(...args);
      });
      const original = service.recordChatGptObservation({
        state: "outcome_unknown",
      });
      await entering;
      // The returning window sees the prior snapshot while the original writer
      // is still pending. Preservation must read inside the serialized turn.
      expect(service.snapshot()).toEqual(before);
      const returned = service.recordChatGptObservation(
        state === "authenticated"
          ? {
              state,
              profile: "chatgpt.next-partition/1",
              runtimeGeneration: "synthetic",
              buildId: "a".repeat(64),
              protocol: "chatgpt-page-readiness/1",
            }
          : { state },
        true,
      );
      release();
      expect((await original).ok).toBe(true);
      expect((await returned).ok).toBe(true);
      const after = service.snapshot();
      expect(after).toMatchObject({
        status: "ready",
        settings: { setup: { chatgpt: { outcomeUnknown: true } } },
      });
      if (after.status !== "ready") throw new Error("settings missing");
      expect(after.settings.computer).toEqual(before.settings.computer);
      expect(after.settings.connectors).toEqual(before.settings.connectors);
      const reopened = new ProductConfigurationService(
        new ProductSettingsStore({ root }),
        dependencies(),
      );
      await reopened.initialize();
      expect(reopened.snapshot()).toEqual(after);
    },
  );

  it("admits bounded workspace list and search actions through the product contract", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.list-workspace",
        workspaceId,
        relativePath: ".",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.search-workspace",
        workspaceId,
        relativePath: ".",
        pattern: "verification",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-list",
        workspaceId,
        relativePath: ".",
        entries: ["README.md", "src/"],
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-search",
        workspaceId,
        relativePath: ".",
        pattern: "verification",
        matches: [
          {
            path: "README.md",
            line: 1,
            text: "Farol Next workspace verification fixture",
            truncated: false,
          },
        ],
        resultLimited: false,
        scanLimited: false,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.list-workspace",
        workspaceId,
        relativePath: "..",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.search-workspace",
        workspaceId,
        relativePath: ".",
        pattern: "line\nsecond line",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-list",
        workspaceId,
        relativePath: ".",
        entries: ["../escape"],
        truncated: false,
      }).success,
    ).toBe(false);

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.update-commands",
        commands: "verification",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.run-git-status",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.run-git-head",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.run-git-status",
        workspaceId,
        command: "sh -c whoami",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-command",
        workspaceId,
        command: "git.status",
        exitCode: 0,
        stdout: "## main\n",
        stderr: "",
        outputBytes: 8,
        network: "none",
        coverage: "tracked-files-only",
        layout: "primary",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-command",
        workspaceId,
        command: "git.head",
        exitCode: 0,
        stdout: `${"a".repeat(40)}\n`,
        stderr: "",
        outputBytes: 41,
        network: "none",
        coverage: "head-commit",
        layout: "linked-worktree",
      }).success,
    ).toBe(true);
  });

  it("admits a reviewed guarded edit and content-free mutation receipt", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const operationId = "00000000-0000-4000-8000-000000000002";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.prepare-workspace-edit",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.apply-workspace-edit",
        operationId,
        oldText: "before",
        newText: "after",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "computer.cancel-workspace-edit",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-edit-preview",
        operationId,
        workspaceId,
        relativePath: "README.md",
        bytes: 7,
        beforeSha256: "a".repeat(64),
        expiresAt: "2026-09-16T10:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "computer.workspace-mutation",
        operationId,
        workspaceId,
        relativePath: "README.md",
        operation: "edit",
        bytes: 6,
        replacements: 1,
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
        resultRetention: "durable",
        redelivered: false,
      }).success,
    ).toBe(true);
  });

  it("separates ChatGPT context preparation from one-shot submission", () => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const operationId = "00000000-0000-4000-8000-000000000002";

    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.prepare-readonly-task",
        workspaceId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.submit-readonly-task",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.cancel-readonly-task",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.recover-task-result",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.ack-task-result",
        operationId,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "chatgpt.reset-conversation",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task-preview",
        operationId,
        workspaceId,
        workspaceLabel: "Owner workspace",
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        excludedPaths: ["private"],
        expiresAt: "2026-09-16T10:10:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task",
        operationId,
        state: "completed",
        code: null,
        workspaceId,
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        deltaCount: 2,
        observedCharacters: 84,
        conversationContinuity: "retained",
        redelivered: false,
        deliveryAckRequired: true,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.task-recovery",
        operationId,
        taskKind: "readonly",
        state: "outcome_unknown",
        code: "CHATGPT_TASK_INTERRUPTED_AFTER_INTENT",
        deltaCount: 0,
        observedCharacters: 0,
        attachmentCount: 0,
        totalBytes: 0,
        stagingCleanup: null,
        conversationContinuity: "review_required",
        redelivered: true,
        deliveryAckRequired: true,
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.conversation-reset",
        state: "new",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "chatgpt.readonly-task",
        state: "completed",
        code: null,
        workspaceId,
        relativePath: "README.md",
        bytes: 42,
        contextCharacters: 42,
        contextLimit: 24_000,
        contextTruncated: false,
        deltaCount: 2,
        observedCharacters: 84,
        conversationContinuity: "retained",
        redelivered: false,
        deliveryAckRequired: true,
      }).success,
    ).toBe(false);
  });

  it("admits bounded native host setup commands and content-free evidence", () => {
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.select-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.verify-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.remove-codex",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "host.run-codex-smoke",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-probe",
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        capabilities: {
          dynamicTools: true,
          correlatedToolCalls: true,
          descendantObservation: true,
          collabObservation: true,
          compaction: true,
        },
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-probe",
        executablePath: "/Users/example/bin/codex",
        version: "0.153.4",
        protocol: "codex-app-server/v2",
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
        capabilities: {
          dynamicTools: true,
          correlatedToolCalls: true,
          descendantObservation: true,
          collabObservation: true,
          compaction: true,
        },
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "host.codex-live",
        model: "gpt-6-astra",
        threadState: "completed",
        dynamicToolCalls: 1,
        executableSha256: "a".repeat(64),
        schemaSha256: "b".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("admits connector setup commands and only content-free evidence", () => {
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.select-client",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId: "tunnel_farol_next",
        runtimeKey: "sk-runtime-example-1234567890",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.start",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.repair",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.stop",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.check-attachment",
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationCommandSchema.safeParse({
        kind: "connector.configure",
        tunnelId: "not valid whitespace",
        runtimeKey: "sk-runtime-example-1234567890",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "connector.client-probe",
        version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
        protocol: "openai-tunnel-client/v1",
        executableSha256: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration: "b".repeat(64),
        computerGeneration: 7,
        buildId: "c".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration: "b".repeat(64),
        computerGeneration: 7,
        buildId: "c".repeat(64),
        runtimeKey: "must-not-escape",
      }).success,
    ).toBe(false);
    expect(
      ProductConfigurationEvidenceSchema.safeParse({
        kind: "connector.attachment",
        runtimeGeneration: "b".repeat(64),
        computerGeneration: 7,
        workspaceId: "00000000-0000-4000-8000-000000000001",
        challengeSha256: "c".repeat(64),
        receiptSha256: "d".repeat(64),
      }).success,
    ).toBe(true);
  });
});

describe("owner-selected embedded app binding", () => {
  it("preserves connector unknown state across reload against settings and stop changes", async () => {
    const root = await stateRoot();
    const store = new ProductSettingsStore({ root });
    const seed = new ProductConfigurationService(store, dependencies());
    await seed.initialize();
    const client = {
      executablePath: "/opt/homebrew/bin/tunnel-client",
      executableSha256: "a".repeat(64),
      version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
      protocol: "openai-tunnel-client/v1",
    };
    expect((await seed.recordSecureMcpTunnelClient(client)).ok).toBe(true);
    expect(
      (await seed.configureSecureMcpTunnel({ tunnelId: "tunnel_farol_next" }))
        .ok,
    ).toBe(true);
    expect((await seed.recordSecureMcpCredential("stored")).ok).toBe(true);
    const current = seed.snapshot();
    if (current.status !== "ready") throw new Error("settings missing");
    expect(
      (
        await seed.recordSecureMcpRuntime({
          state: "outcome_unknown",
          runtimeGeneration: "b".repeat(64),
          computerGeneration: current.settings.computer.generation,
          buildId: "c".repeat(64),
        })
      ).ok,
    ).toBe(true);
    const reloaded = new ProductConfigurationService(store, dependencies());
    await reloaded.initialize();
    const before = reloaded.snapshot();
    for (const result of [
      await reloaded.configureSecureMcpTunnel({ tunnelId: "replacement" }),
      await reloaded.recordSecureMcpTunnelClient({
        ...client,
        executableSha256: "d".repeat(64),
      }),
      await reloaded.recordSecureMcpCredential("missing"),
      await reloaded.recordSecureMcpStopped(),
      await reloaded.renameComputer("Another name"),
    ])
      expect(result).toMatchObject({
        ok: false,
        error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
      });
    expect(reloaded.snapshot()).toEqual(before);
    if (before.status !== "ready") throw new Error("settings missing");
    const independent = await reloaded.updateGeneral(before.settings.general);
    expect(independent.ok).toBe(true);
    if (independent.snapshot.status !== "ready")
      throw new Error("settings missing");
    expect(independent.snapshot.settings.connectors.secureMcp.runtime).toEqual(
      before.settings.connectors.secureMcp.runtime,
    );
    expect(independent.snapshot.settings.setup.connect.outcomeUnknown).toBe(
      true,
    );
    await store.save({
      ...independent.snapshot.settings,
      connectors: {
        ...independent.snapshot.settings.connectors,
        secureMcp: {
          ...independent.snapshot.settings.connectors.secureMcp,
          runtime: null,
        },
      },
    });
    const setupOnly = new ProductConfigurationService(store, dependencies());
    await setupOnly.initialize();
    expect(
      await setupOnly.configureSecureMcpTunnel({ tunnelId: "replacement" }),
    ).toMatchObject({
      ok: false,
      error: "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
    });
  });
  it("preserves selection through reload but invalidates it after connector generation changes", async () => {
    const root = await stateRoot();
    const store = new ProductSettingsStore({ root });
    const service = new ProductConfigurationService(store, dependencies());
    await service.initialize();
    await service.configureSecureMcpTunnel({ tunnelId: "new-fixture" });
    let snapshot = service.snapshot();
    if (snapshot.status !== "ready") throw new Error("settings missing");
    const binding = {
      name: "NEW fixture",
      tunnelId: "new-fixture",
      connectorGeneration: snapshot.settings.connectors.secureMcp.generation,
    };
    expect((await service.selectSecureMcpChatGptApp(binding)).ok).toBe(true);
    const reloaded = new ProductConfigurationService(store, dependencies());
    await reloaded.initialize();
    snapshot = reloaded.snapshot();
    if (snapshot.status !== "ready") throw new Error("settings missing");
    expect(snapshot.settings.connectors.secureMcp.chatgptApp).toEqual(binding);
    const revision = snapshot.settings.revision;
    expect(
      await reloaded.selectSecureMcpChatGptApp({
        ...binding,
        connectorGeneration: binding.connectorGeneration + 1,
      }),
    ).toMatchObject({
      ok: false,
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    expect(reloaded.snapshot()).toEqual(snapshot);
    await reloaded.configureSecureMcpTunnel({ tunnelId: "replacement" });
    expect(await reloaded.selectSecureMcpChatGptApp(binding)).toMatchObject({
      ok: false,
      error: "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
    });
    const replacement = reloaded.snapshot();
    if (replacement.status !== "ready") throw new Error("settings missing");
    expect(replacement.settings.revision).toBe(revision + 1);
  });
  it("refuses changing the target after an unknown submission without clearing uncertainty", async () => {
    const store = new ProductSettingsStore({ root: await stateRoot() });
    const seed = new ProductConfigurationService(store, dependencies());
    await seed.initialize();
    await seed.configureSecureMcpTunnel({ tunnelId: "new-fixture" });
    const snapshot = seed.snapshot();
    if (snapshot.status !== "ready") throw new Error("settings missing");
    await store.save({
      ...snapshot.settings,
      setup: {
        ...snapshot.settings.setup,
        connect: { ...snapshot.settings.setup.connect, outcomeUnknown: true },
      },
    });
    const service = new ProductConfigurationService(store, dependencies());
    await service.initialize();
    const before = service.snapshot();
    expect(
      await service.selectSecureMcpChatGptApp({
        name: "NEW fixture",
        tunnelId: "new-fixture",
        connectorGeneration: snapshot.settings.connectors.secureMcp.generation,
      }),
    ).toMatchObject({
      ok: false,
      error: "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
    });
    expect(service.snapshot()).toEqual(before);
  });
});
