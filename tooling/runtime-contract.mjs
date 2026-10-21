import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TREE_DIGEST_VERSION, treeDigest } from "./artifact-digest.mjs";

// The one reviewed Electron runtime the preview may embed. The expectation is
// pinned here from the vendor's own publication rather than read back from
// whatever `node_modules` currently holds: `distribution.sha256` is the SHA-256
// that the electron/electron v44.4.2 release lists for the darwin/arm64 archive
// (SHASUMS256.txt, mirrored by the npm package's checksums.json), and
// `extractedTreeDigest` is the version-2 tree digest of the Electron.app that
// archive extracts to. A stale runtime whose own manifest hashes agree, and
// same-version bytes modified after extraction, both fail these checks even
// when every other manifest field is consistent with itself. The archive's
// size is not part of the enforced claim: nothing in packaging or
// verification can re-establish it, so it is recorded in the evidence log
// rather than asserted by the manifest.
export const ELECTRON_RUNTIME = Object.freeze({
  version: "44.4.2",
  platform: "darwin",
  arch: "arm64",
  bundleIdentifier: "com.github.Electron",
  executable: "Electron",
  distribution: Object.freeze({
    asset: "electron-v44.4.2-darwin-arm64.zip",
    sha256: "52f8354eacad1dbe43ee12345b0fa9e1fc7de137f77571abbe12efbbc896aad8",
  }),
  treeDigestVersion: TREE_DIGEST_VERSION,
  extractedTreeDigest:
    "60551daa876998dc62293edc75eb1aca819690077fe9d48910459ce175796074",
});

const HEX64 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+$/u;
const SUPPORTED_PLATFORMS = new Set(["darwin"]);
const SUPPORTED_ARCHES = new Set(["arm64"]);

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// The expectation itself must be coherent before anything is compared with
// it: the archive name has to spell the same version, platform and
// architecture, and both digests have to be complete SHA-256 hex strings.
export function assertRuntimeExpectation(expected) {
  const distribution = expected?.distribution;
  requireValue(
    VERSION.test(expected?.version ?? "") &&
      SUPPORTED_PLATFORMS.has(expected.platform) &&
      SUPPORTED_ARCHES.has(expected.arch) &&
      nonEmptyString(expected.bundleIdentifier) &&
      nonEmptyString(expected.executable) &&
      distribution?.asset ===
        `electron-v${expected.version}-${expected.platform}-${expected.arch}.zip` &&
      HEX64.test(distribution.sha256 ?? "") &&
      expected.treeDigestVersion === TREE_DIGEST_VERSION &&
      HEX64.test(expected.extractedTreeDigest ?? ""),
    "RUNTIME_EXPECTATION_INVALID",
  );
  return expected;
}

// The observation of an installed npm `electron` package: its own version
// claims, the vendor checksum it ships for the selected archive, and the bytes
// it extracted. Every field is compared with the pinned expectation; none of
// them is trusted on its own, so a consistent but stale install is refused.
export function assertRuntimeObservation(
  observed,
  expected = ELECTRON_RUNTIME,
) {
  assertRuntimeExpectation(expected);
  requireValue(
    observed?.packageVersion === expected.version,
    "RUNTIME_PACKAGE_VERSION_MISMATCH",
  );
  // The installer's `dist/version` marker spells the bare version in current
  // releases and a `v`-prefixed one in older ones; either form must name the
  // reviewed version exactly.
  requireValue(
    observed.versionFile === expected.version ||
      observed.versionFile === `v${expected.version}`,
    "RUNTIME_VERSION_FILE_MISMATCH",
  );
  requireValue(
    observed.bundleVersion === expected.version,
    "RUNTIME_BUNDLE_VERSION_MISMATCH",
  );
  requireValue(
    observed.bundleIdentifier === expected.bundleIdentifier &&
      observed.executable === expected.executable,
    "RUNTIME_BUNDLE_IDENTITY_MISMATCH",
  );
  requireValue(
    observed.distributionAsset === expected.distribution.asset &&
      observed.distributionSha256 === expected.distribution.sha256,
    "RUNTIME_DISTRIBUTION_CHECKSUM_MISMATCH",
  );
  requireValue(
    observed.treeDigestVersion === expected.treeDigestVersion &&
      observed.extractedTreeDigest === expected.extractedTreeDigest,
    "RUNTIME_TREE_DIGEST_MISMATCH",
  );
  return expected;
}

