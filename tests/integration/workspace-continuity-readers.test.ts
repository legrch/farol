import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../src/apps/desktop/product-configuration";
import {
  ApprovedProductWorkspaceSchema,
  ProductSettingsSchema,
  type ProductSettings,
} from "../../src/pkg/product-settings/contract";
import { ownerSettingsComputerApproval } from "../../src/modules/computer/infra/repo/owner-settings-computer-approval";

// Synthetic approval only: no real workspace, provider, native picker or Go
// transition is involved. A parsed record remains untrusted persisted data.
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roots: string[] = [];

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-continuity-readers-")),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const store = new ProductSettingsStore({ root });
  await new ProductConfigurationService(store).initialize();
  const settings = await store.loadExisting();
  if (settings === null) throw new Error("fixture Settings missing");
  return { root, store, settings, file: path.join(root, "config.json") };
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

function withWorkspace(settings: ProductSettings, continuity: boolean) {
  const candidate = structuredClone(settings);
  const workspace = {
    workspaceId,
    root: "/synthetic/approved",
    label: "synthetic reader fixture",
    access: "read" as const,
    excludedPaths: [],
    rootIdentity: { device: "17", inode: "18446744073709551615" },
    ...(continuity
      ? {
          continuity: {
            schema: "farol.workspace-continuity/1" as const,
            computerId: settings.computer.computerId,
            workspaceId,
            root: "/synthetic/approved",
            filesystem: "apfs" as const,
            volumeUuid: "11111111-2222-3333-4444-555555555555",
            fileId: "18446744073709551615",
            birthSeconds: "9223372036854775807",
            birthNanoseconds: "999999999",
            enrollment: {
              operationId: otherId,
              selectedAt: "2026-11-10T08:00:00.000Z",
              policySha256: "a".repeat(64),
            },
          },
        }
      : {}),
  };
  candidate.computer.workspaces = [workspace];
  return ProductSettingsSchema.parse(candidate);
}

function corrupted(
  valid: ProductSettings,
  mutate: (
    workspace: ProductSettings["computer"]["workspaces"][number],
  ) => void,
) {
  const candidate = structuredClone(valid);
  mutate(candidate.computer.workspaces[0]!);
  return candidate;
}

