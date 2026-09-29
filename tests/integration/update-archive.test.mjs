import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPackageContent } from "../../tooling/verify-package-content.mjs";
import {
  createUpdatePackageVerifier,
  PackageVerificationError,
} from "../../src/modules/release/infra/native/update-package-verifier";

const helper = path.resolve(
  import.meta.dirname,
  "../../resources/native/update_archive.py",
);
const makeZip = `
import json, stat, sys, zipfile
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for entry in entries:
        info = zipfile.ZipInfo(entry["name"])
        info.create_system = 3
        kind = entry.get("kind", "file")
        bits = {"file": stat.S_IFREG | 0o644, "directory": stat.S_IFDIR | 0o755,
                "symlink": stat.S_IFLNK | 0o777, "device": stat.S_IFCHR | 0o600}[kind]
        info.external_attr = bits << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, (entry.get("data", "") * entry.get("repeat", 1)).encode())
`;
const app = "Farol Next Preview.app";
const base = [
  { name: "artifact.json", data: "{}" },
  { name: `${app}/Contents/Info.plist`, data: "plist" },
];

async function fixture(entries, run) {
  const parent = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-archive-test-"),
  );
  const archive = path.join(parent, "archive.zip");
  const stage = path.join(parent, "stage");
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const made = spawnSync(
      "/usr/bin/python3",
      ["-I", "-S", "-B", "-c", makeZip, archive, JSON.stringify(entries)],
      { encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    const bytes = await fs.readFile(archive);
    const result = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        helper,
        archive,
        stage,
        String(bytes.length),
        createHash("sha256").update(bytes).digest("hex"),
      ],
      { encoding: "utf8" },
    );
    await run({ result, stage, archive });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

describe("disposable release archive extraction", () => {
  it("allows a contained vendor-style symlink and extracts plain files", async () => {
    await fixture(
      [
        ...base,
        {
          name: `${app}/Contents/Frameworks/Versions/A/Electron`,
          data: "binary",
        },
        {
          name: `${app}/Contents/Frameworks/Electron`,
          kind: "symlink",
          data: "Versions/A/Electron",
        },
      ],
      async ({ result, stage }) => {
        expect(result.status, result.stderr).toBe(0);
        expect(
          await fs.readlink(
            path.join(stage, app, "Contents/Frameworks/Electron"),
          ),
        ).toBe("Versions/A/Electron");
      },
    );
  });
  for (const [label, entry] of [
    ["traversal", { name: `${app}/../escape` }],
    ["absolute", { name: "/tmp/escape" }],
    ["duplicate", { name: "artifact.json" }],
    ["case collision", { name: "ARTIFACT.JSON" }],
    ["device", { name: `${app}/Contents/device`, kind: "device" }],
    [
      "symlink escape",
      {
        name: `${app}/Contents/out`,
        kind: "symlink",
        data: "../../../../outside",
      },
    ],
  ]) {
    it(`rejects ${label}`, async () => {
      await fixture([...base, entry], async ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("ARCHIVE_REFUSED:");
      });
    });
  }
  it("rejects a ZIP bomb before extraction", async () => {
    await fixture(
      [...base, { name: `${app}/Contents/bomb`, data: "x", repeat: 2_000_000 }],
      async ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("ARCHIVE_RATIO_LIMIT");
      },
    );
  });
  it("rejects a symlink archive path without following it", async () => {
    await fixture(base, async ({ result, stage, archive }) => {
      expect(result.status).toBe(0);
      const link = path.join(path.dirname(archive), "link.zip");
      await fs.symlink(archive, link);
      const bytes = await fs.readFile(archive);
      const secondStage = path.join(path.dirname(archive), "second-stage");
      await fs.mkdir(secondStage, { mode: 0o700 });
      const denied = spawnSync(
        "/usr/bin/python3",
        [
          "-I",
          "-S",
          "-B",
          helper,
          link,
          secondStage,
          String(bytes.length),
          createHash("sha256").update(bytes).digest("hex"),
        ],
        { encoding: "utf8" },
      );
      expect(denied.status).not.toBe(0);
      expect(await fs.readdir(secondStage)).toEqual([]);
      expect(await fs.readFile(path.join(stage, "artifact.json"), "utf8")).toBe(
        "{}",
      );
    });
  });
});

describe("shared package verifier entry", () => {
  it("refuses a legacy tree digest before reading an app", async () => {
    await expect(
      verifyPackageContent({
        artifact: { schema: 4 },
        appPath: "/tmp/Farol Next Preview.app",
        expectedVersion: "0.1.0-preview.0",
        expectedChannel: "local-preview-only",
      }),
    ).rejects.toThrow("PACKAGE_TREE_DIGEST_LEGACY");
  });
});

describe("private handle verification", () => {
  it("binds a handle to a measured app only after package verification and cleans rejected staging", async () => {
    await fixture(base, async ({ archive }) => {
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-verifier-stage-"),
      );
      try {
        const bytes = await fs.readFile(archive);
        const verifier = createUpdatePackageVerifier({
          archivePathForHandle: async (handle) => {
            expect(handle).toBe("private-handle");
            return archive;
          },
          stagingParent: parent,
          extractorPath: helper,
          verifierPath: path.resolve(
            import.meta.dirname,
            "../../tooling/verify-package-standalone.mjs",
          ),
          nodeExecutable: process.execPath,
        });
        const manifest = {
          product: "Farol Next Preview",
          bundleId: "local.farol.next.preview",
          version: "0.1.0-owner.beta.1",
          buildVersion: "2",
          channel: "owner-beta",
          sourceCommit: "a".repeat(40),
          sourceTreeDigest: "b".repeat(64),
          buildId: "c".repeat(64),
          artifactSha256: "d".repeat(64),
          archiveSize: bytes.length,
          archiveSha256: createHash("sha256").update(bytes).digest("hex"),
          signing: "unsigned",
          notarized: false,
        };
        await expect(
          verifier.verifyPackage("private-handle", manifest),
        ).rejects.toMatchObject({
          code: "package_mismatch",
        });
        expect(verifier.verifiedAppPath("private-handle")).toBeNull();
        expect(await fs.readdir(parent)).toEqual([]);
        expect(PackageVerificationError.name).toBe("PackageVerificationError");
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
      }
    });
  });
});
