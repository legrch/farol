import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import {
  nextContinuitySettings,
  workspaceConsentDigest,
  type ContinuityWriteIntent,
} from "../../src/apps/desktop/workspace-continuity-writer";

// Synthetic decisions and receipts ONLY. No external folder, native picker,
// authority, provider or actual Settings publication is exercised here.
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const firstEnrollment = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const temporaryRoots: string[] = [];
async function settings(): Promise<ProductSettings> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-c4-settings-")),
  );
  temporaryRoots.push(root);
  await fs.chmod(root, 0o700);
  const store = new ProductSettingsStore({ root });
  await new ProductConfigurationService(store).initialize();
  const loaded = await store.loadExisting();
  if (loaded === null) throw new Error("SYNTHETIC_SETTINGS_MISSING");
  return loaded;
}
afterEach(async () => {
  for (const root of temporaryRoots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

function fixture(base: ProductSettings, enrolled = false) {
  const source = structuredClone(base);
  source.computer.workspaces = [
    {
      workspaceId,
      root: "/synthetic/approved",
      label: "C4 isolated continuity",
      access: "read",
      excludedPaths: [],
      rootIdentity: { device: "17", inode: "42" },
    },
  ];
  const digest = workspaceConsentDigest(source);
  const input: ContinuityWriteIntent = {
    operationId,
    workspaceId,
    expectedRevision: source.revision,
    expectedGeneration: source.computer.generation,
    expectedConsentSha256: digest,
    rootIdentity: { device: "99", inode: "42" },
    continuity: {
      schema: "farol.workspace-continuity/1",
      computerId: source.computer.computerId,
      workspaceId,
      root: "/synthetic/approved",
      filesystem: "apfs",
      volumeUuid: "11111111-2222-3333-4444-555555555555",
      fileId: "42",
      birthSeconds: "1700000000",
      birthNanoseconds: "0",
      enrollment: {
        operationId: enrolled ? firstEnrollment : operationId,
        selectedAt: "2026-11-10T08:00:00.000Z",
        policySha256: "a".repeat(64),
      },
    },
  };
  if (enrolled)
    source.computer.workspaces[0]!.continuity = structuredClone(
      input.continuity,
    );
  return { source: ProductSettingsSchema.parse(source), input };
}

describe("strict sole-writer continuation proposal", () => {
  it("preserves owner-consent and historical enrollment while rebinding native device", async () => {
    const { source, input } = fixture(await settings(), true);
    const next = nextContinuitySettings(source, input);
    expect(next).not.toBeNull();
    expect(next?.computer.workspaces[0]?.rootIdentity).toEqual({
      device: "99",
      inode: "42",
    });
    expect(
      next?.computer.workspaces[0]?.continuity?.enrollment.operationId,
    ).toBe(firstEnrollment);
    expect(next?.revision).toBe(source.revision + 1);
    expect(next?.computer.generation).toBe(source.computer.generation + 1);
    expect(next?.setup.computer.verified).toBeNull();
    expect(workspaceConsentDigest(next!)).toBe(workspaceConsentDigest(source));
  });
  it("refuses changed owner policy, UUID, inode and stale revision", async () => {
    const { source, input } = fixture(await settings(), true);
    const stale = { ...input, expectedRevision: input.expectedRevision - 1 };
    expect(nextContinuitySettings(source, stale)).toBeNull();
    const wrongFile = { ...input, rootIdentity: { device: "99", inode: "43" } };
    expect(nextContinuitySettings(source, wrongFile)).toBeNull();
    const changedUUID = structuredClone(input);
    changedUUID.continuity.volumeUuid = "aaaaaaaa-2222-3333-4444-555555555555";
    expect(nextContinuitySettings(source, changedUUID)).toBeNull();
    const changedAccess = structuredClone(source);
    changedAccess.computer.workspaces[0]!.access = "write";
    expect(nextContinuitySettings(changedAccess, input)).toBeNull();
  });
  it("requires explicit original operation on first enrollment", async () => {
    const { source, input } = fixture(await settings());
    const mismatched = structuredClone(input);
    mismatched.continuity.enrollment.operationId = firstEnrollment;
    expect(nextContinuitySettings(source, mismatched)).toBeNull();
    expect(nextContinuitySettings(source, input)).not.toBeNull();
  });
});
