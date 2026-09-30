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

describe("archive admission before ZIP object allocation", () => {
  for (const [scenario, expected] of [
    ["count", "ARCHIVE_ENTRY_COUNT_INVALID"],
    ["lying-count", "ARCHIVE_ENTRY_COUNT_INVALID"],
    ["directory-bytes", "ARCHIVE_CENTRAL_DIRECTORY_LIMIT"],
    ["zip64", "ARCHIVE_ZIP64_UNSUPPORTED"],
    ["zip64-locator", "ARCHIVE_ZIP64_UNSUPPORTED"],
    ...["compressed", "expanded", "offset", "extra", "local"].map((field) => [
      `zip64-member-${field}`,
      "ARCHIVE_ZIP64_UNSUPPORTED",
    ]),
  ]) {
    it(`refuses ${scenario} before constructing Python ZIP entries`, async () => {
      const parent = await fs.mkdtemp(
        path.join(os.tmpdir(), "farol-zip-budget-"),
      );
      try {
        const probe = `
import hashlib, importlib.util, os, pathlib, struct, sys, zipfile
helper_path, root_path, scenario = sys.argv[1:]
spec = importlib.util.spec_from_file_location("archive_helper", helper_path)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
root = pathlib.Path(root_path)
archive = root / "archive.zip"
stage = root / "stage"
stage.mkdir(mode=0o700)
with zipfile.ZipFile(archive, "w") as z:
    for name in ["artifact.json", "Farol Next Preview.app/Contents/Info.plist", "Farol Next Preview.app/extra"]:
        if scenario == "zip64-member-local":
            with z.open(name, "w", force_zip64=True) as member:
                member.write(b"")
        else:
            info = zipfile.ZipInfo(name)
            if scenario == "zip64-member-extra":
                info.extra = struct.pack("<HHQQ", 1, 16, 0, 0)
            z.writestr(info, "")
data = bytearray(archive.read_bytes())
end = len(data) - 22
if scenario in ("zip64-member-compressed", "zip64-member-expanded", "zip64-member-offset"):
    central = data.index(b"PK\x01\x02")
    field = {"compressed": 20, "expanded": 24, "offset": 42}[scenario.rsplit("-", 1)[1]]
    struct.pack_into("<I", data, central + field, 0xFFFFFFFF)
elif scenario == "lying-count":
    struct.pack_into("<HH", data, end + 8, 1, 1)
elif scenario == "directory-bytes":
    struct.pack_into("<I", data, end + 12, 32 * 1024 * 1024)
elif scenario == "zip64":
    struct.pack_into("<HH", data, end + 8, 65535, 65535)
elif scenario == "zip64-locator":
    # Keep ordinary EOCD count/size non-sentinel and internally consistent.
    # Hide ZIP64 end records in the last entry comment: ZipFile consults the
    # locator immediately before EOCD even without classic sentinel fields.
    old_length, old_offset = struct.unpack_from("<II", data, end + 12)
    last = data.rfind(b"PK\x01\x02", 0, end)
    records = struct.pack("<4sQ2H2I4Q", b"PK\x06\x06", 44, 45, 45, 0, 0, 3, 3, 32 * 1024 * 1024, old_offset)
    records += struct.pack("<4sIQI", b"PK\x06\x07", 0, end, 1)
    struct.pack_into("<H", data, last + 32, len(records))
    struct.pack_into("<I", data, end + 12, old_length + len(records))
    data[end:end] = records
archive.write_bytes(data)
helper.MAX_ENTRIES = 3 if scenario.startswith("zip64-") else 2
def forbidden(*args, **kwargs):
    raise AssertionError("ZIP_OBJECT_ALLOCATED_BEFORE_ADMISSION")
helper.zipfile.ZipFile = forbidden
sys.argv = [helper_path, str(archive), str(stage), str(len(data)), hashlib.sha256(data).hexdigest()]
try:
    helper.main()
    print("UNEXPECTED_SUCCESS")
except (helper.Refusal, AssertionError) as error:
    print(str(error))
assert list(stage.iterdir()) == []
`;
        const result = spawnSync(
          "/usr/bin/python3",
          ["-I", "-S", "-B", "-c", probe, helper, parent, scenario],
          {
            encoding: "utf8",
            timeout: 3000,
            killSignal: "SIGKILL",
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(expected);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
        await expect(fs.lstat(parent)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  }
  it("refuses expanded bytes above the installer limit before extraction", () => {
    const probe = `
import importlib.util, sys, zipfile
archive_path, installer_path = sys.argv[1:]
def module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
archive = module("archive", archive_path)
installer = module("installer", installer_path)
a = zipfile.ZipInfo("artifact.json")
a.file_size = 2
a.compress_size = 2
b = zipfile.ZipInfo("Farol Next Preview.app/Contents/large")
b.file_size = installer.MAX_BYTES + 1
b.compress_size = b.file_size
class Entries:
    def infolist(self): return [a, b]
try:
    archive.preflight(Entries())
    print("UNEXPECTED_SUCCESS")
except archive.Refusal as error:
    print(str(error))
`;
    const result = spawnSync(
      "/usr/bin/python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        probe,
        helper,
        path.resolve(
          import.meta.dirname,
          "../../resources/native/update_helper.py",
        ),
      ],
      {
        encoding: "utf8",
        timeout: 3000,
        killSignal: "SIGKILL",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("ARCHIVE_EXPANDED_LIMIT");
  });
});