describe("optional workspace continuity reader (non-authorizing)", () => {
  it("accepts legacy absence and roundtrips without inventing continuity", async () => {
    const f = await fixture();
    const legacy = withWorkspace(f.settings, false);
    expect("continuity" in legacy.computer.workspaces[0]!).toBe(false);
    await f.store.save(legacy); // Synthetic fixture seed, not a new product writer.
    const recovered = await f.store.loadExisting();
    expect(recovered).toEqual(legacy);
    expect("continuity" in recovered!.computer.workspaces[0]!).toBe(false);
  });

  it("reads and serializes exact 64-bit evidence losslessly", async () => {
    const f = await fixture();
    const valid = withWorkspace(f.settings, true);
    const parsed = ProductSettingsSchema.parse(valid);
    const evidence = parsed.computer.workspaces[0]!.continuity!;
    expect(evidence.fileId).toBe("18446744073709551615");
    expect(evidence.birthSeconds).toBe("9223372036854775807");
    expect(evidence.birthNanoseconds).toBe("999999999");
    expect(
      ProductSettingsSchema.parse(JSON.parse(JSON.stringify(valid))),
    ).toEqual(valid);
    await f.store.save(valid); // Test-owned disposable config only.
    const before = await fs.readFile(f.file);
    expect(await f.store.loadExisting()).toEqual(valid);
    expect(await fs.readFile(f.file)).toEqual(before);
  });

  it("keeps continuity unchanged through an unrelated existing Settings edit", async () => {
    const f = await fixture();
    const valid = withWorkspace(f.settings, true);
    await f.store.save(valid);
    const service = new ProductConfigurationService(f.store);
    await service.initialize();
    const nextGeneral = {
      ...valid.general,
      sidebarDefault: valid.general.sidebarDefault === "full" ? "rail" : "full",
    };
    expect(await service.updateGeneral(nextGeneral)).toMatchObject({
      ok: true,
    });
    const after = await f.store.loadExisting();
    expect(after?.revision).toBe(valid.revision + 1);
    expect(after?.general).toEqual(nextGeneral);
    expect(after?.computer.workspaces[0]!.continuity).toEqual(
      valid.computer.workspaces[0]!.continuity,
    );
  });

  it("accepts canonical zero birth time and the smallest positive file ID", async () => {
    const f = await fixture();
    const candidate = withWorkspace(f.settings, true);
    const workspace = candidate.computer.workspaces[0]!;
    workspace.rootIdentity!.inode = "1";
    workspace.continuity!.fileId = "1";
    workspace.continuity!.birthSeconds = "0";
    workspace.continuity!.birthNanoseconds = "0";
    expect(ProductSettingsSchema.safeParse(candidate).success).toBe(true);
    const unboundLegacy = withWorkspace(f.settings, false);
    Reflect.deleteProperty(
      unboundLegacy.computer.workspaces[0]!,
      "rootIdentity",
    );
    expect(ProductSettingsSchema.safeParse(unboundLegacy).success).toBe(true);
  });

  it("rejects mismatched scope, missing binding and every malformed optional value", async () => {
    const f = await fixture();
    const valid = withWorkspace(f.settings, true);
    type Case = readonly [
      string,
      (workspace: ProductSettings["computer"]["workspaces"][number]) => void,
    ];
    const cases: ReadonlyArray<Case> = [
      ["null", (w) => Reflect.set(w, "continuity", null)],
      [
        "newer version",
        (w) =>
          Reflect.set(w.continuity!, "schema", "farol.workspace-continuity/2"),
      ],
      [
        "unknown continuity key",
        (w) => Reflect.set(w.continuity!, "privilege", true),
      ],
      [
        "unknown enrollment key",
        (w) => Reflect.set(w.continuity!.enrollment, "grant", true),
      ],
      [
        "null enrollment",
        (w) => Reflect.set(w.continuity!, "enrollment", null),
      ],
      [
        "missing continuity field",
        (w) => Reflect.deleteProperty(w.continuity!, "volumeUuid"),
      ],
      [
        "missing enrollment field",
        (w) => Reflect.deleteProperty(w.continuity!.enrollment, "operationId"),
      ],
      [
        "incorrect workspace ID",
        (w) => Reflect.set(w.continuity!, "workspaceId", otherId),
      ],
      [
        "incorrect root",
        (w) => Reflect.set(w.continuity!, "root", "/synthetic/other"),
      ],
      [
        "changed enclosing root",
        (w) => Reflect.set(w, "root", "/synthetic/other"),
      ],
      [
        "missing root identity",
        (w) => Reflect.deleteProperty(w, "rootIdentity"),
      ],
      [
        "different bound inode",
        (w) => Reflect.set(w.rootIdentity!, "inode", "7"),
      ],
      [
        "noncanonical bound inode",
        (w) => Reflect.set(w.rootIdentity!, "inode", "018446744073709551615"),
      ],
      [
        "wrong computer",
        (w) => Reflect.set(w.continuity!, "computerId", otherId),
      ],
      [
        "non-v4 UUID",
        (w) =>
          Reflect.set(
            w.continuity!,
            "workspaceId",
            "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
          ),
      ],
      [
        "uppercase UUID",
        (w) =>
          Reflect.set(
            w.continuity!,
            "computerId",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          ),
      ],
      [
        "invalid filesystem",
        (w) => Reflect.set(w.continuity!, "filesystem", "ext4"),
      ],
      [
        "zero volume",
        (w) =>
          Reflect.set(
            w.continuity!,
            "volumeUuid",
            "00000000-0000-0000-0000-000000000000",
          ),
      ],
      [
        "uppercase volume",
        (w) =>
          Reflect.set(
            w.continuity!,
            "volumeUuid",
            "AAAAAAAA-2222-3333-4444-555555555555",
          ),
      ],
      [
        "fileId as number",
        (w) => Reflect.set(w.continuity!, "fileId", 18446744073709551615),
      ],
      ["fileId zero", (w) => Reflect.set(w.continuity!, "fileId", "0")],
      [
        "fileId leading zeros",
        (w) => Reflect.set(w.continuity!, "fileId", "0001"),
      ],
      [
        "fileId overflow",
        (w) => Reflect.set(w.continuity!, "fileId", "18446744073709551616"),
      ],
      ["fileId sign", (w) => Reflect.set(w.continuity!, "fileId", "+1")],
      ["fileId fraction", (w) => Reflect.set(w.continuity!, "fileId", "1.0")],
      [
        "fileId exponential",
        (w) => Reflect.set(w.continuity!, "fileId", "1e2"),
      ],
      [
        "birthSeconds number",
        (w) => Reflect.set(w.continuity!, "birthSeconds", 1700000000),
      ],
      [
        "birthSeconds negative",
        (w) => Reflect.set(w.continuity!, "birthSeconds", "-1"),
      ],
      [
        "birthSeconds leading zero",
        (w) => Reflect.set(w.continuity!, "birthSeconds", "01"),
      ],
      [
        "birthSeconds overflow",
        (w) =>
          Reflect.set(w.continuity!, "birthSeconds", "9223372036854775808"),
      ],
      [
        "birthNanoseconds number",
        (w) => Reflect.set(w.continuity!, "birthNanoseconds", 1),
      ],
      [
        "birthNanoseconds leading zero",
        (w) => Reflect.set(w.continuity!, "birthNanoseconds", "01"),
      ],
      [
        "birthNanoseconds overflow",
        (w) => Reflect.set(w.continuity!, "birthNanoseconds", "1000000000"),
      ],
      [
        "invalid selectedAt",
        (w) =>
          Reflect.set(
            w.continuity!.enrollment,
            "selectedAt",
            "2026-11-10T08:00:00Z",
          ),
      ],
      [
        "wrong operation ID",
        (w) => Reflect.set(w.continuity!.enrollment, "operationId", "bad"),
      ],
      [
        "uppercase policy digest",
        (w) =>
          Reflect.set(w.continuity!.enrollment, "policySha256", "A".repeat(64)),
      ],
    ];
    for (const [name, mutate] of cases) {
      const candidate = corrupted(valid, mutate);
      expect(ProductSettingsSchema.safeParse(candidate).success, name).toBe(
        false,
      );
    }
    expect(
      ApprovedProductWorkspaceSchema.safeParse({
        ...valid.computer.workspaces[0],
        bogus: true,
      }).success,
    ).toBe(false);
  });

  it("refuses corrupt continuity without rewriting or silently removing its bytes", async () => {
    const f = await fixture();
    const valid = withWorkspace(f.settings, true);
    await f.store.save(valid);
    const broken = corrupted(valid, (w) => {
      Reflect.set(w.continuity!, "fileId", "18446744073709551616");
    });
    const bytes = Buffer.from(`${JSON.stringify(broken, null, 2)}\n`);
    await fs.writeFile(f.file, bytes);
    const before = await fs.lstat(f.file, { bigint: true });
    await expect(f.store.loadExisting()).rejects.toThrow("SETTINGS_CORRUPT");
    expect(await fs.readFile(f.file)).toEqual(bytes);
    const after = await fs.lstat(f.file, { bigint: true });
    for (const field of [
      "dev",
      "ino",
      "mode",
      "uid",
      "gid",
      "size",
      "mtimeNs",
      "ctimeNs",
    ] as const)
      expect(after[field]).toBe(before[field]);
  });

  it("cannot turn parsed continuity into a new approval, access check or attachment", async () => {
    const f = await fixture();
    const legacy = withWorkspace(f.settings, false);
    const valid = withWorkspace(f.settings, true);
    expect(ownerSettingsComputerApproval(valid, 0)).toEqual(
      ownerSettingsComputerApproval(legacy, 0),
    );
    expect(valid.computer.workspaces[0]!.accessCheck).toBeUndefined();
    expect(valid.connectors.secureMcp.attachment).toBeNull();
    await f.store.save(valid);
    const service = new ProductConfigurationService(f.store);
    await service.initialize();
    const mismatch = await service.recordFolderAccessCheck(
      workspaceId,
      valid.computer.generation,
      "a".repeat(64),
      { device: "999", inode: "18446744073709551615" },
      true,
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: "WORKSPACE_ROOT_CHANGED",
    });
    const persisted = await f.store.loadExisting();
    expect(persisted!.computer.workspaces[0]!.accessCheck).toBeUndefined();
    expect(persisted!.connectors.secureMcp.attachment).toBeNull();
  });
});
