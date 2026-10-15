import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { packageLayout } from "../../tooling/package-layout.mjs";
import { verifyPackageContent } from "../../tooling/verify-package-content.mjs";
import { SIGNED_DERIVATIVE_SCHEMA } from "../../tooling/signed-derivative-contract.mjs";
import {
  parseGithubReleaseManifest,
  parseRetainedGithubReleaseManifest,
} from "../../src/modules/release/app/github-release";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => {
    throw new Error("unexpected native execution");
  }),
  spawnSync: vi.fn(() => {
    throw new Error("unexpected native execution");
  }),
}));

const digest = "a".repeat(64);
// Metadata-only fixtures. Existing public parsers remain the admission authority;
// these tests qualify no signed package, filesystem object or installed consumer.
function unsignedPackage() {
  return {
    schema: 7,
    treeDigestVersion: "farol.next.tree-digest/v2",
    product: "Farol Next Preview",
    version: "0.2.7",
    bundleId: "local.farol.next.preview",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: digest,
    buildId: digest,
    builtAt: "2026-10-14T12:00:00.000Z",
    artifactSha256: digest,
    sourceDirty: false,
    signing: {
      kind: "unsigned",
      reason: "stable-distribution",
      runtimeBytes: "unmodified-vendor-bundle",
    },
    electronSourceSha256: digest,
    notarized: false,
    updateChannel: "github-stable",
  };
}
function release() {
  return {
    schema: "farol.github-release/1",
    repository: "legrch/farol",
    channel: "stable",
    product: "Farol Next Preview",
    bundleId: "local.farol.next.preview",
    version: "0.2.7",
    buildVersion: "36",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: digest,
    buildId: digest,
    artifactSha256: digest,
    archiveSha256: digest,
    archiveName: "Farol-0.2.7-darwin-arm64.zip",
    archiveSize: 10,
    platform: "darwin",
    arch: "arm64",
    signing: "unsigned",
    notarized: false,
    sourceDirty: false,
  };
}
function retained(manifest) {
  return {
    schema: "farol.ready-update/1",
    handle: "synthetic-archive",
    manifest,
    operation: {
      target: {
        digest: manifest.artifactSha256,
        version: manifest.version,
        buildId: manifest.buildId,
      },
    },
  };
}
afterEach(() => vi.restoreAllMocks());

it.each([
  [
    "derivative schema",
    () => ({ schema: SIGNED_DERIVATIVE_SCHEMA }),
    "PACKAGE_MANIFEST_SCHEMA_INVALID",
  ],
  ["schema 8", () => ({ schema: 8 }), "PACKAGE_MANIFEST_SCHEMA_INVALID"],
  [
    "developer-id signature",
    () => ({
      ...unsignedPackage(),
      signing: { ...unsignedPackage().signing, kind: "developer-id" },
    }),
    "PACKAGE_SIGNING_IDENTITY_INVALID",
  ],
  [
    "notarized claim",
    () => ({ ...unsignedPackage(), notarized: true }),
    "PACKAGE_NOTARIZATION_CLAIM_INVALID",
  ],
])(
  "existing package verifier refuses %s before filesystem/native work",
  async (_name, fixture, error) => {
    const io = Object.keys(fs)
      .filter((name) => typeof fs[name] === "function")
      .map((name) =>
        vi.spyOn(fs, name).mockImplementation(() => {
          throw new Error(`unexpected filesystem work: ${name}`);
        }),
      );
    await expect(
      verifyPackageContent({
        artifact: fixture(),
        appPath: "/synthetic/Farol.app",
        expectedVersion: "0.2.7",
        expectedBuildVersion: "36",
        expectedChannel: "github-stable",
      }),
    ).rejects.toThrow(error);
    for (const spy of io) expect(spy).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  },
);

it("keeps package layouts closed to existing generations", () => {
  expect(() => packageLayout(SIGNED_DERIVATIVE_SCHEMA)).toThrow(
    "PACKAGE_MANIFEST_SCHEMA_INVALID",
  );
  expect(() => packageLayout(8)).toThrow("PACKAGE_MANIFEST_SCHEMA_INVALID");
  expect(packageLayout(7).core).toBe(true);
});

it("retains ordinary unsigned release and retained-fixture acceptance", () => {
  const manifest = release();
  expect(parseGithubReleaseManifest(manifest)).toEqual({
    ok: true,
    value: manifest,
  });
  expect(parseRetainedGithubReleaseManifest(retained(manifest))).toEqual({
    ok: true,
    value: manifest,
  });
});

it.each([
  [
    "signed",
    (m) => {
      m.signing = "developer-id";
    },
  ],
  [
    "new release schema",
    (m) => {
      m.schema = "farol.github-release/2";
    },
  ],
  [
    "derivative schema",
    (m) => {
      m.schema = SIGNED_DERIVATIVE_SCHEMA;
    },
  ],
  [
    "notarized",
    (m) => {
      m.notarized = true;
    },
  ],
  [
    "derivative addition",
    (m) => {
      m.signedDerivative = { schema: SIGNED_DERIVATIVE_SCHEMA };
    },
  ],
  [
    "detached stage addition",
    (m) => {
      m.stage = "signed-pre-notarization";
    },
  ],
])("public release parsers refuse %s metadata", (_name, mutate) => {
  const manifest = release();
  mutate(manifest);
  expect(parseGithubReleaseManifest(manifest)).toEqual({
    ok: false,
    code: "invalid_manifest",
  });
  expect(parseRetainedGithubReleaseManifest(retained(manifest))).toEqual({
    ok: false,
    code: "invalid_manifest",
  });
});
