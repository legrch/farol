import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { treeDigest } from "./artifact-digest.mjs";
import { BUILD_ENTRIES, verifyBuildEntries } from "./build-contract.mjs";
import { GEIST_VERSION, verifyGeistBuild } from "./font-contract.mjs";
import {
  NATIVE_SAFE_OPEN_HELPER,
  verifyNativeHelper,
} from "./native-helper-contract.mjs";
import {
  assertCanonicalArtifactPath,
  candidatePaths,
} from "./candidate-contract.mjs";
import { assertResourceManifest } from "./resource-contract.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const canonical = candidatePaths(root);
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
const arguments_ = process.argv.slice(2);

function option(name) {
  const indexes = arguments_
    .map((argument, index) => (argument === name ? index : -1))
    .filter((index) => index !== -1);
  if (indexes.length > 1) throw new Error(`PACKAGE_OPTION_REPEATED:${name}`);
  if (indexes.length === 0) return null;
  const value = arguments_[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`PACKAGE_OPTION_VALUE_MISSING:${name}`);
  }
  return value;
}

const artifactOption = option("--artifact");
const appOption = option("--app");
const known = new Set(["--artifact", "--app"]);
for (let index = 0; index < arguments_.length; index += 1) {
  const argument = arguments_[index];
  if (!known.has(argument))
    throw new Error(`PACKAGE_OPTION_INVALID:${argument}`);
  index += 1;
}
const artifactFile = path.resolve(
  artifactOption ?? path.join(root, "dist/package/artifact.json"),
);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
const packageDocument = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

requireValue(artifact.schema === 3, "PACKAGE_MANIFEST_SCHEMA_INVALID");
requireValue(
  artifact.product === "Farol Next Preview",
  "PACKAGE_PRODUCT_INVALID",
);
requireValue(
  artifact.version === packageDocument.version,
  "PACKAGE_VERSION_INVALID",
);
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
  /^[a-f0-9]{64}$/u.test(artifact.artifactSha256),
  "PACKAGE_DIGEST_INVALID",
);
requireValue(
  typeof artifact.sourceDirty === "boolean",
  "PACKAGE_DIRTY_STATE_INVALID",
);
requireValue(
  artifact.signing?.kind === "unsigned" &&
    artifact.signing?.reason === "local-development-preview" &&
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
  artifact.updateChannel === "local-preview-only",
  "PACKAGE_CHANNEL_INVALID",
);
requireValue(
  artifact.runtime?.electron === "41.10.7" &&
    artifact.runtime?.node === "embedded-in-electron" &&
    artifact.runtime?.testerManagedRuntime === false &&
    artifact.runtime?.layout === "nested-unmodified-vendor-bundle" &&
    artifact.runtime?.relativePath === runtimeRelativePath,
  "PACKAGE_RUNTIME_CLOSURE_INVALID",
);
assertCanonicalArtifactPath(root, artifact);

const appPath = path.resolve(appOption ?? canonical.appPath);
requireValue(
  path.basename(appPath) === "Farol Next Preview.app",
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
  (await fs.readdir(path.join(contents, "Resources"))).join("\0") === "app",
  "PACKAGE_OUTER_RESOURCE_SET_INVALID",
);

const resources = path.join(appPath, "Contents/Resources/app");
const expectedResourceEntries = [
  ...BUILD_ENTRIES,
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
requireValue(embedded.schema === 2, "PACKAGE_EMBEDDED_MANIFEST_INVALID");
requireValue(
  embedded.sourceMode === "head-exact" &&
    embedded.inputExact === true &&
    /^[a-f0-9]{64}$/u.test(embedded.inputLedgerSha256 ?? ""),
  "PACKAGE_EMBEDDED_ATTESTATION_INVALID",
);
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
    embedded.entries.length === BUILD_ENTRIES.length &&
    embedded.entries.every((entry, index) => entry === BUILD_ENTRIES[index]),
  "PACKAGE_EMBEDDED_ENTRY_SET_INVALID",
);
await verifyBuildEntries(resources, embedded.entrySha256);
await verifyGeistBuild(resources);
await verifyNativeHelper(path.join(resources, NATIVE_SAFE_OPEN_HELPER.output));
const embeddedPackage = JSON.parse(
  await fs.readFile(path.join(resources, "package.json"), "utf8"),
);
requireValue(
  embeddedPackage.name === "farol-next-preview-app" &&
    embeddedPackage.productName === artifact.product &&
    embeddedPackage.version === artifact.version &&
    embeddedPackage.main === "main.cjs",
  "PACKAGE_EMBEDDED_APP_IDENTITY_INVALID",
);
const resourceManifest = JSON.parse(
  await fs.readFile(path.join(resources, "resource-manifest.json"), "utf8"),
);
const sourceResourceManifest = JSON.parse(
  await fs.readFile(path.join(root, "resources.json"), "utf8"),
);
assertResourceManifest(sourceResourceManifest);
assertResourceManifest(resourceManifest);

function plistValue(plist, key) {
  return execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Print :${key}`, plist],
    {
      encoding: "utf8",
    },
  ).trim();
}

const mainPlist = path.join(appPath, "Contents/Info.plist");
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
const expectedElectron = path.join(
  root,
  "node_modules/electron/dist/Electron.app",
);
requireValue(
  (await treeDigest(expectedElectron)) === artifact.electronSourceSha256,
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
requireValue(
  (await treeDigest(runtimeApp)) === artifact.electronSourceSha256,
  "PACKAGE_RUNTIME_DIGEST_MISMATCH",
);
execFileSync("/usr/bin/plutil", ["-lint", mainPlist], { stdio: "pipe" });
process.stdout.write(
  `verified ${artifact.product} ${artifact.version} ${artifact.artifactSha256} (${artifact.sourceDirty ? "dirty" : "clean"}) at ${appPath}\n`,
);
