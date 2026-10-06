import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PackageIdentity,
  ReleaseManifest,
} from "../../src/modules/release/domain/github-release-contract";

// CPU/source control-flow evidence only. File bytes, descriptor observations,
// helper pin and child results are scripted. No extractor, content verifier,
// native filesystem, packaged app or installed operation is executed.
const fixture = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  helperDigest: "",
  measured: null as PackageIdentity | null,
  contentError: null as Error | null,
  cleanupError: null as Error | null,
}));
const parent = "/fixture-release-stage";
const stage = parent + "/farol-update-verify-fixture";
const app = stage + "/Farol.app";
const resources = app + "/Contents/Resources/app";
const helper = "/fixture-reviewed-extractor";
const contentVerifier = "/fixture-trusted-content-verifier.mjs";
const helperBytes = Buffer.from("source-only reviewed extractor fixture");
function fileStats(bytes: Buffer) {
  return {
    isFile: () => true,
    dev: 1n,
    ino: 2n,
    mode: 0o700n,
    nlink: 1n,
    uid: 1n,
    gid: 1n,
    size: BigInt(bytes.length),
    mtimeNs: 3n,
    ctimeNs: 4n,
  };
}
vi.mock("node:fs/promises", () => ({
  default: {
    lstat: vi.fn(async (file: string) => {
      if (file === parent)
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          uid: process.getuid?.(),
          mode: 0o700,
        };
      const bytes = fixture.files.get(file);
      if (!bytes) throw new Error("missing scripted file");
      return fileStats(bytes);
    }),
    open: vi.fn(async (file: string) => {
      const bytes = fixture.files.get(file);
      if (!bytes) throw new Error("missing scripted file");
      return {
        stat: async () => fileStats(bytes),
        close: async () => {},
        read: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => ({
          bytesRead: bytes.copy(buffer, offset, position, position + length),
          buffer,
        }),
      };
    }),
    opendir: vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} })),
    realpath: vi.fn(async (file: string) => file),
    mkdtemp: vi.fn(async () => stage),
    writeFile: vi.fn(async () => {}),
    rm: vi.fn(async () => {
      if (fixture.cleanupError) throw fixture.cleanupError;
    }),
  },
}));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (algorithm: string) => ({
      update: (bytes: Buffer) => ({
        digest: (encoding: "hex") =>
          bytes.equals(Buffer.from("source-only reviewed extractor fixture"))
            ? fixture.helperDigest
            : actual.createHash(algorithm).update(bytes).digest(encoding),
      }),
    }),
  };
});
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      file: string,
      _args: string[],
      _options: unknown,
      callback: (
        error: Error | null,
        result?: { stdout: string; stderr: string },
      ) => void,
    ) => {
      if (file === stage + "/.update_archive.py") {
        callback(null, {
          stdout: JSON.stringify({
            appPath: app,
            artifactPath: stage + "/artifact.json",
          }),
          stderr: "",
        });
      } else if (file === "/fixture-node") {
        callback(fixture.contentError, {
          stdout: JSON.stringify(fixture.measured),
          stderr: "",
        });
      } else callback(new Error("unexpected scripted executor"));
    },
  ),
}));
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createUpdatePackageVerifier,
  UPDATE_ARCHIVE_HELPER_SHA256,
} from "../../src/modules/release/infra/native/update-package-verifier";

