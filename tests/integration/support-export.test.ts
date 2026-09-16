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
    await configuration.addReadonlyWorkspace({
      root: "/Users/private/WORKSPACE-CANARY",
      label: "LABEL-CANARY",
    });

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
      configuration: configuration.snapshot(),
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
      tasks: { total: 2, running: 1, waiting: 1, failed: 0 },
    });

    expect(report).toMatchObject({
      schema: 1,
      kind: "farol_next_support",
      build: {
        buildId: "c".repeat(64),
        sourceCommit: "a".repeat(40),
      },
      configuration: {
        status: "ready",
        revision: 3,
        computer: {
          workspaceCount: 1,
          readWorkspaceCount: 1,
          writeWorkspaceCount: 0,
          exclusionCount: 0,
        },
      },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(
      /OWNER-TOKEN-CANARY|WORKSPACE-CANARY|LABEL-CANARY|00000000-0000-4000/u,
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
});
