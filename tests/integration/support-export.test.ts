import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSupportExport,
  writeSupportExport,
} from "../../src/apps/desktop/support-export";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-support-export-"),
  );
  roots.push(root);
  return root;
}

describe("content-free support export", () => {
  it("reports the exact build and readiness without owner content", async () => {
    const root = await temporaryRoot();
    let id = 0;
    const configuration = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "state") }),
      {
        now: () => "2026-09-16T10:00:00.000Z",
        id: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      },
    );
    await configuration.initialize();
    await configuration.renameComputer("OWNER-TOKEN-CANARY");
    const added = await configuration.addReadonlyWorkspace({
      root: "/Users/private/WORKSPACE-CANARY",
      label: "LABEL-CANARY",
    });
    if (added.snapshot.status !== "ready") throw new Error("settings missing");
    const workspace = added.snapshot.settings.computer.workspaces[0];
    if (!workspace) throw new Error("workspace missing");
    const verifiedComputer = await configuration.recordComputerVerification(
      workspace.workspaceId,
      {
        profile: "computer.local.readonly/1",
        runtimeGeneration: "runtime-1",
        buildId: "c".repeat(64),
        protocol: "readonly-workspace/1",
      },
      { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
    );
    if (verifiedComputer.snapshot.status !== "ready")
      throw new Error("verified settings missing");
    // Identity binding changes the effective approval policy. Native-agent
    // evidence must qualify the resulting current generation, not the earlier
    // unbound-folder generation.
    const computerGeneration =
      verifiedComputer.snapshot.settings.computer.generation;
    await configuration.recordCodexHost({
      executablePath: "/Users/private/CODEX-CANARY",
      executableSha256: "d".repeat(64),
      version: "0.153.4",
      protocol: "codex-app-server/v2",
      schemaSha256: "e".repeat(64),
      buildId: "c".repeat(64),
    });
    await configuration.recordCodexHostLiveVerification({
      model: "gpt-6-astra",
      executableSha256: "d".repeat(64),
      schemaSha256: "e".repeat(64),
      buildId: "c".repeat(64),
    });
    await configuration.recordCodexAgentVerification({
      model: "gpt-6-astra",
      executableSha256: "d".repeat(64),
      schemaSha256: "e".repeat(64),
      buildId: "c".repeat(64),
      workspaceId: workspace.workspaceId,
      computerGeneration,
      transport: "codex-native-agent/spawn-prompt-sha256-v1",
      authorityRole: "critic",
      hostRole: "HOST-ROLE-CANARY",
      delegationDigest: "f".repeat(64),
      parentThreadSha256: "1".repeat(64),
      childThreadSha256: "2".repeat(64),
      boundedRunning: true,
      modelTurnsSubmitted: 1,
      fallbackAllowed: false,
      descendantCount: 0,
      resultRefProtocol: "codex-app-server",
      resultRetention: "durable",
      parentDelivery: "acknowledged",
      workspaceEnforcement: "verified",
    });

    const configurationSnapshot = configuration.snapshot();
    if (configurationSnapshot.status !== "ready") {
      throw new Error("settings missing");
    }
    const report = createSupportExport({
      generatedAt: "2026-09-16T11:00:00.000Z",
      build: {
        schema: 1,
        product: "Farol Next Preview",
        version: "0.1.0-preview.0",
        bundleId: "local.farol.next.preview",
        updateChannel: "local-preview-only",
        builtAt: "2026-09-16T09:00:00.000Z",
        sourceCommit: "a".repeat(40),
        sourceTreeDigest: "b".repeat(64),
        sourceDirty: false,
        buildId: "c".repeat(64),
      },
      configuration: configurationSnapshot,
      runtime: {
        state: "ready",
        errorCode: null,
        identity: "farol-next-preview-runtime",
      },
      capabilities: {
        nativeFilesystem: true,
        nativeAgent: false,
        liveProvider: false,
      },
      embedded: { node: "24.20.0", electron: "44.4.1", chrome: "150.0.0.0" },
      tasks: {
        total: 2,
        running: 1,
        waiting: 1,
        failed: 0,
        countsFrom: "current",
      },
    });

    expect(report).toMatchObject({
      schema: 2,
      kind: "farol_next_support",
      build: {
        buildId: "c".repeat(64),
        sourceCommit: "a".repeat(40),
      },
      configuration: {
        status: "ready",
        revision: configurationSnapshot.settings.revision,
        computer: {
          workspaceCount: 1,
          readWorkspaceCount: 1,
          writeWorkspaceCount: 0,
          exclusionCount: 0,
        },
      },
      nativeAgentVerification: {
        status: "verified",
        evidence: {
          model: "gpt-6-astra",
          authorityRole: "critic",
          lineage: "verified",
          taskGrantContinuity: "verified",
          boundedRunning: true,
          modelTurnsSubmitted: 1,
          fallbackAllowed: false,
          descendantCount: 0,
          resultRetention: "durable",
          parentDelivery: "acknowledged",
          workspaceEnforcement: "verified",
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(
      /OWNER-TOKEN-CANARY|WORKSPACE-CANARY|LABEL-CANARY|CODEX-CANARY|HOST-ROLE-CANARY|00000000-0000-4000/u,
    );

    const target = path.join(root, "Farol-Next-Support.json");
    const receipt = await writeSupportExport(target, report);
    expect(receipt).toMatchObject({
      fileName: "Farol-Next-Support.json",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual(report);
  });

  it("refuses to replace a symbolic-link destination", async () => {
    const root = await temporaryRoot();
    const real = path.join(root, "real.json");
    const target = path.join(root, "support.json");
    await fs.writeFile(real, "preserve\n", { mode: 0o600 });
    await fs.symlink(real, target);

    await expect(
      writeSupportExport(target, {
        schema: 1,
        kind: "farol_next_support",
      }),
    ).rejects.toThrow("SUPPORT_EXPORT_UNSAFE");
    await expect(fs.readFile(real, "utf8")).resolves.toBe("preserve\n");
  });

  describe("P07 bounded export", () => {
    function input(overrides: Record<string, unknown> = {}) {
      return {
        generatedAt: "2026-09-16T11:00:00.000Z",
        build: {
          schema: 1 as const,
          product: "Farol Next Preview" as const,
          version: "0.1.0-preview.0",
          bundleId: "local.farol.next.preview" as const,
          updateChannel: "local-preview-only" as const,
          builtAt: "2026-09-16T09:00:00.000Z",
          sourceCommit: "a".repeat(40),
          sourceTreeDigest: "b".repeat(64),
          sourceDirty: false,
          buildId: "c".repeat(64),
        },
        configuration: {
          status: "error" as const,
          error: "SETTINGS_READ_FAILED" as const,
        },
        runtime: {
          state: "failed" as const,
          errorCode: "process_exited" as const,
          identity: null,
        },
        capabilities: {
          nativeFilesystem: true,
          nativeAgent: false,
          liveProvider: true,
        },
        embedded: { node: "24.20.0", electron: "44.4.1", chrome: "150.0.0.0" },
        tasks: {
          total: 1,
          running: 1,
          waiting: 0,
          failed: 1,
          countsFrom: "before_runtime_exit" as const,
        },
        ...overrides,
      };
    }

    it("OBS-F3/F4 refuses input it does not know, including provider diagnostics", () => {
      expect(() =>
        createSupportExport(
          input({
            diagnostics: { lastRefusalCode: "X", lastInputKinds: ["message"] },
          }) as never,
        ),
      ).toThrow("SUPPORT_EXPORT_INPUT_INVALID");
    });

    it("OBS-F4 projects general settings by allowlist", async () => {
      const root = await temporaryRoot();
      const configuration = new ProductConfigurationService(
        new ProductSettingsStore({ root: path.join(root, "state") }),
      );
      await configuration.initialize();
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") throw new Error("settings missing");
      const smuggled = {
        ...snapshot,
        settings: {
          ...snapshot.settings,
          general: { ...snapshot.settings.general, token: "GENERAL-CANARY" },
        },
      };

      const report = createSupportExport(
        input({ configuration: smuggled }) as never,
      );
      expect(JSON.stringify(report)).not.toContain("GENERAL-CANARY");
      expect(report.configuration).toMatchObject({
        general: snapshot.settings.general,
      });
    });

    it("OBS-F5/F6 carries the embedded runtime and says where counts come from", () => {
      expect(createSupportExport(input())).toMatchObject({
        capabilities: { liveProvider: true },
        embedded: { node: "24.20.0", electron: "44.4.1", chrome: "150.0.0.0" },
        tasks: { running: 1, failed: 1, countsFrom: "before_runtime_exit" },
      });
    });

    it("OBS-F4/F8 refuses an oversize report and a failing sink without leaving files", async () => {
      const root = await temporaryRoot();
      await expect(
        writeSupportExport(path.join(root, "big.json"), {
          padding: "x".repeat(512 * 1_024),
        }),
      ).rejects.toThrow("SUPPORT_EXPORT_TOO_LARGE");
      await expect(fs.readdir(root)).resolves.toEqual([]);

      const locked = path.join(root, "locked");
      await fs.mkdir(locked, { mode: 0o500 });
      try {
        await expect(
          writeSupportExport(
            path.join(locked, "support.json"),
            createSupportExport(input()),
          ),
        ).rejects.toThrow();
        await expect(fs.readdir(locked)).resolves.toEqual([]);
      } finally {
        await fs.chmod(locked, 0o700);
      }
    });
  });
});
