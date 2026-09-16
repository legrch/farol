import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { treeDigest } from "./artifact-digest.mjs";
import { BUILD_ENTRIES, verifyBuildEntries } from "./build-contract.mjs";
import { GEIST_RESOURCES, GEIST_VERSION } from "./font-contract.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = process.cwd();
const builtRoot = path.join(root, "dist/app");
const packageRoot = path.join(root, "dist/package");
const appPath = path.join(packageRoot, "Farol Next Preview.app");
const electronApp = path.join(root, "node_modules/electron/dist/Electron.app");
const runtimeRelativePath = "Contents/Frameworks/Electron Runtime.app";
const runtimeApp = path.join(appPath, runtimeRelativePath);
const repositoryRoot = path.resolve(root, "..");
const scope = path.relative(repositoryRoot, root).split(path.sep).join("/");
const packageDocument = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const previewVersion = packageDocument.version;
const bundleVersion = previewVersion.split("-", 1)[0];

const launcher = `#!/bin/sh
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

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Farol Next Preview</string>
  <key>CFBundleExecutable</key>
  <string>Farol Next Preview</string>
  <key>CFBundleIdentifier</key>
  <string>local.farol.next.preview</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Farol Next Preview</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${bundleVersion}</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Local development preview</string>
</dict>
</plist>
`;

const manifest = JSON.parse(
  await fs.readFile(path.join(builtRoot, "build-manifest.json"), "utf8"),
);
if (
  manifest.schema !== 2 ||
  manifest.sourceMode !== "head-exact" ||
  manifest.inputExact !== true ||
  !/^[a-f0-9]{64}$/u.test(manifest.inputLedgerSha256 ?? "")
) {
  throw new Error("BUILD_SOURCE_ATTESTATION_INVALID");
}
if (
  !Array.isArray(manifest.entries) ||
  manifest.entries.length !== BUILD_ENTRIES.length ||
  !manifest.entries.every((entry, index) => entry === BUILD_ENTRIES[index])
) {
  throw new Error("BUILD_ENTRY_SET_INVALID");
}
await verifyBuildEntries(builtRoot, manifest.entrySha256);
const currentSource = sourceIdentity(repositoryRoot, scope);
if (
  manifest.dirty ||
  currentSource.dirty ||
  currentSource.commit !== manifest.sourceCommit ||
  currentSource.treeDigest !== manifest.sourceTreeDigest
) {
  throw new Error(
    "PACKAGE_DIRTY_SOURCE: commit the exact vNext source and rebuild first",
  );
}

const electronSourceSha256 = await treeDigest(electronApp);

await fs.rm(packageRoot, { recursive: true, force: true });
await fs.mkdir(path.join(appPath, "Contents/MacOS"), { recursive: true });
await fs.mkdir(path.join(appPath, "Contents/Resources/app"), {
  recursive: true,
});
await fs.mkdir(path.dirname(runtimeApp), { recursive: true });
await fs.cp(electronApp, runtimeApp, {
  recursive: true,
  verbatimSymlinks: true,
  preserveTimestamps: true,
});
const mainPlist = path.join(appPath, "Contents/Info.plist");
await fs.writeFile(mainPlist, infoPlist, { mode: 0o644 });
const launcherPath = path.join(appPath, "Contents/MacOS/Farol Next Preview");
await fs.writeFile(launcherPath, launcher, { mode: 0o755 });
await fs.chmod(launcherPath, 0o755);

const resources = path.join(appPath, "Contents/Resources");
const appResources = path.join(resources, "app");
for (const entry of BUILD_ENTRIES) {
  await fs.copyFile(
    path.join(builtRoot, entry),
    path.join(appResources, entry),
  );
}
await fs.copyFile(
  path.join(builtRoot, "build-manifest.json"),
  path.join(appResources, "build-manifest.json"),
);
await fs.writeFile(
  path.join(appResources, "package.json"),
  `${JSON.stringify(
    {
      name: "farol-next-preview-app",
      version: previewVersion,
      private: true,
      productName: "Farol Next Preview",
      type: "module",
      main: "main.cjs",
    },
    null,
    2,
  )}\n`,
);
const zodLicense = await fs.readFile(
  path.join(root, "node_modules/zod/LICENSE"),
  "utf8",
);
const geistLicense = await fs.readFile(
  path.join(builtRoot, "Geist-OFL.txt"),
  "utf8",
);
const geistHashes = GEIST_RESOURCES.map(
  (resource) => `${resource.output} SHA-256 ${resource.sha256}`,
).join("\n");
await fs.writeFile(
  path.join(appResources, "THIRD_PARTY_NOTICES.txt"),
  `Farol Next Preview direct runtime notice\n\nGeist ${GEIST_VERSION} (SIL Open Font License 1.1)\n${geistHashes}\n\n${geistLicense}\n\nZod 4.6.5 (MIT)\n${zodLicense}\n\nElectron's own license and Chromium notices are retained in Contents/Resources.\n`,
);
if ((await treeDigest(runtimeApp)) !== electronSourceSha256) {
  throw new Error("PACKAGE_RUNTIME_COPY_MISMATCH");
}
execFileSync("/usr/bin/plutil", ["-lint", mainPlist], { stdio: "inherit" });

const artifact = {
  schema: 3,
  product: "Farol Next Preview",
  version: previewVersion,
  bundleId: "local.farol.next.preview",
  sourceCommit: manifest.sourceCommit,
  sourceTreeDigest: manifest.sourceTreeDigest,
  sourceDirty: manifest.dirty,
  artifactPath: appPath,
  artifactSha256: await treeDigest(appPath),
  electronSourceSha256,
  runtime: {
    electron: "41.10.7",
    node: "embedded-in-electron",
    testerManagedRuntime: false,
    layout: "nested-unmodified-vendor-bundle",
    relativePath: runtimeRelativePath,
  },
  signing: {
    kind: "unsigned",
    reason: "local-development-preview",
    runtimeBytes: "unmodified-vendor-bundle",
  },
  notarized: false,
  updateChannel: "local-preview-only",
};
await fs.writeFile(
  path.join(packageRoot, "artifact.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  { mode: 0o600 },
);
execFileSync(
  process.execPath,
  [
    path.join(root, "tooling/verify-package.mjs"),
    "--artifact",
    path.join(packageRoot, "artifact.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