const expected: ReleaseManifest = {
  schema: "farol.github-release/1",
  repository: "legrch/farol",
  channel: "owner-beta",
  product: "Farol Next Preview",
  bundleId: "local.farol.next.preview",
  version: "0.1.1-owner.beta.1",
  buildVersion: "2",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  buildId: "c".repeat(64),
  artifactSha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
  archiveName: "Farol-0.1.1-owner.beta.1-darwin-arm64.zip",
  archiveSize: 1024,
  platform: "darwin",
  arch: "arm64",
  signing: "unsigned",
  notarized: false,
  sourceDirty: false,
};
function documents() {
  const core = {
    schema: "farol-core-artifact/1",
    build: {
      buildId: expected.buildId,
      sourceSHA: expected.sourceCommit,
      sourceTreeDigest: expected.sourceTreeDigest,
      platform: { goos: "darwin", goarch: "arm64" },
    },
    binary: { path: "farol-backend", size: 64, sha256: "1".repeat(64) },
  };
  const embedded = {
    schema: 4,
    sourceMode: "head-exact",
    inputExact: true,
    dirty: false,
    inputLedgerSha256: "2".repeat(64),
    product: expected.product,
    bundleId: expected.bundleId,
    version: expected.version,
    buildId: expected.buildId,
    sourceCommit: expected.sourceCommit,
    sourceTreeDigest: expected.sourceTreeDigest,
    core: structuredClone(core),
    entries: ["core-artifact.json", "farol-backend"],
    entrySha256: {
      "farol-backend": core.binary.sha256,
      "core-artifact.json": createHash("sha256")
        .update(Buffer.from(JSON.stringify(core)))
        .digest("hex"),
    },
  };
  const artifact: Record<string, unknown> = {
    ...expected,
    schema: 7,
    updateChannel: "github-owner-beta",
    signing: { kind: "unsigned" },
  };
  return { core, embedded, artifact };
}
type Documents = ReturnType<typeof documents>;
function prepare(edit?: (docs: Documents) => void) {
  const docs = documents();
  const originalCoreHash = docs.embedded.entrySha256["core-artifact.json"];
  edit?.(docs);
  docs.embedded.core = structuredClone(docs.core);
  if (docs.embedded.entrySha256["core-artifact.json"] === originalCoreHash)
    docs.embedded.entrySha256["core-artifact.json"] = createHash("sha256")
      .update(Buffer.from(JSON.stringify(docs.core)))
      .digest("hex");
  fixture.files.set(helper, helperBytes);
  fixture.files.set(
    stage + "/artifact.json",
    Buffer.from(JSON.stringify(docs.artifact)),
  );
  fixture.files.set(
    resources + "/build-manifest.json",
    Buffer.from(JSON.stringify(docs.embedded)),
  );
  fixture.files.set(
    resources + "/core-artifact.json",
    Buffer.from(JSON.stringify(docs.core)),
  );
  return createUpdatePackageVerifier({
    stagingParent: parent,
    extractorPath: helper,
    verifierPath: contentVerifier,
    nodeExecutable: "/fixture-node",
    archivePathForHandle: async () => "/fixture-download/owned.zip",
  });
}
function contentCalls() {
  return vi
    .mocked(execFile)
    .mock.calls.filter(([file]) => file === "/fixture-node");
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.files.clear();
  fixture.helperDigest = UPDATE_ARCHIVE_HELPER_SHA256;
  fixture.contentError = fixture.cleanupError = null;
  fixture.measured = {
    product: expected.product,
    bundleId: expected.bundleId,
    version: expected.version,
    buildVersion: expected.buildVersion,
    sourceCommit: expected.sourceCommit,
    sourceTreeDigest: expected.sourceTreeDigest,
    buildId: expected.buildId,
    artifactSha256: expected.artifactSha256,
    updateChannel: "github-owner-beta",
    signing: "unsigned",
    notarized: false,
  };
});
async function expectRefusal(
  verifier: ReturnType<typeof prepare>,
  code = "package_mismatch",
) {
  await expect(
    verifier.verifyPackage("opaque", expected),
  ).rejects.toMatchObject({ code });
  expect(verifier.verifiedAppPath("opaque")).toBeNull();
  expect(fs.rm).toHaveBeenCalledTimes(1);
  expect(fs.rm).toHaveBeenCalledWith(stage, { recursive: true, force: true });
}

