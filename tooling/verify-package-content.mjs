import { GO_CORE_ENTRIES, verifyGoCoreArtifact } from "./go-core-artifact.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TREE_DIGEST_VERSION, treeDigest } from "./artifact-digest.mjs";
import {
  BUILD_ENTRIES,
  LEGACY_BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "./build-contract.mjs";
import { assertBuildIdentity } from "./build-identity-contract.mjs";
import { GEIST_VERSION, verifyGeistBuild } from "./font-contract.mjs";
import {
  NATIVE_SAFE_OPEN_HELPER,
  verifyNativeHelper,
} from "./native-helper-contract.mjs";
import { assertResourceManifest } from "./resource-contract.mjs";
import { packageLayout } from "./package-layout.mjs";
import { verifyBrandAssets } from "./brand-contract.mjs";
import {
  ELECTRON_RUNTIME,
  assertEmbeddedRuntime,
  assertRuntimeClosure,
  observeEmbeddedRuntime,
  plistValue,
} from "./runtime-contract.mjs";

const runtimeRelativePath = "Contents/Frameworks/Electron Runtime.app";
const expectedLauncher = `#!/bin/sh
set -eu

launcher_path=$0
case "$launcher_path" in
  /*) ;;
  *) launcher_path="$PWD/$launcher_path" ;;
esac
macos_dir=\${launcher_path%/*}
contents_dir=\${macos_dir%/*}
export ELECTRON_FORCE_IS_PACKAGED=true
exec "$contents_dir/Frameworks/Electron Runtime.app/Contents/MacOS/Electron" \\
  "$contents_dir/Resources/app" "$@"
`;
function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

export function assertPackageResourceManifest(
  resourceManifest,
  artifact,
  expectedVersion,
  expectedChannel,
) {
  assertResourceManifest(resourceManifest);
  requireValue(
    resourceManifest.product.version === artifact.version &&
      resourceManifest.product.version === expectedVersion,
    "PACKAGE_RESOURCE_VERSION_MISMATCH",
  );
  requireValue(
    resourceManifest.product.updateChannel === artifact.updateChannel &&
      resourceManifest.product.updateChannel === expectedChannel,
    "PACKAGE_RESOURCE_CHANNEL_MISMATCH",
  );
}

export async function verifyPackageContent({
  artifact,
  appPath,
  expectedVersion,
  expectedBuildVersion,
  expectedChannel,
  sourceResourceManifest,
  assertArtifactPath,
}) {
  // Schema 4 manifests carry a version 1 tree digest, whose framing is
  // ambiguous.  Recognize them explicitly instead of reporting a mismatch.
  requireValue(artifact.schema !== 4, "PACKAGE_TREE_DIGEST_LEGACY");
  const layout = packageLayout(artifact.schema);
  const entries = layout.core
    ? [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort()
    : layout.branded
      ? BUILD_ENTRIES
      : LEGACY_BUILD_ENTRIES;
  requireValue(
    artifact.treeDigestVersion === TREE_DIGEST_VERSION,
    "PACKAGE_TREE_DIGEST_VERSION_INVALID",
  );
  assertArtifactPath?.();
  requireValue(
    artifact.product === "Farol Next Preview",
    "PACKAGE_PRODUCT_INVALID",
  );
  requireValue(artifact.version === expectedVersion, "PACKAGE_VERSION_INVALID");
  requireValue(
    artifact.bundleId === "local.farol.next.preview",
    "PACKAGE_BUNDLE_ID_INVALID",
  );
  requireValue(
    /^[a-f0-9]{40}$/u.test(artifact.sourceCommit),
    "PACKAGE_SOURCE_COMMIT_INVALID",
  );
  requireValue(
    /^[a-f0-9]{64}$/u.test(artifact.sourceTreeDigest),
    "PACKAGE_SOURCE_DIGEST_INVALID",
  );
  requireValue(
    /^[a-f0-9]{64}$/u.test(artifact.buildId ?? "") &&
      typeof artifact.builtAt === "string",
    "PACKAGE_BUILD_IDENTITY_INVALID",
  );
  requireValue(
    /^[a-f0-9]{64}$/u.test(artifact.artifactSha256),
    "PACKAGE_DIGEST_INVALID",
  );
  requireValue(
    typeof artifact.sourceDirty === "boolean",
    "PACKAGE_DIRTY_STATE_INVALID",
  );
  requireValue(
    artifact.signing?.kind === "unsigned" &&
      artifact.signing?.reason ===
        (expectedChannel === "github-owner-beta"
          ? "owner-beta-distribution"
          : expectedChannel === "github-stable"
            ? "stable-distribution"
            : "local-development-preview") &&
      artifact.signing?.runtimeBytes === "unmodified-vendor-bundle",
    "PACKAGE_SIGNING_IDENTITY_INVALID",
  );
  requireValue(
    /^[a-f0-9]{64}$/u.test(artifact.electronSourceSha256 ?? ""),
    "PACKAGE_ELECTRON_SOURCE_INVALID",
  );
  requireValue(
    artifact.notarized === false,
    "PACKAGE_NOTARIZATION_CLAIM_INVALID",
  );
  requireValue(
    artifact.updateChannel === expectedChannel,
    "PACKAGE_CHANNEL_INVALID",
  );
  assertRuntimeClosure(artifact.runtime, ELECTRON_RUNTIME, runtimeRelativePath);
  requireValue(
    path.basename(appPath) === layout.appName,
    "PACKAGE_PATH_INVALID",
  );
  const actualDigest = await treeDigest(appPath);
  requireValue(
    actualDigest === artifact.artifactSha256,
    "PACKAGE_DIGEST_MISMATCH",
  );

  const contents = path.join(appPath, "Contents");
  requireValue(
    (await fs.readdir(contents)).sort().join("\0") ===
      ["Frameworks", "Info.plist", "MacOS", "Resources"].join("\0"),
    "PACKAGE_CONTENTS_SET_INVALID",
  );
  requireValue(
    (await fs.readdir(path.join(contents, "MacOS"))).join("\0") ===
      "Farol Next Preview",
    "PACKAGE_EXECUTABLE_SET_INVALID",
  );
  requireValue(
    (await fs.readdir(path.join(contents, "Frameworks"))).join("\0") ===
      "Electron Runtime.app",
    "PACKAGE_FRAMEWORK_SET_INVALID",
  );
  requireValue(
    (await fs.readdir(path.join(contents, "Resources"))).sort().join("\0") ===
      (layout.branded ? ["app", "farol.icns"] : ["app"]).join("\0"),
    "PACKAGE_OUTER_RESOURCE_SET_INVALID",
  );

  const resources = path.join(appPath, "Contents/Resources/app");
  const expectedResourceEntries = [
    ...entries,
    "THIRD_PARTY_NOTICES.txt",
    "build-manifest.json",
    "package.json",
  ].sort();
  requireValue(
    (await fs.readdir(resources)).sort().join("\0") ===
      expectedResourceEntries.join("\0"),
    "PACKAGE_RESOURCE_SET_INVALID",
  );
  const embedded = JSON.parse(
    await fs.readFile(path.join(resources, "build-manifest.json"), "utf8"),
  );
  requireValue(
    embedded.schema === (layout.core ? 4 : 3),
    "PACKAGE_EMBEDDED_MANIFEST_INVALID",
  );
  requireValue(
    embedded.sourceMode === "head-exact" &&
      embedded.inputExact === true &&
      /^[a-f0-9]{64}$/u.test(embedded.inputLedgerSha256 ?? ""),
    "PACKAGE_EMBEDDED_ATTESTATION_INVALID",
  );
  try {
    await verifyInputManifest(resources, embedded);
  } catch (error) {
    throw new Error(
      `PACKAGE_EMBEDDED_INPUT_MANIFEST_INVALID:${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  requireValue(
    embedded.product === artifact.product,
    "PACKAGE_EMBEDDED_PRODUCT_MISMATCH",
  );
  requireValue(
    embedded.bundleId === artifact.bundleId,
    "PACKAGE_EMBEDDED_BUNDLE_MISMATCH",
  );
  requireValue(
    embedded.sourceCommit === artifact.sourceCommit,
    "PACKAGE_EMBEDDED_COMMIT_MISMATCH",
  );
  requireValue(
    embedded.sourceTreeDigest === artifact.sourceTreeDigest,
    "PACKAGE_EMBEDDED_DIGEST_MISMATCH",
  );
  requireValue(
    embedded.dirty === artifact.sourceDirty,
    "PACKAGE_EMBEDDED_DIRTY_MISMATCH",
  );
  requireValue(
    Array.isArray(embedded.entries) &&
      embedded.entries.length === entries.length &&
      embedded.entries.every((entry, index) => entry === entries[index]),
    "PACKAGE_EMBEDDED_ENTRY_SET_INVALID",
  );
  await verifyBuildEntries(resources, embedded.entrySha256, entries);
  if (!layout.core && Object.hasOwn(embedded, "core"))
    throw new Error("PACKAGE_CORE_SCHEMA_MISMATCH");
  if (layout.branded) {
    await verifyBrandAssets(resources);
    requireValue(
      (await fs.readFile(path.join(contents, "Resources/farol.icns"))).equals(
        await fs.readFile(path.join(resources, "farol.icns")),
      ),
      "PACKAGE_OUTER_ICON_MISMATCH",
    );
  }
  const buildIdentity = assertBuildIdentity(
    JSON.parse(
      await fs.readFile(path.join(resources, "build-identity.json"), "utf8"),
    ),
  );
  if (layout.core)
    await verifyGoCoreArtifact(resources, embedded.core, buildIdentity);
  requireValue(
    buildIdentity.product === artifact.product &&
      buildIdentity.version === artifact.version &&
      buildIdentity.bundleId === artifact.bundleId &&
      buildIdentity.updateChannel === artifact.updateChannel &&
      buildIdentity.buildId === artifact.buildId &&
      buildIdentity.builtAt === artifact.builtAt &&
      buildIdentity.sourceCommit === artifact.sourceCommit &&
      buildIdentity.sourceTreeDigest === artifact.sourceTreeDigest &&
      buildIdentity.sourceDirty === artifact.sourceDirty &&
      (buildIdentity.buildVersion === artifact.buildVersion ||
        (expectedChannel === "local-preview-only" &&
          buildIdentity.buildVersion === undefined &&
          artifact.buildVersion === undefined)) &&
      embedded.version === buildIdentity.version &&
      embedded.buildId === buildIdentity.buildId &&
      embedded.builtAt === buildIdentity.builtAt,
    "PACKAGE_BUILD_IDENTITY_MISMATCH",
  );
  await verifyGeistBuild(resources);
  await verifyNativeHelper(
    path.join(resources, NATIVE_SAFE_OPEN_HELPER.output),
  );
  const embeddedPackage = JSON.parse(
    await fs.readFile(path.join(resources, "package.json"), "utf8"),
  );
  requireValue(
    embeddedPackage.name === "farol-next-preview-app" &&
      embeddedPackage.productName === layout.displayName &&
      embeddedPackage.version === artifact.version &&
      embeddedPackage.main === "main.cjs",
    "PACKAGE_EMBEDDED_APP_IDENTITY_INVALID",
  );
  const resourceManifest = JSON.parse(
    await fs.readFile(path.join(resources, "resource-manifest.json"), "utf8"),
  );
  if (sourceResourceManifest !== undefined)
    assertPackageResourceManifest(
      sourceResourceManifest,
      artifact,
      expectedVersion,
      expectedChannel,
    );
  assertPackageResourceManifest(
    resourceManifest,
    artifact,
    expectedVersion,
    expectedChannel,
  );

  const mainPlist = path.join(appPath, "Contents/Info.plist");
  requireValue(
    plistValue(mainPlist, "CFBundleDisplayName") === layout.displayName &&
      plistValue(mainPlist, "CFBundleName") === layout.displayName,
    "PACKAGE_PLIST_DISPLAY_NAME_MISMATCH",
  );
  if (layout.branded)
    requireValue(
      plistValue(mainPlist, "CFBundleIconFile") === "farol.icns",
      "PACKAGE_PLIST_ICON_MISMATCH",
    );
  requireValue(
    plistValue(mainPlist, "CFBundleIdentifier") === artifact.bundleId,
    "PACKAGE_PLIST_BUNDLE_MISMATCH",
  );
  requireValue(
    plistValue(mainPlist, "CFBundleExecutable") === "Farol Next Preview",
    "PACKAGE_PLIST_EXECUTABLE_MISMATCH",
  );
  requireValue(
    plistValue(mainPlist, "CFBundleShortVersionString") ===
      artifact.version.split("-", 1)[0],
    "PACKAGE_PLIST_VERSION_MISMATCH",
  );
  const measuredBuildVersion = plistValue(mainPlist, "CFBundleVersion");
  requireValue(
    /^[1-9][0-9]{0,8}$/u.test(measuredBuildVersion) &&
      measuredBuildVersion ===
        (artifact.buildVersion ??
          (expectedChannel === "local-preview-only" ? "1" : null)) &&
      (expectedBuildVersion === undefined ||
        measuredBuildVersion === expectedBuildVersion),
    "PACKAGE_PLIST_BUILD_VERSION_MISMATCH",
  );
  await fs.access(path.join(appPath, "Contents/MacOS/Farol Next Preview"));
  await fs.access(path.join(resources, "THIRD_PARTY_NOTICES.txt"));
  const notices = await fs.readFile(
    path.join(resources, "THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  requireValue(
    notices.includes(`Geist ${GEIST_VERSION} (SIL Open Font License 1.1)`) &&
      notices.includes("Geist-Variable.woff2 SHA-256") &&
      notices.includes("GeistMono-Variable.woff2 SHA-256"),
    "PACKAGE_GEIST_NOTICE_INVALID",
  );
  requireValue(
    notices.includes("@modelcontextprotocol/server 2.0.0 (MIT)") &&
      notices.includes("@modelcontextprotocol/core 2.0.0 (MIT)"),
    "PACKAGE_MCP_NOTICE_INVALID",
  );

  requireValue(
    notices.includes("ws 8.22.0 (MIT)"),
    "PACKAGE_WS_NOTICE_INVALID",
  );

  const launcherPath = path.join(appPath, "Contents/MacOS/Farol Next Preview");
  const launcherStat = await fs.lstat(launcherPath);
  requireValue(
    launcherStat.isFile() &&
      !launcherStat.isSymbolicLink() &&
      (launcherStat.mode & 0o777) === 0o755,
    "PACKAGE_LAUNCHER_MODE_INVALID",
  );
  requireValue(
    (await fs.readFile(launcherPath, "utf8")) === expectedLauncher,
    "PACKAGE_LAUNCHER_INVALID",
  );

  const runtimeApp = path.join(appPath, runtimeRelativePath);
  const runtimePlist = path.join(runtimeApp, "Contents/Info.plist");
  requireValue(
    plistValue(runtimePlist, "CFBundleIdentifier") === "com.github.Electron" &&
      plistValue(runtimePlist, "CFBundleExecutable") === "Electron",
    "PACKAGE_RUNTIME_IDENTITY_MISMATCH",
  );
  // The trusted expectation is the reviewed vendor distribution pinned in the
  // runtime contract, not whatever `node_modules` currently holds.
  requireValue(
    artifact.electronSourceSha256 === ELECTRON_RUNTIME.extractedTreeDigest,
    "PACKAGE_ELECTRON_SOURCE_MISMATCH",
  );

  const helpers = ["", " (GPU)", " (Plugin)", " (Renderer)"];
  function requireUnsigned(target) {
    const signature = spawnSync("/usr/bin/codesign", ["-d", target], {
      encoding: "utf8",
    });
    requireValue(
      signature.status !== 0 &&
        /code object is not signed at all/u.test(
          `${signature.stdout}${signature.stderr}`,
        ),
      "PACKAGE_SIGNING_IDENTITY_INVALID",
    );
  }

  for (const suffix of helpers) {
    const name = `Electron Helper${suffix}`;
    const helperRoot = path.join(
      runtimeApp,
      "Contents/Frameworks",
      `${name}.app`,
    );
    const helperPlist = path.join(helperRoot, "Contents/Info.plist");
    requireValue(
      plistValue(helperPlist, "CFBundleName") === name,
      "PACKAGE_HELPER_IDENTITY_MISMATCH",
    );
    requireValue(
      plistValue(helperPlist, "CFBundleIdentifier") ===
        "com.github.Electron.helper",
      "PACKAGE_RUNTIME_HELPER_BUNDLE_MISMATCH",
    );
    await fs.access(path.join(helperRoot, "Contents/MacOS", name));
  }

  requireUnsigned(appPath);
  // First the sealed runtime bytes must be the bytes the manifest says were
  // copied; only then is what was copied compared with the reviewed
  // distribution's version, identity and digest.
  const embeddedRuntime = await observeEmbeddedRuntime(runtimeApp);
  requireValue(
    embeddedRuntime.extractedTreeDigest === artifact.electronSourceSha256,
    "PACKAGE_RUNTIME_DIGEST_MISMATCH",
  );
  assertEmbeddedRuntime(embeddedRuntime);
  execFileSync("/usr/bin/plutil", ["-lint", mainPlist], { stdio: "pipe" });
  return {
    product: artifact.product,
    bundleId: artifact.bundleId,
    version: artifact.version,
    buildVersion: measuredBuildVersion,
    buildId: buildIdentity.buildId,
    updateChannel: buildIdentity.updateChannel,
    sourceCommit: embedded.sourceCommit,
    sourceTreeDigest: embedded.sourceTreeDigest,
    artifactSha256: actualDigest,
    signing: artifact.signing.kind,
    notarized: artifact.notarized,
  };
}