// The runtime nested in a sealed package carries only the bundle itself, so
// its plist version and identity and the tree digest of its bytes are what
// remain to compare with the reviewed distribution.
export function assertEmbeddedRuntime(observed, expected = ELECTRON_RUNTIME) {
  assertRuntimeExpectation(expected);
  requireValue(
    observed?.bundleVersion === expected.version,
    "RUNTIME_BUNDLE_VERSION_MISMATCH",
  );
  requireValue(
    observed.bundleIdentifier === expected.bundleIdentifier &&
      observed.executable === expected.executable,
    "RUNTIME_BUNDLE_IDENTITY_MISMATCH",
  );
  requireValue(
    observed.treeDigestVersion === expected.treeDigestVersion &&
      observed.extractedTreeDigest === expected.extractedTreeDigest,
    "RUNTIME_TREE_DIGEST_MISMATCH",
  );
  return expected;
}

// The `runtime` block of the artifact manifest: what the package claims to
// embed, spelled from the expectation so the manifest cannot drift from it.
export function runtimeClosure(expected, relativePath) {
  assertRuntimeExpectation(expected);
  return {
    electron: expected.version,
    platform: expected.platform,
    arch: expected.arch,
    distribution: {
      asset: expected.distribution.asset,
      sha256: expected.distribution.sha256,
    },
    node: "embedded-in-electron",
    testerManagedRuntime: false,
    layout: "nested-unmodified-vendor-bundle",
    relativePath,
  };
}

export function assertRuntimeClosure(runtime, expected, relativePath) {
  const closure = runtimeClosure(expected, relativePath);
  requireValue(
    runtime !== null &&
      typeof runtime === "object" &&
      runtime.electron === closure.electron &&
      runtime.platform === closure.platform &&
      runtime.arch === closure.arch &&
      runtime.distribution?.asset === closure.distribution.asset &&
      runtime.distribution?.sha256 === closure.distribution.sha256 &&
      runtime.node === closure.node &&
      runtime.testerManagedRuntime === false &&
      runtime.layout === closure.layout &&
      runtime.relativePath === closure.relativePath,
    "PACKAGE_RUNTIME_CLOSURE_INVALID",
  );
  return runtime;
}

export function plistValue(plist, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    { encoding: "utf8" },
  ).trim();
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function observeEmbeddedRuntime(app) {
  const plist = path.join(app, "Contents/Info.plist");
  return {
    bundleVersion: plistValue(plist, "CFBundleShortVersionString"),
    bundleIdentifier: plistValue(plist, "CFBundleIdentifier"),
    executable: plistValue(plist, "CFBundleExecutable"),
    treeDigestVersion: TREE_DIGEST_VERSION,
    extractedTreeDigest: await treeDigest(app),
  };
}

// Reads the installed npm `electron` package the way the packager relies on
// it: the package's own version, the `dist/version` marker the installer
// wrote, the vendor checksum the package ships for the selected archive, and
// the extracted bundle. A package that never shipped the selected archive's
// checksum observes `null` for it and is refused by the assertion above.
export async function observeElectronRuntime(
  packageDirectory,
  expected = ELECTRON_RUNTIME,
) {
  assertRuntimeExpectation(expected);
  const manifest = await readJson(path.join(packageDirectory, "package.json"));
  const checksums = await readOptionalJson(
    path.join(packageDirectory, "checksums.json"),
  );
  const asset = expected.distribution.asset;
  const checksum = checksums?.[asset];
  return {
    packageVersion: manifest.version,
    versionFile: (
      await fs.readFile(path.join(packageDirectory, "dist/version"), "utf8")
    ).trim(),
    distributionAsset: asset,
    distributionSha256: typeof checksum === "string" ? checksum : null,
    ...(await observeEmbeddedRuntime(
      path.join(packageDirectory, "dist/Electron.app"),
    )),
  };
}