describe("explicit update package generations", () => {
  it.each([6, 7])(
    "locally reverifies an unchanged retained old-feed schema %s package",
    async (schema) => {
      const verifier = prepare((docs) => {
        docs.artifact.schema = schema;
      });
      const historical = {
        ...expected,
        repository: "legrch/farol-releases" as const,
      };
      const result = await verifier.verifyPackage(
        "exact-retained-handle",
        historical,
      );
      expect(result.identity).toEqual(fixture.measured);
      expect(contentCalls()).toHaveLength(1);
      expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual([
        "/fixture-download/owned.zip",
        stage,
        String(historical.archiveSize),
        historical.archiveSha256,
      ]);
    },
  );

  it("refuses a retained old-feed package whose measured identity mismatches", async () => {
    const verifier = prepare();
    fixture.measured = { ...fixture.measured!, buildId: "f".repeat(64) };
    await expect(
      verifier.verifyPackage("exact-retained-handle", {
        ...expected,
        repository: "legrch/farol-releases",
      }),
    ).rejects.toMatchObject({ code: "package_mismatch" });
    expect(verifier.verifiedAppPath("exact-retained-handle")).toBeNull();
  });

  it("keeps schema 6 verification and performs no Go claim reads", async () => {
    const verifier = prepare((docs) => {
      docs.artifact.schema = 6;
      docs.embedded.schema = 3;
    });
    const result = await verifier.verifyPackage("opaque", expected);
    expect(result.stagedAppPath).toBe(app);
    expect(contentCalls()).toHaveLength(1);
    expect(vi.mocked(fs.open).mock.calls.map(([file]) => file)).toEqual([
      helper,
      stage + "/artifact.json",
    ]);
  });
  it.each([4, 5, 8, "7", 7.1, null])(
    "rejects package schema %s before content verification",
    async (schema) => {
      const verifier = prepare((docs) => {
        docs.artifact.schema = schema;
      });
      await expectRefusal(verifier);
      expect(contentCalls()).toHaveLength(0);
    },
  );
  it("accepts schema 7 only after the trusted verifier returns the matching measurement", async () => {
    const verifier = prepare();
    const result = await verifier.verifyPackage("opaque", expected);
    expect(result.identity).toEqual(fixture.measured);
    expect(verifier.verifiedAppPath("opaque")).toBe(app);
    expect(contentCalls()).toHaveLength(1);
    expect(contentCalls()[0]?.[1]).toEqual([
      contentVerifier,
      stage + "/artifact.json",
      app,
      expected.version,
      expected.buildVersion,
      "github-owner-beta",
    ]);
    expect(fs.rm).not.toHaveBeenCalled();
  });
  const cases: [string, (docs: Documents) => void][] = [
    [
      "old build schema",
      (d) => {
        d.embedded.schema = 3;
      },
    ],
    [
      "future build schema",
      (d) => {
        d.embedded.schema = 5;
      },
    ],
    [
      "different outer release version",
      (d) => {
        d.artifact.version = "0.1.0-owner.beta.1";
      },
    ],
    [
      "different embedded version",
      (d) => {
        d.embedded.version = "0.1.0-owner.beta.1";
      },
    ],
    [
      "dirty build",
      (d) => {
        d.embedded.dirty = true;
      },
    ],
    [
      "inexact source",
      (d) => {
        d.embedded.inputExact = false;
      },
    ],
    [
      "missing input ledger",
      (d) => {
        d.embedded.inputLedgerSha256 = "";
      },
    ],
    [
      "different embedded source",
      (d) => {
        d.embedded.sourceCommit = "f".repeat(40);
      },
    ],
    [
      "different core build",
      (d) => {
        d.core.build.buildId = "f".repeat(64);
      },
    ],
    [
      "different core source",
      (d) => {
        d.core.build.sourceSHA = "f".repeat(40);
      },
    ],
    [
      "different core source tree",
      (d) => {
        d.core.build.sourceTreeDigest = "f".repeat(64);
      },
    ],
    [
      "different core platform",
      (d) => {
        d.core.build.platform.goos = "linux";
      },
    ],
    [
      "different core architecture",
      (d) => {
        d.core.build.platform.goarch = "amd64";
      },
    ],
    [
      "different backend path",
      (d) => {
        d.core.binary.path = "../farol-backend";
      },
    ],
    [
      "too small backend",
      (d) => {
        d.core.binary.size = 63;
      },
    ],
    [
      "oversized backend",
      (d) => {
        d.core.binary.size = 128 * 1024 * 1024 + 1;
      },
    ],
    [
      "fractional backend size",
      (d) => {
        d.core.binary.size = 64.5;
      },
    ],
    [
      "malformed backend hash",
      (d) => {
        d.core.binary.sha256 = "Z".repeat(64);
      },
    ],
    [
      "backend ledger mismatch",
      (d) => {
        d.embedded.entrySha256["farol-backend"] = "f".repeat(64);
      },
    ],
    [
      "core file ledger mismatch",
      (d) => {
        d.embedded.entrySha256["core-artifact.json"] = "f".repeat(64);
      },
    ],
    [
      "missing core file hash",
      (d) => {
        d.embedded.entrySha256["core-artifact.json"] = "";
      },
    ],
    [
      "missing backend entry",
      (d) => {
        d.embedded.entries = ["core-artifact.json"];
      },
    ],
    [
      "duplicate core entry",
      (d) => {
        d.embedded.entries.push("core-artifact.json");
      },
    ],
    [
      "extra core claim",
      (d) => {
        Object.assign(d.core, { unchecked: true });
      },
    ],
    [
      "extra binary claim",
      (d) => {
        Object.assign(d.core.binary, { unchecked: true });
      },
    ],
    [
      "malformed core object",
      (d) => {
        Object.assign(d.core, { binary: null });
      },
    ],
  ];
  it.each(cases)(
    "refuses schema 7 %s without delegating or retaining success",
    async (_name, edit) => {
      const verifier = prepare(edit);
      await expectRefusal(verifier);
      expect(contentCalls()).toHaveLength(0);
    },
  );
  it.each(["build-manifest.json", "core-artifact.json"])(
    "refuses missing %s",
    async (file) => {
      const verifier = prepare();
      fixture.files.delete(resources + "/" + file);
      await expectRefusal(verifier);
      expect(contentCalls()).toHaveLength(0);
    },
  );
  it("refuses different embedded and standalone core declarations", async () => {
    const verifier = prepare();
    fixture.files.set(
      resources + "/core-artifact.json",
      Buffer.from(
        JSON.stringify({
          ...documents().core,
          binary: { ...documents().core.binary, size: 65 },
        }),
      ),
    );
    await expectRefusal(verifier);
    expect(contentCalls()).toHaveLength(0);
  });
  it("bounds the core declaration before opening it", async () => {
    const verifier = prepare();
    fixture.files.set(
      resources + "/core-artifact.json",
      Buffer.alloc(8193, " "),
    );
    await expectRefusal(verifier);
    expect(vi.mocked(fs.open).mock.calls.map(([file]) => file)).not.toContain(
      resources + "/core-artifact.json",
    );
    expect(contentCalls()).toHaveLength(0);
  });
  it("refuses content tampering reported by the trusted content verifier", async () => {
    const verifier = prepare();
    fixture.contentError = new Error("GO_CORE_ARTIFACT_INVALID");
    await expectRefusal(verifier);
    expect(contentCalls()).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
  it("refuses a content verifier measurement from a different build", async () => {
    const verifier = prepare();
    fixture.measured = { ...fixture.measured!, buildId: "f".repeat(64) };
    await expectRefusal(verifier);
    expect(contentCalls()).toHaveLength(1);
  });
  it("preserves cleanup-unknown classification and never records success", async () => {
    const verifier = prepare();
    fixture.contentError = new Error("GO_CORE_ARTIFACT_INVALID");
    fixture.cleanupError = new Error("scripted cleanup outcome unknown");
    await expectRefusal(verifier, "cleanup_unknown");
    expect(contentCalls()).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
