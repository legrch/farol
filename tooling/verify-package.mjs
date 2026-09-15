import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";
import { BUILD_ENTRIES, verifyBuildEntries } from "./build-contract.mjs";

const root = process.cwd();
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
const artifactIndex = process.argv.indexOf("--artifact");
const artifactFile = path.resolve(
  artifactIndex === -1
    ? path.join(root, "dist/package/artifact.json")
    : (process.argv[artifactIndex + 1] ?? ""),
);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

requireValue(artifact.schema === 2, "PACKAGE_MANIFEST_SCHEMA_INVALID");
requireValue(
  artifact.product === "Farol Next Preview",
  "PACKAGE_PRODUCT_INVALID",
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

const appPath = path.resolve(artifact.artifactPath);
requireValue(
  path.basename(appPath) === "Farol Next Preview.app",
  "PACKAGE_PATH_INVALID",
);
const actualDigest = await treeDigest(appPath);
requireValue(
  actualDigest === artifact.artifactSha256,
  "PACKAGE_DIGEST_MISMATCH",
);

const resources = path.join(appPath, "Contents/Resources/app");
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
await fs.access(path.join(appPath, "Contents/MacOS/Farol Next Preview"));
await fs.access(path.join(resources, "THIRD_PARTY_NOTICES.txt"));

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
  `verified ${artifact.product} ${artifact.artifactSha256} (${artifact.sourceDirty ? "dirty" : "clean"})\n`,
);
